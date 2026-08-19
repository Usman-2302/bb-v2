'use strict';
/**
 * BulletBrain — Regime-Switching Scalper v2
 *
 * Fixes from v1 diagnosis:
 *   - RSI threshold was WRONG: at EMA20 reclaims RSI is 45-55, not <42
 *   - V4 (trend-only) fired 0 signals because conditions impossible
 *   - Correct thresholds: RSI<55 for longs, RSI>45 for shorts
 *
 * Signal frequency in W1 BULL regime (validated):
 *   EMA9/20 cross: 87 | EMA20 reclaim RSI<55: 192 | VWAP fade long: 300
 *   EMA50 reclaim: 156 | EMA9 cross+RVOL: 42
 *
 * New variants with corrected thresholds + regime switching.
 * Tests both windows with 1m precise fills + Monte Carlo.
 */

const fs = require('fs');

const EQUITY = 100, RISK = 0.01;
const TAKER = 0.0005, MAKER = 0.0002, SLIP = 0.0006;
const WIN_COST = TAKER + MAKER;

const WINDOWS = [
  { label: 'W1_Mar-May', from: '2026-03-01', to: '2026-05-30' },
  { label: 'W2_Jun-Aug', from: '2026-06-01', to: '2026-08-01' },
];
const WBUF = 700;

// ── Data + Indicators (same helpers as before) ────────────────────────────
function loadNDJSON(f) {
  const o=[];for(const l of fs.readFileSync(f,'utf8').split('\n')){if(!l.trim())continue;try{o.push(JSON.parse(l));}catch(e){}}
  o.sort((a,b)=>a.openTime-b.openTime);const d=[];for(const c of o){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}return d;
}
function resample(base,tfMs){const bMs=base[1].openTime-base[0].openTime;if(tfMs===bMs)return base.slice();const exp=tfMs/bMs;const out=[];let cur=null,cnt=0;for(const c of base){const bkt=Math.floor(c.openTime/tfMs)*tfMs;if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}cnt++;}if(cur&&cnt===exp)out.push(cur);return out;}
function ema(p,n){const k=2/(n+1);const o=Array(p.length).fill(NaN);let v=NaN;for(let i=0;i<p.length;i++){v=!isFinite(v)?p[i]:p[i]*k+v*(1-k);o[i]=v;}return o;}
function atrArr(c,n=14){const out=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));s=!isFinite(s)?tr:s*(n-1)/n+tr/n;out[i]=s;prev=c[i].close;}return out;}
function rsiArr(cl,n=14){const out=Array(cl.length).fill(50);let ag=0,al=0;for(let i=1;i<cl.length;i++){const d=cl[i]-cl[i-1];const g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g/n;al+=l/n;if(i===n)out[i]=al===0?100:100-100/(1+ag/al);}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;out[i]=al===0?100:100-100/(1+ag/al);}}return out;}
function rvolArr(c,n=20){const v=c.map(x=>x.volume);const out=Array(c.length).fill(1);let s=0;for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}return out;}
function vwapArr(c){const out=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;for(let i=0;i<c.length;i++){const d=Math.floor(c[i].openTime/86400000)*86400000;if(d!==day){day=d;pv=0;vv=0;}const tp=(c[i].high+c[i].low+c[i].close)/3;pv+=tp*c[i].volume;vv+=c[i].volume;out[i]=vv>0?pv/vv:c[i].close;}return out;}
function rollingMean(v,n){const o=Array(v.length).fill(NaN);let s=0;for(let i=0;i<v.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)o[i]=s/n;}return o;}
function rollingSd(v,n){const o=Array(v.length).fill(NaN);let s=0,ss=0;for(let i=0;i<v.length;i++){s+=v[i];ss+=v[i]*v[i];if(i>=n){s-=v[i-n];ss-=v[i-n]*v[i-n];}if(i>=n-1){const m=s/n;o[i]=Math.sqrt(Math.max(0,ss/n-m*m));}}return o;}
function er(cl,n=10){const o=Array(cl.length).fill(0.5);for(let i=n;i<cl.length;i++){const net=Math.abs(cl[i]-cl[i-n]);let path=0;for(let j=i-n+1;j<=i;j++)path+=Math.abs(cl[j]-cl[j-1]);o[i]=path>0?net/path:0;}return o;}

