'use strict';

const {
  detectRegimeRaw,
  applyAntiFlapping,
  isZombie,
  checkVolSwitch,
  tagRegimes4H,
  propagateRegime,
} = require('../src/utils/regimeDetector');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandle(close, high, low, openTime = 0) {
  return { openTime, open: close, high, low, close, volume: 1000 };
}

/**
 * Build a trending candle array.
 * direction: 1 = uptrend, -1 = downtrend
 */
function trendCandles(n, startPrice, direction, volatility = 0.5) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    price += direction * 100;
    candles.push(makeCandle(price, price + volatility * 100, price - volatility * 100, i * 4 * 3600000));
  }
  return candles;
}

/**
 * Build flat/choppy candles (for RANGING/ZOMBIE tests)
 */
function flatCandles(n, price = 50000, volatility = 0.5) {
  return Array.from({ length: n }, (_, i) =>
    makeCandle(price, price + volatility * 100, price - volatility * 100, i * 4 * 3600000)
  );
}

// ── detectRegimeRaw ───────────────────────────────────────────────────────────
console.log('\n── detectRegimeRaw ──');

test('returns RANGING for insufficient data (< 200 candles)', () => {
  const candles = flatCandles(100);
  // Pass dummy pre-computed arrays
  const closes = candles.map(c => c.close);
  const e200   = require('../src/indicators/ema').ema(closes, 200);
  const a14    = require('../src/indicators/atr').atr(candles, 14);
  assert(detectRegimeRaw(candles, 5, e200, a14) === 'RANGING');
});

test('returns CRISIS when ATR% > 5', () => {
  const candles = Array.from({ length: 250 }, (_, i) =>
    makeCandle(50000, 55000, 45000, i * 4 * 3600000)
  );
  const closes = candles.map(c => c.close);
  const e200   = require('../src/indicators/ema').ema(closes, 200);
  const a14    = require('../src/indicators/atr').atr(candles, 14);
  const regime = detectRegimeRaw(candles, 249, e200, a14);
  assert(regime === 'CRISIS', `expected CRISIS, got ${regime}`);
});

test('returns BULL for strong uptrend', () => {
  const candles = trendCandles(250, 10000, 1, 0.1);
  const closes  = candles.map(c => c.close);
  const e200    = require('../src/indicators/ema').ema(closes, 200);
  const a14     = require('../src/indicators/atr').atr(candles, 14);
  const regime  = detectRegimeRaw(candles, 249, e200, a14, 0.011);
  assert(regime === 'BULL', `expected BULL, got ${regime}`);
});

test('returns BEAR for strong downtrend', () => {
  const candles = trendCandles(250, 60000, -1, 0.1);
  const closes  = candles.map(c => c.close);
  const e200    = require('../src/indicators/ema').ema(closes, 200);
  const a14     = require('../src/indicators/atr').atr(candles, 14);
  const regime  = detectRegimeRaw(candles, 249, e200, a14, 0.011);
  assert(regime === 'BEAR', `expected BEAR, got ${regime}`);
});

test('returns RANGING for flat market', () => {
  const candles = flatCandles(250);
  const closes  = candles.map(c => c.close);
  const e200    = require('../src/indicators/ema').ema(closes, 200);
  const a14     = require('../src/indicators/atr').atr(candles, 14);
  const regime  = detectRegimeRaw(candles, 249, e200, a14, 0.011);
  assert(regime === 'RANGING', `expected RANGING, got ${regime}`);
});

// ── applyAntiFlapping ─────────────────────────────────────────────────────────
console.log('\n── applyAntiFlapping ──');

test('single-candle regime spike does not switch regime', () => {
  const raw = ['BULL', 'BULL', 'BEAR', 'BULL', 'BULL'];
  const smoothed = applyAntiFlapping(raw, 2);
  // Single BEAR candle should not switch — need 2 consecutive
  assert(smoothed[2] === 'BULL', `expected BULL at index 2, got ${smoothed[2]}`);
});

test('two consecutive candles switch regime', () => {
  const raw = ['BULL', 'BULL', 'BEAR', 'BEAR', 'BEAR'];
  const smoothed = applyAntiFlapping(raw, 2);
  // After 2 consecutive BEAR, should switch
  assert(smoothed[4] === 'BEAR', `expected BEAR at index 4, got ${smoothed[4]}`);
});

test('CRISIS overrides immediately without anti-flapping', () => {
  const raw = ['BULL', 'BULL', 'CRISIS', 'BULL', 'BULL'];
  const smoothed = applyAntiFlapping(raw, 2);
  assert(smoothed[2] === 'CRISIS', `expected CRISIS at index 2, got ${smoothed[2]}`);
});

test('returns same length as input', () => {
  const raw = ['BULL', 'BEAR', 'RANGING', 'CRISIS'];
  assert(applyAntiFlapping(raw, 2).length === 4);
});

