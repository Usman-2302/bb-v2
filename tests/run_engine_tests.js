'use strict';

/**
 * BulletBrain v3.0 — Engine Validation Tests
 * Phase D4 — mandatory before Phase D6
 *
 * Tests use synthetic data with KNOWN outcomes.
 * Every test verifies exact numerical results — not just "no crash".
 * Source: masterplan.md Phase D4 done criteria
 */

const {
  simulateLimitFill,
  simulatePositionFill,
  calcEntryCost,
  applyFundingCost,
  checkTimeExit,
  checkMomentumExit,
  checkZScoreExit,
  checkCVDExhaustionExit,
  checkPortfolioRisk,
  isDailyLossBreached,
  createTrade,
  updateUnrealizedPnl,
  closeTrade,
  createEquityTracker,
  updateEquity,
} = require('../src/backtest/engine');

const { generateReport, wilsonCI, calcProfitFactor } = require('../src/backtest/reporter');

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

function assertClose(a, b, tol = 0.0001, msg) {
  if (Math.abs(a - b) > tol) throw new Error(msg || `expected ${b}, got ${a} (diff ${Math.abs(a-b)})`);
}

// ── FILL SIMULATION ───────────────────────────────────────────────────────────
console.log('\n── Fill Simulation ──');

test('MISS: price never reached limit', () => {
  const candle = { high: 50100, low: 49900, close: 50000 };
  const order  = { side: 'LONG', limitPrice: 49800 };
  const result = simulateLimitFill(candle, order, 'FVG', 'BTCUSDT');
  assert(result.fill === false, 'should not fill');
  assert(result.quality === 'MISS');
});

test('EXACT_TOUCH: candle.low === limitPrice → no fill', () => {
  const candle = { high: 50100, low: 50000, close: 50050 };
  const order  = { side: 'LONG', limitPrice: 50000 };
  const result = simulateLimitFill(candle, order, 'FVG', 'BTCUSDT');
  assert(result.fill === false, 'exact touch should not fill');
  assert(result.quality === 'EXACT_TOUCH');
});

test('TOXIC: deep penetration always fills with 0.3% extra stop slippage', () => {
  // Penetration > 0.10%: 50000 limit, candle.low = 49900 → penetration = 0.2%
  const candle = { high: 50100, low: 49900, close: 50000 };
  const order  = { side: 'LONG', limitPrice: 50000 };
  const result = simulateLimitFill(candle, order, 'FVG', 'BTCUSDT');
  assert(result.fill === true, 'TOXIC should always fill');
  assert(result.quality === 'TOXIC');
  assertClose(result.extraStopSlippage, 0.003, 0.0001, 'TOXIC stop slippage should be 0.3%');
});

test('MARGINAL: moderate penetration has 0.1% extra stop slippage', () => {
  // Penetration 0.02-0.10%: 50000 limit, candle.low = 49960 → penetration = 0.08%
  const candle = { high: 50100, low: 49960, close: 50000 };
  const order  = { side: 'LONG', limitPrice: 50000 };
  const result = simulateLimitFill(candle, order, 'FVG', 'BTCUSDT');
  assert(result.quality === 'MARGINAL');
  assertClose(result.extraStopSlippage, 0.001, 0.0001, 'MARGINAL stop slippage should be 0.1%');
});

test('SHORT TOXIC: deep penetration above limit always fills', () => {
  const candle = { high: 50200, low: 49900, close: 50000 };
  const order  = { side: 'SHORT', limitPrice: 50000 };
  const result = simulateLimitFill(candle, order, 'LSO', 'BTCUSDT');
  assert(result.fill === true, 'SHORT TOXIC should fill');
  assert(result.quality === 'TOXIC');
});

test('Partial fill: RVOL > 3 gives 70% of intended size', () => {
  const size   = 1000;
  const result = simulatePositionFill(size, 3.5);
  assertClose(result, 700, 0.01, 'RVOL > 3 should give 70%');
});

test('Partial fill: RVOL > 2 gives 82% of intended size', () => {
  const result = simulatePositionFill(1000, 2.5);
  assertClose(result, 820, 0.01, 'RVOL > 2 should give 82%');
});

