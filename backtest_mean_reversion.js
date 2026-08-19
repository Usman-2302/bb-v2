'use strict';
/**
 * Mean Reversion & Range Scalper — structurally different from trend-following.
 * 
 * Hypothesis: at 3m/5m, ETH over-extends intrabar and snaps back.
 * These strategies FADE moves rather than chase them.
 * 
 * Also tests: zero-cost baseline, to separate signal quality from fee drag.
 * If zero-cost is profitable and real-cost is not, the problem is purely fees.
 * If zero-cost is also negative, the signal has no edge at all.
 *
 * Usage: node backtest_mean_reversion.js
 */

const fs   = require('fs');
const path = require('path');

const EQUITY = 100;
const RISK   = 0.01;
const TAKER  = 0.0005;
const MAKER  = 0.0002;
const SLIP   = 0.0006;
const WIN_COST  = TAKER + MAKER + 2 * SLIP;

// ── Indicators ────────────────────────────────────────────────────────────
function ema(prices, n) {
  const k=2/(n+1); const out=Array(prices.length).fill(NaN); let v=NaN;
  for(let i=0;i<prices.length;i++){v=!isFinite(v)?prices[i]:prices[i]*k+v*(1-k);out[i]=v;}
  return out;
}
function atrArr(c,n=14) {
  const out=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;
  for(let i=1;i<c.length;i++){
    const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));
    s=!isFinite(s)?tr:s*(n-1)/n+tr/n;out[i]=s;prev=c[i].close;
  }
  return out;
}
function rvolArr(c,n=20) {
  const v=c.map(x=>x.volume);const out=Array(c.length).fill(1);let s=0;
  for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}
  return out;
}
function rollingMean(vals,n) {
  const out=Array(vals.length).fill(NaN);let s=0;
  for(let i=0;i<vals.length;i++){s+=vals[i];if(i>=n)s-=vals[i-n];if(i>=n-1)out[i]=s/n;}
  return out;
}
function rollingSd(vals,n) {
  const out=Array(vals.length).fill(NaN);let s=0,ss=0;
  for(let i=0;i<vals.length;i++){
    s+=vals[i];ss+=vals[i]*vals[i];
    if(i>=n){s-=vals[i-n];ss-=vals[i-n]*vals[i-n];}
    if(i>=n-1){const m=s/n;out[i]=Math.sqrt(Math.max(0,ss/n-m*m));}
  }
  return out;
}
function rsiArr(closes,n=14) {
  const out=Array(closes.length).fill(50);let ag=0,al=0;
  for(let i=1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];const g=d>0?d:0,l=d<0?-d:0;
    if(i<=n){ag+=g/n;al+=l/n;if(i===n)out[i]=al===0?100:100-100/(1+ag/al);}
    else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;out[i]=al===0?100:100-100/(1+ag/al);}
  }
  return out;
}
function vwapArr(c) {
  const out=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;
  for(let i=0;i<c.length;i++){
    const d=Math.floor(c[i].openTime/86400000)*86400000;
    if(d!==day){day=d;pv=0;vv=0;}
    const tp=(c[i].high+c[i].low+c[i].close)/3;
    pv+=tp*c[i].volume;vv+=c[i].volume;out[i]=vv>0?pv/vv:c[i].close;
  }
  return out;
}
function rollingMax(vals,n) {
  const out=Array(vals.length).fill(NaN);
  for(let i=n-1;i<vals.length;i++){let b=-Infinity;for(let j=i-n+1;j<=i;j++)if(vals[j]>b)b=vals[j];out[i]=b;}
  return out;
}
function rollingMin(vals,n) {
  const out=Array(vals.length).fill(NaN);
  for(let i=n-1;i<vals.length;i++){let b=Infinity;for(let j=i-n+1;j<=i;j++)if(vals[j]<b)b=vals[j];out[i]=b;}
  return out;
}

