'use strict';

/**
 * BulletBrain v3.0 — OB Strategy Unit Tests
 * Phase D7 — Step 2.1
 *
 * Usage: node tests/run_ob_tests.js
 */

const {
  detectBullishOBs,
  detectBearishOBs,
  updateOBStatus,
  isOBTradeable,
  checkOBEntry,
  isAsianSession,
} = require('../src/strategies/ob');

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

function makeCandle(open, high, low, close, volume = 1000, openTime = 0) {
  return { openTime, open, high, low, close, volume };
}

// ── Asian Session ─────────────────────────────────────────────────────────────
console.log('\n── Asian Session Gate ──');

test('22:00 UTC is Asian session', () => {
  assert(isAsianSession(new Date('2023-01-01T22:00:00Z').getTime()) === true);
});

test('03:00 UTC is Asian session', () => {
  assert(isAsianSession(new Date('2023-01-01T03:00:00Z').getTime()) === true);
});

test('07:00 UTC is NOT Asian session', () => {
  assert(isAsianSession(new Date('2023-01-01T07:00:00Z').getTime()) === false);
});

test('13:00 UTC is NOT Asian session', () => {
  assert(isAsianSession(new Date('2023-01-01T13:00:00Z').getTime()) === false);
});

// ── detectBullishOBs ──────────────────────────────────────────────────────────
console.log('\n── Bullish OB Detection ──');

