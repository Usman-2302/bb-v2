'use strict';
const fs = require('fs');

// Load the same data and run backtest with trade P&L tracking
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
  const pa = candles[i].close > ema200_vals[i];
  const s10 = (ema200_vals[i] - ema200_vals[Math.max(0, i - 10)]) / ema200_vals[Math.max(0, i - 10)];
  const ap = atr14_all[i] / candles[i].close * 100;
  if (ap > 5) candles[i].regime = 'CRISIS';
  else if (s10 > 0.001 && pa) candles[i].regime = 'BULL';
  else if (s10 < -0.001 && !pa) candles[i].regime = 'BEAR';
  else candles[i].regime = 'RANGING';
}

// Indicators
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const rvolVals = rvol(candles, '15m', 20);
const cvdVals = cvdFn(candles);

// Strategy
const { findEqualLows, isBullishSweep, buildBullishLSOSignal } = require('../strategies/lso');
const { findDOL } = require('../utils/dolFinder');
const { simulateLimitFill, createTrade, closeTrade, checkPortfolioRisk } = require('./engine');
const { LSO: LSO_CONFIG, SIZING, TRADE } = require('../../config');

// ── Pre-compute equal lows pools with volume data ──
const swingLb = LSO_CONFIG.swingLookback || 1;
const swingLowIndices = [];
for (let i = swingLb; i < candles.length - swingLb; i++) {
  const low = candles[i].low;
  let isSw = true;
  for (let d = 1; d <= swingLb; d++) {
    if (low >= candles[i - d].low || low >= candles[i + d].low) { isSw = false; break; }
  }
  if (isSw) swingLowIndices.push(i);
}

const allPools = [];
const seen = new Set();
for (let a = 0; a < swingLowIndices.length; a++) {
  for (let b = a + 1; b < swingLowIndices.length; b++) {
    const si = swingLowIndices[a], sj = swingLowIndices[b];
    if (sj - si > LSO_CONFIG.equalLookback) break;
    if (sj - si < LSO_CONFIG.equalMinGap) continue;
    const lowI = candles[si].low, lowJ = candles[sj].low;
    if (Math.abs(lowI - lowJ) / lowI >= LSO_CONFIG.equalTolerance) continue;
    let swept = false;
    for (let k = si + 1; k < sj; k++) {
      if (candles[k].low < Math.min(lowI, lowJ)) { swept = true; break; }
    }
    if (swept) continue;
    const lk = Math.floor((lowI + lowJ) / 2);
    if (seen.has(lk)) continue;
    seen.add(lk);
    // Pool volume = sum of volumes of candles between the two swing lows
    let poolVol = 0;
    for (let k = si; k <= sj; k++) poolVol += candles[k].volume;
    allPools.push({
      id: 'eql_' + candles[si].openTime + '_' + candles[sj].openTime,
      type: 'EQUAL_LOWS', level: Math.floor((lowI + lowJ) / 2),
      formed_at: sj, expires_at: sj + LSO_CONFIG.equalLookback,
      volume: poolVol, low_i: lowI, low_j: lowJ,
    });
  }
}
allPools.sort((a, b) => a.formed_at - b.formed_at);

// Compute pool volume median for scoring
const poolVolumes = allPools.map(p => p.volume).sort((a, b) => a - b);
const poolVolMedian = poolVolumes[Math.floor(poolVolumes.length / 2)];
console.log('Pools:', allPools.length, '| Median pool vol:', poolVolMedian.toFixed(0));