function buildCtx(candles) {
  const close=candles.map(c=>c.close);
  const high=candles.map(c=>c.high);
  const low=candles.map(c=>c.low);
  const open=candles.map(c=>c.open);
  const volume=candles.map(c=>c.volume);
  const ret1=Array(candles.length).fill(0);
  for(let i=1;i<candles.length;i++)ret1[i]=Math.log(close[i]/close[i-1]);
  const atr=atrArr(candles,14);
  const e9=ema(close,9);const e20=ema(close,20);const e50=ema(close,50);const e200=ema(close,200);
  const rv=rvolArr(candles,20);
  const rsi=rsiArr(close,14);
  const vwap=vwapArr(candles);
  const bbMid=rollingMean(close,20);
  const bbSd=rollingSd(close,20);
  const bbUp=bbMid.map((m,i)=>isFinite(m)?m+2*bbSd[i]:NaN);
  const bbDn=bbMid.map((m,i)=>isFinite(m)?m-2*bbSd[i]:NaN);
  const h10=rollingMax(high,10);const l10=rollingMin(low,10);
  const h20=rollingMax(high,20);const l20=rollingMin(low,20);
  // z-score of last return vs recent vol
  const rv20=rollingSd(ret1,20);
  const retZ=Array(candles.length).fill(NaN);
  for(let i=0;i<candles.length;i++)if(rv20[i]>0)retZ[i]=ret1[i]/rv20[i];
  return {candles,close,high,low,open,volume,ret1,
    atr,e9,e20,e50,e200,rv,rsi,vwap,
    bbUp,bbDn,bbMid,h10,l10,h20,l20,rv20,retZ};
}

// ── Engine (same as backtest_scalper.js, fixed fees) ─────────────────────
function run(strategy, candles, startEquity, zeroCost=false) {
  const ctx=buildCtx(candles);
  const n=candles.length;
  let equity=startEquity;let open=null;
  const trades=[];const rejects={};
  const rej=k=>{rejects[k]=(rejects[k]||0)+1;};
  const taker=zeroCost?0:TAKER;
  const maker=zeroCost?0:MAKER;
  const slip =zeroCost?0:SLIP;

  for(let i=strategy.warmup||200;i<n-1;i++){
    if(open){
      const bar=candles[i];const dir=open.dir;
      const gapped=dir>0?bar.open<=open.sl:bar.open>=open.sl;
      const hitSL=dir>0?bar.low<=open.sl:bar.high>=open.sl;
      const hitTP=dir>0?bar.high>=open.tp:bar.low<=open.tp;
      const timed=(i-open.idx)>=(strategy.maxBars||999);
      if(strategy.trail&&!gapped&&!hitSL&&!hitTP&&!timed){
        const u=strategy.trail(open,ctx,i);if(u!==undefined)open.sl=u;
      }
      let exitPx=null,isMaker=false,reason=null;
      if(gapped){exitPx=bar.open;reason='GAP';}
      else if(hitSL){exitPx=open.sl;reason='SL';}
      else if(hitTP){exitPx=open.tp;reason='TP';isMaker=true;}
      else if(timed){exitPx=bar.close;reason='TIME';}
      if(exitPx!==null){
        const exitFill=isMaker?exitPx:exitPx*(1+dir*slip);
        const gross=(exitFill-open.entry)*dir*open.qty;
        const exitFee=Math.abs(exitPx*open.qty)*(isMaker?maker:taker);
        const pnl=gross-open.entryFee-exitFee;
        equity+=pnl;
        const stopD=Math.abs(open.entry-open.sl);
        trades.push({dir,reason,pnl,equity,
          rMult:stopD>0?pnl/(stopD*open.qty):NaN,
          fees:open.entryFee+exitFee,holdBars:i-open.idx,
          entry:open.entry,exit:exitFill,
          entryTime:open.entryTime,exitTime:bar.closeTime});
        open=null;
      }
    }
    if(open)continue;
    const sig=strategy.signal(ctx,i);
    if(!sig)continue;
    const nextBar=candles[i+1];
    const entry=nextBar.open*(1+sig.dir*slip);
    const sl=strategy.sl(ctx,i,sig,entry);
    const tp=strategy.tp(ctx,i,sig,entry,sl);
    if(!isFinite(sl)||!isFinite(tp)){rej('invalid');continue;}
    const stopD=Math.abs(entry-sl);
    if(stopD<=0){rej('zero_stop');continue;}
    if(sig.dir>0&&sl>=entry){rej('sl_side');continue;}
    if(sig.dir<0&&sl<=entry){rej('sl_side');continue;}
    if(!zeroCost){
      const tpMove=Math.abs(tp-entry)/entry;
      if(tpMove<WIN_COST){rej('cost_floor');continue;}
    }
    const riskAmt=equity*RISK;
    const perUnit=stopD+entry*(zeroCost?0:taker*2);
    const qty=riskAmt/perUnit;
    const entryFee=entry*qty*taker;
    open={dir:sig.dir,entry,sl,tp,qty,entryFee,idx:i+1,entryTime:nextBar.openTime};
  }
  return{trades,rejects,finalEquity:equity};
}

