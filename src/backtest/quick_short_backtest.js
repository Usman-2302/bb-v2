'use strict';
const fs = require('fs');
const lines = fs.readFileSync('data/historical/BTCUSDT_15m_recent.ndjson', 'utf8').trim().split('\n').filter(Boolean);
const candles = lines.map(JSON.parse);

// Tag regimes
const { ema } = require('../indicators/ema');
const { atr: atrFn } = require('../indicators/atr');
const atr14_all = atrFn(candles, 14);
const closes = candles.map(c => c.close);
const ema200_vals = ema(closes, 200);

for (let i = 0; i < candles.length; i++) {
  if (i < 200) { candles[i].regime = 'RANGING'; continue; }
  const priceAbove = candles[i].close > ema200_vals[i];
  const slope10 = (ema200_vals[i] - ema200_vals[Math.max(0,i-10)]) / ema200_vals[Math.max(0,i-10)];
  const atrPct = atr14_all[i] / candles[i].close * 100;
  if (atrPct > 5) candles[i].regime = 'CRISIS';
  else if (slope10 > 0.001 && priceAbove) candles[i].regime = 'BULL';
  else if (slope10 < -0.001 && !priceAbove) candles[i].regime = 'BEAR';
  else candles[i].regime = 'RANGING';
}

// Indicators
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const rvolVals = rvol(candles, '15m', 20);
const cvdVals = cvdFn(candles);

// SHORT-LSO functions
const { isBearishSweep, buildBearishLSOSignal, checkCVDVelocityGate } = require('../strategies/lso');
const { findDOL } = require('../utils/dolFinder');
const { simulateLimitFill, createTrade, closeTrade, createEquityTracker, updateEquity, checkPortfolioRisk } = require('./engine');
const { LSO: LSO_CONFIG, GATES, SIZING, TRADE } = require('../../config');

console.log('=== SHORT-LSO BACKTEST — LAST 30 DAYS ===');
console.log('Candles:', candles.length, '| BTC: $' + candles[0].close.toFixed(0), '→ $' + candles[candles.length-1].close.toFixed(0));

// Pre-detect equal highs pools
const swingLb = LSO_CONFIG.swingLookback || 1;
const swingHighIndices = [];
for (let i = swingLb; i < candles.length - swingLb; i++) {
  const high = candles[i].high;
  let isSwing = true;
  for (let d = 1; d <= swingLb; d++) {
    if (high <= candles[i-d].high || high <= candles[i+d].high) { isSwing = false; break; }
  }
  if (isSwing) swingHighIndices.push(i);
}

const allPools = [];
const seen = new Set();
for (let a = 0; a < swingHighIndices.length; a++) {
  for (let b = a + 1; b < swingHighIndices.length; b++) {
    const si = swingHighIndices[a], sj = swingHighIndices[b];
    if (sj - si > LSO_CONFIG.equalLookback) break;
    if (sj - si < LSO_CONFIG.equalMinGap) continue;
    const highI = candles[si].high, highJ = candles[sj].high;
    if (Math.abs(highI - highJ) / highI >= LSO_CONFIG.equalTolerance) continue;
    let swept = false;
    for (let k = si + 1; k < sj; k++) {
      if (candles[k].high > Math.max(highI, highJ)) { swept = true; break; }
    }
    if (swept) continue;
    const lk = Math.floor((highI + highJ) / 2);
    if (seen.has(lk)) continue;
    seen.add(lk);
    allPools.push({
      id: 'eqh_' + candles[si].openTime + '_' + candles[sj].openTime,
      type: 'EQUAL_HIGHS', level: (highI + highJ) / 2,
      formed_at: sj, expires_at: sj + LSO_CONFIG.equalLookback,
    });
  }
}
allPools.sort((a, b) => a.formed_at - b.formed_at);
console.log('Equal highs pools:', allPools.length);

// Run backtest
const activePools = [];
let poolPtr = 0;
const equity = createEquityTracker(10000);
const openTrades = [];
const closedTrades = [];
let sweepsDetected = 0, blocked = 0;

