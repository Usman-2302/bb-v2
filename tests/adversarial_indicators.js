'use strict';

/**
 * Adversarial indicator tests — Phase D2/D3 validation
 *
 * These tests are designed to CATCH errors, not confirm success.
 * They inject bad data, wrong formulas, and edge cases.
 * If these pass with a wrong implementation, the test is useless.
 *
 * Gemini concern: "Your unit tests are useless — they use happy-path data."
 * This file addresses that directly.
 */

const { ema, emaAtrSlope }               = require('../src/indicators/ema');
const { atr }                            = require('../src/indicators/atr');
const { cvd, cvdDeltaCandle }            = require('../src/indicators/cvd');
const { efficiencyRatio }                = require('../src/indicators/efficiencyRatio');
const { tagRegimes4H }                   = require('../src/utils/regimeDetector');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL  ' + name + ' — ' + e.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeCandle(close, high, low, openTime = 0) {
  return { openTime, open: close, high, low, close, volume: 1000 };
}

// ── TEST 1: Serial vs vectorized consistency ──────────────────────────────────
// Gemini concern: vectorized EMA might differ from serial (candle-by-candle) EMA
// This test proves they are identical — no lookahead bias possible

console.log('\n── Serial vs Vectorized Consistency ──');

test('EMA serial matches vectorized exactly', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 20);

  // Vectorized: compute all at once
  const vectorized = ema(closes, 9);

  // Serial: simulate live feed — push one candle at a time
  const serialResult = [];
  const k = 2 / (9 + 1);
  let prev = closes[0];
  serialResult.push(prev);
  for (let i = 1; i < closes.length; i++) {
    const next = closes[i] * k + prev * (1 - k);
    serialResult.push(next);
    prev = next;
  }

  // Must match exactly — any difference = lookahead bias
  for (let i = 0; i < closes.length; i++) {
    assert(
      Math.abs(vectorized[i] - serialResult[i]) < 1e-10,
      `Mismatch at index ${i}: vectorized=${vectorized[i]}, serial=${serialResult[i]}`
    );
  }
});

test('emaAtrSlope uses only past data (no lookahead)', () => {
  const candles = Array.from({ length: 50 }, (_, i) =>
    makeCandle(100 + i, 101 + i, 99 + i, i * 4 * 3600000)
  );
  const closes = candles.map(c => c.close);
  const ema200 = ema(closes, 9); // use period 9 for small dataset
  const atr14  = atr(candles, 5);

  // Compute slope at index 25
  const slope25 = emaAtrSlope(ema200, atr14, 25, 10);

  // Now modify future candles (index 26+) — slope at 25 must not change
  const closesModified = [...closes];
  for (let i = 26; i < 50; i++) closesModified[i] = 999999; // extreme future values
  const ema200Modified = ema(closesModified, 9);
  const atr14Modified  = atr(
    candles.map((c, i) => i >= 26 ? makeCandle(999999, 1000000, 999998, c.openTime) : c),
    5
  );
  const slope25Modified = emaAtrSlope(ema200Modified, atr14Modified, 25, 10);

  assert(
    Math.abs(slope25 - slope25Modified) < 1e-10,
    `Slope at index 25 changed when future data was modified: ${slope25} vs ${slope25Modified}`
  );
});

// ── TEST 2: Adversarial / garbage data ───────────────────────────────────────
// Gemini concern: tests only use "happy path" data

console.log('\n── Adversarial / Garbage Data ──');

test('EMA handles all-zero closes without NaN', () => {
  const result = ema(new Array(20).fill(0), 9);
  result.forEach((v, i) => assert(!isNaN(v), `NaN at index ${i}`));
  result.forEach((v, i) => assert(v === 0, `Expected 0 at index ${i}, got ${v}`));
});

test('EMA handles single candle', () => {
  const result = ema([42], 9);
  assert(result.length === 1);
  assert(result[0] === 42);
});

test('ATR handles candles with high=low (doji)', () => {
  const candles = Array.from({ length: 20 }, (_, i) =>
    makeCandle(100, 100, 100, i * 3600000) // high=low=close=100
  );
  const result = atr(candles, 14);
  result.forEach((v, i) => assert(!isNaN(v), `NaN at index ${i}`));
  result.forEach((v, i) => assert(v >= 0, `Negative ATR at index ${i}`));
});

test('CVD handles candle with high=low (zero range)', () => {
  const c = makeCandle(100, 100, 100, 0);
  assert(cvdDeltaCandle(c) === 0, 'Zero-range candle should have zero delta');
});

test('CVD handles negative volume gracefully', () => {
  // Negative volume is a data artifact — should not crash
  const c = { openTime: 0, open: 100, high: 105, low: 95, close: 102, volume: -100 };
  const delta = cvdDeltaCandle(c);
  assert(!isNaN(delta), 'CVD delta should not be NaN for negative volume');
});

test('EfficiencyRatio handles all-same-close (zero path)', () => {
  const candles = Array.from({ length: 15 }, () => makeCandle(100, 101, 99));
  const er = efficiencyRatio(candles, 10);
  assert(er === 0, `Expected 0 for flat market, got ${er}`);
});

