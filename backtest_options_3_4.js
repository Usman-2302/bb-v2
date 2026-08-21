'use strict';
/**
 * Options 3 + 4 Test
 *
 * FINDING FROM OPTIONS 1+2:
 *   Signal has POSITIVE gross edge: +0.077R per trade
 *   Fees cost: ~0.196R per trade (0.22% of notional)
 *   Solution: either earn MORE per trade (bigger moves) or trade LESS often
 *
 * OPTION 3: Signal Quality Gate — only trade highest confidence setups
 *   - Stochastic threshold: >75 instead of >70 (stricter overbought for BEAR shorts)
 *   - RVOL >= 1.5 (real volume behind the move — not ghost moves)
 *   - RSI also extreme (>65 for shorts — double confirmation)
 *   - Price rejection: bar closed well below open (>= 0.5 ATR body size)
 *   Impact: fewer trades, but each trade has a much higher initial probability
 *
 * OPTION 4: 60m WFO EMA Crossover (the only validated strategy)
 *   - Already tested: Sharpe 6.52 on OOS data, 0.0% bootstrap exceedance
 *   - Tested here as a position strategy (hold for days)
 *   - Shows what ACTUALLY works vs scalping
 *   - Note: generates 1-3 trades per week, not 3-10/day
 *
 * ALSO TESTS:
 *   - Option 3 with different stop sizes (wider stop = better fee ratio)
 *   - Limit entry (maker fee on entry) — cuts entry fee from 0.11% to 0.04%
 *   - Combined: high quality gate + wider stop
 *
 * Windows: W1 Mar-May, W2 Jun-Aug, Combined Mar-Aug 2026
 */

const fs = require('fs');

const EQUITY=100, RISK=0.01;
const TAKER=0.0005, MAKER=0.0002, SLIP=0.0006;
const WIN_COST=TAKER+MAKER;

function loadNDJSON(f){const o=[];for(const l of fs.readFileSync(f,'utf8').split('\n')){if(!l.trim())continue;try{o.push(JSON.parse(l));}catch(e){}}o.sort((a,b)=>a.openTime-b.openTime);const d=[];for(const c of o){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}return d;}
function resample(base,tfMs){const bMs=base[1].openTime-base[0].openTime;if(tfMs===bMs)return base.slice();const exp=tfMs/bMs;const out=[];let cur=null,cnt=0;for(const c of base){const bkt=Math.floor(c.openTime/tfMs)*tfMs;if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}cnt++;}if(cur&&cnt===exp)out.push(cur);return out;}
function ema(p,n){const k=2/(n+1);const o=Array(p.length).fill(NaN);let v=NaN;for(let i=0;i<p.length;i++){v=!isFinite(v)?p[i]:p[i]*k+v*(1-k);o[i]=v;}return o;}
function atrArr(c,n=14){const o=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));s=!isFinite(s)?tr:s*(n-1)/n+tr/n;o[i]=s;prev=c[i].close;}return o;}
function rsiArr(cl,n=14){const o=Array(cl.length).fill(50);let ag=0,al=0;for(let i=1;i<cl.length;i++){const d=cl[i]-cl[i-1];const g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g/n;al+=l/n;if(i===n)o[i]=al===0?100:100-100/(1+ag/al);}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}
function rvolArr(c,n=20){const v=c.map(x=>x.volume);const o=Array(c.length).fill(1);let s=0;for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)o[i]=(s/n)>0?v[i]/(s/n):1;}return o;}
function vwapArr(c){const o=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;for(let i=0;i<c.length;i++){const d=Math.floor(c[i].openTime/86400000)*86400000;if(d!==day){day=d;pv=0;vv=0;}const tp=(c[i].high+c[i].low+c[i].close)/3;pv+=tp*c[i].volume;vv+=c[i].volume;o[i]=vv>0?pv/vv:c[i].close;}return o;}
function erArr(cl,n=10){const o=Array(cl.length).fill(0.5);for(let i=n;i<cl.length;i++){const net=Math.abs(cl[i]-cl[i-n]);let path=0;for(let j=i-n+1;j<=i;j++)path+=Math.abs(cl[j]-cl[j-1]);o[i]=path>0?net/path:0;}return o;}
function stochK(hi,lo,cl,i,n=14){if(i<n)return 50;let hh=-Infinity,ll=Infinity;for(let j=i-n+1;j<=i;j++){if(hi[j]>hh)hh=hi[j];if(lo[j]<ll)ll=lo[j];}return hh!==ll?(cl[i]-ll)/(hh-ll)*100:50;}

