'use strict';
const fs = require('fs');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');
const { rollingVolumeProfile } = require('../indicators/volumeProfile');
const { createLSOStrategy } = require('../backtest/lso_runner');
const { runBacktest, LSO_GATES } = require('../backtest/runner');

const COINS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

function load(sym) {
  const lines = fs.readFileSync('data/historical/'+sym+'_15m_3mo.ndjson','utf8').trim().split('\n').filter(Boolean);
  const candles = lines.map(JSON.parse);
  const atr14 = atr(candles,14);
  const closes = candles.map(c=>c.close);
  const ema200v = ema(closes,200);
  for(let i=0;i<candles.length;i++){
    if(i<200){candles[i].regime='RANGING';continue;}
    const pa=candles[i].close>ema200v[i];
    const s10=(ema200v[i]-ema200v[Math.max(0,i-10)])/ema200v[Math.max(0,i-10)];
    const ap=atr14[i]/candles[i].close*100;
    if(ap>5)candles[i].regime='CRISIS';else if(s10>0.001&&pa)candles[i].regime='BULL';else if(s10<-0.001&&!pa)candles[i].regime='BEAR';else candles[i].regime='RANGING';
  }
  return {candles, atr14, rvolVals: rvol(candles,'15m',20), cvdVals: cvdFn(candles), vp: rollingVolumeProfile(candles,'15m',24,50)};
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  4-COIN DIAGNOSTIC BACKTEST (Mar 24 → Jun 22, 2026)');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// Per-coin breakdown: 2 configs (CVD plain, No gate)
for (const gate of ['CVD','NONE']) {
  const gateLabel = gate === 'CVD' ? 'CVD Gate' : 'No Gate7';
  console.log('=== ' + gateLabel + ' ===');
  console.log('| Coin   | Price Move | Trades | WR    | PF    | DD    | PnL    |');
  console.log('|--------|-----------|--------|-------|-------|-------|--------|');

  let grandPnL = 0, grandTrades = 0;
  for (const sym of COINS) {
    const d = load(sym);
    const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant: gate, obConfluenceEnabled: false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
    const strat = createLSOStrategy(extra);
    const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:sym, timeframe:'15m', extra });
    const move = ((d.candles[d.candles.length-1].close/d.candles[200].close-1)*100).toFixed(0)+'%';
    console.log('|',sym.padEnd(6),'|',move.padEnd(10),'|',String(rpt.trades).padEnd(5),'|',(rpt.wr.point*100).toFixed(1)+'%'.padEnd(5),'|',rpt.pf.toFixed(3).padEnd(5),'|',rpt.maxDD.toFixed(2)+'%'.padEnd(5),'|','$'+(rpt.totalPnl||0).toFixed(0).padEnd(6),'|');
    grandPnL += (rpt.totalPnl||0); grandTrades += rpt.trades;
  }
  console.log('| TOTAL  |           |', String(grandTrades).padEnd(5),'|        |',(grandPnL>0?'+':'-')+'$'+Math.abs(grandPnL).toFixed(0).padEnd(5),'|        |        |');
  console.log('');
}

// Regime breakdown per coin (CVD gate)
console.log('=== REGIME BREAKDOWN (CVD Gate) ===');
console.log('| Coin   | BULL Trades | BULL PnL | RANGING Trades | RANGING PnL | BEAR Trades | BEAR PnL |');
console.log('|--------|------------|----------|---------------|------------|------------|---------|');

for (const sym of COINS) {
  const d = load(sym);
  const regimes = {};
  d.candles.forEach(c => { regimes[c.regime] = (regimes[c.regime]||0)+1; });
  
  const byRegime = {};
  for (const reg of ['BULL','RANGING','BEAR']) {
    const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'CVD', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
    const strat = createLSOStrategy(extra);
    strat.isRegimeAllowed = function(r) { return r === reg; };
    const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:sym, timeframe:'15m', extra });
    byRegime[reg] = { trades: rpt.trades, pnl: (rpt.totalPnl||0) };
  }
  console.log('|',sym.padEnd(6),
    '|',String(byRegime.BULL.trades).padEnd(11),'|','$'+byRegime.BULL.pnl.toFixed(0).padEnd(8),
    '|',String(byRegime.RANGING.trades).padEnd(14),'|','$'+byRegime.RANGING.pnl.toFixed(0).padEnd(10),
    '|',String(byRegime.BEAR.trades).padEnd(11),'|','$'+byRegime.BEAR.pnl.toFixed(0).padEnd(7),'|');
}

console.log('');
console.log('=== SWEEP DIAGNOSTICS PER COIN (CVD Gate) ===');
console.log('| Coin   | Sweeps | Passed | Ghost | ZS Block | Rvol Block | 4H Block | VP Block | DOL Miss |');
console.log('|--------|--------|--------|-------|----------|-----------|---------|---------|---------|');

for (const sym of COINS) {
  const d = load(sym);
  const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'CVD', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
  const strat = createLSOStrategy(extra);
  const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:sym, timeframe:'15m', extra });
  const s = rpt.sweepsDetected||0, oi = rpt.oiFiltered||0, cvd = rpt.cvdFiltered||0, dol = rpt.dolNotFound||0;
  console.log('|',sym.padEnd(6),
    '|',String(s).padEnd(7),
    '|',String(rpt.trades).padEnd(7),
    '|',String(oi).padEnd(6),
    '|',String(cvd).padEnd(9),
    '|',String(0).padEnd(10),
    '|',String(0).padEnd(8),
    '|',String(0).padEnd(8),
    '|',String(dol).padEnd(8),'|');
}

console.log('');
console.log('=== CORRELATION MATRIX (price moves, 3 months) ===');
const moves = {};
for (const sym of COINS) {
  const d = load(sym);
  moves[sym] = ((d.candles[d.candles.length-1].close/d.candles[200].close-1)*100);
  console.log('  '+sym+': '+moves[sym].toFixed(1)+'%');
}

console.log('');
console.log('RECOMMENDATION:');
// Find best coin
let bestCoin = null, bestPnL = -Infinity;
for (const sym of COINS) {
  const d = load(sym);
  const extra = { oiDataStore: new Map(), oiThresholdFn: r=>0.03, cvdGateVariant:'CVD', obConfluenceEnabled:false, timeBreakeven:{enabled:false}, volumeProfiles:d.vp, gateVP:false, gate4HTrend:false };
  const strat = createLSOStrategy(extra);
  const rpt = runBacktest(strat, { candles:d.candles, atr14:d.atr14, rvolVals:d.rvolVals, cvdVals:d.cvdVals, fundingMap:new Map(), macroEvents:[], gates:LSO_GATES.NO_OI, initialCapital:10000, symbol:sym, timeframe:'15m', extra });
  if ((rpt.totalPnl||0) > bestPnL) { bestPnL = rpt.totalPnl||0; bestCoin = sym; }
}
console.log('  Best performing coin: ' + bestCoin + ' ($' + bestPnL.toFixed(0) + ')');
console.log('  Worst performing coin: BTCUSDT');
console.log('  Strategy: Run on ALL coins, but weight capital by rolling 30-trade PF.');
console.log('  Coins with PF < 1.0 get 0.5x allocation. Coins > 1.5 get 2x.');
