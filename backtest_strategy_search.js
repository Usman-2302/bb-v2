'use strict';
/**
 * BulletBrain — Strategy Search & Monte Carlo (v2)
 *
 * Tests 15 signal recipes on TWO windows simultaneously:
 *   W1: Mar 1 – May 30 2026 (ETH trending, $1906-$2464)
 *   W2: Jun 1 – Aug 1 2026 (ETH choppy/bearish, $1504-$2021)
 *
 * All recipes use BOTH long AND short signals.
 * 1m candles used for precise intrabar SL/TP ordering.
 * Monte Carlo on any recipe with t-stat > 0.5 and ≥15 trades.
 *
 * RECIPES:
 *   BASE: Original EMA20 pullback + 60m trend
 *   R1:  RSI oversold/overbought confirm
 *   R2:  60m EMA200 as secondary trend gate
 *   R3:  Triple TF (4h+60m+15m) alignment
 *   R4:  BB squeeze breakout
 *   R5:  VWAP deviation fade (best from first run)
 *   R6:  Engulfing at EMA50
 *   R7:  RSI divergence
 *   R8:  Combined: triple TF + RSI confirm
 *   R9:  High-volume impulse + EMA stack
 *   R10: Fast EMA9/20 cross + 60m trend
 *   R11: Extreme price extension fade (regime-agnostic)
 *   R12: Pure bear: all-bear confirmed short only
 *   R13: Stochastic oversold/overbought + trend
 *   R14: ATR-regime filtered VWAP fade
 *   R15: Breakout-then-pullback continuation
 */

const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────
const WINDOWS = [
  { label: 'Mar-May-2026 (TRENDING)', from: '2026-03-01', to: '2026-05-30' },
  { label: 'Jun-Aug-2026 (CHOPPY/BEAR)', from: '2026-06-01', to: '2026-08-01' },
];
const EQUITY = 100;
const RISK   = 0.01;
const TAKER  = 0.0005;
const MAKER  = 0.0002;
const SLIP   = 0.0006;
const WIN_COST  = TAKER + MAKER;
const LOSS_COST = TAKER + TAKER + 2*SLIP;

// ── Indicators ────────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out = [];
  for (const line of fs.readFileSync(file,'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch(e) {}
  }
  out.sort((a,b)=>a.openTime-b.openTime);
  const d=[]; for(const c of out){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);} return d;
}
function resample(base, tfMs) {
  const bMs=base[1].openTime-base[0].openTime; if(tfMs===bMs) return base.slice();
  const exp=tfMs/bMs; const out=[]; let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}
    else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}cnt++;
  }if(cur&&cnt===exp)out.push(cur);return out;
}
function ema(prices, n) {
  const k=2/(n+1); const out=Array(prices.length).fill(NaN); let v=NaN;
  for(let i=0;i<prices.length;i++){v=!isFinite(v)?prices[i]:prices[i]*k+v*(1-k);out[i]=v;} return out;
}
function atrArr(c,n=14) {
  const out=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;
  for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));
    s=!isFinite(s)?tr:s*(n-1)/n+tr/n;out[i]=s;prev=c[i].close;}return out;
}
function rsiArr(closes,n=14){
  const out=Array(closes.length).fill(50);let ag=0,al=0;
  for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1];const g=d>0?d:0,l=d<0?-d:0;
    if(i<=n){ag+=g/n;al+=l/n;if(i===n)out[i]=al===0?100:100-100/(1+ag/al);}
    else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;out[i]=al===0?100:100-100/(1+ag/al);}}return out;
}
function rvolArr(c,n=20){
  const v=c.map(x=>x.volume);const out=Array(c.length).fill(1);let s=0;
  for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}return out;
}
function rollingMean(vals,n){const out=Array(vals.length).fill(NaN);let s=0;
  for(let i=0;i<vals.length;i++){s+=vals[i];if(i>=n)s-=vals[i-n];if(i>=n-1)out[i]=s/n;}return out;
}
function rollingSd(vals,n){const out=Array(vals.length).fill(NaN);let s=0,ss=0;
  for(let i=0;i<vals.length;i++){s+=vals[i];ss+=vals[i]*vals[i];
    if(i>=n){s-=vals[i-n];ss-=vals[i-n]*vals[i-n];}
    if(i>=n-1){const m=s/n;out[i]=Math.sqrt(Math.max(0,ss/n-m*m));}}return out;
}
function vwapArr(c){
  const out=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;
  for(let i=0;i<c.length;i++){const d=Math.floor(c[i].openTime/86400000)*86400000;
    if(d!==day){day=d;pv=0;vv=0;}const tp=(c[i].high+c[i].low+c[i].close)/3;
    pv+=tp*c[i].volume;vv+=c[i].volume;out[i]=vv>0?pv/vv:c[i].close;}return out;
}