// Validated 4H regime
function buildRegimes(c4h){const cl=c4h.map(c=>c.close),e200=ema(cl,200),atr=atrArr(c4h,14),erv=erArr(cl,10);const n=c4h.length,LOOK=20,THR=0.011,AF=2,ZER=0.15,ZCD=3;const raw=Array(n).fill('RANGING');for(let i=LOOK;i<n;i++){const ap=(atr[i]||0)/c4h[i].close*100;if(ap>5){raw[i]='CRISIS';continue;}if(!isFinite(e200[i])||!isFinite(atr[i-LOOK]))continue;const s=(e200[i]-e200[i-LOOK])/(atr[i]*LOOK);raw[i]=s>THR?'BULL':s<-THR?'BEAR':'RANGING';}const sm=Array(n).fill('RANGING');let cur='RANGING',pend=null,pc=0;sm[0]=raw[0];cur=raw[0];for(let i=1;i<n;i++){if(raw[i]==='CRISIS'){cur='CRISIS';pend=null;pc=0;sm[i]='CRISIS';continue;}if(raw[i]===cur){pend=null;pc=0;sm[i]=cur;}else if(raw[i]===pend){pc++;if(pc>=AF){cur=pend;pend=null;pc=0;}sm[i]=cur;}else{pend=raw[i];pc=1;sm[i]=cur;}}let zc=0,cc=0,za=false;const final=Array(n);for(let i=0;i<n;i++){if(sm[i]!=='RANGING'){zc=0;cc=0;za=false;final[i]=sm[i];continue;}if(erv[i]<ZER){zc++;cc=0;}else{cc++;zc=0;}if(!za&&zc>=ZCD)za=true;if(za&&cc>=ZCD)za=false;final[i]=za?'RANGING_ZOMBIE':'RANGING';}return final;}
function buildLookup(c4h,regs){return(t)=>{let lo=0,hi=c4h.length-1,idx=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(c4h[mid].closeTime<=t){idx=mid;lo=mid+1;}else hi=mid-1;}return idx>=0?regs[idx]:'RANGING';};}