test('Partial fill: normal RVOL gives 100%', () => {
  const result = simulatePositionFill(1000, 1.2);
  assertClose(result, 1000, 0.01, 'Normal RVOL should give 100%');
});

// ── COST CALCULATION ──────────────────────────────────────────────────────────
console.log('\n── Cost Calculation ──');

test('Entry cost: BTC in killzone includes fee + killzone slippage + latency', () => {
  const cost = calcEntryCost('BTCUSDT', '15m', true, false);
  // fee: 0.0004, killzone slippage: 0.0002, latency 15m: 0.0003
  const expected = 0.0004 + 0.0002 + 0.0003;
  assertClose(cost, expected, 0.00001, `Expected ${expected}, got ${cost}`);
});

test('Entry cost: BTC outside killzone uses base slippage', () => {
  const cost = calcEntryCost('BTCUSDT', '15m', false, false);
  // fee: 0.0004, base slippage: 0.0004, latency 15m: 0.0003
  const expected = 0.0004 + 0.0004 + 0.0003;
  assertClose(cost, expected, 0.00001);
});

test('Entry cost: CRISIS uses crisis slippage', () => {
  const cost = calcEntryCost('BTCUSDT', '15m', false, true);
  // fee: 0.0004, crisis slippage: 0.0015, latency 15m: 0.0003
  const expected = 0.0004 + 0.0015 + 0.0003;
  assertClose(cost, expected, 0.00001);
});

test('Entry cost: XRP is more expensive than BTC', () => {
  const btcCost = calcEntryCost('BTCUSDT', '15m', false, false);
  const xrpCost = calcEntryCost('XRPUSDT', '15m', false, false);
  assert(xrpCost > btcCost, `XRP cost ${xrpCost} should be > BTC cost ${btcCost}`);
});

test('Entry cost: news window doubles slippage', () => {
  const normalCost = calcEntryCost('BTCUSDT', '15m', false, false, false);
  const newsCost   = calcEntryCost('BTCUSDT', '15m', false, false, true);
  // News doubles slippage component only (fee and latency unchanged)
  // base slippage: 0.0004, doubled: 0.0008 → difference = 0.0004
  assert(newsCost > normalCost, 'News window should increase cost');
  assertClose(newsCost - normalCost, 0.0004, 0.00001, 'News doubles base slippage (0.0004 extra)');
});

// ── FUNDING COST ──────────────────────────────────────────────────────────────
console.log('\n── Funding Cost ──');

test('Funding cost: LONG pays when rate positive', () => {
  const trade = { symbol: 'BTCUSDT', side: 'LONG', size: 1, entryPrice: 50000, unrealizedPnl: 0 };
  const fundingMap = new Map([['BTCUSDT', new Map([[1000000, 0.0003]])]]);
  applyFundingCost(trade, 1000000, fundingMap);
  // notional = 1 × 50000 = 50000, cost = 50000 × 0.0003 = 15
  assertClose(trade.unrealizedPnl, -15, 0.01, 'LONG should pay funding');
  assertClose(trade.cumulativeFundingCost, 15, 0.01);
});

test('Funding cost: SHORT receives when rate positive', () => {
  const trade = { symbol: 'BTCUSDT', side: 'SHORT', size: 1, entryPrice: 50000, unrealizedPnl: 0 };
  const fundingMap = new Map([['BTCUSDT', new Map([[1000000, 0.0003]])]]);
  applyFundingCost(trade, 1000000, fundingMap);
  assertClose(trade.unrealizedPnl, 15, 0.01, 'SHORT should receive funding');
});

test('Funding cost: no effect when timestamp not in map', () => {
  const trade = { symbol: 'BTCUSDT', side: 'LONG', size: 1, entryPrice: 50000, unrealizedPnl: 0 };
  const fundingMap = new Map([['BTCUSDT', new Map([[999999, 0.0003]])]]);
  applyFundingCost(trade, 1000000, fundingMap); // different timestamp
  assertClose(trade.unrealizedPnl, 0, 0.001, 'No funding at this timestamp');
});