for (let i = 200; i < candles.length; i++) {
  const candle = candles[i];
  const regime = candle.regime;

  while (poolPtr < allPools.length && allPools[poolPtr].formed_at <= i) {
    activePools.push(allPools[poolPtr++]);
  }
  for (let p = activePools.length - 1; p >= 0; p--) {
    if (activePools[p].expires_at < i) activePools.splice(p, 1);
  }
  if (activePools.length > 20) activePools.splice(0, activePools.length - 20);
  if (activePools.length === 0) continue;

  // Process open trades
  for (let t = openTrades.length - 1; t >= 0; t--) {
    const trade = openTrades[t];
    const stopHit = candle.high >= trade.stopPrice;
    if (stopHit) {
      const closed = closeTrade(trade, trade.stopPrice * 1.003, 'stop', 1.0, candle.openTime, false);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
      continue;
    }
    if (!trade.pastTP1 && candle.low <= trade.tp1) {
      closeTrade(trade, trade.tp1, 'tp1', TRADE.tp1CloseFraction, candle.openTime, false);
    }
    if (candle.low <= trade.tp2) {
      const closed = closeTrade(trade, trade.tp2, 'tp2', 1.0, candle.openTime, false);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
      continue;
    }
    // Time exit in RANGING
    trade.candlesHeld = (trade.candlesHeld || 0) + 1;
    if (trade.candlesHeld > TRADE.maxDurationCandles[regime] && !trade.pastTP1) {
      const closed = closeTrade(trade, candle.close, 'time_exit', 1.0, candle.openTime, false);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
    }
  }

  // Check for bearish sweeps
  for (let p = activePools.length - 1; p >= 0; p--) {
    const pool = activePools[p];
    if (!isBearishSweep(candle, pool)) continue;

    sweepsDetected++;
    activePools.splice(p, 1); // consume pool

    // Gate7: CVD_ZSCORE with regime-adaptive threshold
    const isRanging = regime === 'RANGING' || regime === 'RANGING_ZOMBIE';
    const tier1Threshold = isRanging
      ? Math.max(2.5 * GATES.gate7_range_multiplier, GATES.gate7_range_zscore_floor)
      : 2.5;
    const zr = checkCVDVelocityGate(i, cvdVals, tier1Threshold, LSO_CONFIG.cvdVelocityLookback || 96);
    
    let passedGate = zr.pass;
    if (!passedGate) {
      const tier2Zmin = isRanging ? 1.0 : 1.5;
      const tier2Rvol = isRanging ? 1.5 : 3.0;
      if (zr.zscore != null && zr.zscore >= tier2Zmin && rvolVals[i] > tier2Rvol) {
        passedGate = true;
      }
    }
    
    if (!passedGate) { blocked++; break; }

    const signal = buildBearishLSOSignal(candle, pool, atr14_all[i]);
    const entryPrice = signal.limitPrice;
    const stopPrice = signal.stopPrice;
    const riskDist = Math.abs(entryPrice - stopPrice);
    if (riskDist <= 0) { blocked++; break; }

    const dolResult = findDOL(candles, i, entryPrice, stopPrice, 'SHORT', [], atr14_all);
    if (!dolResult) { blocked++; break; }

    const fillResult = simulateLimitFill(candle, { side: 'SHORT', limitPrice: entryPrice }, 'LSO', 'BTCUSDT', atr14_all[i]);
    if (!fillResult.fill) { blocked++; break; }

    const riskAmount = 10000 * SIZING.baseRisk;
    const rawSize = riskAmount / riskDist;
    const riskCheck = checkPortfolioRisk(openTrades, 'BTCUSDT', riskAmount, equity.capital);
    if (!riskCheck.allowed) { blocked++; break; }

    const tp1 = entryPrice - riskDist * TRADE.tp1RR;
    const tp2 = dolResult.dol;

    const trade = createTrade({
      symbol: 'BTCUSDT', entryPrice, stopPrice, tp1, tp2, size: rawSize, riskAmount,
      side: 'SHORT', strategy: 'SHORT_LSO', regime,
      fillQuality: fillResult.quality, extraStopSlippage: fillResult.extraStopSlippage,
      entryTimestamp: candle.openTime, entryCandle: i,
      notionalValue: rawSize * entryPrice, entryCostPct: 0.0004,
      inKillzone: false, kzSizeMult: 1.0, dolTier: dolResult.tier, dolType: dolResult.type,
    });
    openTrades.push(trade);
    break;
  }
}

// Close remaining
const lastCandle = candles[candles.length-1];
for (const trade of openTrades) {
  const closed = closeTrade(trade, lastCandle.close, 'end', 1.0, lastCandle.openTime, false);
  closedTrades.push(closed);
  updateEquity(equity, closed.realizedPnl, lastCandle.openTime);
}

const wins = closedTrades.filter(t => t.realizedPnl > 0);
const losses = closedTrades.filter(t => t.realizedPnl < 0);
const gw = wins.reduce((s,t) => s + t.realizedPnl, 0);
const gl = Math.abs(losses.reduce((s,t) => s + t.realizedPnl, 0));
const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);

console.log('');
console.log('═══════════════════════════════════════');
console.log('  SHORT-LSO BACKTEST RESULTS');
console.log('═══════════════════════════════════════');
console.log('  Trades:  ', closedTrades.length);
console.log('  Wins:    ', wins.length, '| Losses:', losses.length);
console.log('  WR:      ', (wins.length/closedTrades.length*100).toFixed(1)+'%');
console.log('  PF:      ', pf.toFixed(3));
console.log('  DD:      ', (equity.maxDrawdown*100).toFixed(2)+'%');
console.log('  Sweeps:  ', sweepsDetected, '| Blocked:', blocked);
console.log('  Final:   $' + equity.capital.toFixed(0), '| PnL: $' + (equity.capital-10000).toFixed(0));

// Regime breakdown
const byRegime = {};
closedTrades.forEach(t => {
  const r = t.regime || 'UNKNOWN';
  byRegime[r] = byRegime[r] || { trades: 0, wins: 0, pnl: 0 };
  byRegime[r].trades++;
  if (t.realizedPnl > 0) byRegime[r].wins++;
  byRegime[r].pnl += t.realizedPnl;
});
console.log('');
console.log('Regime breakdown:');
for (const [r, d] of Object.entries(byRegime)) {
  console.log('  ' + r + ': ' + d.trades + ' trades, WR=' + (d.trades>0?(d.wins/d.trades*100).toFixed(0):'N/A') + '%, PnL=$' + d.pnl.toFixed(0));
}

console.log('');
console.log('═══════════════════════════════════════');
console.log('  COMPARISON');
console.log('═══════════════════════════════════════');
console.log('  LSO-LONG  (SCALPER): 6 trades, PF 0.274, PnL -$369');
console.log('  SHORT-LSO:           ', closedTrades.length, 'trades, PF', pf.toFixed(3), ', PnL $' + (equity.capital-10000).toFixed(0));
if (pf > 1.0) {
  console.log('  ✓ SHORT-LSO IS PROFITABLE in this BEAR market!');
} else {
  console.log('  ✗ SHORT-LSO is NOT profitable yet');
}