// ── Validated 4H regime (same as regime_switch.js) ────────────────────────
function buildValidatedRegimes(c4h) {
  const cl=c4h.map(c=>c.close), e200=ema(cl,200), atr=atrArr(c4h,14), erv=er(cl,10);
  const n=c4h.length, LOOK=20, THR=0.011, CRISIS=5.0, AF=2, ZER=0.15, ZCD=3;
  const raw=Array(n).fill('RANGING');
  for(let i=LOOK;i<n;i++){
    const ap=(atr[i]||0)/c4h[i].close*100; if(ap>CRISIS){raw[i]='CRISIS';continue;}
    if(!isFinite(e200[i])||!isFinite(atr[i-LOOK])){raw[i]='RANGING';continue;}
    const s=(e200[i]-e200[i-LOOK])/(atr[i]*LOOK);
    raw[i]=s>THR?'BULL':s<-THR?'BEAR':'RANGING';
  }
  const sm=Array(n).fill('RANGING');let cur='RANGING',pend=null,pc=0;sm[0]=raw[0];cur=raw[0];
  for(let i=1;i<n;i++){if(raw[i]==='CRISIS'){cur='CRISIS';pend=null;pc=0;sm[i]='CRISIS';continue;}if(raw[i]===cur){pend=null;pc=0;sm[i]=cur;}else if(raw[i]===pend){pc++;if(pc>=AF){cur=pend;pend=null;pc=0;}sm[i]=cur;}else{pend=raw[i];pc=1;sm[i]=cur;}}
  let zc=0,cc=0,za=false; const final=Array(n);
  for(let i=0;i<n;i++){if(sm[i]!=='RANGING'){zc=0;cc=0;za=false;final[i]=sm[i];continue;}if(erv[i]<ZER){zc++;cc=0;}else{cc++;zc=0;}if(!za&&zc>=ZCD)za=true;if(za&&cc>=ZCD)za=false;final[i]=za?'RANGING_ZOMBIE':'RANGING';}
  return final;
}
function build4hLookup(c4h, regs) {
  return (t)=>{let lo=0,hi=c4h.length-1,idx=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(c4h[mid].closeTime<=t){idx=mid;lo=mid+1;}else hi=mid-1;}return idx>=0?regs[idx]:'RANGING';};
}