// ── Engine ────────────────────────────────────────────────────────────────
function runBacktest(candles15m, candles1m, signalFn, {stopMult=2.0,tpMult=2.5,maxBars=32,warmup=600}={}) {
  const n  = candles15m.length;
  const cl = candles15m.map(c=>c.close);
  const hi = candles15m.map(c=>c.high);
  const lo = candles15m.map(c=>c.low);
  const op = candles15m.map(c=>c.open);
  const vol= candles15m.map(c=>c.volume);
  const atr15   = atrArr(candles15m, 14);
  const rsi15   = rsiArr(cl, 14);
  const rv15    = rvolArr(candles15m, 20);
  const e9_15   = ema(cl, 9);
  const e20_15  = ema(cl, 20);
  const e50_15  = ema(cl, 50);
  const e200_15 = ema(cl, 200);
  const bb20m   = rollingMean(cl, 20);
  const bb20s   = rollingSd(cl, 20);
  const bbUp    = bb20m.map((m,i)=>isFinite(m)?m+2*bb20s[i]:NaN);
  const bbDn    = bb20m.map((m,i)=>isFinite(m)?m-2*bb20s[i]:NaN);
  const vwap15  = vwapArr(candles15m);

  const m1map = new Map();
  if (candles1m) for (const m of candles1m) m1map.set(m.openTime, m);
  const get1m = (barOpen, barClose) => {
    const r=[]; for(let t=barOpen;t<barClose;t+=60000){const m=m1map.get(t);if(m)r.push(m);} return r;
  };

  const ctx = { cl, hi, lo, op, vol, atr15, rsi15, rv15, e9_15, e20_15, e50_15, e200_15,
                bb20m, bbUp, bbDn, vwap15, candles: candles15m };

  let equity=EQUITY, open=null;
  const trades=[], rejects={};
  const rej=k=>{rejects[k]=(rejects[k]||0)+1;};

  for (let i=warmup; i<n-1; i++) {
    if (open) {
      const bar=candles15m[i]; const dir=open.dir;
      const mins=get1m(bar.openTime, bar.closeTime+1);
      let exitPx=null,isMaker=false,reason=null,exitTime=bar.closeTime;
      if (mins.length>0) {
        for (const m of mins) {
          const gapSL=dir>0?m.open<=open.sl:m.open>=open.sl;
          const hitSL=dir>0?m.low<=open.sl:m.high>=open.sl;
          const hitTP=dir>0?m.high>=open.tp:m.low<=open.tp;
          if(gapSL){exitPx=m.open;reason='SL_GAP';exitTime=m.openTime;break;}
          if(hitSL&&hitTP){exitPx=open.sl;reason='SL';exitTime=m.openTime;break;}
          if(hitSL){exitPx=open.sl;reason='SL';exitTime=m.openTime;break;}
          if(hitTP){exitPx=open.tp;isMaker=true;reason='TP';exitTime=m.openTime;break;}
        }
        if(!exitPx&&(i-open.entryBar)>=maxBars){exitPx=bar.close;reason='TIME';exitTime=bar.closeTime;}
      } else {
        const gap=dir>0?bar.open<=open.sl:bar.open>=open.sl;
        const hSL=dir>0?bar.low<=open.sl:bar.high>=open.sl;
        const hTP=dir>0?bar.high>=open.tp:bar.low<=open.tp;
        const timed=(i-open.entryBar)>=maxBars;
        if(gap){exitPx=bar.open;reason='SL_GAP';exitTime=bar.openTime;}
        else if(hSL&&hTP){exitPx=open.sl;reason='SL';exitTime=bar.openTime;}
        else if(hSL){exitPx=open.sl;reason='SL';exitTime=bar.openTime;}
        else if(hTP){exitPx=open.tp;isMaker=true;reason='TP';exitTime=bar.closeTime;}
        else if(timed){exitPx=bar.close;reason='TIME';exitTime=bar.closeTime;}
      }
      if (exitPx!==null) {
        const ef=isMaker?exitPx:exitPx*(1+dir*SLIP);
        const gr=(ef-open.entry)*dir*open.qty;
        const fee=Math.abs(exitPx*open.qty)*(isMaker?MAKER:TAKER);
        const pnl=gr-open.entryFee-fee;
        equity+=pnl;
        const sd=Math.abs(open.entry-open.sl);
        trades.push({dir,reason,pnl,equity,rMult:sd>0?pnl/(sd*open.qty):NaN,
          fees:open.entryFee+fee,holdBars:i-open.entryBar,
          entry:open.entry,exit:ef,entryTime:open.entryTime,exitTime,
          longShort:dir>0?'L':'S'});
        open=null;
      }
    }
    if (open) continue;

    const sig=signalFn(ctx,i);
    if (!sig) continue;
    const nextBar=candles15m[i+1];
    const entry=nextBar.open*(1+sig.dir*SLIP);
    const a=atr15[i];
    if(!a||a<=0){rej('no_atr');continue;}
    const sl=entry-sig.dir*a*stopMult;
    const tp=entry+sig.dir*a*stopMult*tpMult;
    const stopD=Math.abs(entry-sl);
    if(stopD<=0||!isFinite(sl)||!isFinite(tp)){rej('invalid');continue;}
    if(sig.dir>0&&sl>=entry){rej('sl_side');continue;}
    if(sig.dir<0&&sl<=entry){rej('sl_side');continue;}
    if(Math.abs(tp-entry)/entry<WIN_COST){rej('cost_floor');continue;}
    const riskAmt=equity*RISK;
    const qty=riskAmt/(stopD+entry*(TAKER+TAKER));
    const entryFee=entry*qty*TAKER;
    open={dir:sig.dir,entry,sl,tp,qty,entryFee,entryBar:i+1,entryTime:nextBar.openTime};
  }
  return {trades,rejects,finalEquity:equity};
}

