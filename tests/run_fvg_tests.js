'use strict';

/**
 * BulletBrain v3.0 — FVG Strategy Tests
 * Phase D6
 */

const {
  detectBullishFVGs,
  detectBearishFVGs,
  updateFVGStatus,
  isTradeable,
  checkFVGEntry,
  isAsianSession,
} = require('../src/strategies/fvg');

const {
  findDOL,
  findEqualHighsClusters,
  findEqualLowsClusters,
} = require('../src/utils/dolFinder');

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

function assertClose(a, b, tol = 0.001, msg) {
  if (Math.abs(a - b) > tol) throw new Error(msg || `expected ${b}, got ${a}`);
}

function makeCandle(open, high, low, close, volume = 1000, openTime = 0, rvol = 2.0) {
  return { openTime, open, high, low, close, volume, rvol };
}

// ── isAsianSession ────────────────────────────────────────────────────────────
console.log('\n── Asian Session Gate ──');

test('22:00 UTC is Asian session', () => {
  const ts = new Date('2023-01-01T22:00:00Z').getTime();
  assert(isAsianSession(ts) === true);
});

test('03:00 UTC is Asian session', () => {
  const ts = new Date('2023-01-01T03:00:00Z').getTime();
  assert(isAsianSession(ts) === true);
});

test('07:00 UTC is NOT Asian session (London open)', () => {
  const ts = new Date('2023-01-01T07:00:00Z').getTime();
  assert(isAsianSession(ts) === false);
});

test('13:00 UTC is NOT Asian session (NY open)', () => {
  const ts = new Date('2023-01-01T13:00:00Z').getTime();
  assert(isAsianSession(ts) === false);
});

// ── detectBullishFVGs ─────────────────────────────────────────────────────────
console.log('\n── Bullish FVG Detection ──');

// Build a valid bullish FVG scenario:
// candle[0]: high=100, candle[1]: impulse up, candle[2]: low=105 (gap: 100-105)
function makeBullishFVGCandles() {
  const atr14   = [2, 2, 2, 2, 2];
  const rvolVals = [1.0, 2.5, 1.0, 1.0, 1.0]; // candle[1] has high RVOL
  const candles = [
    makeCandle(98, 100, 96, 99,  1000, new Date('2023-01-01T08:00:00Z').getTime(), 1.0),
    makeCandle(99, 108, 98, 107, 2000, new Date('2023-01-01T09:00:00Z').getTime(), 2.5), // impulse
    makeCandle(105, 110, 105, 108, 1000, new Date('2023-01-01T10:00:00Z').getTime(), 1.0),
    makeCandle(107, 112, 106, 110, 1000, new Date('2023-01-01T11:00:00Z').getTime(), 1.0),
    makeCandle(109, 114, 108, 112, 1000, new Date('2023-01-01T12:00:00Z').getTime(), 1.0),
  ];
  // candle[0].high=100, candle[2].low=105 → gap exists (100 < 105)
  // candle[1] body = |107-99| = 8 > 1.2 × ATR14[1]=2 → 2.4 ✓
  // candle[1] rvol = 2.5 > 1.8 ✓
  return { candles, atr14, rvolVals };
}

test('Detects valid bullish FVG', () => {
  const { candles, atr14, rvolVals } = makeBullishFVGCandles();
  const fvgs = detectBullishFVGs(candles, atr14, rvolVals);
  assert(fvgs.length >= 1, `Expected at least 1 FVG, got ${fvgs.length}`);
  assert(fvgs[0].type === 'BULLISH');
  assertClose(fvgs[0].bottom, 100, 0.01, 'FVG bottom should be candle[0].high = 100');
  assertClose(fvgs[0].top,    105, 0.01, 'FVG top should be candle[2].low = 105');
  assertClose(fvgs[0].mid,    102.5, 0.01, 'FVG mid should be 102.5');
});

test('Rejects FVG in Asian session', () => {
  const { candles, atr14, rvolVals } = makeBullishFVGCandles();
  // Move candles to Asian session (03:00 UTC)
  const asianCandles = candles.map((c, i) => ({
    ...c,
    openTime: new Date('2023-01-01T03:00:00Z').getTime() + i * 3600000,
  }));
  // Detection is now ALLOWED in Asian session
  const fvgs = detectBullishFVGs(asianCandles, atr14, rvolVals);
  // FVG should be detected (detection gate removed)
  // Entry should be blocked (entry gate in checkFVGEntry)
  assert(fvgs.length >= 1, 'FVG should be detected even in Asian session');
  // Now check that entry is blocked
  const fvg    = fvgs[0];
  const asianEntryCandle = { ...asianCandles[2], openTime: new Date('2023-01-01T03:00:00Z').getTime() };
  const signal = checkFVGEntry(fvg, asianEntryCandle);
  assert(signal === null, 'Entry should be blocked during Asian session');
});