// ── Engine ────────────────────────────────────────────────────────────────
function runBacktest(c15, c1m, sigFn, {warmup=WBUF,sm=2.0,tp=2.5,maxBars=32}={}) {
  const n=c15.length, cl=c15.map(c=>c.close), hi=c15.map(c=>c.high), lo=c15.map(c=>c.low), op=c15.map(c=>c.open);
  const a15=atrArr(c15,14), r15=rsiArr(cl,14), rv=rvolArr(c15,20);
  const e9=ema(cl,9), e20=ema(cl,20), e50=ema(cl,50), e200=ema(cl,200);
  const bbm=rollingMean(cl,20), bbs=rollingSd(cl,20);
  const bbUp=bbm.map((m,i)=>isFinite(m)?m+2*bbs[i]:NaN), bbDn=bbm.map((m,i)=>isFinite(m)?m-2*bbs[i]:NaN);
  const vwap=vwapArr(c15);
  const ctx={cl,hi,lo,op,a15,r15,rv,e9,e20,e50,e200,bbUp,bbDn,vwap,c:c15};
  const m1map=new Map(); if(c1m)for(const m of c1m)m1map.set(m.openTime,m);
  const g1m=(a,b)=>{const r=[];for(let t=a;t<b;t+=60000){const m=m1map.get(t);if(m)r.push(m);}return r;};
  let eq=EQUITY, open=null; const trades=[], rej={};
  const rj=k=>{rej[k]=(rej[k]||0)+1;};
  for(let i=warmup;i<n-1;i++){
    if(open){
      const b=c15[i], dir=open.dir, mins=g1m(b.openTime,b.closeTime+1);
      let ep=null,im=false,reason=null,et=b.closeTime;
      if(mins.length>0){for(const m of mins){const g=dir>0?m.open<=open.sl:m.open>=open.sl,hsl=dir>0?m.low<=open.sl:m.high>=open.sl,htp=dir>0?m.high>=open.tp:m.low<=open.tp;if(g){ep=m.open;reason='SL_GAP';et=m.openTime;break;}if(hsl&&htp){ep=open.sl;reason='SL';et=m.openTime;break;}if(hsl){ep=open.sl;reason='SL';et=m.openTime;break;}if(htp){ep=open.tp;im=true;reason='TP';et=m.openTime;break;}}if(!ep&&(i-open.eb)>=maxBars){ep=b.close;reason='TIME';}}
      else{const g=dir>0?b.open<=open.sl:b.open>=open.sl,hsl=dir>0?b.low<=open.sl:b.high>=open.sl,htp=dir>0?b.high>=open.tp:b.low<=open.tp,to=(i-open.eb)>=maxBars;if(g){ep=b.open;reason='SL_GAP';}else if(hsl&&htp){ep=open.sl;reason='SL';}else if(hsl){ep=open.sl;reason='SL';}else if(htp){ep=open.tp;im=true;reason='TP';}else if(to){ep=b.close;reason='TIME';}}
      if(ep!==null){const ef=im?ep:ep*(1+dir*SLIP), gr=(ef-open.entry)*dir*open.qty, fee=Math.abs(ep*open.qty)*(im?MAKER:TAKER), pnl=gr-open.entryFee-fee;eq+=pnl;const sd=Math.abs(open.entry-open.sl);trades.push({dir,reason,pnl,eq,rMult:sd>0?pnl/(sd*open.qty):NaN,fees:open.entryFee+fee,holdBars:i-open.eb,entry:open.entry,exit:ef,entryTime:open.entryTime,exitTime:et,regime:open.regime,ls:dir>0?'L':'S'});open=null;}
    }
    if(open)continue;
    const sig=sigFn(ctx,i); if(!sig)continue;
    const nb=c15[i+1], entry=nb.open*(1+sig.dir*SLIP), aa=a15[i]; if(!aa||aa<=0){rj('no_atr');continue;}
    const sl=entry-sig.dir*aa*sm, tpp=entry+sig.dir*aa*sm*tp, stopD=Math.abs(entry-sl);
    if(stopD<=0||!isFinite(sl)||!isFinite(tpp)){rj('invalid');continue;}
    if(sig.dir>0&&sl>=entry){rj('sl_side');continue;}if(sig.dir<0&&sl<=entry){rj('sl_side');continue;}
    if(Math.abs(tpp-entry)/entry<WIN_COST){rj('cost_floor');continue;}
    const ra=eq*RISK, qty=ra/(stopD+entry*(TAKER+TAKER)), ef=entry*qty*TAKER;
    open={dir:sig.dir,entry,sl,tp:tpp,qty,entryFee:ef,eb:i+1,entryTime:nb.openTime,regime:sig.regime||'?'};
  }
  return{trades,rejects:rej,finalEquity:eq};
}

function stats(trades,days){
  if(!trades.length)return{n:0,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0,longs:0,shorts:0,longWR:0,shortWR:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite); if(!rs.length)return{n:trades.length,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0,longs:0,shorts:0,longWR:0,shortWR:0};
  const wins=rs.filter(r=>r>0), avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sd>0?avgR/(sd/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak=0,dd=0,eq=0; for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  const reasons={},regimes={};
  for(const t2 of trades){reasons[t2.reason]=(reasons[t2.reason]||0)+1;regimes[t2.regime]=(regimes[t2.regime]||0)+1;}
  const L=trades.filter(t=>t.dir>0).length, S=trades.filter(t=>t.dir<0).length;
  return{n:trades.length,wr:wins.length/rs.length*100,avgR,sd,t,pf,tpd:trades.length/days,maxDD:dd,reasons,regimes,longs:L,shorts:S,longWR:trades.filter(t=>t.dir>0&&t.pnl>0).length/(L||1)*100,shortWR:trades.filter(t=>t.dir<0&&t.pnl>0).length/(S||1)*100};
}

function mc(trades,iters=1000,block=10){
  const rs=trades.map(t=>t.rMult).filter(isFinite); if(rs.length<block*2)return null;
  const finals=[],dds=[];
  for(let it=0;it<iters;it++){const sim=[];while(sim.length<rs.length){const s=Math.floor(Math.random()*(rs.length-block));for(let j=0;j<block&&sim.length<rs.length;j++)sim.push(rs[s+j]);}let eq=0,peak=0,dd=0;for(const r of sim){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}finals.push(eq);dds.push(dd);}
  finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);
  return{p5:finals[Math.floor(0.05*iters)],p25:finals[Math.floor(0.25*iters)],p50:finals[Math.floor(0.50*iters)],p75:finals[Math.floor(0.75*iters)],p95:finals[Math.floor(0.95*iters)],p95DD:dds[Math.floor(0.95*iters)],pProfit:finals.filter(f=>f>0).length/iters*100};
}