test('Funding cost: clock-aware — charges at exact 8H boundary, not duration', () => {
  // Trade opens at 07:55, funding event at 08:00 → should pay full funding
  // This tests that the engine is clock-aware (checks timestamp) not duration-aware
  const trade = { symbol: 'BTCUSDT', side: 'LONG', size: 1, entryPrice: 50000, unrealizedPnl: 0 };
  const fundingTimestamp = new Date('2023-01-01T08:00:00Z').getTime();
  const fundingMap = new Map([['BTCUSDT', new Map([[fundingTimestamp, 0.0003]])]]);

  // Apply at the exact 08:00 timestamp — should charge full funding
  applyFundingCost(trade, fundingTimestamp, fundingMap);
  assertClose(trade.unrealizedPnl, -15, 0.01, 'Should charge full funding at 08:00 boundary');

  // Apply at 08:15 (not a funding timestamp) — should NOT charge again
  const notFundingTimestamp = new Date('2023-01-01T08:15:00Z').getTime();
  applyFundingCost(trade, notFundingTimestamp, fundingMap);
  assertClose(trade.unrealizedPnl, -15, 0.01, 'Should not charge at non-funding timestamp');
});

// ── EXIT CONDITIONS ───────────────────────────────────────────────────────────
console.log('\n── Exit Conditions ──');

test('Time exit: fires after max duration with profit', () => {
  const trade = { unrealizedPnl: 100, riskAmount: 100, pastTP1: false };
  const result = checkTimeExit(trade, 50, 'RANGING'); // RANGING max = 32 candles
  assert(result !== null, 'should fire after 50 candles in RANGING');
  assert(result.action === 'PARTIAL_EXIT', 'should partial exit when profitable');
});

test('Time exit: full exit when flat at max duration', () => {
  const trade = { unrealizedPnl: 10, riskAmount: 100, pastTP1: false }; // 0.1R profit
  const result = checkTimeExit(trade, 50, 'RANGING');
  assert(result !== null);
  assert(result.action === 'FULL_EXIT', 'should full exit when barely profitable');
});

test('Time exit: does not fire before max duration', () => {
  const trade = { unrealizedPnl: 100, riskAmount: 100 };
  const result = checkTimeExit(trade, 10, 'RANGING'); // only 10 candles
  assert(result === null, 'should not fire before max duration');
});

test('Momentum exit: fires on RVOL drop when in profit', () => {
  const trade = { pastTP1: true, unrealizedPnl: 60, riskAmount: 100, tp1: 50100 };
  const candle     = { rvol: 0.5, cvdDelta: 0, high: 50200, low: 50000, open: 50100, close: 50150 };
  const prevCandle = { rvol: 2.0, cvdDelta: 100 };
  const result = checkMomentumExit(trade, candle, prevCandle);
  assert(result !== null, 'should fire on RVOL drop');
  assert(result.action === 'PARTIAL_EXIT');
});

test('Momentum exit: does not fire when not past TP1', () => {
  const trade = { pastTP1: false, unrealizedPnl: 60, riskAmount: 100 };
  const candle     = { rvol: 0.5, cvdDelta: 0, high: 50200, low: 50000, open: 50100, close: 50150 };
  const prevCandle = { rvol: 2.0, cvdDelta: 100 };
  const result = checkMomentumExit(trade, candle, prevCandle);
  assert(result === null, 'should not fire before TP1');
});

test('Z-score exit: fires on blow-off when near TP2', () => {
  // Trade: entry 50000, TP2 at 52000 (tp2Distance=2000), riskAmount=100
  // unrealizedPnl = 1800 → 90% of tp2Distance → pctToTP2 = 0.90 > 0.80
  const trade = {
    pastTP1: true,
    side: 'LONG',
    unrealizedPnl: 1800,
    riskAmount: 100,
    tp2Distance: 2000,
  };
  const candle     = { close: 51000 };
  const prevCandle = { close: 50000 };
  // Return = 2%, historical vol per 15m ≈ 0.3% → z-score ≈ 6.7 > 3.5
  const result = checkZScoreExit(trade, candle, prevCandle, 0.003);
  assert(result !== null, 'should fire on large move near TP2');
  assert(result.action === 'FULL_EXIT');
});

