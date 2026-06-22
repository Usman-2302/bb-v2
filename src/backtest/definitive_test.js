'use strict';
const fs = require('fs');
const lines = fs.readFileSync('data/historical/BTCUSDT_15m_live_period.ndjson', 'utf8').trim().split('\n').filter(Boolean);
const candles = lines.map(JSON.parse);

console.log('=== DEFINITIVE BACKTEST — LIVE PERIOD ===');
console.log(candles.length, 'candles |', new Date(candles[0].openTime).toISOString().slice(0,10), '->', new Date(candles[candles.length-1].openTime).toISOString().slice(0,10));
console.log('');

// Tag regimes (same as live bot)
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

const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const rvolVals = rvol(candles, '15m', 20);
const cvdData = cvdFn(candles);
const { rollingVolumeProfile } = require('../indicators/volumeProfile');
const vp = rollingVolumeProfile(candles, '15m', 24, 50);

const { createLSOStrategy } = require('../backtest/lso_runner');
const { runBacktest, LSO_GATES } = require('../backtest/runner');

// Test all 3 account configs with SAME settings as live
const configs = [
  // SNIPER: CVD_ZSCORE, strict
  {
    name: 'SNIPER',
    extra: {
      oiDataStore: new Map(), oiThresholdFn: r => 0.03,
      cvdGateVariant: 'CVD_ZSCORE', obConfluenceEnabled: true,
      timeBreakeven: { enabled: false }, volumeProfiles: vp,
      gateVP: true, gate4HTrend: true,
    }
  },
  // SCALPER: CVD (plain), relaxed, conviction score
  {
    name: 'SCALPER',
    extra: {
      oiDataStore: new Map(), oiThresholdFn: r => 0.03,
      cvdGateVariant: 'CVD', obConfluenceEnabled: true,
      timeBreakeven: { enabled: true }, volumeProfiles: vp,
      gateVP: true, gate4HTrend: true,
      useRangeTP2: true,
    }
  },
  // SMART: CVD (plain), signal-strength scoring
  {
    name: 'SMART',
    extra: {
      oiDataStore: new Map(), oiThresholdFn: r => 0.03,
      cvdGateVariant: 'CVD', obConfluenceEnabled: true,
      timeBreakeven: { enabled: false }, volumeProfiles: vp,
      gateVP: true, gate4HTrend: true,
    }
  },
];

console.log('');
console.log('| Account | Trades | WR    | PF    | DD    | PnL    |');
console.log('|---------|--------|-------|-------|-------|--------|');

for (const cfg of configs) {
  const strat = createLSOStrategy(cfg.extra);
  const report = runBacktest(strat, {
    candles, atr14, rvolVals, cvdVals: cvdData, fundingMap: new Map(), macroEvents: [],
    gates: LSO_GATES.NO_OI, initialCapital: 10000,
    symbol: 'BTCUSDT', timeframe: '15m', extra: cfg.extra,
  });
  
  console.log(
    '|', cfg.name.padEnd(8),
    '|', String(report.trades).padEnd(6),
    '|', (report.wr.point*100).toFixed(1)+'%'.padEnd(5),
    '|', report.pf.toFixed(3).padEnd(5),
    '|', report.maxDD.toFixed(2)+'%'.padEnd(5),
    '|', '$'+(report.totalPnl||0).toFixed(0).padEnd(6),
    '|'
  );
  
  // Show missed trade reasons
  console.log(`  ${cfg.name} sweepsDetected: ${report.sweepsDetected}, oiFiltered: ${report.oiFiltered}, cvdFiltered: ${report.cvdFiltered}, dolNotFound: ${report.dolNotFound}`);
}

console.log('');
console.log('=== VERDICT ===');
console.log('If backtest shows 0 trades on live data: the market is dead, code is fine.');
console.log('If backtest shows trades on live data: LIVE RUNNER HAS A BUG.');
