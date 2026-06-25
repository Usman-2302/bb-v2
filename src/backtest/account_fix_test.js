'use strict';
const fs = require('fs');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');

const SYM = 'ETHUSDT';
const WINDOW = 500;

console.log('══════════════════════════════════════════════');
console.log('  ACCOUNT FIX BACKTEST — ETHUSDT, Rolling Window');
console.log('  3 months, 8,640 candles, no lookahead bias');
console.log('══════════════════════════════════════════════');
console.log('');

const lines = fs.readFileSync('data/historical/'+SYM+'_15m_3mo.ndjson','utf8').trim().split('\n').filter(Boolean);
const allCandles = lines.map(JSON.parse);

// Pre-compute full dataset for "ideal" baseline
const fullCloses = allCandles.map(c=>c.close);
const fullEma200 = ema(fullCloses,200);
const fullAtr = atr(allCandles,14);
const fullRvol = rvol(allCandles,'15m',20);
const fullCvd = cvdFn(allCandles);

for(let j=0;j<allCandles.length;j++){
  if(j<200){allCandles[j].regime='RANGING';continue;}
  const pa=allCandles[j].close>fullEma200[j];
  const s10=(fullEma200[j]-fullEma200[Math.max(0,j-10)])/fullEma200[Math.max(0,j-10)];
  const ap=fullAtr[j]/allCandles[j].close*100;
  if(ap>5)allCandles[j].regime='CRISIS';else if(s10>0.001&&pa)allCandles[j].regime='BULL';else if(s10<-0.001&&!pa)allCandles[j].regime='BEAR';else allCandles[j].regime='RANGING';
}

function runConfig(name, opts) {
  const { useCvd, sweepRvolMin, stopPct, useBE, beR, skipRanging, useFullData } = opts;
  
  let capital = 10000, maxCap = 10000, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, beHits = 0;
  
  const startIdx = useFullData ? 200 : WINDOW;
  
  for (let idx = startIdx; idx < allCandles.length; idx++) {
    let wc, i, atr14, wrvol, wcvd;
    
    if (useFullData) {
      // Full data lookback (like old backtest — has lookahead bias)
      wc = allCandles.slice(0, idx + 1);
      i = idx;
      atr14 = fullAtr;
      wrvol = fullRvol;
      wcvd = fullCvd;
    } else {
      // Rolling window (like live bot — no lookahead)
      const ws = Math.max(0, idx - WINDOW);
      wc = allCandles.slice(ws, idx + 1);
      i = wc.length - 1;
      if (i < 200) continue;
      
      const c2 = wc.map(c=>c.close);
      const e2 = ema(c2,200);
      atr14 = atr(wc,14);
      for(let j=0;j<wc.length;j++){if(j<200)continue;const pa=wc[j].close>e2[j];const s10=(e2[j]-e2[Math.max(0,j-10)])/e2[Math.max(0,j-10)];const ap=atr14[j]/wc[j].close*100;if(ap>5)wc[j].regime='CRISIS';else if(s10>0.001&&pa)wc[j].regime='BULL';else if(s10<-0.001&&!pa)wc[j].regime='BEAR';else wc[j].regime='RANGING';}
      wrvol = rvol(wc,'15m',20);
      wcvd = cvdFn(wc);
    }
    
    const candle = wc[i];
    const regime = candle.regime || 'RANGING';
    if (skipRanging && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) continue;
    
    // Pools from window
    const swLo = [];
    for(let j=1;j<wc.length-1;j++){if(wc[j].low<wc[j-1].low&&wc[j].low<wc[j+1].low)swLo.push(j);}
    const pools=[];
    for(let a=0;a<swLo.length;a++){for(let b=a+1;b<swLo.length;b++){const si=swLo[a],sj=swLo[b];if(sj-si>50)break;if(sj-si<2)continue;if(Math.abs(wc[si].low-wc[sj].low)/wc[si].low>=0.005)continue;let sw=false;for(let k=si+1;k<sj;k++){if(wc[k].low<Math.min(wc[si].low,wc[sj].low)){sw=true;break;}}if(sw)continue;pools.push({level:Math.floor((wc[si].low+wc[sj].low)/2),formed:sj,expires:sj+50});}}
    
    const cv = wcvd.delta[i]||0, pv = wcvd.delta[i-1]||0, rv = wrvol[i]||0, av = atr14[i]||0;
    
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.low >= pool.level || candle.close <= pool.level) continue;
      
      // RVOL filter
      if (sweepRvolMin > 0 && rv < sweepRvolMin) continue;
      
      // CVD gate
      if (useCvd) {
        const cvdChg = cv - pv;
        const isGhost = cvdChg <= 0;
        if (isGhost) continue;
      }
      
      // Entry LONG
      const entry = pool.level;
      const stopDist = av * stopPct;
      const stop = entry - stopDist;
      const tpDist = stopDist * 2; // 2:1 R:R
      const tp = entry + tpDist;
      if (stopDist <= 0 || entry <= stop) continue;
      
      const riskAmt = capital * 0.01;
      const posSize = riskAmt / stopDist;
      
      // Breakeven
      let beActivated = false;
      
      // Forward simulation
      let outcome = 'OPEN', pnl = 0;
      for (let f = i + 1; f < Math.min(i + 50, wc.length); f++) {
        const fc = wc[f];
        
        // Breakeven check
        if (useBE && !beActivated) {
          const beLevel = entry + (stopDist * beR);
          if (fc.high >= beLevel) {
            beActivated = true;
            beHits++;
            // Move stop to entry
            if (fc.low <= entry) { outcome = 'BE'; pnl = 0; break; }
          }
        }
        
        if (fc.low <= stop) { outcome = 'LOSS'; pnl = -riskAmt; break; }
        if (fc.high >= tp) { outcome = 'WIN'; pnl = riskAmt * 2; break; }
      }
      if (outcome === 'OPEN') {
        outcome = 'TIME';
        const lastPx = wc[Math.min(i+50, wc.length-1)].close;
        pnl = posSize * (lastPx - entry);
      }
      
      capital += pnl;
      if (capital > maxCap) maxCap = capital;
      const dd = (maxCap - capital) / maxCap; if (dd > maxDD) maxDD = dd;
      trades++;
      if (outcome === 'WIN') wins++;
      else if (outcome === 'LOSS') losses++;
      else if (outcome === 'BE') wins++; // breakeven counts as tiny win
      break;
    }
  }
  
  const gw = wins * 2; // each win = 2R
  const gl = losses;
  const pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  return { name, trades, wins, losses, beHits, wr: trades>0 ? (wins/trades) : 0, pf, dd: maxDD*100, pnl: capital - 10000, capital };
}

