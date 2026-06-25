'use strict';
const fs = require('fs');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');

const SYM = 'ETHUSDT';
const lines = fs.readFileSync('data/historical/'+SYM+'_15m_3mo.ndjson','utf8').trim().split('\n').filter(Boolean);
const candles = lines.map(JSON.parse);

const c2 = candles.map(c=>c.close);
const e2 = ema(c2,200);
const a2 = atr(candles,14);
const r2 = rvol(candles,'15m',20);
const cv2 = cvdFn(candles);

for(let j=0;j<candles.length;j++){
  if(j<200){candles[j].regime='RANGING';continue;}
  const pa=candles[j].close>e2[j];
  const s10=(e2[j]-e2[Math.max(0,j-10)])/e2[Math.max(0,j-10)];
  const ap=a2[j]/candles[j].close*100;
  if(ap>5)candles[j].regime='CRISIS';else if(s10>0.001&&pa)candles[j].regime='BULL';else if(s10<-0.001&&!pa)candles[j].regime='BEAR';else candles[j].regime='RANGING';
}

function runPoolTest(name, useRollingPool) {
  // Pre-compute ALL pools from full dataset
  const allSw = [];
  for(let j=1;j<candles.length-1;j++){if(candles[j].low<candles[j-1].low&&candles[j].low<candles[j+1].low)allSw.push(j);}
  const allPools=[];
  for(let a=0;a<allSw.length;a++){for(let b=a+1;b<allSw.length;b++){const si=allSw[a],sj=allSw[b];if(sj-si>50)break;if(sj-si<2)continue;if(Math.abs(candles[si].low-candles[sj].low)/candles[si].low>=0.005)continue;let sw=false;for(let k=si+1;k<sj;k++){if(candles[k].low<Math.min(candles[si].low,candles[sj].low)){sw=true;break;}}if(sw)continue;allPools.push({level:Math.floor((candles[si].low+candles[sj].low)/2),formed:sj,expires:sj+50});}}
  allPools.sort((a,b)=>a.formed-b.formed);
  
  let capital = 10000, maxCap = 10000, maxDD = 0;
  let trades = 0, wins = 0, losses = 0;
  
  let rollingPools = [];
  let poolPtr = 0;
  
  for (let i = 500; i < candles.length; i++) {
    const candle = candles[i];
    const regime = candle.regime;
    const rv = r2[i]||0, cv = cv2.delta[i]||0, pv = cv2.delta[i-1]||0, av = a2[i]||0;
    
    // Pool management
    if (useRollingPool) {
      // Recompute pools from last 500 candles only
      const ws = Math.max(0, i - 500);
      const wc = candles.slice(ws, i + 1);
      const sw = [];
      for(let j=1;j<wc.length-1;j++){if(wc[j].low<wc[j-1].low&&wc[j].low<wc[j+1].low)sw.push(j);}
      rollingPools=[];
      for(let a=0;a<sw.length;a++){for(let b=a+1;b<sw.length;b++){const si=sw[a],sj=sw[b];if(sj-si>50)break;if(sj-si<2)continue;if(Math.abs(wc[si].low-wc[sj].low)/wc[si].low>=0.005)continue;let swb=false;for(let k=si+1;k<sj;k++){if(wc[k].low<Math.min(wc[si].low,wc[sj].low)){swb=true;break;}}if(swb)continue;rollingPools.push({level:Math.floor((wc[si].low+wc[sj].low)/2),formed:sj,expires:sj+50});}}
    }
    
    const pools = useRollingPool ? rollingPools : allPools;
    
    for (const pool of pools) {
      if (!useRollingPool) {
        if (pool.formed > i || pool.expires < i) continue;
      } else {
        if (pool.expires < 0) { pool.expires = pool.formed + 50; }
        if (pool.expires < i) continue;
      }
      if (candle.low >= pool.level || candle.close <= pool.level) continue;
      if (rv < 0.8) continue;
      if ((cv - pv) <= 0) continue; // CVD gate
      
      const entry = pool.level;
      const stopDist = av * 0.5; // 0.5 ATR stop
      const stop = entry - stopDist;
      const tp = entry + stopDist * 2;
      if (stopDist <= 0 || entry <= stop) continue;
      
      const riskAmt = 100; // $100 = 1% of $10K
      const posSize = riskAmt / stopDist;
      
      let outcome = 'OPEN', pnl = 0;
      for (let f = i + 1; f < Math.min(i + 50, candles.length); f++) {
        const fc = candles[f];
        if (fc.low <= stop) { outcome = 'LOSS'; pnl = -riskAmt; break; }
        if (fc.high >= tp) { outcome = 'WIN'; pnl = riskAmt * 2; break; }
      }
      if (outcome === 'OPEN') {
        const lp = candles[Math.min(i+50, candles.length-1)].close;
        pnl = posSize * (lp - entry);
      }
      
      capital += pnl;
      if (capital > maxCap) maxCap = capital;
      const dd = (maxCap - capital) / maxCap; if (dd > maxDD) maxDD = dd;
      trades++;
      if (outcome === 'WIN') wins++; else if (outcome === 'LOSS') losses++;
      break;
    }
  }
  
  const gw = wins * 2; const gl = losses;
  const pf = gl > 0 ? gw/gl : (gw>0?Infinity:0);
  return { name, trades, wins, losses, wr: trades>0?wins/trades:0, pf, dd: maxDD*100, pnl: capital-10000 };
}

const res1 = runPoolTest('Full data pools (lookahead)', false);
const res2 = runPoolTest('Rolling 500-candle pools (live)', true);

console.log('| Pool Source | Trades | WR | PF | DD | PnL |');
console.log('|-------------|--------|-----|-----|-----|-----|');
for (const r of [res1, res2]) {
  console.log('|',r.name.padEnd(35),'|',String(r.trades).padEnd(5),'|',(r.wr*100).toFixed(1)+'%'.padEnd(4),'|',r.pf.toFixed(2).padEnd(4),'|',r.dd.toFixed(1)+'%'.padEnd(4),'|','$'+r.pnl.toFixed(0).padEnd(6),'|');
}
console.log('');
console.log('Delta: '+(r2.trades-r1.trades)+' trades, $'+(r2.pnl-r1.pnl).toFixed(0)+' PnL difference');