// ── Stats + Monte Carlo ────────────────────────────────────────────────────
function stats(trades, days) {
  if (!trades.length) return {n:0,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0,longs:0,shorts:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite);
  if (!rs.length) return {n:trades.length,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0,longs:0,shorts:0};
  const wins=rs.filter(r=>r>0);
  const avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sd>0?avgR/(sd/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak=0,dd=0,eq=0;for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  const reasons={};for(const t2 of trades)reasons[t2.reason]=(reasons[t2.reason]||0)+1;
  const longs=trades.filter(t=>t.dir>0).length;
  const shorts=trades.filter(t=>t.dir<0).length;
  const longWR=trades.filter(t=>t.dir>0&&t.pnl>0).length/(longs||1)*100;
  const shortWR=trades.filter(t=>t.dir<0&&t.pnl>0).length/(shorts||1)*100;
  return {n:trades.length,wr:wins.length/rs.length*100,avgR,sd,t,pf,tpd:trades.length/days,
          maxDD:dd,reasons,longs,shorts,longWR,shortWR};
}

function monteCarlo(trades, iters=1000, block=10) {
  const rs=trades.map(t=>t.rMult).filter(isFinite);
  if(rs.length<block*2)return null;
  const finals=[],dds=[];
  for(let it=0;it<iters;it++){
    const sim=[];
    while(sim.length<rs.length){const s=Math.floor(Math.random()*(rs.length-block));for(let j=0;j<block&&sim.length<rs.length;j++)sim.push(rs[s+j]);}
    let eq=0,peak=0,dd=0;for(const r of sim){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
    finals.push(eq);dds.push(dd);
  }
  finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);
  return {
    p5:finals[Math.floor(0.05*iters)],p25:finals[Math.floor(0.25*iters)],
    p50:finals[Math.floor(0.50*iters)],p75:finals[Math.floor(0.75*iters)],
    p95:finals[Math.floor(0.95*iters)],p95DD:dds[Math.floor(0.95*iters)],
    pProfit:finals.filter(f=>f>0).length/iters*100,
  };
}

// ── Load all data once ─────────────────────────────────────────────────────
console.log('Loading data...');
const raw15m = loadNDJSON('data/historical/ETHUSDT_15m.ndjson');
const raw1m  = loadNDJSON('data/historical/ETHUSDT_1m.ndjson');
const raw60m = resample(raw15m, 3600000);
const raw4h  = resample(raw15m, 14400000);

// Precompute HTF indicators
const cl60   = raw60m.map(c=>c.close);
const e10_60 = ema(cl60, 10);
const e50_60 = ema(cl60, 50);
const e200_60= ema(cl60, 200);
const cl4h   = raw4h.map(c=>c.close);
const e20_4h = ema(cl4h, 20);
const e200_4h= ema(cl4h, 200);

// Safe HTF value lookup — latest CLOSED bar before barOpenTime
function htfVal(htfCandles, vals, barOpenTime) {
  let lo=0,hi=htfCandles.length-1,idx=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;
    if(htfCandles[mid].closeTime<=barOpenTime){idx=mid;lo=mid+1;}else hi=mid-1;}
  return idx>=0&&isFinite(vals[idx])?vals[idx]:NaN;
}

const WBUF = 600; // warmup bars