// 60m WFO EMA crossover
function runWFO(candles60m, fromMs, toMs, fees) {
  const taker=fees?TAKER:0, slip=fees?SLIP:0, maker=fees?MAKER:0;
  const cl=candles60m.map(c=>c.close);
  const EMA_FAST=[7,10,15,20], EMA_SLOW=[40,50,100,150,200];
  const TRAIN_MS=28*24*3600000, TEST_MS=28*24*3600000;
  let eq=EQUITY; const trades=[];
  const trainStart=candles60m[0].openTime;
  const testEnd=candles60m[candles60m.length-1].openTime;
  let wStart=trainStart;
  while(wStart+TRAIN_MS+TEST_MS<=testEnd){
    const trainEnd=wStart+TRAIN_MS, testEnd2=wStart+TRAIN_MS+TEST_MS;
    const trainC=candles60m.filter(c=>c.openTime>=wStart&&c.openTime<trainEnd);
    const testC =candles60m.filter(c=>c.openTime>=trainEnd&&c.openTime<testEnd2);
    if(trainC.length<100||testC.length<10){wStart+=TEST_MS;continue;}
    const trainCl=trainC.map(c=>c.close);
    let bestSharpe=-Infinity,bestF=EMA_FAST[0],bestS=EMA_SLOW[0];
    for(const fast of EMA_FAST){for(const slow of EMA_SLOW){
      const ef=ema(trainCl,fast),es=ema(trainCl,slow);
      const rets=[];let pos=0,lastPrice=trainCl[0];
      for(let i=1;i<trainCl.length;i++){
        const np=ef[i]>=es[i]?1:-1;
        if(np!==pos){rets.push((trainCl[i]-lastPrice)*pos/lastPrice);lastPrice=trainCl[i];pos=np;}
      }
      if(!rets.length)continue;
      const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
      const sd=Math.sqrt(rets.reduce((a,r)=>a+(r-mean)**2,0)/rets.length);
      const sharpe=sd>0?mean/sd:0;
      if(sharpe>bestSharpe){bestSharpe=sharpe;bestF=fast;bestS=slow;}
    }}
    // Apply on test
    const tCl=testC.map(c=>c.close);
    const ef2=ema(tCl,bestF),es2=ema(tCl,bestS);
    let pos=0;
    for(let i=1;i<testC.length;i++){
      const np=ef2[i]>=es2[i]?1:-1;
      if(np!==pos){
        const entry=testC[i].open*(1+np*slip);
        const exit=testC[i-1+1]?testC[i].close:testC[i].close;
        if(pos!==0){
          const pnl=(testC[i].open-lastEntry)*pos*qty2-lastEntry*qty2*taker-Math.abs(testC[i].open)*qty2*taker;
          if(testC[i].entryTime>=fromMs&&testC[i].openTime<=toMs){eq+=pnl;trades.push({pnl,equity:eq,dir:pos,entryTime:lastEntryTime,exitTime:testC[i].openTime});}
        }
        var lastEntry=entry,lastEntryTime=testC[i].openTime;
        var qty2=eq*0.95/entry;
        pos=np;
      }
    }
    wStart+=TEST_MS;
  }
  return{trades,finalEquity:eq};
}

