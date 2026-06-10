'use strict';
const fs = require('fs');
const lines = fs.readFileSync('data/historical/BTCUSDT_15m_latest.ndjson', 'utf8').trim().split('\n').filter(Boolean);
const candles = lines.map(JSON.parse);

const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const atr14 = atr(candles, 14);
const closes = candles.map(c => c.close);
const ema200_vals = ema(closes, 200);

for (let i = 0; i < candles.length; i++) {
  if (i < 200) { candles[i].regime = 'RANGING'; continue; }
  const pa = candles[i].close > ema200_vals[i];
  const s10 = (ema200_vals[i] - ema200_vals[Math.max(0, i - 10)]) / ema200_vals[Math.max(0, i - 10)];
  const ap = atr14[i] / candles[i].close * 100;
  if (ap > 5) candles[i].regime = 'CRISIS';
  else if (s10 > 0.001 && pa) candles[i].regime = 'BULL';
  else if (s10 < -0.001 && !pa) candles[i].regime = 'BEAR';
  else candles[i].regime = 'RANGING';
}

const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const rvolVals = rvol(candles, '15m', 20);
const cvdData = cvdFn(candles);

const { createLSOStrategy } = require('../backtest/lso_runner');
const { runBacktest, LSO_GATES } = require('../backtest/runner');
const { rollingVolumeProfile } = require('../indicators/volumeProfile');
const vp = rollingVolumeProfile(candles, '15m', 24, 50);

console.log('═══════════════════════════════════════════════');
console.log('  sweepRvolMin BACKTEST — Last 14 Days');
console.log('═══════════════════════════════════════════════');
console.log('Candles:', candles.length, '|', candles[0].close.toFixed(0), '->', candles[candles.length-1].close.toFixed(0));
console.log('');

const results = [];

for (const sweepRvolMin of [1.2, 0.8, 0.5]) {
  const extra = {
    oiDataStore: new Map(), oiThresholdFn: r => 0.03,
    cvdGateVariant: 'CVD', obConfluenceEnabled: false,
    timeBreakeven: { enabled: false }, volumeProfiles: vp,
    gateVP: false, gate4HTrend: false,
    _sweepRvolMin: sweepRvolMin,
  };
  const strat = createLSOStrategy(extra);
  
  // Override validateSignal to use our sweepRvolMin
  const origValidate = strat.validateSignal;
  strat.validateSignal = function(signal, candle, i, ctx) {
    const cfg = ctx.cfg || {};
    const min = extra._sweepRvolMin;
    if (min > 0 && ctx.rvolVals[i] < min) {
      return { accept: false, reason: 'sweep_rvol' };
    }
    return { accept: true };
  };
  
  const report = runBacktest(strat, {
    candles, atr14, rvolVals, cvdVals: cvdData, fundingMap: new Map(), macroEvents: [],
    gates: LSO_GATES.NO_OI, initialCapital: 10000,
    symbol: 'BTCUSDT', timeframe: '15m', extra,
  });
  
  results.push({ sweepRvolMin, trades: report.trades, wr: report.wr.point, pf: report.pf, dd: report.maxDD, pnl: report.totalPnl || 0, final: report.finalCapital || 10000 });
  
  console.log(`sweepRvolMin=${sweepRvolMin}: ${report.trades} trades | WR ${(report.wr.point*100).toFixed(1)}% | PF ${report.pf.toFixed(3)} | DD ${report.maxDD.toFixed(2)}% | PnL $${(report.totalPnl||0).toFixed(0)}`);
}

console.log('');
console.log('VERDICT:');
const base = results[0];
for (const r of results) {
  const delta = r.pnl - base.pnl;
  const extra = r.trades - base.trades;
  console.log(`  min=${r.sweepRvolMin}: ${extra} extra trades, PnL delta $${delta.toFixed(0)}`);
}