// ── Run backtest with CVD (plain) gate, tracking all trade data ──
const activePools = [];
let poolPtr = 0;
const trades = []; // store { pnl, rvol, poolVol, regime, score }

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

  // Process open trades from previous entries
  for (let t = 0; t < trades.length; t++) {
    const trade = trades[t];
    if (trade.closed) continue;
    // Check stop
    if (candle.low <= trade.stopPrice) {
      const adjStop = trade.stopPrice * (1 - (trade.extraStopSlippage || 0.003));
      trade.pnl = trade.size * (adjStop - trade.entryPrice);
      trade.exitReason = 'stop';
      trade.closed = true;
    } else if (!trade.tp1Hit && candle.high >= trade.tp1) {
      // TP1: partial close at 1:1
      trade.tp1Hit = true;
      trade.tp1Pnl = trade.size * TRADE.tp1CloseFraction * (trade.tp1 - trade.entryPrice);
    } else if (candle.high >= trade.tp2) {
      const remaining = trade.size * (1 - (trade.tp1Hit ? TRADE.tp1CloseFraction : 0));
      const tp2Pnl = remaining * (trade.tp2 - trade.entryPrice);
      trade.pnl = (trade.tp1Hit ? trade.tp1Pnl : 0) + tp2Pnl;
      trade.exitReason = 'tp2';
      trade.closed = true;
    }
  }

  // Check for sweeps
  for (let p = activePools.length - 1; p >= 0; p--) {
    const pool = activePools[p];
    if (!isBullishSweep(candle, pool)) continue;
    activePools.splice(p, 1);

    // Plain CVD gate check
    const cvd = cvdVals.delta[i] || 0;
    const prevCvd = cvdVals.delta[i - 1] || 0;
    const { isSweepCandle } = require('../indicators/cvd');
    if (isSweepCandle(candle) && cvd <= prevCvd) continue; // ghost sweep
    if (i >= 20) {
      const windowVals = cvdVals.delta.slice(i - 20, i).map(v => Math.abs(v));
      const avgAbs = windowVals.reduce((a, b) => a + b, 0) / windowVals.length;
      if (avgAbs > 0 && cvd < -1.5 * avgAbs) continue; // strongly negative CVD
    }

    const signal = buildBullishLSOSignal(candle, pool, atr14_all[i]);
    const entryPrice = signal.limitPrice;
    const stopPrice = signal.stopPrice;
    const riskDist = Math.abs(entryPrice - stopPrice);
    if (riskDist <= 0) continue;

    const dolResult = findDOL(candles, i, entryPrice, stopPrice, 'LONG', [], atr14_all);
    if (!dolResult) continue;

    const fillResult = simulateLimitFill(candle, { side: 'LONG', limitPrice: entryPrice }, 'LSO', 'BTCUSDT', atr14_all[i]);
    if (!fillResult.fill) continue;

    const tp1 = entryPrice + riskDist * TRADE.tp1RR;
    const tp2 = dolResult.dol;

    // ── COMPUTE SIGNAL STRENGTH SCORE ──
    let score = 1; // base point for passing all gates

    // 1. RVOL quality
    const sweepRvol = rvolVals[i] || 1.0;
    if (sweepRvol >= 2.0) score += 2;
    else if (sweepRvol >= 1.5) score += 1;

    // 2. Pool depth (volume relative to median)
    if (pool.volume >= poolVolMedian * 1.5) score += 2;
    else score += 1; // base pool point

    // 3. Regime alignment
    if (regime === 'BULL') score += 2;        // long in bull = strong alignment
    else if (regime === 'RANGING') score += 1; // long in range = acceptable
    // BEAR adds 0 — long in bear = misaligned

    score = Math.max(2, Math.min(6, score));

    // ── RISK MULTIPLIER from score ──
    const riskMultMap = { 2: 0.5, 3: 0.5, 4: 1.0, 5: 1.5, 6: 2.0 };
    const riskMult = riskMultMap[score] || 1.0;

    const baseSize = (10000 * SIZING.baseRisk) / riskDist;
    const size = baseSize * riskMult;

    trades.push({
      entryPrice, stopPrice, tp1, tp2, size,
      rvol: sweepRvol, poolVol: pool.volume, regime, score, riskMult,
      extraStopSlippage: fillResult.extraStopSlippage,
      pnl: 0, tp1Hit: false, tp1Pnl: 0, closed: false, exitReason: null,
    });
    break;
  }
}