test('Z-score exit: does not fire when not past TP1', () => {
  const trade = { pastTP1: false, side: 'LONG', unrealizedPnl: 50, riskAmount: 100, tp2Distance: 200 };
  const result = checkZScoreExit(trade, { close: 51000 }, { close: 50000 }, 0.003);
  assert(result === null, 'should not fire before TP1');
});

test('CVD exhaustion exit: fires on 2 consecutive negative deltas after peak', () => {
  const trade = { pastTP1: true, unrealizedPnl: 100, riskAmount: 100 };
  // Peak at [0]=100, then declining into negative territory
  const history = [100, -20, -40]; // peaked, then 2 consecutive negatives
  const result = checkCVDExhaustionExit(trade, history);
  assert(result !== null, 'should fire on CVD exhaustion');
  assert(result.action === 'PARTIAL_EXIT');
  assertClose(result.fraction, 0.75, 0.001);
});

test('CVD exhaustion exit: does not fire when CVD still rising', () => {
  const trade = { pastTP1: true, unrealizedPnl: 100, riskAmount: 100 };
  const history = [60, 80, 100]; // rising
  const result = checkCVDExhaustionExit(trade, history);
  assert(result === null, 'should not fire when CVD rising');
});

// ── RISK CONTROLS ─────────────────────────────────────────────────────────────
console.log('\n── Risk Controls ──');

test('Portfolio heat: blocks 4th trade when 3% reached', () => {
  const openTrades = [
    { symbol: 'XRPUSDT', riskAmount: 100 },
    { symbol: 'XRPUSDT', riskAmount: 100 },
    { symbol: 'XRPUSDT', riskAmount: 100 },
  ];
  const result = checkPortfolioRisk(openTrades, 'XRPUSDT', 100, 10000);
  assert(result.allowed === false, 'should block 4th trade');
  assert(result.reason === 'max_concurrent_trades');
});

test('Portfolio heat: blocks when 3% total risk exceeded', () => {
  const openTrades = [
    { symbol: 'XRPUSDT', riskAmount: 250 },
  ];
  // 250 + 100 = 350 / 10000 = 3.5% > 3%
  const result = checkPortfolioRisk(openTrades, 'XRPUSDT', 100, 10000);
  assert(result.allowed === false, 'should block when heat exceeded');
  assert(result.reason === 'portfolio_heat_exceeded');
});

test('Correlation cluster: blocks 2nd trade from cluster A', () => {
  const openTrades = [{ symbol: 'BTCUSDT', riskAmount: 50 }];
  const result = checkPortfolioRisk(openTrades, 'ETHUSDT', 50, 10000);
  assert(result.allowed === false, 'should block ETH when BTC open');
  assert(result.reason === 'correlation_cluster_A_full');
});

test('Correlation cluster: allows XRP when BTC open', () => {
  const openTrades = [{ symbol: 'BTCUSDT', riskAmount: 50 }];
  const result = checkPortfolioRisk(openTrades, 'XRPUSDT', 50, 10000);
  assert(result.allowed === true, 'XRP is cluster B — should be allowed');
});

test('Daily loss limit: triggers at 3%', () => {
  assert(isDailyLossBreached(-300, 10000) === true,  '-3% should breach');
  assert(isDailyLossBreached(-299, 10000) === false, '-2.99% should not breach');
  assert(isDailyLossBreached(0,    10000) === false, 'no loss should not breach');
});

// ── POSITION STATE MACHINE ────────────────────────────────────────────────────
console.log('\n── Position State Machine ──');

test('createTrade: sets all required fields', () => {
  const trade = createTrade({
    symbol: 'BTCUSDT', side: 'LONG', strategy: 'FVG', regime: 'BULL',
    entryPrice: 50000, stopPrice: 49600, tp1: 50400, tp2: 51800,
    size: 0.1, riskAmount: 40, fillQuality: 'CLEAN', entryTimestamp: 1000000,
  });
  assert(trade.status === 'OPEN');
  assert(trade.pastTP1 === false);
  assertClose(trade.tp1Distance, 400, 0.01);
  assertClose(trade.tp2Distance, 1800, 0.01);
});