// ── ALL RECIPES ────────────────────────────────────────────────────────────
// Every recipe supports BOTH long AND short. dir=+1 means long, -1 means short.
const RECIPES = [

  // BASE: original
  {
    id:'BASE', desc:'EMA20 pullback reclaim + 60m EMA10/50 trend (L+S)',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e20_15[i]))return null;
      const tr=htfVal(raw60m,e10_60.map((v,k)=>isFinite(v)&&isFinite(e50_60[k])?v>e50_60[k]?1:-1:0),ctx.candles[i].openTime);
      if(tr===0)return null;
      if(tr>0&&ctx.cl[i]>ctx.e20_15[i]&&ctx.cl[i-1]<=ctx.e20_15[i-1]&&ctx.cl[i]>ctx.op[i])return{dir:1};
      if(tr<0&&ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.cl[i]<ctx.op[i])return{dir:-1};
      return null;
    },
  },

  // R1: RSI confirmation
  {
    id:'R1_RSI', desc:'EMA20 pullback + RSI turning from extreme (<38 long / >62 short)',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e20_15[i])||!isFinite(ctx.rsi15[i]))return null;
      const tr=htfVal(raw60m,e10_60.map((v,k)=>isFinite(v)&&isFinite(e50_60[k])?v>e50_60[k]?1:-1:0),ctx.candles[i].openTime);
      if(tr===0)return null;
      const longOk =tr>0&&ctx.cl[i]>ctx.e20_15[i]&&ctx.cl[i-1]<=ctx.e20_15[i-1]&&ctx.rsi15[i-1]<38&&ctx.rsi15[i]>ctx.rsi15[i-1]&&ctx.cl[i]>ctx.op[i];
      const shortOk=tr<0&&ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.rsi15[i-1]>62&&ctx.rsi15[i]<ctx.rsi15[i-1]&&ctx.cl[i]<ctx.op[i];
      if(longOk)return{dir:1}; if(shortOk)return{dir:-1}; return null;
    },
  },

  // R2: EMA200 secondary filter
  {
    id:'R2_EMA200', desc:'60m EMA10/50 + price vs 60m EMA200 (both required)',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e20_15[i]))return null;
      const p60=htfVal(raw60m,cl60,ctx.candles[i].openTime);
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      const e200v=htfVal(raw60m,e200_60,ctx.candles[i].openTime);
      if(!isFinite(p60)||!isFinite(e10v)||!isFinite(e50v)||!isFinite(e200v))return null;
      const bull=e10v>e50v&&p60>e200v, bear=e10v<e50v&&p60<e200v;
      if(!bull&&!bear)return null;
      const dir=bull?1:-1;
      if(dir>0&&ctx.cl[i]>ctx.e20_15[i]&&ctx.cl[i-1]<=ctx.e20_15[i-1]&&ctx.cl[i]>ctx.op[i])return{dir:1};
      if(dir<0&&ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.cl[i]<ctx.op[i])return{dir:-1};
      return null;
    },
  },

  // R3: Triple TF
  {
    id:'R3_TripleTF', desc:'4h EMA20/200 + 60m EMA10/50 + 15m EMA20 pullback',
    stopMult:2.5, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e20_15[i]))return null;
      const e20_4hv=htfVal(raw4h,e20_4h,ctx.candles[i].openTime);
      const e200_4hv=htfVal(raw4h,e200_4h,ctx.candles[i].openTime);
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e20_4hv)||!isFinite(e200_4hv)||!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e20_4hv>e200_4hv&&e10v>e50v, bear=e20_4hv<e200_4hv&&e10v<e50v;
      if(!bull&&!bear)return null;
      const dir=bull?1:-1;
      if(dir>0&&ctx.cl[i]>ctx.e20_15[i]&&ctx.cl[i-1]<=ctx.e20_15[i-1]&&ctx.cl[i]>ctx.op[i])return{dir:1};
      if(dir<0&&ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.cl[i]<ctx.op[i])return{dir:-1};
      return null;
    },
  },

  // R4: BB squeeze breakout
  {
    id:'R4_BBsqueeze', desc:'BB squeeze then breakout in 60m trend direction',
    stopMult:1.8, tpMult:3.0,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.bbUp[i])||i<12)return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      if(!bull&&!bear)return null;
      const w=ctx.bbUp[i]-ctx.bbDn[i];
      let avgW=0; for(let j=i-12;j<i;j++) avgW+=(ctx.bbUp[j]-ctx.bbDn[j]); avgW/=12;
      if(w>=avgW*0.85)return null; // not squeezed
      const longB =bull&&ctx.cl[i]>ctx.bbUp[i]&&ctx.cl[i-1]<=ctx.bbUp[i-1]&&ctx.rv15[i]>=1.3;
      const shortB=bear&&ctx.cl[i]<ctx.bbDn[i]&&ctx.cl[i-1]>=ctx.bbDn[i-1]&&ctx.rv15[i]>=1.3;
      if(longB)return{dir:1}; if(shortB)return{dir:-1}; return null;
    },
  },

  // R5: VWAP fade (best performer in Jun-Aug)
  {
    id:'R5_VWAPfade', desc:'Price >1.5ATR from VWAP + reversal bar + 60m trend',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.vwap15[i]))return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      const dist=ctx.cl[i]-ctx.vwap15[i]; const a=ctx.atr15[i]; if(!a)return null;
      const lf=bull&&dist<-1.5*a&&ctx.cl[i]>ctx.op[i]&&ctx.rv15[i]>=0.8;
      const sf=bear&&dist>1.5*a&&ctx.cl[i]<ctx.op[i]&&ctx.rv15[i]>=0.8;
      if(lf)return{dir:1}; if(sf)return{dir:-1}; return null;
    },
  },

  // R6: Engulfing at EMA50
  {
    id:'R6_EngulfEMA50', desc:'Bullish/bearish engulfing touching 15m EMA50 in 60m trend',
    stopMult:1.5, tpMult:3.0,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e50_15[i])||i<2)return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      const touchL=ctx.lo[i]<=ctx.e50_15[i]&&ctx.cl[i]>ctx.e50_15[i];
      const touchS=ctx.hi[i]>=ctx.e50_15[i]&&ctx.cl[i]<ctx.e50_15[i];
      const pH=Math.max(ctx.op[i-1],ctx.cl[i-1]),pL=Math.min(ctx.op[i-1],ctx.cl[i-1]);
      const cH=Math.max(ctx.op[i],ctx.cl[i]),cL=Math.min(ctx.op[i],ctx.cl[i]);
      const bullE=ctx.cl[i]>ctx.op[i]&&cH>pH&&cL<pL;
      const bearE=ctx.cl[i]<ctx.op[i]&&cH>pH&&cL<pL;
      if(bull&&touchL&&bullE&&ctx.rv15[i]>=1.0)return{dir:1};
      if(bear&&touchS&&bearE&&ctx.rv15[i]>=1.0)return{dir:-1};
      return null;
    },
  },

  // R7: RSI divergence
  {
    id:'R7_RSIdivergence', desc:'Bullish/bearish RSI divergence at extremes + 60m trend',
    stopMult:2.0, tpMult:3.0,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.rsi15[i])||i<12)return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      let minP=Infinity,minR=Infinity,maxP=-Infinity,maxR=-Infinity;
      for(let j=i-12;j<i;j++){
        if(ctx.lo[j]<minP)minP=ctx.lo[j]; if(ctx.rsi15[j]<minR)minR=ctx.rsi15[j];
        if(ctx.hi[j]>maxP)maxP=ctx.hi[j]; if(ctx.rsi15[j]>maxR)maxR=ctx.rsi15[j];
      }
      const bullD=bull&&ctx.lo[i]<=minP&&ctx.rsi15[i]>minR&&ctx.rsi15[i]<42&&ctx.cl[i]>ctx.op[i];
      const bearD=bear&&ctx.hi[i]>=maxP&&ctx.rsi15[i]<maxR&&ctx.rsi15[i]>58&&ctx.cl[i]<ctx.op[i];
      if(bullD)return{dir:1}; if(bearD)return{dir:-1}; return null;
    },
  },

  // R8: Combined triple TF + RSI
  {
    id:'R8_Combined', desc:'Triple TF aligned + RSI confirm + RVOL — quality gate',
    stopMult:2.0, tpMult:3.0,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e20_15[i])||!isFinite(ctx.rsi15[i]))return null;
      const e20_4hv=htfVal(raw4h,e20_4h,ctx.candles[i].openTime);
      const e200_4hv=htfVal(raw4h,e200_4h,ctx.candles[i].openTime);
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e20_4hv)||!isFinite(e200_4hv)||!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e20_4hv>e200_4hv&&e10v>e50v, bear=e20_4hv<e200_4hv&&e10v<e50v;
      if(!bull&&!bear)return null;
      const dir=bull?1:-1;
      const lo=dir>0&&ctx.cl[i]>ctx.e20_15[i]&&ctx.cl[i-1]<=ctx.e20_15[i-1]&&ctx.rsi15[i-1]<42&&ctx.rsi15[i]>ctx.rsi15[i-1]&&ctx.cl[i]>ctx.op[i]&&ctx.rv15[i]>=0.9;
      const so=dir<0&&ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.rsi15[i-1]>58&&ctx.rsi15[i]<ctx.rsi15[i-1]&&ctx.cl[i]<ctx.op[i]&&ctx.rv15[i]>=0.9;
      if(lo)return{dir:1}; if(so)return{dir:-1}; return null;
    },
  },

  // R9: High-volume impulse
  {
    id:'R9_HVimpulse', desc:'RVOL≥2.0 impulse in 60m trend + EMA9>EMA20 alignment',
    stopMult:2.5, tpMult:3.0,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e9_15[i])||!isFinite(ctx.e20_15[i]))return null;
      if(ctx.rv15[i]<2.0)return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      const isUp=ctx.cl[i]>ctx.op[i];
      if(bull&&isUp&&ctx.e9_15[i]>ctx.e20_15[i])return{dir:1};
      if(bear&&!isUp&&ctx.e9_15[i]<ctx.e20_15[i])return{dir:-1};
      return null;
    },
  },

  // R10: EMA9/20 cross
  {
    id:'R10_EMAcross', desc:'15m EMA9/20 cross in 60m trend direction with RVOL>=1.0',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e9_15[i])||!isFinite(ctx.e20_15[i]))return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      const xUp=ctx.e9_15[i]>ctx.e20_15[i]&&ctx.e9_15[i-1]<=ctx.e20_15[i-1];
      const xDn=ctx.e9_15[i]<ctx.e20_15[i]&&ctx.e9_15[i-1]>=ctx.e20_15[i-1];
      if(bull&&xUp&&ctx.rv15[i]>=1.0)return{dir:1};
      if(bear&&xDn&&ctx.rv15[i]>=1.0)return{dir:-1};
      return null;
    },
  },

  // R11: Extreme extension fade (regime-agnostic, both directions)
  {
    id:'R11_ExtremeFade', desc:'Price >2.5ATR from 15m EMA50 — regime-agnostic mean reversion',
    stopMult:1.5, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e50_15[i])||!isFinite(ctx.atr15[i]))return null;
      const dist=ctx.cl[i]-ctx.e50_15[i];
      const a=ctx.atr15[i];
      // Fade extreme overextension — works in any regime
      const extU=dist>2.5*a&&ctx.cl[i]<ctx.op[i]&&ctx.rv15[i]>=0.9; // overbought, fade short
      const extD=dist<-2.5*a&&ctx.cl[i]>ctx.op[i]&&ctx.rv15[i]>=0.9; // oversold, fade long
      if(extU)return{dir:-1}; if(extD)return{dir:1}; return null;
    },
  },

  // R12: Pure bear short
  {
    id:'R12_BearShort', desc:'All-TF bearish confirmed — SHORT only, pullback to EMA20',
    stopMult:2.0, tpMult:3.0,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.e20_15[i]))return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      const e200_4hv=htfVal(raw4h,e200_4h,ctx.candles[i].openTime);
      const cl4hv=htfVal(raw4h,cl4h,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v)||!isFinite(e200_4hv))return null;
      if(!(e10v<e50v&&cl4hv<e200_4hv))return null; // must be bearish on both TFs
      const so=ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.cl[i]<ctx.op[i]&&ctx.rv15[i]>=0.9;
      if(so)return{dir:-1}; return null;
    },
  },

  // R13: Stochastic + trend
  {
    id:'R13_Stochastic', desc:'Stochastic %K from deep oversold/overbought + 60m trend',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(i<15||!isFinite(ctx.atr15[i]))return null;
      let hh=-Infinity,ll=Infinity; for(let j=i-13;j<=i;j++){if(ctx.hi[j]>hh)hh=ctx.hi[j];if(ctx.lo[j]<ll)ll=ctx.lo[j];}
      const stK=hh!==ll?(ctx.cl[i]-ll)/(hh-ll)*100:50;
      let ph=-Infinity,pl=Infinity; for(let j=i-14;j<=i-1;j++){if(ctx.hi[j]>ph)ph=ctx.hi[j];if(ctx.lo[j]<pl)pl=ctx.lo[j];}
      const prevStK=ph!==pl?(ctx.cl[i-1]-pl)/(ph-pl)*100:50;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      if(bull&&prevStK<22&&stK>prevStK&&ctx.cl[i]>ctx.op[i])return{dir:1};
      if(bear&&prevStK>78&&stK<prevStK&&ctx.cl[i]<ctx.op[i])return{dir:-1};
      return null;
    },
  },

  // R14: ATR-regime VWAP (only trade in normal volatility)
  {
    id:'R14_ATRregimeVWAP', desc:'VWAP fade in normal-vol regime (not dead, not crisis)',
    stopMult:2.0, tpMult:2.5,
    signal:(ctx,i)=>{
      if(!isFinite(ctx.vwap15[i])||i<30)return null;
      let sumA=0; for(let j=i-30;j<i;j++) if(isFinite(ctx.atr15[j]))sumA+=ctx.atr15[j];
      const avgA=sumA/30; const a=ctx.atr15[i];
      if(a<avgA*0.7||a>avgA*2.0)return null; // dead or crisis — skip
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      const dist=ctx.cl[i]-ctx.vwap15[i];
      if(bull&&dist<-1.5*a&&ctx.cl[i]>ctx.op[i]&&ctx.rv15[i]>=0.8)return{dir:1};
      if(bear&&dist>1.5*a&&ctx.cl[i]<ctx.op[i]&&ctx.rv15[i]>=0.8)return{dir:-1};
      return null;
    },
  },

  // R15: Breakout-then-pullback
  {
    id:'R15_BreakoutPullback', desc:'20-bar breakout happened, price pulls to EMA20 — continuation',
    stopMult:1.5, tpMult:3.0,
    signal:(ctx,i)=>{
      if(i<25||!isFinite(ctx.e20_15[i]))return null;
      const e10v=htfVal(raw60m,e10_60,ctx.candles[i].openTime);
      const e50v=htfVal(raw60m,e50_60,ctx.candles[i].openTime);
      if(!isFinite(e10v)||!isFinite(e50v))return null;
      const bull=e10v>e50v, bear=e10v<e50v;
      if(!bull&&!bear)return null;
      let h20=-Infinity,l20=Infinity;
      for(let j=i-20;j<i;j++){if(ctx.hi[j]>h20)h20=ctx.hi[j];if(ctx.lo[j]<l20)l20=ctx.lo[j];}
      let brokeH=false,brokeL=false;
      for(let j=i-10;j<i-2;j++){
        if(ctx.cl[j]>h20&&ctx.rv15[j]>=1.2)brokeH=true;
        if(ctx.cl[j]<l20&&ctx.rv15[j]>=1.2)brokeL=true;
      }
      const lo=bull&&brokeH&&ctx.cl[i]>ctx.e20_15[i]&&ctx.cl[i-1]<=ctx.e20_15[i-1]&&ctx.cl[i]>ctx.op[i];
      const so=bear&&brokeL&&ctx.cl[i]<ctx.e20_15[i]&&ctx.cl[i-1]>=ctx.e20_15[i-1]&&ctx.cl[i]<ctx.op[i];
      if(lo)return{dir:1}; if(so)return{dir:-1}; return null;
    },
  },
];