// Valid bullish OB scenario:
// candle[0]: bearish (close < open), candle[1]: significant bullish move
function makeBullishOBCandles() {
  const atr14    = [2, 2, 2, 2];
  const rvolVals = [1.0, 2.5, 1.0, 1.0]; // candle[1] has high RVOL
  const candles  = [
    makeCandle(105, 106, 100, 101, 1000, new Date('2023-01-01T08:00:00Z').getTime()), // bearish OB
    makeCandle(101, 112, 100, 111, 2000, new Date('2023-01-01T09:00:00Z').getTime()), // significant move up: body=10 > 1.5×ATR=3
    makeCandle(110, 114, 109, 112, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
    makeCandle(111, 115, 110, 113, 1000, new Date('2023-01-01T11:00:00Z').getTime()),
  ];
  return { candles, atr14, rvolVals };
}

test('Detects valid bullish OB', () => {
  const { candles, atr14, rvolVals } = makeBullishOBCandles();
  const obs = detectBullishOBs(candles, atr14, rvolVals);
  assert(obs.length >= 1, `Expected at least 1 OB, got ${obs.length}`);
  assert(obs[0].type === 'BULLISH');
  assertClose(obs[0].top,    106, 0.01, 'OB top should be bearish candle high = 106');
  assertClose(obs[0].bottom, 100, 0.01, 'OB bottom should be bearish candle low = 100');
  assertClose(obs[0].mid,    103, 0.01, 'OB mid should be 103');
});

test('Rejects OB when OB candle is not bearish', () => {
  const atr14    = [2, 2, 2];
  const rvolVals = [1.0, 2.5, 1.0];
  const candles  = [
    makeCandle(100, 106, 99, 105, 1000, new Date('2023-01-01T08:00:00Z').getTime()), // bullish — not a valid OB candle
    makeCandle(105, 115, 104, 114, 2000, new Date('2023-01-01T09:00:00Z').getTime()),
    makeCandle(113, 116, 112, 115, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
  ];
  const obs = detectBullishOBs(candles, atr14, rvolVals);
  assert(obs.length === 0, 'Should reject when OB candle is not bearish');
});

test('Rejects OB when move candle body is insufficient', () => {
  const atr14    = [2, 10, 2]; // large ATR on move candle — body won't pass
  const rvolVals = [1.0, 2.5, 1.0];
  const candles  = [
    makeCandle(105, 106, 100, 101, 1000, new Date('2023-01-01T08:00:00Z').getTime()), // bearish
    makeCandle(101, 104, 100, 103, 2000, new Date('2023-01-01T09:00:00Z').getTime()), // body=2, ATR=10 → 2 < 1.5×10=15 → fails
    makeCandle(102, 105, 101, 104, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
  ];
  const obs = detectBullishOBs(candles, atr14, rvolVals);
  assert(obs.length === 0, 'Should reject when move body < moveMultiplier × ATR');
});

test('Rejects OB when move candle RVOL is insufficient', () => {
  const atr14    = [2, 2, 2];
  const rvolVals = [1.0, 1.5, 1.0]; // RVOL 1.5 < threshold 2.0
  const candles  = [
    makeCandle(105, 106, 100, 101, 1000, new Date('2023-01-01T08:00:00Z').getTime()),
    makeCandle(101, 112, 100, 111, 1000, new Date('2023-01-01T09:00:00Z').getTime(), 1.5),
    makeCandle(110, 114, 109, 112, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
  ];
  const obs = detectBullishOBs(candles, atr14, rvolVals);
  assert(obs.length === 0, 'Should reject when move RVOL < rvolThreshold');
});

test('Rejects OB when move candle is not bullish', () => {
  const atr14    = [2, 2, 2];
  const rvolVals = [1.0, 2.5, 1.0];
  const candles  = [
    makeCandle(105, 106, 100, 101, 1000, new Date('2023-01-01T08:00:00Z').getTime()), // bearish OB
    makeCandle(101, 112, 100,  95, 2000, new Date('2023-01-01T09:00:00Z').getTime()), // bearish move — not valid
    makeCandle(96,  98,  94,  97, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
  ];
  const obs = detectBullishOBs(candles, atr14, rvolVals);
  assert(obs.length === 0, 'Should reject when move candle is not bullish');
});

// ── detectBearishOBs ──────────────────────────────────────────────────────────
console.log('\n── Bearish OB Detection ──');

test('Detects valid bearish OB', () => {
  const atr14    = [2, 2, 2, 2];
  const rvolVals = [1.0, 2.5, 1.0, 1.0];
  const candles  = [
    makeCandle(100, 106, 99, 105, 1000, new Date('2023-01-01T08:00:00Z').getTime()), // bullish OB candle
    makeCandle(105,  106, 94,  95, 2000, new Date('2023-01-01T09:00:00Z').getTime()), // significant move down: body=10 > 1.5×2=3
    makeCandle(96,   98,  93,  94, 1000, new Date('2023-01-01T10:00:00Z').getTime()),
    makeCandle(95,   97,  92,  93, 1000, new Date('2023-01-01T11:00:00Z').getTime()),
  ];
  const obs = detectBearishOBs(candles, atr14, rvolVals);
  assert(obs.length >= 1, `Expected at least 1 bearish OB, got ${obs.length}`);
  assert(obs[0].type === 'BEARISH');
  assertClose(obs[0].top,    106, 0.01, 'Bearish OB top should be bullish candle high = 106');
  assertClose(obs[0].bottom,  99, 0.01, 'Bearish OB bottom should be bullish candle low = 99');
});

// ── OB State Management ───────────────────────────────────────────────────────
console.log('\n── OB State Management ──');

function makeOB(overrides = {}) {
  return {
    id: 'test_ob',
    type: 'BULLISH',
    top: 106,
    bottom: 100,
    mid: 103,
    formed_at: 0,
    expires_at: 48,
    status: 'ACTIVE',
    contested_touches: 0,
    atr_at_formation: 2,
    ...overrides,
  };
}

test('OB expires at expires_at candle', () => {
  const ob = makeOB();
  updateOBStatus(ob, makeCandle(108, 110, 107, 109), 48);
  assert(ob.status === 'EXPIRED', `Expected EXPIRED, got ${ob.status}`);
});

test('Bullish OB invalidated when price closes below bottom', () => {
  const ob = makeOB();
  updateOBStatus(ob, makeCandle(102, 104, 98, 99), 10); // close=99 < bottom=100
  assert(ob.status === 'INVALIDATED', `Expected INVALIDATED, got ${ob.status}`);
});

test('Bearish OB invalidated when price closes above top', () => {
  const ob = makeOB({ type: 'BEARISH', top: 106, bottom: 100 });
  updateOBStatus(ob, makeCandle(104, 108, 103, 107), 10); // close=107 > top=106
  assert(ob.status === 'INVALIDATED', `Expected INVALIDATED, got ${ob.status}`);
});

test('isOBTradeable: ACTIVE is tradeable', () => {
  assert(isOBTradeable(makeOB({ status: 'ACTIVE' })) === true);
});

test('isOBTradeable: EXPIRED is not tradeable', () => {
  assert(isOBTradeable(makeOB({ status: 'EXPIRED' })) === false);
});

test('isOBTradeable: INVALIDATED is not tradeable', () => {
  assert(isOBTradeable(makeOB({ status: 'INVALIDATED' })) === false);
});

// ── checkOBEntry ──────────────────────────────────────────────────────────────
console.log('\n── OB Entry Signal ──');

test('Generates bullish entry signal when price reaches OB top', () => {
  const ob     = makeOB(); // top=106, bottom=100
  const candle = makeCandle(108, 109, 105, 107, 1000, new Date('2023-01-01T09:00:00Z').getTime()); // low=105 <= top=106
  const signal = checkOBEntry(ob, candle);
  assert(signal !== null, 'Should generate signal');
  assert(signal.type === 'BULLISH_OB');
  assertClose(signal.limitPrice, 106, 0.01, 'Limit price should be OB top = 106');
  // stop = bottom - stopBuffer × ATR = 100 - 0.1×2 = 99.8
  assertClose(signal.stopPrice, 99.8, 0.01, 'Stop should be below OB bottom');
});

test('No signal when price does not reach OB top', () => {
  const ob     = makeOB(); // top=106
  const candle = makeCandle(110, 112, 107, 111, 1000, new Date('2023-01-01T09:00:00Z').getTime()); // low=107 > top=106
  const signal = checkOBEntry(ob, candle);
  assert(signal === null, 'Should not generate signal when price above OB top');
});

test('No signal when close is below OB bottom (invalidation candle)', () => {
  const ob     = makeOB(); // bottom=100
  const candle = makeCandle(104, 106, 98, 99, 1000, new Date('2023-01-01T09:00:00Z').getTime()); // close=99 < bottom=100
  const signal = checkOBEntry(ob, candle);
  assert(signal === null, 'Should not generate signal when close below OB bottom');
});

test('No signal for expired OB', () => {
  const ob     = makeOB({ status: 'EXPIRED' });
  const candle = makeCandle(108, 109, 105, 107, 1000, new Date('2023-01-01T09:00:00Z').getTime());
  const signal = checkOBEntry(ob, candle);
  assert(signal === null, 'Should not generate signal for expired OB');
});

test('No signal for invalidated OB', () => {
  const ob     = makeOB({ status: 'INVALIDATED' });
  const candle = makeCandle(108, 109, 105, 107, 1000, new Date('2023-01-01T09:00:00Z').getTime());
  const signal = checkOBEntry(ob, candle);
  assert(signal === null, 'Should not generate signal for invalidated OB');
});

test('No entry signal during Asian session', () => {
  const ob          = makeOB();
  const asianCandle = makeCandle(108, 109, 105, 107, 1000, new Date('2023-01-01T03:00:00Z').getTime());
  const signal      = checkOBEntry(ob, asianCandle);
  assert(signal === null, 'Entry should be blocked during Asian session');
});

test('Entry signal allowed during London open', () => {
  const ob           = makeOB();
  const londonCandle = makeCandle(108, 109, 105, 107, 1000, new Date('2023-01-01T08:00:00Z').getTime());
  const signal       = checkOBEntry(ob, londonCandle);
  assert(signal !== null, 'Entry should be allowed during London open');
});

test('Generates bearish entry signal when price reaches OB bottom', () => {
  const ob     = makeOB({ type: 'BEARISH', top: 106, bottom: 100, mid: 103 });
  const candle = makeCandle(98, 101, 97, 99, 1000, new Date('2023-01-01T09:00:00Z').getTime()); // high=101 >= bottom=100
  const signal = checkOBEntry(ob, candle);
  assert(signal !== null, 'Should generate bearish signal');
  assert(signal.type === 'BEARISH_OB');
  assertClose(signal.limitPrice, 100, 0.01, 'Limit price should be OB bottom = 100');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + passed + '/' + (passed + failed) + ' OB tests passed');
if (failed > 0) {
  console.log(failed + ' FAILED');
  process.exit(1);
} else {
  console.log('Phase D7 OB strategy: ALL PASS');
}