test('empty input returns empty array', () => {
  assert(applyAntiFlapping([], 2).length === 0);
});

// ── isZombie ──────────────────────────────────────────────────────────────────
console.log('\n── isZombie ──');

test('choppy market is zombie (ER < 0.3)', () => {
  // Alternating up/down — very low ER
  const candles = Array.from({ length: 30 }, (_, i) =>
    makeCandle(50000 + (i % 2 === 0 ? 100 : -100), 50200, 49800, i * 4 * 3600000)
  );
  assert(isZombie(candles, 25) === true, 'choppy market should be zombie');
});

test('trending market is not zombie (ER > 0.3)', () => {
  const candles = trendCandles(30, 10000, 1, 0.05);
  assert(isZombie(candles, 25) === false, 'trending market should not be zombie');
});

test('returns false for insufficient data', () => {
  const candles = flatCandles(5);
  assert(isZombie(candles, 3) === false);
});

// ── checkVolSwitch ────────────────────────────────────────────────────────────
console.log('\n── checkVolSwitch ──');

test('returns CRISIS when 15m ATR > 3× 4H baseline', () => {
  // Build 15m candles with extreme volatility
  const candles15m = Array.from({ length: 30 }, (_, i) =>
    makeCandle(50000, 53000, 47000, i * 15 * 60000) // 12% range
  );
  const atr4HBaseline = 1.0; // 1% baseline
  // 15m ATR% ≈ 12% >> 3 × 1% = 3% → should trigger
  const result = checkVolSwitch(candles15m, 25, atr4HBaseline);
  assert(result === 'CRISIS', `expected CRISIS, got ${result}`);
});

test('returns null when 15m ATR is normal', () => {
  const candles15m = Array.from({ length: 30 }, (_, i) =>
    makeCandle(50000, 50100, 49900, i * 15 * 60000) // 0.4% range
  );
  const atr4HBaseline = 1.0;
  const result = checkVolSwitch(candles15m, 25, atr4HBaseline);
  assert(result === null, `expected null, got ${result}`);
});

test('returns null for zero baseline', () => {
  const candles15m = flatCandles(30);
  assert(checkVolSwitch(candles15m, 25, 0) === null);
});

// ── tagRegimes4H ──────────────────────────────────────────────────────────────
console.log('\n── tagRegimes4H ──');

test('returns same length as input', () => {
  const candles = flatCandles(250);
  const regimes = tagRegimes4H(candles, 15);
  assert(regimes.length === 250, `expected 250, got ${regimes.length}`);
});

test('all values are valid regime strings', () => {
  const valid = new Set(['BULL', 'BEAR', 'RANGING', 'RANGING_ZOMBIE', 'RANGING_PREZONE', 'CRISIS']);
  const candles = flatCandles(250);
  const regimes = tagRegimes4H(candles, 15);
  regimes.forEach(r => assert(valid.has(r), `invalid regime: ${r}`));
});

test('uptrend produces BULL regime', () => {
  const candles = trendCandles(250, 10000, 1, 0.05);
  const regimes = tagRegimes4H(candles, 0.011);
  const bullCount = regimes.filter(r => r === 'BULL').length;
  // ATR-normalized slope fires quickly — expect most candles after warmup to be BULL
  assert(bullCount > 100, `expected many BULL candles, got ${bullCount}`);
});

// ── propagateRegime ───────────────────────────────────────────────────────────
console.log('\n── propagateRegime ──');

test('lower-TF candle gets regime of containing 4H candle', () => {
  const candles4H = [
    { openTime: 0,           close: 50000, regime: 'BULL' },
    { openTime: 4*3600*1000, close: 51000, regime: 'BEAR' },
  ];
  // 15m candles: first 4 belong to first 4H, next 4 to second 4H
  const candles15m = [
    { openTime: 0 },
    { openTime: 15*60*1000 },
    { openTime: 30*60*1000 },
    { openTime: 4*3600*1000 },
    { openTime: 4*3600*1000 + 15*60*1000 },
  ];
  const regimes = propagateRegime(candles15m, candles4H);
  assert(regimes[0] === 'BULL', `expected BULL, got ${regimes[0]}`);
  assert(regimes[3] === 'BEAR', `expected BEAR, got ${regimes[3]}`);
});

test('returns same length as lower-TF input', () => {
  const candles4H  = [{ openTime: 0, close: 50000, regime: 'BULL' }];
  const candles15m = Array.from({ length: 16 }, (_, i) => ({ openTime: i * 15 * 60000 }));
  assert(propagateRegime(candles15m, candles4H).length === 16);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + passed + '/' + (passed + failed) + ' tests passed');
if (failed > 0) {
  console.log(failed + ' FAILED');
  process.exit(1);
} else {
  console.log('Phase D3 regime tests: ALL PASS');
}