// ── Load data ─────────────────────────────────────────────────────────────
console.log('Loading...');
const raw15m=loadNDJSON('data/historical/ETHUSDT_15m.ndjson');
const raw1m =loadNDJSON('data/historical/ETHUSDT_1m.ndjson');
const raw4h =resample(raw15m,14400000);
const raw60m=resample(raw15m,3600000);
const regs4h=buildValidatedRegimes(raw4h);
const getReg=build4hLookup(raw4h,regs4h);

// 60m EMA for secondary trend confirmation
const cl60=raw60m.map(c=>c.close), e10_60=ema(cl60,10), e50_60=ema(cl60,50);
const htf=(arr60,t)=>{let lo=0,hi=raw60m.length-1,idx=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(raw60m[mid].closeTime<=t){idx=mid;lo=mid+1;}else hi=mid-1;}return idx>=0&&isFinite(arr60[idx])?arr60[idx]:NaN;};

// Show regime distributions
for(const w of WINDOWS){
  const f=Date.parse(w.from+'T00:00:00Z'),t=Date.parse(w.to+'T23:59:59Z');
  const c4=raw4h.filter(c=>c.openTime>=f&&c.openTime<=t);
  const dist={};c4.forEach(c=>{const r=getReg(c.openTime);dist[r]=(dist[r]||0)+1;});
  console.log(`${w.label}: ${Object.entries(dist).map(([k,v])=>`${k}:${(v/c4.length*100).toFixed(0)}%`).join(' ')}`);
}

