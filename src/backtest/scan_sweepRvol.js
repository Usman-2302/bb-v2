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

console.log('Candles:', candles.length, '| Price:', candles[0].close.toFixed(0), '->', candles[candles.length-1].close.toFixed(0));
console.log('');
console.log('| sweepRvolMin | Trades | WR     | PF     | DD     | PnL     |');
console.log('|-------------|--------|--------|--------|--------|---------|');

const results = [];
for (const sweepRvolMin of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]) {
  const extra = {
    oiDataStore: new Map(), oiThresholdFn: r => 0.03,
    cvdGateVariant: 'CVD', obConfluenceEnabled: false,
    timeBreakeven: { enabled: false }, volumeProfiles: vp,
    gateVP: false, gate4HTrend: false,
    _sweepRvolMin: sweepRvolMin,
  };
  const strat = createLSOStrategy(extra);
  
  strat.validateSignal = function(signal, candle, i, ctx) {
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
  
  results.push({ sweepRvolMin, trades: report.trades, wr: report.wr.point, pf: report.pf, dd: report.maxDD, pnl: report.totalPnl || 0 });
}

results.sort((a, b) => b.pnl - a.pnl);
const best = results[0];

for (const r of results) {
  const mark = r === best ? ' ← BEST' : '';
  console.log(
    '|', String(r.sweepRvolMin).padEnd(12),
    '|', String(r.trades).padEnd(7),
    '|', (r.wr*100).toFixed(1)+'%'.padEnd(7),
    '|', r.pf.toFixed(3).padEnd(7),
    '|', r.dd.toFixed(2)+'%'.padEnd(7),
    '|', ('$'+r.pnl.toFixed(0)).padEnd(8),
    '|' + mark
  );
}

console.log('');
console.log('BEST: sweepRvolMin=' + best.sweepRvolMin, '→', best.trades, 'trades, $' + best.pnl.toFixed(0), 'PnL, PF=' + best.pf.toFixed(3));
console.log('');
console.log('INSIGHT: sweepRvolMin acts as a quality filter. Higher = fewer but better trades.');
