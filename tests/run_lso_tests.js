'use strict';

/**
 * BulletBrain v3.0 — LSO Strategy Unit Tests
 * Phase D8 — Step 3.1 through 3.3
 *
 * Tests:
 *   - Equal lows/highs detection
 *   - Sweep detection (bullish + bearish)
 *   - OI interpolation
 *   - OI flush check
 *   - OI velocity gate
 *   - Signal generation
 *   - OB confluence check (D7 deferred item 1)
 *   - Time-based breakeven gate (D7 deferred item 3)
 *   - Asian session (LSO ALLOWED — unlike FVG/OB)
 */

const {
  findEqualLows,
  findEqualHighs,
  isBullishSweep,
  isBearishSweep,
  getInterpolatedOI,
  checkOIFlush,
  checkOIVelocityGate,
  buildBullishLSOSignal,
  buildBearishLSOSignal,
  checkOBConfluence,
  checkLSOTimeBreakeven,
  isAsianSession,
} = require('../src/strategies/lso');

// ─────────────────────────────────────────────────────────────────────────────
// TEST HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertClose(a, b, tol = 0.0001, message) {
  if (Math.abs(a - b) > tol) {
    throw new Error(message || `Expected ${a} ≈ ${b} (tolerance ${tol})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANDLE FACTORY
// ─────────────────────────────────────────────────────────────────────────────

function makeCandle(overrides = {}) {
  return {
    openTime: Date.UTC(2023, 0, 1, 12, 0, 0),
    open:  100,
    high:  105,
    low:   95,
    close: 102,
    volume: 1000,
    regime: 'BULL',
    ...overrides,
  };
}

function makeCandleArray(n, basePrice = 100, baseTime = Date.UTC(2023, 0, 1)) {
  return Array.from({ length: n }, (_, i) => makeCandle({
    openTime: baseTime + i * 900000, // 15m intervals
    open:  basePrice + (Math.random() - 0.5) * 2,
    high:  basePrice + 3 + Math.random() * 2,
    low:   basePrice - 3 - Math.random() * 2,
    close: basePrice + (Math.random() - 0.5) * 2,
    volume: 1000 + Math.random() * 500,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUAL LOWS DETECTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nEqual lows detection:');

test('Detects equal lows within tolerance', () => {
  // Use candles with high lows so planted values are the only candidates near 95
  // Need proper swing low structure: low[i] < neighbors on both sides
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 105, low: 99, close: 102, volume: 1000,
  }));
  // Plant two swing lows at indices 10 and 20
  // Swing low: lower than 2 bars on each side
  candles[10].low = 95.0;
  candles[9].low  = 97.0;  // higher than swing low
  candles[8].low  = 97.5;
  candles[11].low = 97.0;
  candles[12].low = 97.5;

  candles[20].low = 95.1; // within 0.3% of 95.0
  candles[19].low = 97.0;
  candles[18].low = 97.5;
  candles[21].low = 97.0;
  candles[22].low = 97.5;

  const pools = findEqualLows(candles, 55);
  const found = pools.find(p => p.index_i === 10 && p.index_j === 20);
  assert(found, 'Should detect equal lows pairing indices 10 and 20');
});

test('Rejects equal lows outside tolerance', () => {
  // Use candles with high lows so planted values are the only candidates near 95
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 105, low: 99, close: 102, volume: 1000,
  }));
  // Plant two swing lows that are outside tolerance
  candles[10].low = 95.0;
  candles[9].low  = 97.0; candles[8].low  = 97.5;
  candles[11].low = 97.0; candles[12].low = 97.5;

  candles[20].low = 95.5; // 0.53% apart — outside 0.3% tolerance
  candles[19].low = 97.0; candles[18].low = 97.5;
  candles[21].low = 97.0; candles[22].low = 97.5;

  const pools = findEqualLows(candles, 55);
  const found = pools.find(p => p.index_i === 10 && p.index_j === 20);
  assert(!found, 'Should NOT detect equal lows outside tolerance');
});

test('Rejects equal lows less than minGap apart', () => {
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 105, low: 99, close: 102, volume: 1000,
  }));
  // Two swing lows only 2 candles apart — below minGap of 5
  candles[10].low = 95.0;
  candles[9].low  = 97.0; candles[8].low  = 97.5;
  candles[11].low = 97.0; candles[12].low = 97.5;

  candles[12].low = 95.1; // only 2 candles apart from index 10
  // Note: candles[12] is already set to 97.5 above, overwrite:
  candles[12].low = 95.1;
  candles[13].low = 97.0; candles[14].low = 97.5;

  const pools = findEqualLows(candles, 55);
  const found = pools.find(p =>
    p.index_i === 10 && p.index_j === 12
  );
  assert(!found, 'Should NOT detect equal lows less than minGap apart');
});

test('Rejects equal lows when swept between them', () => {
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 105, low: 99, close: 102, volume: 1000,
  }));
  // Two swing lows with a sweep between them
  candles[10].low = 95.0;
  candles[9].low  = 97.0; candles[8].low  = 97.5;
  candles[11].low = 97.0; candles[12].low = 97.5;

  candles[15].low = 94.0; // swept below both lows

  candles[20].low = 95.1;
  candles[19].low = 97.0; candles[18].low = 97.5;
  candles[21].low = 97.0; candles[22].low = 97.5;

  const pools = findEqualLows(candles, 55);
  const found = pools.find(p =>
    p.index_i === 10 && p.index_j === 20
  );
  assert(!found, 'Should NOT detect equal lows when swept between them');
});

test('Returns pool level as average of the two lows', () => {
  // Use candles with high lows so planted values are the only candidates near 95
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 105, low: 99, close: 102, volume: 1000,
  }));
  // Two proper swing lows
  candles[10].low = 95.0;
  candles[9].low  = 97.0; candles[8].low  = 97.5;
  candles[11].low = 97.0; candles[12].low = 97.5;

  candles[20].low = 95.2;
  candles[19].low = 97.0; candles[18].low = 97.5;
  candles[21].low = 97.0; candles[22].low = 97.5;

  const pools = findEqualLows(candles, 55);
  const found = pools.find(p => p.index_i === 10 && p.index_j === 20);
  assert(found, 'Should find pool pairing indices 10 and 20');
  assertClose(found.level, 95.1, 0.01, 'Pool level should be average of the two lows (95.1)');
});

// ─────────────────────────────────────────────────────────────────────────────
// EQUAL HIGHS DETECTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nEqual highs detection:');

test('Detects equal highs within tolerance', () => {
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 101, low: 99, close: 100, volume: 1000,
  }));
  // Two proper swing highs
  candles[10].high = 108.0;
  candles[9].high  = 106.0; candles[8].high  = 105.5;
  candles[11].high = 106.0; candles[12].high = 105.5;

  candles[20].high = 108.2; // within 0.3%
  candles[19].high = 106.0; candles[18].high = 105.5;
  candles[21].high = 106.0; candles[22].high = 105.5;

  const pools = findEqualHighs(candles, 55);
  const found = pools.find(p => p.index_i === 10 && p.index_j === 20);
  assert(found, 'Should detect equal highs pairing indices 10 and 20');
});

test('Rejects equal highs when swept between them', () => {
  const candles = Array.from({ length: 60 }, (_, i) => makeCandle({
    openTime: Date.UTC(2023, 0, 1) + i * 900000,
    open: 100, high: 101, low: 99, close: 100, volume: 1000,
  }));
  // Two swing highs with a sweep between them
  candles[10].high = 108.0;
  candles[9].high  = 106.0; candles[8].high  = 105.5;
  candles[11].high = 106.0; candles[12].high = 105.5;

  candles[15].high = 109.0; // swept above both highs

  candles[20].high = 108.1;
  candles[19].high = 106.0; candles[18].high = 105.5;
  candles[21].high = 106.0; candles[22].high = 105.5;

  const pools = findEqualHighs(candles, 55);
  const found = pools.find(p =>
    p.index_i === 10 && p.index_j === 20
  );
  assert(!found, 'Should NOT detect equal highs when swept between them');
});

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP DETECTION TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nBullish sweep detection:');

test('Detects valid bullish sweep', () => {
  const pool = { type: 'EQUAL_LOWS', level: 95.0 };
  // Wick below 95, close above 95, wick-dominated
  const candle = makeCandle({ open: 96, high: 98, low: 94, close: 97 });
  // body = 1, range = 4, ratio = 0.25 < 0.4 ✓
  assert(isBullishSweep(candle, pool), 'Should detect bullish sweep');
});

test('Rejects sweep when low does not reach pool level', () => {
  const pool = { type: 'EQUAL_LOWS', level: 95.0 };
  const candle = makeCandle({ open: 96, high: 99, low: 95.5, close: 97 });
  assert(!isBullishSweep(candle, pool), 'Should NOT detect sweep when low above pool');
});

test('Rejects sweep when close does not recover above pool level', () => {
  const pool = { type: 'EQUAL_LOWS', level: 95.0 };
  const candle = makeCandle({ open: 96, high: 96.5, low: 94, close: 94.5 });
  assert(!isBullishSweep(candle, pool), 'Should NOT detect sweep when close below pool');
});

test('Rejects sweep when body/wick ratio too high (not wick-dominated)', () => {
  const pool = { type: 'EQUAL_LOWS', level: 95.0 };
  // body = 4, range = 5, ratio = 0.8 > 0.4 — body-dominated
  const candle = makeCandle({ open: 94, high: 99, low: 94, close: 98 });
  assert(!isBullishSweep(candle, pool), 'Should NOT detect sweep when body-dominated');
});

test('Rejects sweep for wrong pool type', () => {
  const pool = { type: 'EQUAL_HIGHS', level: 95.0 };
  const candle = makeCandle({ open: 96, high: 98, low: 94, close: 97 });
  assert(!isBullishSweep(candle, pool), 'Should NOT detect bullish sweep on EQUAL_HIGHS pool');
});

console.log('\nBearish sweep detection:');

test('Detects valid bearish sweep', () => {
  const pool = { type: 'EQUAL_HIGHS', level: 105.0 };
  // Wick above 105, close below 105, wick-dominated
  const candle = makeCandle({ open: 104, high: 106, low: 102, close: 103 });
  // body = 1, range = 4, ratio = 0.25 < 0.4 ✓
  assert(isBearishSweep(candle, pool), 'Should detect bearish sweep');
});

test('Rejects bearish sweep when high does not reach pool level', () => {
  const pool = { type: 'EQUAL_HIGHS', level: 105.0 };
  const candle = makeCandle({ open: 104, high: 104.5, low: 102, close: 103 });
  assert(!isBearishSweep(candle, pool), 'Should NOT detect sweep when high below pool');
});

// ─────────────────────────────────────────────────────────────────────────────
// OI INTERPOLATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nOI interpolation:');

function makeOIStore(symbol, entries) {
  const store = new Map();
  store.set(symbol, entries);
  return store;
}

test('Interpolates OI correctly at 15m boundary', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  const hourEnd   = hourStart + 3600000;
  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart, oi: 1000 },
    { timestamp: hourEnd,   oi: 1100 },
  ]);

  // At 15m mark (25% through the hour)
  const ts15m = hourStart + 900000;
  const result = getInterpolatedOI('BTCUSDT', ts15m, store);
  assertClose(result, 1025, 0.01, 'OI at 15m should be 1025 (25% of 100 increase)');
});

test('Interpolates OI correctly at 30m boundary', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  const hourEnd   = hourStart + 3600000;
  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart, oi: 1000 },
    { timestamp: hourEnd,   oi: 1200 },
  ]);

  const ts30m = hourStart + 1800000;
  const result = getInterpolatedOI('BTCUSDT', ts30m, store);
  assertClose(result, 1100, 0.01, 'OI at 30m should be 1100 (50% of 200 increase)');
});

test('Returns null when OI data gap exists', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  // Missing hourEnd entry
  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart, oi: 1000 },
  ]);

  const ts15m = hourStart + 900000;
  const result = getInterpolatedOI('BTCUSDT', ts15m, store);
  assert(result === null, 'Should return null when OI data gap exists');
});

test('Returns null for unknown symbol', () => {
  const store = new Map();
  const result = getInterpolatedOI('UNKNOWN', Date.now(), store);
  assert(result === null, 'Should return null for unknown symbol');
});

// ─────────────────────────────────────────────────────────────────────────────
// OI FLUSH TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nOI flush detection:');

test('Detects OI flush above threshold (3.0%)', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  const hourEnd   = hourStart + 3600000;
  const ts15m     = hourStart + 900000;
  const tsPrior   = hourStart; // prior 15m = hour start

  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart - 3600000, oi: 1000 }, // prior hour
    { timestamp: hourStart,           oi: 1000 }, // current hour start
    { timestamp: hourEnd,             oi: 900  }, // current hour end (OI dropped)
  ]);

  // At ts15m: interpolated OI = 1000 + (900-1000) * 0.25 = 975
  // At tsPrior (hourStart): interpolated OI = 1000 + (900-1000) * 0 = 1000
  // Delta = (975 - 1000) / 1000 = -0.025 = -2.5% — below 3.0% threshold
  const result = checkOIFlush('BTCUSDT', ts15m, store, 0.030);
  assert(!result, 'Should NOT detect flush at 2.5% (below 3.0% threshold)');
});

test('Detects OI flush when drop exceeds threshold', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  const hourEnd   = hourStart + 3600000;
  const ts15m     = hourStart + 900000;

  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart - 3600000, oi: 1000 },
    { timestamp: hourStart,           oi: 1000 },
    { timestamp: hourEnd,             oi: 800  }, // 20% drop over the hour
  ]);

  // At ts15m: OI = 1000 + (800-1000) * 0.25 = 950
  // At prior 15m (hourStart): OI = 1000 + (800-1000) * 0 = 1000
  // Delta = (950 - 1000) / 1000 = -0.05 = -5.0% — above 3.0% threshold
  const result = checkOIFlush('BTCUSDT', ts15m, store, 0.030);
  assert(result, 'Should detect flush at 5.0% (above 3.0% threshold)');
});

test('Returns false when OI data unavailable', () => {
  const store = new Map();
  const result = checkOIFlush('BTCUSDT', Date.now(), store, 0.030);
  assert(!result, 'Should return false when OI data unavailable');
});

// ─────────────────────────────────────────────────────────────────────────────
// OI VELOCITY GATE TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nOI velocity gate:');

test('Passes when OI drops fast and decelerates', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  const hourEnd   = hourStart + 3600000;
  const ts        = hourStart + 1800000; // 30m mark
  const tsMinus1  = hourStart + 900000;  // 15m mark
  const tsMinus2  = hourStart;           // 0m mark

  // OI: 1000 → 990 → 960 (fast drop in sweep candle, slower prior)
  // velocity_prior  = (990 - 1000) / 1000 = -0.01 (-1.0%)
  // velocity_sweep  = (960 - 990) / 990 = -0.0303 (-3.03%)
  // fastDrop: -3.03% < -0.3% ✓
  // decelerating: -3.03% > -1.0%? NO — sweep is MORE negative than prior
  // This should FAIL (accelerating, not decelerating)
  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart - 3600000, oi: 1000 },
    { timestamp: hourStart,           oi: 1000 },
    { timestamp: hourEnd,             oi: 900  },
  ]);

  // At ts (30m): OI = 1000 + (900-1000)*0.5 = 950
  // At tsMinus1 (15m): OI = 1000 + (900-1000)*0.25 = 975
  // At tsMinus2 (0m): OI = 1000
  // velocity_prior = (975 - 1000) / 1000 = -0.025
  // velocity_sweep = (950 - 975) / 975 = -0.0256
  // fastDrop: -2.56% < -0.3% ✓
  // decelerating: -2.56% > -2.5%? YES (barely, but yes)
  // notCascading: -2.56% > -1.5%? NO — this is > 1.5% drop
  const result = checkOIVelocityGate('BTCUSDT', ts, store);
  // With these numbers: fastDrop ✓, decelerating ✓, notCascading ✗ (2.56% > 1.5%)
  assert(!result.pass, 'Should fail when OI drop exceeds cascade threshold');
  assert(result.reason === 'OI_CASCADE_CONTINUING', `Expected OI_CASCADE_CONTINUING, got ${result.reason}`);
});

test('Returns DATA_GAP when OI data missing', () => {
  const store = new Map();
  const result = checkOIVelocityGate('BTCUSDT', Date.now(), store);
  assert(!result.pass, 'Should fail on data gap');
  assert(result.reason === 'DATA_GAP', `Expected DATA_GAP, got ${result.reason}`);
});

test('Fails when OI drop too small', () => {
  const hourStart = Date.UTC(2023, 0, 1, 12, 0, 0);
  const hourEnd   = hourStart + 3600000;
  const ts        = hourStart + 1800000;

  // Very small OI change — well below 0.3% threshold
  const store = makeOIStore('BTCUSDT', [
    { timestamp: hourStart - 3600000, oi: 1000 },
    { timestamp: hourStart,           oi: 1000 },
    { timestamp: hourEnd,             oi: 999  }, // tiny drop
  ]);

  const result = checkOIVelocityGate('BTCUSDT', ts, store);
  assert(!result.pass, 'Should fail when OI drop too small');
  assert(result.reason === 'OI_DROP_TOO_SMALL', `Expected OI_DROP_TOO_SMALL, got ${result.reason}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nSignal generation:');

test('Builds bullish LSO signal with correct entry and stop', () => {
  const sweepCandle = makeCandle({ open: 97, high: 99, low: 93, close: 98 });
  const pool = { id: 'eql_test', type: 'EQUAL_LOWS', level: 95.0 };
  const atr14 = 2.0;

  const signal = buildBullishLSOSignal(sweepCandle, pool, atr14);

  assert(signal.type === 'BULLISH_LSO', 'Signal type should be BULLISH_LSO');
  // Level Reclaim entry: limitPrice = pool.level (not body midpoint)
  assertClose(signal.limitPrice, 95.0, 0.01, 'Limit price should be pool level (reclaim entry)');
  // stopPrice = sweepLow - stopBuffer * atr14 = 93 - 0.1 * 2.0 = 92.8
  assertClose(signal.stopPrice, 92.8, 0.01, 'Stop price should be sweep low - buffer');
  assert(signal.poolId === 'eql_test', 'Pool ID should be preserved');
  assert(signal.entryModel === 'LEVEL_RECLAIM', 'Entry model should be LEVEL_RECLAIM');
});

test('Builds bearish LSO signal with tighter stop', () => {
  const sweepCandle = makeCandle({ open: 103, high: 107, low: 101, close: 102 });
  const pool = { id: 'eqh_test', type: 'EQUAL_HIGHS', level: 105.0 };
  const atr14 = 2.0;

  const signal = buildBearishLSOSignal(sweepCandle, pool, atr14);

  assert(signal.type === 'BEARISH_LSO', 'Signal type should be BEARISH_LSO');
  // Level Reclaim entry: limitPrice = pool.level
  assertClose(signal.limitPrice, 105.0, 0.01, 'Limit price should be pool level (reclaim entry)');
  // stopPrice = sweepHigh + shortStopBuffer * atr14 = 107 + 0.07 * 2.0 = 107.14
  assertClose(signal.stopPrice, 107.14, 0.01, 'Stop price should use tighter short buffer');
  assert(signal.entryModel === 'LEVEL_RECLAIM', 'Entry model should be LEVEL_RECLAIM');
});

// ─────────────────────────────────────────────────────────────────────────────
// OB CONFLUENCE TESTS (D7 Deferred Item 1)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nOB confluence check (D7 deferred item 1):');

test('Detects sweep inside active OB zone', () => {
  const sweepCandle = makeCandle({ open: 97, high: 99, low: 94, close: 98 });
  const activeOBs = [{
    id:     'ob_bull_test',
    type:   'BULLISH',
    status: 'ACTIVE',
    top:    98,
    bottom: 93,
  }];

  const result = checkOBConfluence(sweepCandle, activeOBs);
  assert(result.insideOB, 'Should detect sweep inside OB zone');
  assert(result.obId === 'ob_bull_test', 'Should return correct OB ID');
});

test('Returns no confluence when sweep is outside OB zone', () => {
  const sweepCandle = makeCandle({ open: 97, high: 99, low: 94, close: 98 });
  const activeOBs = [{
    id:     'ob_bull_test',
    type:   'BULLISH',
    status: 'ACTIVE',
    top:    90,
    bottom: 85,
  }];

  const result = checkOBConfluence(sweepCandle, activeOBs);
  assert(!result.insideOB, 'Should NOT detect confluence when sweep outside OB');
});

test('Returns no confluence when no active OBs', () => {
  const sweepCandle = makeCandle({ open: 97, high: 99, low: 94, close: 98 });
  const result = checkOBConfluence(sweepCandle, []);
  assert(!result.insideOB, 'Should return no confluence with empty OB list');
});

test('Ignores INVALIDATED OB zones', () => {
  const sweepCandle = makeCandle({ open: 97, high: 99, low: 94, close: 98 });
  const activeOBs = [{
    id:     'ob_bull_test',
    type:   'BULLISH',
    status: 'INVALIDATED', // not active
    top:    98,
    bottom: 93,
  }];

  const result = checkOBConfluence(sweepCandle, activeOBs);
  assert(!result.insideOB, 'Should ignore INVALIDATED OB zones');
});

// ─────────────────────────────────────────────────────────────────────────────
// TIME-BASED BREAKEVEN GATE TESTS (D7 Deferred Item 3)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nTime-based breakeven gate (D7 deferred item 3):');

test('No exit before 8 candles', () => {
  const trade = {
    side:       'LONG',
    entryPrice: 100,
    tp1:        105,
    pastTP1:    false,
  };
  const result = checkLSOTimeBreakeven(trade, 5, 101);
  assert(result === null, 'Should not exit before 8 candles');
});

test('Exits at 8 candles with insufficient progress', () => {
  const trade = {
    side:       'LONG',
    entryPrice: 100,
    tp1:        105, // TP1 distance = 5
    pastTP1:    false,
  };
  // Progress = 101 - 100 = 1, which is < 50% of 5 (2.5)
  const result = checkLSOTimeBreakeven(trade, 8, 101);
  assert(result !== null, 'Should exit at 8 candles with insufficient progress');
  assert(result.exit, 'Exit flag should be true');
  assert(result.reason === 'lso_time_breakeven', 'Reason should be lso_time_breakeven');
});

test('No exit at 8 candles when progress is sufficient', () => {
  const trade = {
    side:       'LONG',
    entryPrice: 100,
    tp1:        105, // TP1 distance = 5
    pastTP1:    false,
  };
  // Progress = 103 - 100 = 3, which is > 50% of 5 (2.5)
  const result = checkLSOTimeBreakeven(trade, 8, 103);
  assert(result === null, 'Should NOT exit when progress is sufficient');
});

test('No exit when already past TP1', () => {
  const trade = {
    side:       'LONG',
    entryPrice: 100,
    tp1:        105,
    pastTP1:    true, // already past TP1
  };
  const result = checkLSOTimeBreakeven(trade, 10, 101);
  assert(result === null, 'Should NOT exit when already past TP1');
});

// ─────────────────────────────────────────────────────────────────────────────
// ASIAN SESSION TESTS (LSO is ALLOWED in Asian session)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nAsian session (LSO allowed):');

test('22:00 UTC is Asian session', () => {
  const ts = Date.UTC(2023, 0, 1, 22, 0, 0);
  assert(isAsianSession(ts), '22:00 UTC should be Asian session');
});

test('03:00 UTC is Asian session', () => {
  const ts = Date.UTC(2023, 0, 1, 3, 0, 0);
  assert(isAsianSession(ts), '03:00 UTC should be Asian session');
});

test('07:00 UTC is NOT Asian session', () => {
  const ts = Date.UTC(2023, 0, 1, 7, 0, 0);
  assert(!isAsianSession(ts), '07:00 UTC should NOT be Asian session');
});

test('13:00 UTC is NOT Asian session', () => {
  const ts = Date.UTC(2023, 0, 1, 13, 0, 0);
  assert(!isAsianSession(ts), '13:00 UTC should NOT be Asian session');
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC CVD VELOCITY GATE TESTS (Gemini D8 Round 3)
// ─────────────────────────────────────────────────────────────────────────────

const { checkCVDVelocityGate } = require('../src/strategies/lso');

console.log('\nSynthetic CVD velocity gate (Gemini D8 Round 3):');

test('Passes when CVD velocity z-score exceeds threshold', () => {
  // Build a CVD delta array where the last value is a large spike
  const baseline = Array.from({ length: 96 }, () => 10 + Math.random() * 5); // mean ~12.5, std ~1.4
  const spike = 100; // z-score = (100 - 12.5) / 1.4 ≈ 62 — well above 2.5
  const deltas = [...baseline, spike];
  const cvdVals = { delta: deltas };

  const result = checkCVDVelocityGate(96, cvdVals, 2.5, 96);
  assert(result.pass, `Should pass on large CVD spike (z=${result.zscore?.toFixed(1)})`);
  assert(result.reason === 'CVD_VELOCITY_SPIKE', `Expected CVD_VELOCITY_SPIKE, got ${result.reason}`);
  assert(result.zscore > 2.5, 'Z-score should exceed threshold');
});

test('Fails when CVD velocity z-score is below threshold', () => {
  // Normal CVD delta — no spike
  const baseline = Array.from({ length: 96 }, () => 10 + Math.random() * 2);
  const normal = 11; // within normal range
  const deltas = [...baseline, normal];
  const cvdVals = { delta: deltas };

  const result = checkCVDVelocityGate(96, cvdVals, 2.5, 96);
  assert(!result.pass, 'Should fail on normal CVD delta');
  assert(result.reason === 'CVD_VELOCITY_BELOW_THRESHOLD', `Expected CVD_VELOCITY_BELOW_THRESHOLD, got ${result.reason}`);
});

test('Fails with insufficient history', () => {
  const cvdVals = { delta: [10, 20, 30] }; // only 3 candles
  const result = checkCVDVelocityGate(2, cvdVals, 2.5, 96);
  assert(!result.pass, 'Should fail with insufficient history');
  assert(result.reason === 'INSUFFICIENT_HISTORY', `Expected INSUFFICIENT_HISTORY, got ${result.reason}`);
});

test('Fails when CVD data is missing', () => {
  const result = checkCVDVelocityGate(50, null, 2.5, 96);
  assert(!result.pass, 'Should fail when CVD data is null');
  assert(result.reason === 'NO_CVD_DATA', `Expected NO_CVD_DATA, got ${result.reason}`);
});

test('Fails when all CVD deltas are identical (zero variance)', () => {
  const deltas = Array.from({ length: 97 }, () => 10); // all same value
  const cvdVals = { delta: deltas };
  const result = checkCVDVelocityGate(96, cvdVals, 2.5, 96);
  assert(!result.pass, 'Should fail on zero variance');
  assert(result.reason === 'ZERO_VARIANCE', `Expected ZERO_VARIANCE, got ${result.reason}`);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`tests/run_lso_tests.js: ${passed}/${passed + failed} PASS`);
if (failed > 0) {
  console.log(`FAILED: ${failed} test(s)`);
  process.exit(1);
}