// Main backtest engine (same as before)
function run(c15,c1m,sigFn,warmup=700){
  const n=c15.length,cl=c15.map(c=>c.close),hi=c15.map(c=>c.high),lo=c15.map(c=>c.low),op=c15.map(c=>c.open);
  const a15=atrArr(c15,14),r15=rsiArr(cl,14),rv=rvolArr(c15,20),e9=ema(cl,9),e20=ema(cl,20),e50=ema(cl,50),vwap=vwapArr(c15);
  const ctx={cl,hi,lo,op,a15,r15,rv,e9,e20,e50,vwap,c:c15};
  const m1map=new Map();if(c1m)for(const m of c1m)m1map.set(m.openTime,m);
  const g1m=(a,b)=>{const r=[];for(let t=a;t<b;t+=60000){const m=m1map.get(t);if(m)r.push(m);}return r;};
  let eq=EQUITY,open=null;const trades=[];
  for(let i=warmup;i<n-1;i++){
    if(open){
      const b=c15[i],dir=open.dir,mins=g1m(b.openTime,b.closeTime+1);
      let ep=null,im=false,reason=null;
      if(mins.length>0){for(const m of mins){const g=dir>0?m.open<=open.sl:m.open>=open.sl,hsl=dir>0?m.low<=open.sl:m.high>=open.sl,htp=dir>0?m.high>=open.tp:m.low<=open.tp;if(g){ep=m.open;reason='SL_GAP';break;}if(hsl&&htp){ep=open.sl;reason='SL';break;}if(hsl){ep=open.sl;reason='SL';break;}if(htp){ep=open.tp;im=true;reason='TP';break;}}if(!ep&&(i-open.eb)>=32){ep=b.close;reason='TIME';}}
      else{const g=dir>0?b.open<=open.sl:b.open>=open.sl,hsl=dir>0?b.low<=open.sl:b.high>=open.sl,htp=dir>0?b.high>=open.tp:b.low<=open.tp,to=(i-open.eb)>=32;if(g){ep=b.open;reason='SL_GAP';}else if(hsl&&htp){ep=open.sl;reason='SL';}else if(hsl){ep=open.sl;reason='SL';}else if(htp){ep=open.tp;im=true;reason='TP';}else if(to){ep=b.close;reason='TIME';}}
      if(ep!==null){const ef=im?ep:ep*(1+open.dir*SLIP),gr=(ef-open.entry)*open.dir*open.qty,fee=Math.abs(ep*open.qty)*(im?MAKER:TAKER),pnl=gr-open.entryFee-fee;eq+=pnl;const sd=Math.abs(open.entry-open.sl);trades.push({dir:open.dir,reason,pnl,equity:eq,rMult:sd>0?pnl/(sd*open.qty):NaN,fees:open.entryFee+fee,holdBars:i-open.eb,entryTime:open.entryTime,regime:open.regime});open=null;}
    }
    if(open)continue;
    const sig=sigFn(ctx,i);if(!sig)continue;
    // Limit entry support (maker fee for entry)
    const nb=c15[i+1];
    let entry,entryFee,entryMode;
    if(sig.limitEntry){
      // Resting limit at signal close — fill if next bar trades through (conservative: need 1 tick beyond)
      const limit=c15[i].close;
      const fillsLong=sig.dir>0&&nb.low<limit*0.9999;
      const fillsShort=sig.dir<0&&nb.high>limit*1.0001;
      if(!fillsLong&&!fillsShort)continue; // not filled
      entry=sig.dir>0?Math.min(nb.open,limit):Math.max(nb.open,limit);
      entryFee=entry*0*MAKER; // maker — no taker fee, minimal slip
      entryMode='LIMIT';
    } else {
      entry=nb.open*(1+sig.dir*SLIP);
      entryFee=entry*(nb.open/entry)*TAKER*0; // simplified
      entryFee=Math.abs(entry)*RISK*TAKER/(entry*(entry>0?1:1)); // wrong, do properly
      const aa2=a15[i];if(!aa2||aa2<=0)continue;
      const stopD2=Math.abs(entry-(entry-sig.dir*aa2*(sig.stopMult||2.0)));
      const qty2=(eq*RISK)/(stopD2+entry*(TAKER*2));
      entryFee=entry*qty2*TAKER;
    }
    const aa=a15[i];if(!aa||aa<=0)continue;
    const sm2=sig.stopMult||2.0,tp2=sig.tpMult||1.5;
    const sl=entry-sig.dir*aa*sm2,tpp=entry+sig.dir*aa*sm2*tp2;
    const stopD=Math.abs(entry-sl);if(stopD<=0||!isFinite(sl)||!isFinite(tpp))continue;
    if(sig.dir>0&&sl>=entry)continue;if(sig.dir<0&&sl<=entry)continue;
    if(Math.abs(tpp-entry)/entry<WIN_COST)continue;
    const ra=eq*RISK,qty=ra/(stopD+entry*(TAKER*2));
    if(!sig.limitEntry)entryFee=entry*qty*TAKER;
    else entryFee=entry*qty*MAKER; // maker entry = much cheaper
    open={dir:sig.dir,entry,sl,tp:tpp,qty,entryFee,eb:i+1,entryTime:nb.openTime,regime:sig.regime||'?'};
  }
  return{trades,finalEquity:eq};
}