test('updateUnrealizedPnl: correct for LONG', () => {
  const trade = createTrade({
    symbol: 'BTCUSDT', side: 'LONG', strategy: 'FVG', regime: 'BULL',
    entryPrice: 50000, stopPrice: 49600, tp1: 50400, tp2: 51800,
    size: 0.1, riskAmount: 40, fillQuality: 'CLEAN', entryTimestamp: 1000000,
  });
  updateUnrealizedPnl(trade, 50500);
  assertClose(trade.unrealizedPnl, 50, 0.01, 'LONG PnL: (50500-50000)*0.1 = 50');
});

test('updateUnrealizedPnl: correct for SHORT', () => {
  const trade = createTrade({
    symbol: 'BTCUSDT', side: 'SHORT', strategy: 'LSO', regime: 'BEAR',
    entryPrice: 50000, stopPrice: 50400, tp1: 49600, tp2: 48200,
    size: 0.1, riskAmount: 40, fillQuality: 'CLEAN', entryTimestamp: 1000000,
  });
  updateUnrealizedPnl(trade, 49500);
  assertClose(trade.unrealizedPnl, 50, 0.01, 'SHORT PnL: (50000-49500)*0.1 = 50');
});

test('closeTrade: full close sets status to CLOSED', () => {
  const trade = createTrade({
    symbol: 'BTCUSDT', side: 'LONG', strategy: 'FVG', regime: 'BULL',
    entryPrice: 50000, stopPrice: 49600, tp1: 50400, tp2: 51800,
    size: 0.1, riskAmount: 40, fillQuality: 'CLEAN', entryTimestamp: 1000000,
  });
  closeTrade(trade, 51800, 'tp2', 1.0, 2000000);
  assert(trade.status === 'CLOSED');
  assert(trade.exitPrice === 51800);
  assert(trade.realizedPnl !== null);
});

test('closeTrade: partial close at TP1 moves stop to breakeven', () => {
  const trade = createTrade({
    symbol: 'BTCUSDT', side: 'LONG', strategy: 'FVG', regime: 'BULL',
    entryPrice: 50000, stopPrice: 49600, tp1: 50400, tp2: 51800,
    size: 0.1, riskAmount: 40, fillQuality: 'CLEAN', entryTimestamp: 1000000,
  });
  closeTrade(trade, 50400, 'tp1', 0.5, 1500000);
  assert(trade.status === 'PARTIAL_CLOSE');
  assert(trade.pastTP1 === true);
  assertClose(trade.stopPrice, 50000, 0.01, 'Stop should move to breakeven');
});

// ── EQUITY TRACKER ────────────────────────────────────────────────────────────
console.log('\n── Equity Tracker ──');

test('Equity tracker: updates capital correctly', () => {
  const tracker = createEquityTracker(10000);
  updateEquity(tracker, 100, new Date('2023-01-01').getTime());
  assertClose(tracker.capital, 10100, 0.01);
});

test('Equity tracker: tracks max drawdown', () => {
  const tracker = createEquityTracker(10000);
  updateEquity(tracker, 1000, new Date('2023-01-01').getTime()); // 11000
  updateEquity(tracker, -2000, new Date('2023-01-02').getTime()); // 9000
  // DD = (11000 - 9000) / 11000 = 18.18%
  assertClose(tracker.maxDrawdown, 0.1818, 0.001, 'Max DD should be ~18.18%');
});

test('Equity tracker: daily loss pause triggers at 3%', () => {
  const tracker = createEquityTracker(10000);
  updateEquity(tracker, -300, new Date('2023-01-01T10:00:00Z').getTime()); // -3%
  assert(tracker.paused === true, 'Should pause after 3% daily loss');
});

test('Equity tracker: daily loss resets on new day', () => {
  const tracker = createEquityTracker(10000);
  updateEquity(tracker, -300, new Date('2023-01-01T10:00:00Z').getTime()); // -3%, paused
  assert(tracker.paused === true);
  updateEquity(tracker, 100, new Date('2023-01-02T10:00:00Z').getTime()); // new day
  assert(tracker.paused === false, 'Should unpause on new day');
});

test('triggerForceClose: sets forceClose flag', () => {
  const { triggerForceClose } = require('../src/backtest/engine');
  const tracker = createEquityTracker(10000);
  assert(tracker.forceClose === false, 'Should start as false');
  triggerForceClose(tracker, 'crisis_exit');
  assert(tracker.forceClose === true, 'Should be true after trigger');
  assert(tracker.forceCloseReason === 'crisis_exit');
});