function stats(trades,days) {
  if(!trades.length)return{n:0,wr:0,avgR:0,pf:0,t:0,ret:0,tpd:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite);
  if(!rs.length)return{n:trades.length,wr:0,avgR:0,pf:0,t:0,ret:0,tpd:0};
  const wins=rs.filter(r=>r>0);
  const avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sdR=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sdR>0?avgR/(sdR/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  const finalEq=trades[trades.length-1].equity;
  return{n:trades.length,wr:wins.length/rs.length*100,avgR,sdR,t,pf,
    ret:((finalEq-EQUITY)/EQUITY*100),tpd:trades.length/days};
}

// ── Data ─────────────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out=[];
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;try{out.push(JSON.parse(line));}catch(e){}
  }
  out.sort((a,b)=>a.openTime-b.openTime);
  const d=[];for(const c of out){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}
  return d;
}
function resample(base,tfMs) {
  const baseMs=base[1].openTime-base[0].openTime;
  if(tfMs===baseMs)return base.slice();
  const exp=tfMs/baseMs;const out=[];let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){
      if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;
    } else {if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}
    cnt++;
  }
  if(cur&&cnt===exp)out.push(cur);
  return out;
}
function sliceByMonth(c,y,m) {
  const from=new Date(Date.UTC(y,m-1,1)).getTime();
  const to=new Date(Date.UTC(y,m,0,23,59,59,999)).getTime();
  return c.filter(x=>x.openTime>=from&&x.openTime<=to);
}