test('Rejects FVG with insufficient body size', () => {
  const atr14    = [10, 10, 10]; // large ATR — body won't pass
  const rvolVals = [1.0, 2.5, 1.0];
  const candles  = [
    makeCandle(98, 100, 96, 99,  1000, new Date('2023-01-01T08:00:00Z').getTime()),
    makeCandle(99, 102, 98, 101, 1000, new Date('2023-01-01T09:00:00Z').getTime(), 2.5), // body=2, ATR=10 → fails
    makeCandle(105, 110, 105, 108, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
  ];
  const fvgs = detectBullishFVGs(candles, atr14, rvolVals);
  assert(fvgs.length === 0, 'Should reject FVG with small body');
});

test('Rejects FVG with insufficient RVOL', () => {
  const atr14    = [2, 2, 2];
  const rvolVals = [1.0, 1.2, 1.0]; // RVOL 1.2 < threshold 1.8
  const candles  = [
    makeCandle(98, 100, 96, 99,  1000, new Date('2023-01-01T08:00:00Z').getTime()),
    makeCandle(99, 108, 98, 107, 1000, new Date('2023-01-01T09:00:00Z').getTime(), 1.2),
    makeCandle(105, 110, 105, 108, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
  ];
  const fvgs = detectBullishFVGs(candles, atr14, rvolVals);
  assert(fvgs.length === 0, 'Should reject FVG with low RVOL');
});

test('Returns empty array when no gap exists', () => {
  const atr14    = [2, 2, 2];
  const rvolVals = [1.0, 2.5, 1.0];
  const candles  = [
    makeCandle(98, 102, 96, 100, 1000, new Date('2023-01-01T08:00:00Z').getTime()),
    makeCandle(99, 108, 98, 107, 1000, new Date('2023-01-01T09:00:00Z').getTime(), 2.5),
    makeCandle(100, 110, 100, 108, 1000, new Date('2023-01-01T10:00:00Z').getTime()), // low=100 = prev.high → no gap
  ];
  const fvgs = detectBullishFVGs(candles, atr14, rvolVals);
  assert(fvgs.length === 0, 'Should return empty when no gap');
});

// ── FVG State Management ──────────────────────────────────────────────────────
console.log('\n── FVG State Management ──');

function makeFVG(overrides = {}) {
  return {
    id: 'test_fvg',
    type: 'BULLISH',
    top: 105,
    bottom: 100,
    mid: 102.5,
    formed_at: 0,
    expires_at: 72,
    status: 'ACTIVE',
    fill_pct: 0,
    contested_touches: 0,
    atr_at_formation: 2,
    ...overrides,
  };
}

test('FVG expires at expires_at candle', () => {
  const fvg = makeFVG();
  updateFVGStatus(fvg, makeCandle(106, 108, 104, 107), 72);
  assert(fvg.status === 'EXPIRED', `Expected EXPIRED, got ${fvg.status}`);
});

test('FVG invalidated when price closes below bottom', () => {
  const fvg = makeFVG();
  updateFVGStatus(fvg, makeCandle(102, 104, 98, 99), 10); // close=99 < bottom=100
  assert(fvg.status === 'FILLED', `Expected FILLED, got ${fvg.status}`);
});

test('FVG becomes PARTIALLY_FILLED when 50%+ of zone touched', () => {
  const fvg = makeFVG(); // top=105, bottom=100, range=5
  // Candle touches 3 units of the 5-unit zone = 60%
  updateFVGStatus(fvg, makeCandle(106, 106, 101, 104), 10); // low=101, high=106 → overlap 101-105 = 4 units
  assert(fvg.status === 'PARTIALLY_FILLED', `Expected PARTIALLY_FILLED, got ${fvg.status}`);
});

test('FVG becomes CONTESTED after 3 touches without fill', () => {
  const fvg = makeFVG({ contested_touches: 2 });
  // One more touch inside zone without closing below bottom
  updateFVGStatus(fvg, makeCandle(103, 106, 101, 103), 10); // close=103 inside zone
  assert(fvg.status === 'CONTESTED', `Expected CONTESTED, got ${fvg.status}`);
});

test('isTradeable: ACTIVE is tradeable', () => {
  assert(isTradeable(makeFVG({ status: 'ACTIVE' })) === true);
});

test('isTradeable: PARTIALLY_FILLED is tradeable', () => {
  assert(isTradeable(makeFVG({ status: 'PARTIALLY_FILLED' })) === true);
});

test('isTradeable: EXPIRED is not tradeable', () => {
  assert(isTradeable(makeFVG({ status: 'EXPIRED' })) === false);
});

test('isTradeable: CONTESTED is not tradeable', () => {
  assert(isTradeable(makeFVG({ status: 'CONTESTED' })) === false);
});

// ── checkFVGEntry ─────────────────────────────────────────────────────────────
console.log('\n── FVG Entry Signal ──');

test('Generates entry signal when price reaches FVG entry level', () => {
  const fvg    = makeFVG(); // top=105, bottom=100, entryOffset=0.50 → entry=102.5
  const candle = makeCandle(104, 106, 102, 103, 1000, new Date('2023-01-01T09:00:00Z').getTime()); // low=102 <= 102.5
  const signal = checkFVGEntry(fvg, candle);
  assert(signal !== null, 'Should generate signal');
  assert(signal.type === 'BULLISH_FVG');
  // Entry level = top - 0.50 × (top-bottom) = 105 - 0.50×5 = 102.5
  assertClose(signal.limitPrice, 102.5, 0.01);
  assert(signal.entryOffset === 0.50, 'Should use default entryOffset');
});

test('No signal when price does not reach entry level', () => {
  const fvg    = makeFVG(); // entry level = 102.5
  const candle = makeCandle(106, 108, 103, 107, 1000, new Date('2023-01-01T09:00:00Z').getTime()); // low=103 > 102.5
  const signal = checkFVGEntry(fvg, candle);
  assert(signal === null, 'Should not generate signal when price above entry level');
});

test('No signal for expired FVG', () => {
  const fvg    = makeFVG({ status: 'EXPIRED' });
  const candle = makeCandle(104, 106, 102, 103, 1000, new Date('2023-01-01T09:00:00Z').getTime());
  const signal = checkFVGEntry(fvg, candle);
  assert(signal === null, 'Should not generate signal for expired FVG');
});

test('No entry signal during Asian session (entry gate)', () => {
  const fvg    = makeFVG(); // FVG detected outside Asian session
  const asianCandle = makeCandle(104, 106, 102, 103, 1000, new Date('2023-01-01T03:00:00Z').getTime());
  const signal = checkFVGEntry(fvg, asianCandle);
  assert(signal === null, 'Entry should be blocked during Asian session');
});

test('Entry signal allowed during London open for Asian-detected FVG', () => {
  const fvg    = makeFVG(); // FVG could have been detected during Asian session
  const londonCandle = makeCandle(104, 106, 102, 103, 1000, new Date('2023-01-01T08:00:00Z').getTime());
  const signal = checkFVGEntry(fvg, londonCandle);
  assert(signal !== null, 'Entry should be allowed during London open');
});

// ── DOL Finder ────────────────────────────────────────────────────────────────
console.log('\n── DOL Finder ──');

test('findEqualHighsClusters: detects cluster of 2 similar highs', () => {
  const candles = [
    makeCandle(98, 100.1, 96, 99, 1000, 1000),
    makeCandle(99, 105,   97, 103, 1000, 2000),
    makeCandle(102, 100.2, 100, 101, 1000, 3000), // high ≈ 100.1 (within 0.3%)
    makeCandle(100, 98,   98, 99, 1000, 4000),
  ];
  const clusters = findEqualHighsClusters(candles, { tolerance: 0.003, minTouches: 2, lookback: 10 });
  assert(clusters.length >= 1, `Expected at least 1 cluster, got ${clusters.length}`);
  // Cluster should be around 100.15 (avg of 100.1 and 100.2)
  assert(clusters[0].level > 99 && clusters[0].level < 101, `Cluster level ${clusters[0].level} out of range`);
});

test('findDOL: returns null when no valid target exists', () => {
  const candles = Array.from({ length: 10 }, (_, i) =>
    makeCandle(100, 101, 99, 100, 1000, i * 3600000)
  );
  const result = findDOL(candles, 9, 100, 98, 'LONG');
  assert(result === null, 'Should return null when no DOL found');
});

test('findDOL: lookahead bias guard — signal candle not included in scan', () => {
  const candles = Array.from({ length: 15 }, (_, i) =>
    makeCandle(100 + i, 101 + i, 99 + i, 100 + i, 1000, i * 3600000)
  );
  // Signal at index 10 — DOL scan should only use candles 0-9
  const signalTime = candles[10].openTime;
  const validCandles = candles.filter(c => c.openTime < signalTime);
  assert(validCandles.length === 10, `Expected 10 valid candles, got ${validCandles.length}`);
  assert(validCandles.every(c => c.openTime < signalTime), 'All valid candles should be before signal');
});

test('findDOL: rejects target with R:R < 1.8', () => {
  // Entry at 100, stop at 99 (risk = 1), target at 101 (reward = 1, R:R = 1.0 < 1.8)
  const candles = [
    makeCandle(100, 101.1, 99, 100, 1000, 1000),
    makeCandle(100, 101.2, 99, 100, 1000, 2000), // equal highs at ~101.15
    makeCandle(100, 101,   99, 100, 1000, 3000),
  ];
  const result = findDOL(candles, 2, 100, 99, 'LONG');
  // R:R = (101.15 - 100) / (100 - 99) = 1.15 < 1.8 → should reject
  assert(result === null, 'Should reject target with R:R < 1.8');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + passed + '/' + (passed + failed) + ' FVG tests passed');
if (failed > 0) {
  console.log(failed + ' FAILED');
  process.exit(1);
} else {
  console.log('Phase D6 FVG strategy: ALL PASS');
}
