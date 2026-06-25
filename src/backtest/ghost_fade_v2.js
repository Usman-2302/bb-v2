'use strict';
const fs = require('fs');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');

const WINDOW = 500;

function backtestGhostFade(sym, config) {
  const { stopMult, tpMult, maxCandles } = config;
  const lines = fs.readFileSync('data/historical/'+sym+'_15m_3mo.ndjson','utf8').trim().split('\n').filter(Boolean);
  const allCandles = lines.map(JSON.parse);
  
  let capital = 10000, maxCapital = 10000, maxDD = 0;
  let trades = 0, wins = 0, losses = 0;
  
  for (let idx = WINDOW; idx < allCandles.length; idx++) {
    const ws = Math.max(0, idx - WINDOW);
    const wc = allCandles.slice(ws, idx + 1);
    const i = wc.length - 1;
    if (i < 200) continue;
    
    const closes = wc.map(c=>c.close);
    const ema200v = ema(closes,200);
    const atr14 = atr(wc,14);
    
    for(let j=0;j<wc.length;j++){
      if(j<200){wc[j].regime='RANGING';continue;}
      const pa=wc[j].close>ema200v[j];
      const s10=(ema200v[j]-ema200v[Math.max(0,j-10)])/ema200v[Math.max(0,j-10)];
      const ap=atr14[j]/wc[j].close*100;
      if(ap>5)wc[j].regime='CRISIS';else if(s10>0.001&&pa)wc[j].regime='BULL';else if(s10<-0.001&&!pa)wc[j].regime='BEAR';else wc[j].regime='RANGING';
    }
    
    const wrvol = rvol(wc,'15m',20);
    const wcvd = cvdFn(wc);
    
    // Pools
    const swLo = [];
    for(let j=1;j<wc.length-1;j++){if(wc[j].low<wc[j-1].low&&wc[j].low<wc[j+1].low)swLo.push(j);}
    const pools=[];
    for(let a=0;a<swLo.length;a++){for(let b=a+1;b<swLo.length;b++){const si=swLo[a],sj=swLo[b];if(sj-si>50)break;if(sj-si<2)continue;if(Math.abs(wc[si].low-wc[sj].low)/wc[si].low>=0.005)continue;let sw=false;for(let k=si+1;k<sj;k++){if(wc[k].low<Math.min(wc[si].low,wc[sj].low)){sw=true;break;}}if(sw)continue;pools.push({level:Math.floor((wc[si].low+wc[sj].low)/2),formed:sj,expires:sj+50});}}
    
    const candle=wc[i], cv=wcvd.delta[i]||0, pv=wcvd.delta[i-1]||0, rv=wrvol[i]||0, av=atr14[i]||0;
    
    for(const pool of pools){
      if(pool.formed>i||pool.expires<i)continue;
      if(candle.low>=pool.level||candle.close<=pool.level)continue;
      
      // Ghost check: CVD flat/negative
      if((cv-pv) > 0) continue;
      
      // SHORT: sell stop at sweep low
      const entry = candle.low;
      const stopDist = av * stopMult;
      const stop = entry + stopDist;
      const tpDist = stopDist * tpMult;
      const tp = entry - tpDist;
      if(stopDist<=0)continue;
      
      // Risk 1% per trade
      const riskAmt = capital * 0.01;
      const posSize = riskAmt / stopDist;
      
      // Look ahead
      let outcome='OPEN', pnl=0;
      for(let f=i+1;f<Math.min(i+maxCandles,wc.length);f++){
        const fc=wc[f];
        if(fc.high>=stop){outcome='LOSS';pnl=-riskAmt;break;}
        if(fc.low<=tp){outcome='WIN';pnl=riskAmt*tpMult;break;}
      }
      if(outcome==='OPEN'){outcome='TIME';pnl=(entry-wc[Math.min(i+maxCandles,wc.length-1)].close)/entry*capital*0.01;}
      
      capital+=pnl;
      if(capital>maxCapital)maxCapital=capital;
      const dd=(maxCapital-capital)/maxCapital;if(dd>maxDD)maxDD=dd;
      trades++;
      if(outcome==='WIN')wins++;else if(outcome==='LOSS')losses++;
      break;
    }
  }
  
  const gw=trades>0?wins:0, gl=losses>0?losses:0;
  const pf = gl>0 ? (gw*config.tpMult)/gl : (gw>0?Infinity:0);
  return {trades,wins,losses,wr:trades>0?wins/trades:0,pf,dd:maxDD*100,pnl:capital-10000};
}

const COINS = ['BTCUSDT','ETHUSDT'];
const configs = [
  { label:'Tight 1.5ATR/1.5R', stopMult:1.5, tpMult:1.5, maxCandles:50 },
  { label:'Medium 2ATR/2R', stopMult:2.0, tpMult:2.0, maxCandles:50 },
  { label:'Wide 2.5ATR/2R', stopMult:2.5, tpMult:2.0, maxCandles:50 },
  { label:'Tight 1ATR/2R fast', stopMult:1.0, tpMult:2.0, maxCandles:30 },
];

console.log('Ghost Fade scan:');
console.log('| Config | Coin | Trades | WR | PF | DD | PnL |');
console.log('|--------|------|--------|-----|-----|-----|-----|');
for (const cfg of configs) {
  for (const sym of COINS) {
    const r = backtestGhostFade(sym, cfg);
    console.log('|',cfg.label.padEnd(18),'|',sym.padEnd(5),'|',String(r.trades).padEnd(5),'|',(r.wr*100).toFixed(1)+'%'.padEnd(4),'|',r.pf.toFixed(2).padEnd(4),'|',r.dd.toFixed(1)+'%'.padEnd(4),'|','$'+r.pnl.toFixed(0).padEnd(5),'|');
  }
}