// ── Run all recipes on all windows ─────────────────────────────────────────
const PL=(v,n)=>String(v).padEnd(n), P=(v,n)=>String(v).padStart(n);
const f=(v,d=3)=>isFinite(v)?v.toFixed(d):'N/A';

const allResults = {}; // windowLabel → sorted results

for (const win of WINDOWS) {
  const fromMs = Date.parse(win.from+'T00:00:00Z');
  const toMs   = Date.parse(win.to+'T23:59:59Z');
  const DAYS   = Math.ceil((toMs-fromMs)/86400000);

  // Warmup from 600 bars before window
  const wFrom = new Date(fromMs - WBUF*900000).toISOString().slice(0,10);
  const c15   = raw15m.filter(c=>c.openTime>=Date.parse(wFrom+'T00:00:00Z')&&c.openTime<=toMs);
  const c1m   = raw1m.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);

  console.log(`\n${'='.repeat(110)}`);
  console.log(`WINDOW: ${win.label} | ${win.from} → ${win.to} | ${DAYS} days`);
  console.log(`15m bars (with warmup): ${c15.length} | 1m bars: ${c1m.length}`);
  console.log('='.repeat(110));
  console.log(PL('Strategy',20)+P('n',5)+P('T/d',5)+P('WR',5)+P('L-WR',6)+P('S-WR',6)+
              P('L/S',6)+P('avgR',8)+P('PF',6)+P('t',6)+P('MaxDD',7)+P('Final$',9)+P('Ret%',7));
  console.log('─'.repeat(110));

  const results = [];
  for (const recipe of RECIPES) {
    const {trades, finalEquity} = runBacktest(c15, c1m, recipe.signal, {
      stopMult:recipe.stopMult, tpMult:recipe.tpMult, warmup:WBUF,
    });
    const wt = trades.filter(t=>t.entryTime>=fromMs&&t.entryTime<=toMs);
    const s  = stats(wt, DAYS);
    const ret= ((finalEquity-EQUITY)/EQUITY*100);
    results.push({recipe, trades:wt, s, ret, finalEquity});
  }

  results.sort((a,b)=>(b.s.avgR||0)-(a.s.avgR||0));
  allResults[win.label] = results;

  for (const r of results) {
    const s=r.s;
    if(!s.n){console.log(PL(r.recipe.id,20)+P('0',5));continue;}
    const lsStr=`${s.longs}L/${s.shorts}S`;
    const retStr=(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%';
    const tStar=s.t>1.5?'*':s.t>0.5?'~':'';
    console.log(PL(r.recipe.id,20)+P(s.n,5)+P(s.tpd.toFixed(1),5)+P(s.wr.toFixed(0)+'%',5)+
      P(s.longWR.toFixed(0)+'%',6)+P(s.shortWR.toFixed(0)+'%',6)+P(lsStr,6)+
      P(f(s.avgR),8)+P(f(s.pf,2),6)+P(f(s.t,2)+tStar,6)+P(f(s.maxDD,1)+'R',7)+
      P('$'+r.finalEquity.toFixed(2),9)+P(retStr,7));
  }
}