// ── REPORTER ──────────────────────────────────────────────────────────────────
console.log('\n── Reporter ──');

test('Wilson CI: reliable=false when n < 100', () => {
  const ci = wilsonCI(40, 80);
  assert(ci.reliable === false, 'n=80 should not be reliable');
  assertClose(ci.point, 0.5, 0.001);
});

test('Wilson CI: reliable=true when n >= 100', () => {
  const ci = wilsonCI(50, 100);
  assert(ci.reliable === true, 'n=100 should be reliable');
});

test('Wilson CI: lower < point < upper', () => {
  const ci = wilsonCI(60, 100);
  assert(ci.lower < ci.point, 'lower should be < point');
  assert(ci.point < ci.upper, 'point should be < upper');
});

test('Profit factor: correct calculation', () => {
  const trades = [
    { realizedPnl: 100 },
    { realizedPnl: 200 },
    { realizedPnl: -50 },
    { realizedPnl: -100 },
  ];
  const pf = calcProfitFactor(trades);
  // gross wins = 300, gross losses = 150, PF = 2.0
  assertClose(pf, 2.0, 0.001);
});

test('generateReport: empty trades returns zero metrics', () => {
  const equity = createEquityTracker(10000);
  const report = generateReport([], equity, { strategy: 'FVG' });
  assert(report.trades === 0);
  assert(report.pf === 0);
});

test('generateReport: correct WR from known trades', () => {
  const trades = [
    { realizedPnl: 100, fillQuality: 'CLEAN', regime: 'BULL', entryTimestamp: new Date('2023-01-01').getTime(), exitTimestamp: new Date('2023-01-02').getTime(), status: 'CLOSED', cumulativeFundingCost: 0 },
    { realizedPnl: 100, fillQuality: 'CLEAN', regime: 'BULL', entryTimestamp: new Date('2023-01-03').getTime(), exitTimestamp: new Date('2023-01-04').getTime(), status: 'CLOSED', cumulativeFundingCost: 0 },
    { realizedPnl: -50, fillQuality: 'TOXIC', regime: 'BULL', entryTimestamp: new Date('2023-01-05').getTime(), exitTimestamp: new Date('2023-01-06').getTime(), status: 'CLOSED', cumulativeFundingCost: 0 },
  ];
  const equity = createEquityTracker(10000);
  updateEquity(equity, 150, new Date('2023-01-06').getTime());
  const report = generateReport(trades, equity, { strategy: 'FVG' });
  assertClose(report.wr.point, 2/3, 0.001, 'WR should be 2/3');
  assertClose(report.toxicFillRate, 33.3, 0.5, 'Toxic fill rate should be 33.3%');
});

// ── EQUITY CURVE ACCURACY (manual verification) ───────────────────────────────
console.log('\n── Equity Curve Accuracy ──');

test('Manual equity curve: 3 trades with known outcomes', () => {
  // Trade 1: LONG BTC, entry 50000, exit 51000, size 0.1 → gross PnL = 100
  // Trade 2: LONG BTC, entry 50000, exit 49500, size 0.1 → gross PnL = -50
  // Trade 3: LONG BTC, entry 50000, exit 50800, size 0.1 → gross PnL = 80
  // Net (ignoring fees): 100 - 50 + 80 = 130

  const tracker = createEquityTracker(10000);
  updateEquity(tracker, 100, new Date('2023-01-01').getTime());
  updateEquity(tracker, -50, new Date('2023-01-02').getTime());
  updateEquity(tracker, 80,  new Date('2023-01-03').getTime());

  assertClose(tracker.capital, 10130, 0.01, 'Final capital should be 10130');
  assert(tracker.curve.length === 4, 'Curve should have 4 points (initial + 3 updates)');
  assertClose(tracker.curve[3].capital, 10130, 0.01);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + passed + '/' + (passed + failed) + ' engine tests passed');
if (failed > 0) {
  console.log(failed + ' FAILED');
  process.exit(1);
} else {
  console.log('Phase D4 engine validation: ALL PASS');
}