// Close remaining trades at last candle
const lastCandle = candles[candles.length - 1];
for (const trade of trades) {
  if (!trade.closed) {
    trade.pnl = trade.size * (lastCandle.close - trade.entryPrice);
    trade.exitReason = 'end';
    trade.closed = true;
  }
}

// ── ANALYSIS ──
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  SIGNAL-STRENGTH LEVERAGE BACKTEST');
console.log('═══════════════════════════════════════════════════');
console.log('Total trades:', trades.length);
console.log('');

// Baseline: all trades at flat 1x risk (same as current)
const flatPnl = trades.reduce((s, t) => s + (t.pnl / (t.riskMult || 1)), 0);
const flatWinTrades = trades.filter(t => (t.pnl / (t.riskMult || 1)) > 0);
console.log('BASELINE (flat 1% risk, no leverage):');
console.log('  P&L: $' + flatPnl.toFixed(0), '| WR:', (flatWinTrades.length/trades.length*100).toFixed(1)+'%');

// Signal-strength scaled
const scaledPnl = trades.reduce((s, t) => s + t.pnl, 0);
const scaledWins = trades.filter(t => t.pnl > 0);
const scaledLosses = trades.filter(t => t.pnl < 0);
const grossWins = scaledWins.reduce((s, t) => s + t.pnl, 0);
const grossLosses = Math.abs(scaledLosses.reduce((s, t) => s + t.pnl, 0));
const scaledPF = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

console.log('');
console.log('SIGNAL-STRENGTH SCALED (0.5x-2.0x risk by score):');
console.log('  P&L: $' + scaledPnl.toFixed(0), '| WR:', (scaledWins.length/trades.length*100).toFixed(1)+'%', '| PF:', scaledPF.toFixed(3));
console.log('  Improvement: $' + (scaledPnl - flatPnl).toFixed(0), '(' + ((scaledPnl/flatPnl-1)*100).toFixed(0) + '%)');

// Score distribution
console.log('');
console.log('Score distribution:');
for (let s = 2; s <= 6; s++) {
  const scoreTrades = trades.filter(t => t.score === s);
  if (scoreTrades.length === 0) continue;
  const spnl = scoreTrades.reduce((a, t) => a + t.pnl, 0);
  const swins = scoreTrades.filter(t => t.pnl > 0);
  console.log('  Score ' + s + ' (' + riskMultMap[s].toFixed(1) + 'x risk): ' +
    scoreTrades.length + ' trades, WR=' + (swins.length/scoreTrades.length*100).toFixed(0) +
    '%, P&L=$' + spnl.toFixed(0));
}

// Regime breakdown of scaled results
console.log('');
console.log('Regime breakdown (scaled):');
const byRegime = {};
trades.forEach(t => {
  const r = t.regime;
  byRegime[r] = byRegime[r] || { trades: 0, wins: 0, pnl: 0 };
  byRegime[r].trades++;
  if (t.pnl > 0) byRegime[r].wins++;
  byRegime[r].pnl += t.pnl;
});
for (const [r, d] of Object.entries(byRegime)) {
  console.log('  ' + r + ': ' + d.trades + ' trades, WR=' + (d.trades>0?(d.wins/d.trades*100).toFixed(0):'N/A') +
    '%, P&L=$' + d.pnl.toFixed(0));
}

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  VERDICT');
console.log('═══════════════════════════════════════════════════');
if (scaledPnl > flatPnl) {
  console.log('  ✓ Signal-strength scaling IMPROVES profit by $' + (scaledPnl - flatPnl).toFixed(0));
  console.log('  ✓ IMPLEMENT IT.');
} else {
  console.log('  ✗ Signal-strength scaling does NOT improve profit');
  console.log('  ✗ DO NOT implement.');
}