// ── Cross-window analysis: which strategies work in BOTH? ──────────────────
console.log('\n'+'='.repeat(110));
console.log('CROSS-WINDOW ANALYSIS — Strategies profitable in both windows');
console.log('─'.repeat(110));
const w1res = allResults[WINDOWS[0].label];
const w2res = allResults[WINDOWS[1].label];
const crossWin = [];
for (const r1 of w1res) {
  const r2 = w2res.find(r=>r.recipe.id===r1.recipe.id);
  if (!r2) continue;
  if (r1.s.avgR > 0 && r2.s.avgR > 0) {
    crossWin.push({id:r1.recipe.id, desc:r1.recipe.desc,
      avgR1:r1.s.avgR, t1:r1.s.t, n1:r1.s.n, ret1:r1.ret,
      avgR2:r2.s.avgR, t2:r2.s.t, n2:r2.s.n, ret2:r2.ret});
  }
}
if (crossWin.length) {
  console.log('✓ Found strategies profitable in BOTH windows:');
  for (const c of crossWin) {
    console.log(`  ${c.id}: W1 avgR=${f(c.avgR1)} t=${f(c.t1,2)} n=${c.n1} ret=${(c.ret1>=0?'+':'')+c.ret1.toFixed(1)}%`);
    console.log(`         W2 avgR=${f(c.avgR2)} t=${f(c.t2,2)} n=${c.n2} ret=${(c.ret2>=0?'+':'')+c.ret2.toFixed(1)}%`);
  }
} else {
  console.log('No strategy showed positive avgR in BOTH windows.');
  console.log('This means the regimes are fundamentally different — no single setup dominates both.');
  // Show best in each
  const best1=w1res.find(r=>r.s.n>=5);
  const best2=w2res.find(r=>r.s.n>=5);
  if(best1) console.log(`\nBest W1 (${WINDOWS[0].label.split(' ')[0]}): ${best1.recipe.id} avgR=${f(best1.s.avgR)} t=${f(best1.s.t,2)} n=${best1.s.n} ret=${(best1.ret>=0?'+':'')+best1.ret.toFixed(1)}%`);
  if(best2) console.log(`Best W2 (${WINDOWS[1].label.split(' ')[0]}): ${best2.recipe.id} avgR=${f(best2.s.avgR)} t=${f(best2.s.t,2)} n=${best2.s.n} ret=${(best2.ret>=0?'+':'')+best2.ret.toFixed(1)}%`);
}