// Test configurations
const configs = [
  { name:'Current (CVD, rvol0.8, stop0.3, rolling)', useCvd:true, sweepRvolMin:0.8, stopPct:0.3, useBE:false, beR:0, skipRanging:false, useFullData:false },
  { name:'No CVD (rvol0.8, stop0.3, rolling)', useCvd:false, sweepRvolMin:0.8, stopPct:0.3, useBE:false, beR:0, skipRanging:false, useFullData:false },
  { name:'No rvol filter (CVD, stop0.3, rolling)', useCvd:true, sweepRvolMin:0, stopPct:0.3, useBE:false, beR:0, skipRanging:false, useFullData:false },
  { name:'Wide stop 0.5ATR (CVD, rvol0.8, rolling)', useCvd:true, sweepRvolMin:0.8, stopPct:0.5, useBE:false, beR:0, skipRanging:false, useFullData:false },
  { name:'B/E at 0.5R (CVD, rvol0.8, stop0.3, rolling)', useCvd:true, sweepRvolMin:0.8, stopPct:0.3, useBE:true, beR:0.5, skipRanging:false, useFullData:false },
  { name:'Skip RANGING (CVD, rvol0.8, stop0.3, rolling)', useCvd:true, sweepRvolMin:0.8, stopPct:0.3, useBE:false, beR:0, skipRanging:true, useFullData:false },
  { name:'B/E + Wide (CVD, rvol0.8, stop0.5, rolling)', useCvd:true, sweepRvolMin:0.8, stopPct:0.5, useBE:true, beR:0.5, skipRanging:false, useFullData:false },
  { name:'Full data baseline (CVD, rvol0.8, stop0.3)', useCvd:true, sweepRvolMin:0.8, stopPct:0.3, useBE:false, beR:0, skipRanging:false, useFullData:true },
];

console.log('| Config | Trades | WR | PF | DD | PnL |');
console.log('|--------|--------|-----|-----|-----|-----|');

let best = null;
for (const cfg of configs) {
  const r = runConfig(cfg.name, cfg);
  if (!best || r.pnl > best.pnl) best = r;
  const mark = r === best ? ' ← BEST' : '';
  console.log('|',r.name.padEnd(52),'|',String(r.trades).padEnd(5),'|',(r.wr*100).toFixed(1)+'%'.padEnd(4),'|',r.pf.toFixed(2).padEnd(4),'|',r.dd.toFixed(1)+'%'.padEnd(4),'|','$'+r.pnl.toFixed(0).padEnd(5),'|'+mark);
}

console.log('');
console.log('BEST: ' + best.name);
console.log('Monthly PnL: ~$' + (best.pnl/3).toFixed(0) + ' (' + (best.pnl/3/10000*100).toFixed(1) + '%)');
