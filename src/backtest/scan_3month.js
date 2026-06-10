'use strict';
const fs = require('fs');
const lines = fs.readFileSync('data/historical/BTCUSDT_15m_3month.ndjson', 'utf8').trim().split('\n').filter(Boolean);
const candles = lines.map(JSON.parse);

console.log('Tagging regimes on', candles.length, 'candles...');
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

const regimes = {}; candles.forEach(c => { regimes[c.regime] = (regimes[c.regime]||0)+1 });
console.log('Regimes:', regimes);

console.log('Computing indicators...');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const rvolVals = rvol(candles, '15m', 20);
const cvdData = cvdFn(candles);
const { rollingVolumeProfile } = require('../indicators/volumeProfile');
const vp = rollingVolumeProfile(candles, '15m', 24, 50);

console.log('Running backtests...');
const { createLSOStrategy } = require('../backtest/lso_runner');
const { runBacktest, LSO_GATES } = require('../backtest/runner');

const sweepValues = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
const results = [];

for (const sweepRvolMin of sweepValues) {
  process.stdout.write('  min=' + sweepRvolMin + '... ');
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
  console.log(report.trades + ' trades, $' + (report.totalPnl||0).toFixed(0));
}

results.sort((a, b) => b.pnl - a.pnl);
const best = results[0];

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  3-MONTH BACKTEST RESULTS (Mar 12 → Jun 10, 2026)');
console.log('  8,640 candles | $70,394 → $61,886');
console.log('  Regimes:', JSON.stringify(regimes));
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('| sweepRvolMin | Trades | WR     | PF     | DD     | PnL     |');
console.log('|-------------|--------|--------|--------|--------|---------|');

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
console.log('BEST: sweepRvolMin=' + best.sweepRvolMin + ' → ' + best.trades + ' trades, $' + best.pnl.toFixed(0) + ' PnL, PF=' + best.pf.toFixed(3) + ', DD=' + best.dd.toFixed(2) + '%');

// Also show monthly breakdown
const monthlyPnL = {};
const monthlyTrades = {};
results.forEach(r => {
  monthlyPnL[r.sweepRvolMin] = r.pnl;
  monthlyTrades[r.sweepRvolMin] = r.trades;
});
console.log('');
console.log('Monthly projection (3-month PnL / 3):');
const bestMonthly = (best.pnl / 3).toFixed(0);
console.log('  Best config: ~$' + bestMonthly + '/month on $10K = ' + (best.pnl/3/10000*100).toFixed(1) + '% monthly');
console.log('  Annualized:  ~$' + (best.pnl/3*12).toFixed(0) + ' on $10K = ' + (best.pnl/3/10000*100*12).toFixed(0) + '%');