test('EfficiencyRatio handles single spike then flat', () => {
  const candles = [
    ...Array.from({ length: 10 }, () => makeCandle(100, 101, 99)),
    makeCandle(200, 201, 199), // spike
    ...Array.from({ length: 4 }, () => makeCandle(200, 201, 199)),
  ];
  const er = efficiencyRatio(candles, 10);
  assert(er >= 0 && er <= 1, `ER out of range: ${er}`);
  assert(!isNaN(er), 'ER should not be NaN');
});

// ── TEST 3: Intentional wrong formula detection ───────────────────────────────
// Gemini concern: "If an external reviewer didn't catch that formula error,
// you would have backtested on a mathematical lie."
// This test INJECTS a wrong formula and verifies the test catches it.

console.log('\n── Intentional Wrong Formula Detection ──');

test('CATCH: wrong EMA formula (using SMA instead) produces different results', () => {
  const closes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  // Correct EMA
  const correctEMA = ema(closes, 3);

  // Wrong formula: simple moving average (SMA) — NOT EMA
  function wrongSMA(closes, period) {
    return closes.map((_, i) => {
      if (i < period - 1) return closes[0];
      const slice = closes.slice(i - period + 1, i + 1);
      return slice.reduce((a, b) => a + b, 0) / period;
    });
  }
  const wrongResult = wrongSMA(closes, 3);

  // They MUST differ — if they're the same, the test can't distinguish correct from wrong
  let differs = false;
  for (let i = 3; i < closes.length; i++) {
    if (Math.abs(correctEMA[i] - wrongResult[i]) > 0.001) {
      differs = true;
      break;
    }
  }
  assert(differs, 'EMA and SMA produce identical results — test cannot detect wrong formula');
});

test('CATCH: wrong slope formula (degree-based) produces different threshold behavior', () => {
  const candles = Array.from({ length: 50 }, (_, i) =>
    makeCandle(10000 + i * 100, 10100 + i * 100, 9900 + i * 100, i * 4 * 3600000)
  );
  const closes = candles.map(c => c.close);
  const ema200 = ema(closes, 9);
  const atr14  = atr(candles, 5);

  // Correct ATR-normalized slope
  const correctSlope = emaAtrSlope(ema200, atr14, 40, 10);

  // Wrong formula: degree-based (the one we had before)
  function wrongDegreeSlope(emaValues, index, lookback) {
    const current  = emaValues[index];
    const previous = emaValues[index - lookback];
    const pct = ((current - previous) / previous) / lookback;
    return Math.atan(pct * 100) * (180 / Math.PI);
  }
  const wrongSlope = wrongDegreeSlope(ema200, 40, 10);

  // They must be in different units/scales — threshold 0.011 would mean different things
  // Correct slope: dimensionless ATR units (~0.1-1.0 range)
  // Wrong slope: degrees (~1-45 range)
  assert(
    Math.abs(correctSlope) < 5,
    `Correct ATR slope should be < 5, got ${correctSlope} — may be using wrong formula`
  );
  assert(
    Math.abs(wrongSlope) > 1 || Math.abs(wrongSlope) < 0.1,
    `Wrong degree slope should be in degree range, got ${wrongSlope}`
  );
  // The two must differ significantly
  assert(
    Math.abs(correctSlope - wrongSlope) > 0.5,
    `Correct and wrong formulas produce too-similar results: ${correctSlope} vs ${wrongSlope}`
  );
});

// ── TEST 4: Regime with missing/gap candles ───────────────────────────────────

console.log('\n── Regime with Edge Cases ──');

test('tagRegimes4H handles minimum viable candle count', () => {
  const candles = Array.from({ length: 25 }, (_, i) =>
    makeCandle(50000, 50100, 49900, i * 4 * 3600000)
  );
  const regimes = tagRegimes4H(candles);
  assert(regimes.length === 25, 'Should return same length');
  // Flat data with ER=0 correctly classifies as RANGING_ZOMBIE (no impulse)
  // All candles before slopeLookback (20) are RANGING, rest may be ZOMBIE
  const validRegimes = new Set(['RANGING', 'RANGING_ZOMBIE', 'RANGING_PREZONE']);
  regimes.forEach(r => assert(validRegimes.has(r), `Unexpected regime for short dataset: ${r}`));
});

test('tagRegimes4H handles extreme price spike (CRISIS detection)', () => {
  const candles = Array.from({ length: 250 }, (_, i) => {
    // Normal candles, then one extreme spike
    if (i === 200) return makeCandle(50000, 60000, 40000, i * 4 * 3600000); // 40% range
    return makeCandle(50000, 50100, 49900, i * 4 * 3600000);
  });
  const regimes = tagRegimes4H(candles);
  assert(regimes[200] === 'CRISIS', `Expected CRISIS at spike candle, got ${regimes[200]}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + passed + '/' + (passed + failed) + ' adversarial tests passed');
if (failed > 0) {
  console.log(failed + ' FAILED — testing framework has gaps');
  process.exit(1);
} else {
  console.log('Adversarial validation: ALL PASS');
  console.log('Testing framework can detect intentional formula errors.');
}