// ── CORRECTED STRATEGY VARIANTS ────────────────────────────────────────────
const VARIANTS = [

  // ── VA: EMA20 reclaim + RSI<55 (CORRECTED THRESHOLD) ──────────────────
  {id:'VA_EMA20_rsi55', desc:'4H regime + EMA20 reclaim + RSI<55 (corrected threshold)',
   sm:2.0, tp:2.5,
   sig:(ctx,i)=>{
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
     const e20=ctx.e20[i], rsi=ctx.r15[i]; if(!isFinite(e20)||!isFinite(rsi))return null;
     if(reg==='BULL'&&ctx.cl[i]>e20&&ctx.cl[i-1]<=ctx.e20[i-1]&&rsi<55&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};
     if(reg==='BEAR'&&ctx.cl[i]<e20&&ctx.cl[i-1]>=ctx.e20[i-1]&&rsi>45&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(d<-1.5*a&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};if(d>1.5*a&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};}
     return null;
   }},

  // ── VB: EMA9/20 cross with regime (FIXED: removed RSI gate) ──────────
  {id:'VB_EMA9cross_regime', desc:'4H regime + 15m EMA9/20 cross + RVOL>=1.0',
   sm:2.0, tp:2.5,
   sig:(ctx,i)=>{
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
     const e9=ctx.e9[i], e20=ctx.e20[i]; if(!isFinite(e9)||!isFinite(e20))return null;
     const xUp=e9>e20&&ctx.e9[i-1]<=ctx.e20[i-1], xDn=e9<e20&&ctx.e9[i-1]>=ctx.e20[i-1];
     if(reg==='BULL'&&xUp&&ctx.rv[i]>=1.0)return{dir:1,regime:reg};
     if(reg==='BEAR'&&xDn&&ctx.rv[i]>=1.0)return{dir:-1,regime:reg};
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(d<-1.5*a&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};if(d>1.5*a&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};}
     return null;
   }},

  // ── VC: EMA50 reclaim (deeper pullback entry) ─────────────────────────
  {id:'VC_EMA50_reclaim', desc:'4H regime + 15m EMA50 reclaim (deeper pullback)',
   sm:2.5, tp:2.5,
   sig:(ctx,i)=>{
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
     const e50=ctx.e50[i]; if(!isFinite(e50))return null;
     if(reg==='BULL'&&ctx.cl[i]>e50&&ctx.cl[i-1]<=ctx.e50[i-1]&&ctx.cl[i]>ctx.op[i]&&ctx.rv[i]>=0.8)return{dir:1,regime:reg};
     if(reg==='BEAR'&&ctx.cl[i]<e50&&ctx.cl[i-1]>=ctx.e50[i-1]&&ctx.cl[i]<ctx.op[i]&&ctx.rv[i]>=0.8)return{dir:-1,regime:reg};
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(d<-1.5*a&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};if(d>1.5*a&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};}
     return null;
   }},

  // ── VD: VWAP fade only (both regimes) ────────────────────────────────
  {id:'VD_VWAP_allregimes', desc:'All regimes: VWAP fade >1.5ATR with reversal bar',
   sm:2.0, tp:2.5,
   sig:(ctx,i)=>{
     const reg=getReg(ctx.c[i].openTime); if(reg==='CRISIS')return null;
     const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i]; if(!a||!isFinite(ctx.vwap[i]))return null;
     if(d<-1.5*a&&ctx.cl[i]>ctx.op[i]&&ctx.rv[i]>=0.8)return{dir:1,regime:reg};
     if(d>1.5*a&&ctx.cl[i]<ctx.op[i]&&ctx.rv[i]>=0.8)return{dir:-1,regime:reg};
     return null;
   }},

  // ── VE: 3-bar pullback with correct RSI ─────────────────────────────
  {id:'VE_3bar_rsi55', desc:'4H regime + 3-bar trend pullback + resumption bar (RSI<60)',
   sm:2.0, tp:2.5,
   sig:(ctx,i)=>{
     if(i<5)return null;
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
     if(reg==='BULL'){
       const pb=ctx.cl[i-3]>ctx.cl[i-2]&&ctx.cl[i-2]>ctx.cl[i-1]; // 3 declining bars
       const res=ctx.cl[i]>ctx.op[i]&&ctx.cl[i]>ctx.cl[i-1]&&ctx.cl[i]>ctx.e20[i]&&ctx.r15[i]<60;
       if(pb&&res&&ctx.rv[i]>=0.8)return{dir:1,regime:reg};
     }
     if(reg==='BEAR'){
       const pb=ctx.cl[i-3]<ctx.cl[i-2]&&ctx.cl[i-2]<ctx.cl[i-1];
       const res=ctx.cl[i]<ctx.op[i]&&ctx.cl[i]<ctx.cl[i-1]&&ctx.cl[i]<ctx.e20[i]&&ctx.r15[i]>40;
       if(pb&&res&&ctx.rv[i]>=0.8)return{dir:-1,regime:reg};
     }
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(d<-1.5*a&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};if(d>1.5*a&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};}
     return null;
   }},

  // ── VF: High-vol impulse + regime (wider stop) ────────────────────────
  {id:'VF_HVimp_wider', desc:'4H regime + RVOL>=2.0 impulse + EMA stack + 3R target',
   sm:2.5, tp:3.0,
   sig:(ctx,i)=>{
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='RANGING_PREZONE'||reg==='CRISIS')return null;
     if(ctx.rv[i]<2.0)return null;
     const e9=ctx.e9[i], e20=ctx.e20[i]; if(!isFinite(e9)||!isFinite(e20))return null;
     const up=ctx.cl[i]>ctx.op[i];
     if(reg==='BULL'&&up&&e9>e20)return{dir:1,regime:reg};
     if(reg==='BEAR'&&!up&&e9<e20)return{dir:-1,regime:reg};
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(Math.abs(d)>2*a){if(d<0&&up)return{dir:1,regime:reg};if(d>0&&!up)return{dir:-1,regime:reg};}}
     return null;
   }},

  // ── VG: DOUBLE confirmation — regime + 60m trend aligned ─────────────
  {id:'VG_regime_60m_double', desc:'4H regime + 60m EMA10/50 aligned + EMA20 reclaim RSI<58',
   sm:2.0, tp:2.5,
   sig:(ctx,i)=>{
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
     const e10v=htf(e10_60,ctx.c[i].openTime), e50v=htf(e50_60,ctx.c[i].openTime);
     if(!isFinite(e10v)||!isFinite(e50v))return null;
     // Both 4H regime and 60m EMA must agree
     const bull60=e10v>e50v, bear60=e10v<e50v;
     const e20=ctx.e20[i], rsi=ctx.r15[i]; if(!isFinite(e20))return null;
     if(reg==='BULL'&&bull60&&ctx.cl[i]>e20&&ctx.cl[i-1]<=ctx.e20[i-1]&&rsi<58&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};
     if(reg==='BEAR'&&bear60&&ctx.cl[i]<e20&&ctx.cl[i-1]>=ctx.e20[i-1]&&rsi>42&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(d<-1.5*a&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};if(d>1.5*a&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};}
     return null;
   }},

  // ── VH: Stochastic <30/>70 with regime (no RSI) ───────────────────────
  {id:'VH_stoch_regime', desc:'4H regime + Stochastic %K <30 long / >70 short',
   sm:2.0, tp:2.5,
   sig:(ctx,i)=>{
     if(i<15)return null;
     const reg=getReg(ctx.c[i].openTime);
     if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
     let hh=-Infinity,ll=Infinity;for(let j=i-13;j<=i;j++){if(ctx.hi[j]>hh)hh=ctx.hi[j];if(ctx.lo[j]<ll)ll=ctx.lo[j];}
     const stK=hh!==ll?(ctx.cl[i]-ll)/(hh-ll)*100:50;
     let ph=-Infinity,pl=Infinity;for(let j=i-14;j<=i-1;j++){if(ctx.hi[j]>ph)ph=ctx.hi[j];if(ctx.lo[j]<pl)pl=ctx.lo[j];}
     const prevK=ph!==pl?(ctx.cl[i-1]-pl)/(ph-pl)*100:50;
     if(reg==='BULL'&&prevK<30&&stK>prevK&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};
     if(reg==='BEAR'&&prevK>70&&stK<prevK&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};
     if(reg==='RANGING'){const d=ctx.cl[i]-ctx.vwap[i], a=ctx.a15[i];if(!a)return null;if(d<-1.5*a&&prevK<30&&ctx.cl[i]>ctx.op[i])return{dir:1,regime:reg};if(d>1.5*a&&prevK>70&&ctx.cl[i]<ctx.op[i])return{dir:-1,regime:reg};}
     return null;
   }},
];

