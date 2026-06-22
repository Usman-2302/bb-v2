'use strict';
const fs = require('fs');

function loadAndTag(file) {
  const lines = fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean);
  const candles = lines.map(JSON.parse);
  const { ema } = require('../indicators/ema');
  const { atr } = require('../indicators/atr');
  const atr14 = atr(candles,14);
  const closes = candles.map(c=>c.close);
  const ema200v = ema(closes,200);
  for(let i=0;i<candles.length;i++){
    if(i<200){candles[i].regime='RANGING';continue;}
    const pa=candles[i].close>ema200v[i];
    const s10=(ema200v[i]-ema200v[Math.max(0,i-10)])/ema200v[Math.max(0,i-10)];
    const ap=atr14[i]/candles[i].close*100;
    if(ap>5)candles[i].regime='CRISIS'; else if(s10>0.001&&pa)candles[i].regime='BULL'; else if(s10<-0.001&&!pa)candles[i].regime='BEAR'; else candles[i].regime='RANGING';
  }
  return { candles, atr14 };
}

const { createLSOStrategy } = require('../backtest/lso_runner');
const { runBacktest, LSO_GATES } = require('../backtest/runner');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const { rollingVolumeProfile } = require('../indicators/volumeProfile');

const coins = ['BTCUSDT','ETHUSDT','SOLUSDT'];
const results = [];

console.log('═══════════════════════════════════════════════════');
console.log('  MULTI-APPROACH 3-MONTH BACKTEST (Mar 24 - Jun 22)');
console.log('═══════════════════════════════════════════════════');
console.log('');

// Load all
const data = {};
for (const coin of coins) {
  const d = loadAndTag('data/historical/'+coin+'_15m_3mo.ndjson');
  d.rvolVals = rvol(d.candles,'15m',20);
  d.cvdVals = cvdFn(d.candles);
  d.vp = rollingVolumeProfile(d.candles,'15m',24,50);
  data[coin] = d;
}

// ──── APPROACH 1: Current (baseline) ────
console.log('Running Approach 1: Current setup (BTC, CVD, sweepRvolMin=0.8)...');
let totalPnL1 = 0, totalTrades1 = 0;
for (const coin of coins) {
  const d = data[coin];
  const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'CVD', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
  const strat = createLSOStrategy(extra);
  const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:coin, timeframe:'15m', extra });
  totalPnL1 += (rpt.totalPnl||0); totalTrades1 += rpt.trades;
  console.log('  '+coin+': '+rpt.trades+' trades, WR '+(rpt.wr.point*100).toFixed(1)+'%, PF '+rpt.pf.toFixed(3)+', \$'+(rpt.totalPnl||0).toFixed(0));
}
results.push({ name:'Current (BTC+ETH+SOL, CVD)', trades:totalTrades1, pnl:totalPnL1, monthly:totalPnL1/3 });

// ──── APPROACH 2: No Gate7 (raw sweep + DOL only) ────
console.log('');
console.log('Running Approach 2: No Gate7 (sweep + DOL only, sweepRvolMin=0.8)...');
let totalPnL2 = 0, totalTrades2 = 0;
for (const coin of coins) {
  const d = data[coin];
  const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'NONE', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:[], gateVP:false, gate4HTrend:false };
  const strat = createLSOStrategy(extra);
  const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:coin, timeframe:'15m', extra });
  totalPnL2 += (rpt.totalPnl||0); totalTrades2 += rpt.trades;
  console.log('  '+coin+': '+rpt.trades+' trades, WR '+(rpt.wr.point*100).toFixed(1)+'%, PF '+rpt.pf.toFixed(3)+', \$'+(rpt.totalPnl||0).toFixed(0));
}
results.push({ name:'No Gate7 (raw sweep)', trades:totalTrades2, pnl:totalPnL2, monthly:totalPnL2/3 });

// ──── APPROACH 3: BULL regime only ────
console.log('');
console.log('Running Approach 3: BULL regime only (skip RANGING/BEAR)...');
let totalPnL3 = 0, totalTrades3 = 0;
for (const coin of coins) {
  const d = data[coin];
  const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'CVD', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
  const strat = createLSOStrategy(extra);
  // Override isRegimeAllowed
  strat.isRegimeAllowed = function(regime) { return regime === 'BULL'; };
  const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:coin, timeframe:'15m', extra });
  totalPnL3 += (rpt.totalPnl||0); totalTrades3 += rpt.trades;
  console.log('  '+coin+': '+rpt.trades+' trades, WR '+(rpt.wr.point*100).toFixed(1)+'%, PF '+rpt.pf.toFixed(3)+', \$'+(rpt.totalPnl||0).toFixed(0));
}
results.push({ name:'BULL only (regime filtered)', trades:totalTrades3, pnl:totalPnL3, monthly:totalPnL3/3 });

// ──── APPROACH 4: CVD plain + BULL/BEAR dual direction ────
console.log('');
console.log('Running Approach 4: CVD plain, no gateVP/4H, sweepRvolMin=0.8...');
let totalPnL4 = 0, totalTrades4 = 0;
for (const coin of coins) {
  const d = data[coin];
  const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'CVD', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
  const strat = createLSOStrategy(extra);
  const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:coin, timeframe:'15m', extra });
  totalPnL4 += (rpt.totalPnl||0); totalTrades4 += rpt.trades;
  console.log('  '+coin+': '+rpt.trades+' trades, WR '+(rpt.wr.point*100).toFixed(1)+'%, PF '+rpt.pf.toFixed(3)+', \$'+(rpt.totalPnl||0).toFixed(0));
}
results.push({ name:'CVD plain, no VP/4H', trades:totalTrades4, pnl:totalPnL4, monthly:totalPnL4/3 });

// ──── RESULTS ────
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  FINAL COMPARISON (3 coins combined, 3 months)');
console.log('═══════════════════════════════════════════════════');
console.log('');
console.log('| Approach | Trades | PnL | Monthly \$ |');
console.log('|----------|--------|-----|-----------|');

results.sort((a,b) => b.pnl - a.pnl);
const best = results[0];
for (const r of results) {
  const mark = r === best ? ' ← BEST' : '';
  console.log('|', r.name.padEnd(28), '|', String(r.trades).padEnd(6), '|', ('\$'+r.pnl.toFixed(0)).padEnd(5), '|', ('\$'+r.monthly.toFixed(0)+'/mo').padEnd(10), '|' + mark);
}
console.log('');
console.log('BEST APPROACH:', best.name);
console.log('Trades/month:', (best.trades/3).toFixed(0));
console.log('Profit/month: \$' + best.monthly.toFixed(0));
console.log('Annualized:   \$' + (best.monthly*12).toFixed(0));