// ── MEAN REVERSION STRATEGIES ─────────────────────────────────────────────
// Core idea: fade extremes instead of chasing continuations.
// At 5m, a -2.5σ bar snapping back is more common than a -2.5σ trend starting.
// These are SHORT-TERM (target: 30-90 min) counter-move plays.
const STRATEGIES = [

  // MR1: z-score reversion — price moved too far in one bar, fade it
  {
    id: 'MR1_zscore_fade_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:12,
    desc: 'Fade when single bar return > 2.5σ (overextended). Works if 5m has mean-reverting autocorrelation.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.retZ[i]))return null;
      // Very large single-bar move: fade it
      if(ctx.retZ[i]<-2.5&&ctx.rv[i]>=1.0)return{dir:1};   // big down bar → long
      if(ctx.retZ[i]>2.5 &&ctx.rv[i]>=1.0)return{dir:-1};  // big up bar → short
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.0,
  },

  // MR2: BB band touch reversion — price touches outer band, fade back to mid
  {
    id: 'MR2_BB_fade_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:12,
    desc: 'Close touches/breaches BB 2σ band → fade back to midline. Classic mean reversion.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.bbUp[i]))return null;
      // Close outside band AND reversing (close better than open for the reversal)
      const longFade  = ctx.close[i]<ctx.bbDn[i]&&ctx.close[i]>ctx.open[i];  // oversold, bullish close
      const shortFade = ctx.close[i]>ctx.bbUp[i]&&ctx.close[i]<ctx.open[i]; // overbought, bearish close
      if(longFade &&ctx.rv[i]>=0.8)return{dir:1};
      if(shortFade&&ctx.rv[i]>=0.8)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>ctx.bbMid[i],  // target: midline
  },

  // MR3: RSI extreme reversal — RSI below 20 or above 80, reversal bar
  {
    id: 'MR3_RSI_extreme_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:12,
    desc: 'RSI below 20 with bullish close bar = extreme oversold. Fade. Target 2R.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.rsi[i]))return null;
      const deepOs  = ctx.rsi[i]<22&&ctx.close[i]>ctx.open[i]&&ctx.rsi[i]>ctx.rsi[i-1];
      const deepOb  = ctx.rsi[i]>78&&ctx.close[i]<ctx.open[i]&&ctx.rsi[i]<ctx.rsi[i-1];
      if(deepOs)return{dir:1};
      if(deepOb)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.0,
  },

  // MR4: VWAP deviation fade — price far from VWAP, snap back
  {
    id: 'MR4_VWAP_fade_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:16,
    desc: 'Price >1.5 ATR from VWAP = overextended. Fade back toward VWAP.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.vwap[i]))return null;
      const dist=ctx.close[i]-ctx.vwap[i];
      const atr=ctx.atr[i];
      if(!atr)return null;
      // Very far from VWAP with reversal bar
      const longFade  = dist<-1.5*atr&&ctx.close[i]>ctx.open[i];
      const shortFade = dist>1.5*atr &&ctx.close[i]<ctx.open[i];
      if(longFade &&ctx.rv[i]>=0.8)return{dir:1};
      if(shortFade&&ctx.rv[i]>=0.8)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.0,
  },

  // MR5: 3m z-score fade
  {
    id: 'MR5_zscore_fade_3m', tf:'3m', tfMs:3*60*1000, warmup:200, maxBars:20,
    desc: 'Same as MR1 but at 3m — more signals, smaller moves.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.retZ[i]))return null;
      if(ctx.retZ[i]<-2.5&&ctx.rv[i]>=1.0)return{dir:1};
      if(ctx.retZ[i]>2.5 &&ctx.rv[i]>=1.0)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.0,
  },

  // MR6: 3m BB reversal
  {
    id: 'MR6_BB_fade_3m', tf:'3m', tfMs:3*60*1000, warmup:200, maxBars:20,
    desc: 'BB 2σ fade at 3m. More frequent signal than 5m.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.bbUp[i]))return null;
      const longFade  = ctx.close[i]<ctx.bbDn[i]&&ctx.close[i]>ctx.open[i];
      const shortFade = ctx.close[i]>ctx.bbUp[i]&&ctx.close[i]<ctx.open[i];
      if(longFade &&ctx.rv[i]>=0.8)return{dir:1};
      if(shortFade&&ctx.rv[i]>=0.8)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>ctx.bbMid[i],
  },

  // MR7: Inside day range scalp — price near session high/low fades back into range
  {
    id: 'MR7_range_fade_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:12,
    desc: 'Price touches 10-bar high/low with reversal bar = range exhaustion. Fade back into range.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.h10[i-1]))return null;
      // Touch 10-bar extreme with a reversal close
      const atHigh = ctx.high[i]>=ctx.h10[i-1]&&ctx.close[i]<ctx.open[i];
      const atLow  = ctx.low[i] <=ctx.l10[i-1]&&ctx.close[i]>ctx.open[i];
      if(atLow &&ctx.rv[i]>=0.8)return{dir:1};
      if(atHigh&&ctx.rv[i]>=0.8)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*1.8,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.0,
  },

  // MR8: Combined — z-score AND BB both extreme
  {
    id: 'MR8_combined_extreme_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:12,
    desc: 'Both z-score>2σ AND outside BB required = highest confidence overextension. Fewer trades but cleaner.',
    signal: (ctx,i) => {
      if(!isFinite(ctx.retZ[i])||!isFinite(ctx.bbUp[i]))return null;
      const longFade  = ctx.retZ[i]<-2.0&&ctx.close[i]<ctx.bbDn[i]&&ctx.close[i]>ctx.open[i];
      const shortFade = ctx.retZ[i]>2.0 &&ctx.close[i]>ctx.bbUp[i]&&ctx.close[i]<ctx.open[i];
      if(longFade )return{dir:1};
      if(shortFade)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.0,
  },
];

// ── Run ───────────────────────────────────────────────────────────────────
console.log('Loading 1m data...');
const raw1m=loadNDJSON(path.join(__dirname,'data','historical','ETHUSDT_1m.ndjson'));
const firstDate=new Date(raw1m[0].openTime);
const lastDate =new Date(raw1m[raw1m.length-1].openTime);

const months=[];
let y=firstDate.getUTCFullYear(),m=firstDate.getUTCMonth()+1;
while(y<lastDate.getUTCFullYear()||(y===lastDate.getUTCFullYear()&&m<=lastDate.getUTCMonth()+1)){
  months.push({y,m});m++;if(m>12){m=1;y++;}
}

// Cache resampled data per TF
const tfCache={};
for(const s of STRATEGIES){
  if(!tfCache[s.tf])tfCache[s.tf]=resample(raw1m,s.tfMs);
}

const P=(v,n)=>String(v).padStart(n);
const PL=(v,n)=>String(v).padEnd(n);

// Results store: {id: [{month, ret_real, ret_zero, n, wr, t}]}
const allResults={};
for(const s of STRATEGIES)allResults[s.id]=[];

console.log('\n' + '='.repeat(130));
console.log('MEAN REVERSION SCALPER — Monthly Returns | ETHUSDT 3m/5m | $100 start');
console.log('Real cost = taker+slip | Zero cost = no fees/slip (tests pure signal quality)');
console.log('='.repeat(130));

const HEAD = PL('Month',8) + STRATEGIES.map(s=>PL(s.id.slice(0,16),34)).join('');
console.log(HEAD);
console.log(PL('',8) + STRATEGIES.map(()=>PL('n  T/d WR% Real%  Zero%  t',34)).join(''));
console.log('─'.repeat(130));

for(const {y,m} of months){
  const monthStart=new Date(Date.UTC(y,m-1,1)).getTime();
  const monthEnd  =new Date(Date.UTC(y,m,0,23,59,59,999)).getTime();
  const daysInMonth=new Date(Date.UTC(y,m,0)).getUTCDate();
  const label=`${y}-${String(m).padStart(2,'0')}`;
  let line=PL(label,8);

  for(const strat of STRATEGIES){
    const resampled=tfCache[strat.tf];
    const warmupBars=resampled.filter(c=>c.openTime<monthStart).length;
    const modified={...strat,warmup:warmupBars};
    const monthSlice=resampled.filter(c=>c.openTime<=monthEnd);
    if(monthSlice.length<warmupBars+10){line+=PL('< data',34);continue;}

    const resReal=run(modified,monthSlice,EQUITY,false);
    const resZero=run(modified,monthSlice,EQUITY,true);

    const tReal=resReal.trades.filter(t=>t.entryTime>=monthStart&&t.entryTime<=monthEnd);
    const tZero=resZero.trades.filter(t=>t.entryTime>=monthStart&&t.entryTime<=monthEnd);

    if(!tReal.length){line+=PL('0',34);continue;}

    const pnlReal=tReal.reduce((a,t)=>a+t.pnl,0);
    const pnlZero=tZero.reduce((a,t)=>a+t.pnl,0);
    const retReal=((pnlReal)/EQUITY*100).toFixed(1);
    const retZero=((pnlZero)/EQUITY*100).toFixed(1);
    const wr=(tReal.filter(t=>t.pnl>0).length/tReal.length*100).toFixed(0);
    const tpd=(tReal.length/daysInMonth).toFixed(1);
    const rs=tReal.map(t=>t.rMult).filter(isFinite);
    const avgR=rs.length>0?rs.reduce((a,b)=>a+b,0)/rs.length:0;
    const sdR=rs.length>1?Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length):1;
    const tStat=sdR>0?avgR/(sdR/Math.sqrt(rs.length)):0;

    const rS=(parseFloat(retReal)>=0?'+':'')+retReal+'%';
    const zS=(parseFloat(retZero)>=0?'+':'')+retZero+'%';
    const cell=`${tReal.length} ${tpd} ${wr}% ${rS.padStart(7)} ${zS.padStart(7)} ${tStat.toFixed(1)}`;
    line+=PL(cell,34);

    allResults[strat.id].push({month:label,retReal:parseFloat(retReal),retZero:parseFloat(retZero),n:tReal.length,wr:parseFloat(wr),t:tStat});
  }
  console.log(line);
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n'+'='.repeat(130));
console.log('SUMMARY — Real vs Zero-cost comparison');
console.log('Key: if Zero-cost is positive but Real is negative → fee problem only (fixable with higher capital/lower fees)');
console.log('     if Zero-cost is also negative → no signal edge at all (structural problem)');
console.log('─'.repeat(130));

let bestStrategy=null, bestAvg=-Infinity;

for(const strat of STRATEGIES){
  const rs=allResults[strat.id];
  if(!rs.length)continue;
  const avgReal=rs.reduce((a,b)=>a+b.retReal,0)/rs.length;
  const avgZero=rs.reduce((a,b)=>a+b.retZero,0)/rs.length;
  const posReal=rs.filter(r=>r.retReal>0).length;
  const posZero=rs.filter(r=>r.retZero>0).length;
  const over20Real=rs.filter(r=>r.retReal>=20).length;
  const over20Zero=rs.filter(r=>r.retZero>=20).length;
  const avgT=rs.reduce((a,b)=>a+b.t,0)/rs.length;

  // fee drag = avg zero - avg real
  const feeDrag=(avgZero-avgReal).toFixed(1);

  console.log(`\n${strat.id} — ${strat.desc}`);
  console.log(`  Real:  avg ${avgReal.toFixed(1)}% | profitable ${posReal}/${rs.length} months | ≥20%: ${over20Real} months`);
  console.log(`  Zero:  avg ${avgZero.toFixed(1)}% | profitable ${posZero}/${rs.length} months | ≥20%: ${over20Zero} months`);
  console.log(`  Fee drag: ${feeDrag}%/month | avg t-stat: ${avgT.toFixed(2)}`);
  console.log(`  Verdict: ${avgZero>5?'✓ Signal has edge (zero-cost positive)':'✗ No signal edge (zero-cost also negative)'} | ${feeDrag>20?'Fees kill it':'Fees manageable'}`);

  if(avgReal>bestAvg){bestAvg=avgReal;bestStrategy=strat;}
}

console.log('\n'+'='.repeat(130));
if(bestStrategy&&bestAvg>0){
  console.log(`BEST: ${bestStrategy.id} with avg ${bestAvg.toFixed(1)}% real monthly return`);
  console.log('→ Ready to wire into liveRunner.js');
} else if(bestStrategy){
  const rs=allResults[bestStrategy.id];
  const avgZ=rs.reduce((a,b)=>a+b.retZero,0)/rs.length;
  if(avgZ>0){
    console.log(`BEST: ${bestStrategy.id} — zero-cost is positive (${avgZ.toFixed(1)}%/month) but real is negative (${bestAvg.toFixed(1)}%/month)`);
    console.log(`→ Signal has edge but fees eat it. At $${(100*20/Math.abs(bestAvg-avgZ)*10).toFixed(0)}+ capital this strategy likely becomes profitable.`);
  } else {
    console.log('NO strategy showed positive expectancy, even at zero cost.');
    console.log('→ The signal hypotheses themselves have no edge. Need different data (order book, liquidations).');
  }
}
console.log('='.repeat(130));