// ── Run all variants on all windows ───────────────────────────────────────
const P=(v,n)=>String(v).padStart(n), PL=(v,n)=>String(v).padEnd(n);
const f=(v,d=3)=>isFinite(v)?v.toFixed(d):'N/A';
const allRes={};

for(const win of WINDOWS){
  const from=Date.parse(win.from+'T00:00:00Z'), to=Date.parse(win.to+'T23:59:59Z');
  const DAYS=Math.ceil((to-from)/86400000);
  const wf=new Date(from-WBUF*900000).toISOString().slice(0,10);
  const c15=raw15m.filter(c=>c.openTime>=Date.parse(wf+'T00:00:00Z')&&c.openTime<=to);
  const c1m=raw1m.filter(c=>c.openTime>=from&&c.openTime<=to);

  console.log(`\n${'='.repeat(120)}`);
  console.log(`WINDOW: ${win.label} | ${win.from}→${win.to} | ${DAYS} days | bars:${c15.length}`);
  console.log('='.repeat(120));
  console.log(PL('Variant',24)+P('n',5)+P('T/d',5)+P('WR',5)+P('L-WR',6)+P('S-WR',6)+P('L/S',8)+P('avgR',8)+P('PF',6)+P('t',7)+P('MaxDD',7)+P('$',8)+P('Ret%',7));
  console.log('─'.repeat(120));

  const results=[];
  for(const v of VARIANTS){
    const {trades,finalEquity}=runBacktest(c15,c1m,v.sig,{sm:v.sm,tp:v.tp});
    const wt=trades.filter(t=>t.entryTime>=from&&t.entryTime<=to);
    const s=stats(wt,DAYS), ret=((finalEquity-EQUITY)/EQUITY*100);
    results.push({v,trades:wt,s,ret,fe:finalEquity});
  }
  results.sort((a,b)=>(b.s.avgR||0)-(a.s.avgR||0));
  allRes[win.label]=results;

  for(const r of results){
    const s=r.s; if(!s.n){console.log(PL(r.v.id,24)+P('0',5));continue;}
    const mark=s.t>1.5?'★':s.t>0.5?'~':' ';
    const retStr=(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%';
    console.log(PL(r.v.id,24)+P(s.n,5)+P(s.tpd.toFixed(1),5)+P(s.wr.toFixed(0)+'%',5)+
      P(s.longWR.toFixed(0)+'%',6)+P(s.shortWR.toFixed(0)+'%',6)+P(`${s.longs}L/${s.shorts}S`,8)+
      P(f(s.avgR),8)+P(f(s.pf,2),6)+P(f(s.t,2)+mark,7)+P(f(s.maxDD,1)+'R',7)+
      P('$'+r.fe.toFixed(2),8)+P(retStr,7));
  }
}

// ── Cross-window analysis ──────────────────────────────────────────────────
console.log('\n'+'='.repeat(120));
console.log('CROSS-WINDOW: Variants positive in BOTH windows');
console.log('─'.repeat(120));
const w1r=allRes[WINDOWS[0].label], w2r=allRes[WINDOWS[1].label];
const crossPos=[];
for(const r1 of w1r){
  const r2=w2r.find(r=>r.v.id===r1.v.id); if(!r2) continue;
  if(r1.s.n>=5&&r2.s.n>=5&&r1.s.avgR>0&&r2.s.avgR>0)
    crossPos.push({id:r1.v.id,desc:r1.v.desc,r1,r2});
}
if(crossPos.length){
  console.log(`✓ ${crossPos.length} variant(s) positive in BOTH windows:`);
  for(const c of crossPos){
    console.log(`\n  ${c.id} — ${c.desc}`);
    console.log(`  W1: avgR=${f(c.r1.s.avgR)} t=${f(c.r1.s.t,2)} n=${c.r1.s.n} WR=${c.r1.s.wr.toFixed(1)}% ret=${(c.r1.ret>=0?'+':'')+c.r1.ret.toFixed(1)}%`);
    console.log(`  W2: avgR=${f(c.r2.s.avgR)} t=${f(c.r2.s.t,2)} n=${c.r2.s.n} WR=${c.r2.s.wr.toFixed(1)}% ret=${(c.r2.ret>=0?'+':'')+c.r2.ret.toFixed(1)}%`);
  }
} else {
  console.log('No variant positive in both windows.');
  for(const wl of WINDOWS){const b=allRes[wl.label].find(r=>r.s.n>=5);if(b)console.log(`  Best ${wl.label}: ${b.v.id} avgR=${f(b.s.avgR)} t=${f(b.s.t,2)} n=${b.s.n} ret=${(b.ret>=0?'+':'')+b.ret.toFixed(1)}%`);}
}

// ── Monte Carlo top 3 each window ─────────────────────────────────────────
for(const win of WINDOWS){
  const res=allRes[win.label];
  const cands=res.filter(r=>r.s.n>=15&&r.s.t>0.3).slice(0,3);
  if(!cands.length){console.log(`\n${win.label}: no MC candidates (t>0.3)`);continue;}
  console.log(`\n${'─'.repeat(80)}\nMONTE CARLO — ${win.label}`);
  for(const r of cands){
    const m=mc(r.trades,1000,10); if(!m)continue;
    const rk=EQUITY*RISK;
    console.log(`\n  ${r.v.id} | n=${r.s.n} T/d=${r.s.tpd.toFixed(1)} WR=${r.s.wr.toFixed(1)}% avgR=${f(r.s.avgR)} t=${f(r.s.t,2)} $${r.fe.toFixed(2)} (${(r.ret>=0?'+':'')+r.ret.toFixed(1)}%)`);
    console.log(`  L:${r.s.longs}(WR${r.s.longWR.toFixed(0)}%) S:${r.s.shorts}(WR${r.s.shortWR.toFixed(0)}%) | Exits:${Object.entries(r.s.reasons).map(([k,v])=>`${k}:${v}`).join(' ')}`);
    console.log(`  Regimes:${Object.entries(r.s.regimes).map(([k,v])=>`${k}:${v}`).join(' ')}`);
    console.log(`  MC: P5=$${(EQUITY+m.p5*rk).toFixed(2)} P25=$${(EQUITY+m.p25*rk).toFixed(2)} P50=$${(EQUITY+m.p50*rk).toFixed(2)} P75=$${(EQUITY+m.p75*rk).toFixed(2)} P95=$${(EQUITY+m.p95*rk).toFixed(2)} | ProbProfit=${m.pProfit.toFixed(1)}%`);
  }
}
console.log('\n'+'='.repeat(120));