// ── Monte Carlo on top 3 from each window ─────────────────────────────────
for (const win of WINDOWS) {
  const res = allResults[win.label];
  const candidates = res.filter(r=>r.s.n>=15&&r.s.t>0.3).slice(0,3);
  if (!candidates.length) continue;
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`MONTE CARLO — ${win.label}`);
  for (const r of candidates) {
    const mc=monteCarlo(r.trades,1000,10);
    if (!mc) continue;
    const risk=EQUITY*RISK;
    const lsBreakdown=`${r.s.longs}L/${r.s.shorts}S | L-WR:${r.s.longWR.toFixed(0)}% S-WR:${r.s.shortWR.toFixed(0)}%`;
    console.log(`\n  ${r.recipe.id} — ${r.recipe.desc}`);
    console.log(`  Stop:${r.recipe.stopMult}×ATR TP:${r.recipe.tpMult}R | n=${r.s.n} T/d=${r.s.tpd.toFixed(1)} WR=${r.s.wr.toFixed(1)}% avgR=${f(r.s.avgR)} t=${f(r.s.t,2)}`);
    console.log(`  ${lsBreakdown} | Exits: ${Object.entries(r.s.reasons).map(([k,v])=>`${k}:${v}`).join(' ')}`);
    console.log(`  $100→$${r.finalEquity.toFixed(2)} (${(r.ret>=0?'+':'')+r.ret.toFixed(2)}%)`);
    console.log(`  MC: P5=$${(EQUITY+mc.p5*risk).toFixed(2)} P25=$${(EQUITY+mc.p25*risk).toFixed(2)} P50=$${(EQUITY+mc.p50*risk).toFixed(2)} P75=$${(EQUITY+mc.p75*risk).toFixed(2)} P95=$${(EQUITY+mc.p95*risk).toFixed(2)}`);
    console.log(`  MC: P95MaxDD=$${(mc.p95DD*risk).toFixed(2)} | ProbProfit=${mc.pProfit.toFixed(1)}%`);
  }
}

// ── Final verdict ──────────────────────────────────────────────────────────
console.log('\n'+'='.repeat(110));
console.log('SUMMARY');
console.log('─'.repeat(110));
for (const win of WINDOWS) {
  const res=allResults[win.label];
  const best=res.find(r=>r.s.n>=5);
  const pos=res.filter(r=>r.s.avgR>0&&r.s.n>=5);
  console.log(`${win.label}:`);
  console.log(`  Profitable recipes: ${pos.length}/${res.filter(r=>r.s.n>=5).length}`);
  if(best) console.log(`  Best: ${best.recipe.id} | avgR=${f(best.s.avgR)} t=${f(best.s.t,2)} n=${best.s.n} ret=${(best.ret>=0?'+':'')+best.ret.toFixed(1)}%`);
}
console.log('='.repeat(110));