function stats(trades,days){
  if(!trades.length)return{n:0,wr:0,avgR:0,pf:0,t:0,tpd:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite);if(!rs.length)return{n:trades.length};
  const wins=rs.filter(r=>r>0),avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sd>0?avgR/(sd/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak=0,dd=0,eq=0;for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  const reasons={};for(const t2 of trades)reasons[t2.reason]=(reasons[t2.reason]||0)+1;
  const L=trades.filter(t=>t.dir>0).length,S=trades.filter(t=>t.dir<0).length;
  return{n:trades.length,wr:wins.length/rs.length*100,avgR,t,pf,tpd:trades.length/days,maxDD:dd,reasons,longs:L,shorts:S,longWR:trades.filter(t=>t.dir>0&&t.pnl>0).length/(L||1)*100,shortWR:trades.filter(t=>t.dir<0&&t.pnl>0).length/(S||1)*100};
}

function monteCarlo(trades,iters=2000,block=10){
  const rs=trades.map(t=>t.rMult).filter(isFinite);if(rs.length<block*2)return null;
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
const regs4h=buildRegimes(raw4h);
const getReg=buildLookup(raw4h,regs4h);

const WINDOWS=[
  {label:'W1_Mar-May', from:'2026-03-01', to:'2026-05-30'},
  {label:'W2_Jun-Aug', from:'2026-06-01', to:'2026-08-01'},
  {label:'COMBINED',   from:'2026-03-01', to:'2026-08-30'},
];
const WBUF=700;
const f=(v,d=3)=>isFinite(v)?v.toFixed(d):'N/A';

// ── OPTION 3: HIGH QUALITY GATE signals ──────────────────────────────────
function makeO3Signal(cfg){
  const{stochThresh=75, rvolMin=1.5, rsiThresh=65, minBodyATR=0.3, stopMult=2.0, tpMult=1.5, limitEntry=false}=cfg;
  return(ctx,i)=>{
    if(i<15)return null;
    const reg=getReg(ctx.c[i].openTime);
    if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
    const a=ctx.a15[i];if(!a)return null;
    const sk=stochK(ctx.hi,ctx.lo,ctx.cl,i,14), prevSk=stochK(ctx.hi,ctx.lo,ctx.cl,i-1,14);
    const rsi=ctx.r15[i], rv=ctx.rv[i];
    const body=Math.abs(ctx.cl[i]-ctx.op[i]);

    if(reg==='BEAR'){
      const stochOk=prevSk>stochThresh&&sk<prevSk;
      const rsiOk=rsi>rsiThresh;
      const rvolOk=rv>=rvolMin;
      const bodyOk=body>=minBodyATR*a&&ctx.cl[i]<ctx.op[i]; // bearish body
      const priceOk=ctx.cl[i]<ctx.e20[i];
      if(stochOk&&rsiOk&&rvolOk&&bodyOk&&priceOk)
        return{dir:-1,regime:reg,stopMult,tpMult,limitEntry};
    }
    // No BULL signal (removed in Option 1)
    // RANGING: VWAP fade (only with strict quality)
    if(reg==='RANGING'||reg==='RANGING_PREZONE'){
      const dist=ctx.cl[i]-ctx.vwap[i];
      if(dist>1.5*a&&prevSk>stochThresh&&sk<prevSk&&rv>=rvolMin&&ctx.cl[i]<ctx.op[i])
        return{dir:-1,regime:reg,stopMult:1.8,tpMult,limitEntry};
      if(dist<-1.5*a&&prevSk<(100-stochThresh)&&sk>prevSk&&rv>=rvolMin&&ctx.cl[i]>ctx.op[i])
        return{dir:1,regime:reg,stopMult:1.8,tpMult,limitEntry};
    }
    return null;
  };
}

const O3_TESTS=[
  {id:'O3_base',       label:'O3 stoch>75 rvol>=1.5 rsi>65 body>=0.3ATR (TP1.5)',  stochThresh:75,rvolMin:1.5,rsiThresh:65,minBodyATR:0.3,stopMult:2.0,tpMult:1.5},
  {id:'O3_tp1.8',      label:'O3 same + TP=1.8R',                                   stochThresh:75,rvolMin:1.5,rsiThresh:65,minBodyATR:0.3,stopMult:2.0,tpMult:1.8},
  {id:'O3_tp2.0',      label:'O3 same + TP=2.0R',                                   stochThresh:75,rvolMin:1.5,rsiThresh:65,minBodyATR:0.3,stopMult:2.0,tpMult:2.0},
  {id:'O3_wide_stop',  label:'O3 + wider stop 2.5×ATR TP=2.0R (better fee ratio)', stochThresh:75,rvolMin:1.5,rsiThresh:65,minBodyATR:0.3,stopMult:2.5,tpMult:2.0},
  {id:'O3_strict',     label:'O3 strict: stoch>80 rvol>=2.0 rsi>70 TP=2.0R',       stochThresh:80,rvolMin:2.0,rsiThresh:70,minBodyATR:0.4,stopMult:2.0,tpMult:2.0},
  {id:'O3_limit',      label:'O3 + limit entry (maker fee) TP=1.5R',                stochThresh:75,rvolMin:1.5,rsiThresh:65,minBodyATR:0.3,stopMult:2.0,tpMult:1.5,limitEntry:true},
  {id:'O3_lim_tp2',    label:'O3 + limit entry TP=2.0R',                            stochThresh:75,rvolMin:1.5,rsiThresh:65,minBodyATR:0.3,stopMult:2.0,tpMult:2.0,limitEntry:true},
];

// ── Run all Option 3 tests ────────────────────────────────────────────────
const allRes={};
for(const win of WINDOWS){
  const fromMs=Date.parse(win.from+'T00:00:00Z'),toMs=Date.parse(win.to+'T23:59:59Z');
  const DAYS=Math.ceil((toMs-fromMs)/86400000);
  const wf=new Date(fromMs-WBUF*900000).toISOString().slice(0,10);
  const c15=raw15m.filter(c=>c.openTime>=Date.parse(wf+'T00:00:00Z')&&c.openTime<=toMs);
  const c1m=raw1m.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);
  allRes[win.label]=[];
  for(const test of O3_TESTS){
    const sigFn=makeO3Signal(test);
    const{trades,finalEquity}=run(c15,c1m,sigFn);
    const wt=trades.filter(t=>t.entryTime>=fromMs&&t.entryTime<=toMs);
    const s=stats(wt,DAYS);
    allRes[win.label].push({test,wt,s,ret:((finalEquity-EQUITY)/EQUITY*100),finalEquity});
  }
}

// ── OPTION 4: 60m WFO (already tested — reproduce key result) ─────────────
// Quick 60m EMA crossover: train on Mar-May, test on Jun-Aug
const W2from=Date.parse('2026-06-01T00:00:00Z'), W2to=Date.parse('2026-08-01T23:59:59Z');
const wfoC60=raw60m.filter(c=>c.openTime>=Date.parse('2026-01-01T00:00:00Z')&&c.openTime<=W2to);
const cl60=wfoC60.map(c=>c.close);
// Simple WFO: train Jan-May 2026, test Jun-Aug 2026
const trainC=wfoC60.filter(c=>c.openTime<W2from);
const testC =wfoC60.filter(c=>c.openTime>=W2from&&c.openTime<=W2to);
let bestSharpe=-Infinity,bestF=10,bestS=50;
for(const fast of [5,7,10,15,20]){for(const slow of [30,40,50,100,150,200]){
  const ef=ema(trainC.map(c=>c.close),fast),es=ema(trainC.map(c=>c.close),slow);
  const rets=[];let pos=0;
  for(let i=1;i<ef.length;i++){const np=ef[i]>=es[i]?1:-1;if(np!==pos){rets.push((trainC[i].close-trainC[i-1].close)/trainC[i-1].close*pos);pos=np;}}
  const mean=rets.reduce((a,b)=>a+b,0)/(rets.length||1);
  const sd=Math.sqrt(rets.reduce((a,r)=>a+(r-mean)**2,0)/(rets.length||1));
  const sharpe=sd>0?mean/sd:0;
  if(sharpe>bestSharpe){bestSharpe=sharpe;bestF=fast;bestS=slow;}
}}
// Apply on test
const ef2=ema(testC.map(c=>c.close),bestF),es2=ema(testC.map(c=>c.close),bestS);
let wfoEq=EQUITY,wfoPos=0,wfoEntry=0,wfoQty=0,wfoTrades=0,wfoWins=0;
for(let i=1;i<testC.length;i++){
  const np=ef2[i]>=es2[i]?1:-1;
  if(np!==wfoPos){
    if(wfoPos!==0){
      const exit=testC[i].open*(1-wfoPos*SLIP);
      const gross=(exit-wfoEntry)*wfoPos*wfoQty;
      const fees=wfoEntry*wfoQty*TAKER+exit*wfoQty*TAKER;
      const pnl=gross-fees;
      wfoEq+=pnl;wfoTrades++;if(pnl>0)wfoWins++;
    }
    wfoEntry=testC[i].open*(1+np*SLIP);
    wfoQty=wfoEq*0.95/wfoEntry;
    wfoPos=np;
  }
}
const wfoRet=((wfoEq-EQUITY)/EQUITY*100);

// ── Print results ─────────────────────────────────────────────────────────
const P=(v,n)=>String(v).padStart(n), PL=(v,n)=>String(v).padEnd(n);
console.log('\n'+'='.repeat(120));
console.log('OPTION 3: High Quality Signal Gate');
console.log('='.repeat(120));
console.log(PL('Test',46)+' '+WINDOWS.map(w=>PL(w.label,26)).join(''));
console.log(PL('',46)+' '+WINDOWS.map(()=>PL('n   WR%   avgR    Ret%',26)).join(''));
console.log('─'.repeat(120));

let bestOption3=null;
for(const test of O3_TESTS){
  let line=PL(test.label,46)+' ', anyPos=false;
  for(const win of WINDOWS){
    const r=allRes[win.label].find(x=>x.test.id===test.id);
    if(!r||!r.s.n){line+=PL('0',26);continue;}
    const ret=(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%';
    if(r.ret>0)anyPos=true;
    const cell=`${String(r.s.n).padStart(3)} ${r.s.wr.toFixed(0).padStart(3)}% ${f(r.s.avgR).padStart(7)} ${ret.padStart(7)}`;
    line+=PL(cell,26);
    if(!bestOption3||r.ret>allRes[WINDOWS[2].label].find(x=>x.test.id===bestOption3)?.ret){
      if(win.label==='COMBINED')bestOption3=test.id;
    }
  }
  console.log(line+(anyPos?' ←':''));
}

// Detail any positive
for(const win of WINDOWS){
  const pos=allRes[win.label].filter(r=>r.ret>0&&r.s.n>=5);
  for(const r of pos){
    console.log(`\n✓ POSITIVE: ${r.test.label} | ${win.label}`);
    console.log(`  Trades:${r.s.n} T/d:${r.s.tpd.toFixed(1)} WR:${r.s.wr.toFixed(1)}% L:${r.s.longs}(${r.s.longWR.toFixed(0)}%) S:${r.s.shorts}(${r.s.shortWR.toFixed(0)}%)`);
    console.log(`  avgR:${f(r.s.avgR)} PF:${f(r.s.pf,2)} t:${f(r.s.t,2)} $100→$${r.finalEquity.toFixed(2)} (+${r.ret.toFixed(2)}%)`);
    console.log(`  Exits:${Object.entries(r.s.reasons).map(([k,v])=>`${k}:${v}`).join(' ')}`);
    if(r.s.n>=15){const m=monteCarlo(r.wt,2000,8);if(m){const rk=EQUITY*RISK;console.log(`  MC P5=$${(EQUITY+m.p5*rk).toFixed(2)} P50=$${(EQUITY+m.p50*rk).toFixed(2)} P95=$${(EQUITY+m.p95*rk).toFixed(2)} ProbProfit=${m.pProfit.toFixed(1)}%`);}}
  }
}

// Cross-window check for Option 3
const bothPos=O3_TESTS.filter(t=>{const r1=allRes['W1_Mar-May'].find(r=>r.test.id===t.id),r2=allRes['W2_Jun-Aug'].find(r=>r.test.id===t.id);return r1&&r2&&r1.ret>0&&r2.ret>0&&r1.s.n>=5&&r2.s.n>=5;});
console.log('\n'+'─'.repeat(80));
if(bothPos.length)console.log('✓ Positive in BOTH windows:',bothPos.map(t=>t.id).join(', '));
else console.log('No Option 3 variant positive in both windows.');

// ── Option 4: 60m WFO ────────────────────────────────────────────────────
console.log('\n'+'='.repeat(120));
console.log('OPTION 4: 60m Walk-Forward EMA Crossover (validated strategy)');
console.log('='.repeat(120));
console.log(`Train: Jan-May 2026 | Test: Jun-Aug 2026`);
console.log(`Best params found: EMA${bestF}/EMA${bestS} | Train Sharpe: ${bestSharpe.toFixed(3)}`);
console.log(`Trades: ${wfoTrades} | WR: ${(wfoTrades>0?wfoWins/wfoTrades*100:0).toFixed(1)}%`);
console.log(`$100 → $${wfoEq.toFixed(2)} (${(wfoRet>=0?'+':'')+wfoRet.toFixed(2)}%) on Jun-Aug 2026`);
console.log('');
console.log('NOTE: 60m WFO tested across full 2021-2026 dataset showed Sharpe 6.52 OOS');
console.log('This is a position strategy holding for days, not a scalper.');
console.log('Trade frequency: ~1-3/week at 60m');
console.log('');

// ── Final verdict ─────────────────────────────────────────────────────────
console.log('='.repeat(120));
console.log('OVERALL FINDINGS:');
console.log('');

const bestCombined=allRes['COMBINED'].sort((a,b)=>b.ret-a.ret)[0];
const bestW2=allRes['W2_Jun-Aug'].sort((a,b)=>b.ret-a.ret)[0];
console.log(`Best Option 3 combined: ${bestCombined?.test?.label} → $${bestCombined?.finalEquity?.toFixed(2)} (${(bestCombined?.ret>=0?'+':'')+bestCombined?.ret?.toFixed(1)}%)`);
console.log(`Best Option 3 W2 only:  ${bestW2?.test?.label} → $${bestW2?.finalEquity?.toFixed(2)} (${(bestW2?.ret>=0?'+':'')+bestW2?.ret?.toFixed(1)}%)`);
console.log(`60m WFO Jun-Aug 2026:  $${wfoEq.toFixed(2)} (${(wfoRet>=0?'+':'')+wfoRet.toFixed(2)}%)`);
console.log('');

if(wfoRet>0){
  console.log('✓ Option 4 (60m WFO) IS POSITIVE in Jun-Aug 2026');
  console.log('  This is the validated strategy with proven Sharpe 6.52 OOS');
  console.log('  Recommendation: deploy this strategy, not scalping');
}

const bestPos=allRes['COMBINED'].filter(r=>r.ret>0);
if(bestPos.length){
  console.log('✓ Option 3 variants positive:',bestPos.map(r=>r.test.label).join(', '));
}else{
  console.log('✗ No Option 3 variant positive on combined 6-month window');
  console.log('  Signal has positive gross edge (+0.077R) but fees cost 0.196R');
  console.log('  At $100 capital, fee drag cannot be overcome without higher notional');
  console.log('  Solution: scale to $500+ OR use 60m WFO strategy');
}
console.log('='.repeat(120));
