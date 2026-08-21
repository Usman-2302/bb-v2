'use strict';
/**
 * Options 1 + 2 Test
 *
 * OPTION 1: Remove BULL signal entirely
 *   Rationale: BULL impulse WR=17.7%, pullback WR=7% — both worse than random
 *   Keep only: BEAR stochastic fade (WR ~39-42%) + RANGING VWAP fade
 *
 * OPTION 2: Reduce TP to match MFE reality
 *   P50 MFE = 0.55R — half of trades reach this max
 *   P90 MFE = 2.47R — 90% reach this at some point
 *   Best isolated result: TP 2.0R = +11.7% on VH BEAR W2
 *   Test: 1.0R, 1.5R, 1.8R, 2.0R, 2.5R, 3.0R
 *
 * COMBINED OPTION 1+2: No BULL + optimal TP
 *
 * ALSO TESTS:
 *   - BEAR only (no RANGING trades either)
 *   - BEAR + RANGING with optimal TP
 *   - Effect of RVOL filter on RANGING trades
 *
 * Windows: W1 Mar-May 2026, W2 Jun-Aug 2026, Combined Mar-Aug 2026
 * Monte Carlo on any positive result.
 */

const fs = require('fs');

// ── Constants ─────────────────────────────────────────────────────────────
const EQUITY = 100, RISK = 0.01;
const TAKER = 0.0005, MAKER = 0.0002, SLIP = 0.0006;
const WIN_COST = TAKER + MAKER;
const LOSS_COST = TAKER*2 + SLIP*2;

// ── Helpers ───────────────────────────────────────────────────────────────
function loadNDJSON(f) {
  const o = [];
  for (const l of fs.readFileSync(f,'utf8').split('\n')) {
    if (!l.trim()) continue; try { o.push(JSON.parse(l)); } catch(e) {}
  }
  o.sort((a,b)=>a.openTime-b.openTime);
  const d=[]; for(const c of o){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);} return d;
}
function resample(base,tfMs) {
  const bMs=base[1].openTime-base[0].openTime; if(tfMs===bMs)return base.slice();
  const exp=tfMs/bMs; const out=[]; let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}
    else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}cnt++;
  }if(cur&&cnt===exp)out.push(cur);return out;
}
function ema(p,n){const k=2/(n+1);const o=Array(p.length).fill(NaN);let v=NaN;for(let i=0;i<p.length;i++){v=!isFinite(v)?p[i]:p[i]*k+v*(1-k);o[i]=v;}return o;}
function atrArr(c,n=14){const o=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));s=!isFinite(s)?tr:s*(n-1)/n+tr/n;o[i]=s;prev=c[i].close;}return o;}
function rsiArr(cl,n=14){const o=Array(cl.length).fill(50);let ag=0,al=0;for(let i=1;i<cl.length;i++){const d=cl[i]-cl[i-1];const g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g/n;al+=l/n;if(i===n)o[i]=al===0?100:100-100/(1+ag/al);}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}
function rvolArr(c,n=20){const v=c.map(x=>x.volume);const o=Array(c.length).fill(1);let s=0;for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)o[i]=(s/n)>0?v[i]/(s/n):1;}return o;}
function vwapArr(c){const o=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;for(let i=0;i<c.length;i++){const d=Math.floor(c[i].openTime/86400000)*86400000;if(d!==day){day=d;pv=0;vv=0;}const tp=(c[i].high+c[i].low+c[i].close)/3;pv+=tp*c[i].volume;vv+=c[i].volume;o[i]=vv>0?pv/vv:c[i].close;}return o;}
function erArr(cl,n=10){const o=Array(cl.length).fill(0.5);for(let i=n;i<cl.length;i++){const net=Math.abs(cl[i]-cl[i-n]);let path=0;for(let j=i-n+1;j<=i;j++)path+=Math.abs(cl[j]-cl[j-1]);o[i]=path>0?net/path:0;}return o;}

// ── Validated 4H regime ───────────────────────────────────────────────────
function buildRegimes(c4h) {
  const cl=c4h.map(c=>c.close),e200=ema(cl,200),atr=atrArr(c4h,14),erv=erArr(cl,10);
  const n=c4h.length,LOOK=20,THR=0.011,AF=2,ZER=0.15,ZCD=3;
  const raw=Array(n).fill('RANGING');
  for(let i=LOOK;i<n;i++){
    const ap=(atr[i]||0)/c4h[i].close*100; if(ap>5){raw[i]='CRISIS';continue;}
    if(!isFinite(e200[i])||!isFinite(atr[i-LOOK]))continue;
    const s=(e200[i]-e200[i-LOOK])/(atr[i]*LOOK);
    raw[i]=s>THR?'BULL':s<-THR?'BEAR':'RANGING';
  }
  const sm=Array(n).fill('RANGING'); let cur='RANGING',pend=null,pc=0; sm[0]=raw[0]; cur=raw[0];
  for(let i=1;i<n;i++){if(raw[i]==='CRISIS'){cur='CRISIS';pend=null;pc=0;sm[i]='CRISIS';continue;}if(raw[i]===cur){pend=null;pc=0;sm[i]=cur;}else if(raw[i]===pend){pc++;if(pc>=AF){cur=pend;pend=null;pc=0;}sm[i]=cur;}else{pend=raw[i];pc=1;sm[i]=cur;}}
  let zc=0,cc=0,za=false; const final=Array(n);
  for(let i=0;i<n;i++){if(sm[i]!=='RANGING'){zc=0;cc=0;za=false;final[i]=sm[i];continue;}if(erv[i]<ZER){zc++;cc=0;}else{cc++;zc=0;}if(!za&&zc>=ZCD)za=true;if(za&&cc>=ZCD)za=false;final[i]=za?'RANGING_ZOMBIE':'RANGING';}
  return final;
}
function buildLookup(c4h,regs){
  return (t)=>{let lo=0,hi=c4h.length-1,idx=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(c4h[mid].closeTime<=t){idx=mid;lo=mid+1;}else hi=mid-1;}return idx>=0?regs[idx]:'RANGING';};
}
function stochK(hi,lo,cl,i,n=14){if(i<n)return 50;let hh=-Infinity,ll=Infinity;for(let j=i-n+1;j<=i;j++){if(hi[j]>hh)hh=hi[j];if(lo[j]<ll)ll=lo[j];}return hh!==ll?(cl[i]-ll)/(hh-ll)*100:50;}

// ── Engine ────────────────────────────────────────────────────────────────
function run(c15, c1m, sigFn, warmup=700) {
  const n=c15.length, cl=c15.map(c=>c.close), hi=c15.map(c=>c.high), lo=c15.map(c=>c.low), op=c15.map(c=>c.open);
  const a15=atrArr(c15,14), r15=rsiArr(cl,14), rv=rvolArr(c15,20);
  const e9=ema(cl,9), e20=ema(cl,20), e50=ema(cl,50);
  const vwap=vwapArr(c15);
  const ctx={cl,hi,lo,op,a15,r15,rv,e9,e20,e50,vwap,c:c15};
  const m1map=new Map(); if(c1m)for(const m of c1m)m1map.set(m.openTime,m);
  const g1m=(a,b)=>{const r=[];for(let t=a;t<b;t+=60000){const m=m1map.get(t);if(m)r.push(m);}return r;};
  let eq=EQUITY, open=null; const trades=[];
  for(let i=warmup;i<n-1;i++){
    if(open){
      const b=c15[i],dir=open.dir,mins=g1m(b.openTime,b.closeTime+1);
      let ep=null,im=false,reason=null;
      if(mins.length>0){for(const m of mins){const g=dir>0?m.open<=open.sl:m.open>=open.sl,hsl=dir>0?m.low<=open.sl:m.high>=open.sl,htp=dir>0?m.high>=open.tp:m.low<=open.tp;if(g){ep=m.open;reason='SL_GAP';break;}if(hsl&&htp){ep=open.sl;reason='SL';break;}if(hsl){ep=open.sl;reason='SL';break;}if(htp){ep=open.tp;im=true;reason='TP';break;}}if(!ep&&(i-open.eb)>=32){ep=b.close;reason='TIME';}}
      else{const g=dir>0?b.open<=open.sl:b.open>=open.sl,hsl=dir>0?b.low<=open.sl:b.high>=open.sl,htp=dir>0?b.high>=open.tp:b.low<=open.tp,to=(i-open.eb)>=32;if(g){ep=b.open;reason='SL_GAP';}else if(hsl&&htp){ep=open.sl;reason='SL';}else if(hsl){ep=open.sl;reason='SL';}else if(htp){ep=open.tp;im=true;reason='TP';}else if(to){ep=b.close;reason='TIME';}}
      if(ep!==null){const ef=im?ep:ep*(1+open.dir*SLIP),gr=(ef-open.entry)*open.dir*open.qty,fee=Math.abs(ep*open.qty)*(im?MAKER:TAKER),pnl=gr-open.entryFee-fee;eq+=pnl;const sd=Math.abs(open.entry-open.sl);trades.push({dir:open.dir,reason,pnl,equity:eq,rMult:sd>0?pnl/(sd*open.qty):NaN,fees:open.entryFee+fee,holdBars:i-open.eb,entryTime:open.entryTime,exitTime:b.closeTime,regime:open.regime});open=null;}
    }
    if(open)continue;
    const sig=sigFn(ctx,i); if(!sig)continue;
    const nb=c15[i+1],entry=nb.open*(1+sig.dir*SLIP),aa=a15[i]; if(!aa||aa<=0)continue;
    const sm=sig.stopMult||2.0,tp=sig.tpMult||2.0;
    const sl=entry-sig.dir*aa*sm,tpp=entry+sig.dir*aa*sm*tp;
    const stopD=Math.abs(entry-sl); if(stopD<=0||!isFinite(sl)||!isFinite(tpp))continue;
    if(sig.dir>0&&sl>=entry)continue; if(sig.dir<0&&sl<=entry)continue;
    if(Math.abs(tpp-entry)/entry<WIN_COST)continue;
    const ra=eq*RISK,qty=ra/(stopD+entry*(TAKER*2)),ef=entry*qty*TAKER;
    open={dir:sig.dir,entry,sl,tp:tpp,qty,entryFee:ef,eb:i+1,entryTime:nb.openTime,regime:sig.regime};
  }
  return{trades,finalEquity:eq};
}

function stats(trades,days){
  if(!trades.length)return{n:0,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite); if(!rs.length)return{n:trades.length,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0};
  const wins=rs.filter(r=>r>0),avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sd>0?avgR/(sd/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak=0,dd=0,eq=0; for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  const reasons={};for(const t2 of trades)reasons[t2.reason]=(reasons[t2.reason]||0)+1;
  const L=trades.filter(t=>t.dir>0).length,S=trades.filter(t=>t.dir<0).length;
  return{n:trades.length,wr:wins.length/rs.length*100,avgR,t,pf,tpd:trades.length/days,maxDD:dd,reasons,longs:L,shorts:S,longWR:trades.filter(t=>t.dir>0&&t.pnl>0).length/(L||1)*100,shortWR:trades.filter(t=>t.dir<0&&t.pnl>0).length/(S||1)*100};
}

function monteCarlo(trades,iters=2000,block=10){
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
const regs4h=buildRegimes(raw4h);
const getReg=buildLookup(raw4h,regs4h);

const WINDOWS=[
  {label:'W1 Mar-May-2026', from:'2026-03-01', to:'2026-05-30'},
  {label:'W2 Jun-Aug-2026', from:'2026-06-01', to:'2026-08-01'},
  {label:'COMBINED Mar-Aug', from:'2026-03-01', to:'2026-08-30'},
];
const WBUF=700;
const f=(v,d=3)=>isFinite(v)?v.toFixed(d):'N/A';

// ── SIGNAL VARIANTS ────────────────────────────────────────────────────────
// All combinations of Option 1 (no BULL) + Option 2 (TP levels)
function makeSignal(cfg) {
  const {bearTP, rangeTP, includeRanging, rvolMin} = cfg;
  return (ctx, i) => {
    if(i<15)return null;
    const reg=getReg(ctx.c[i].openTime);
    if(reg==='RANGING_ZOMBIE'||reg==='CRISIS')return null;
    const a=ctx.a15[i]; if(!a)return null;
    const sk=stochK(ctx.hi,ctx.lo,ctx.cl,i,14);
    const prevSk=stochK(ctx.hi,ctx.lo,ctx.cl,i-1,14);

    // BEAR: stochastic overbought fade short
    if(reg==='BEAR'){
      const stochOk=prevSk>70&&sk<prevSk;
      const barOk=ctx.cl[i]<ctx.op[i]&&ctx.cl[i]<ctx.e20[i];
      const impulseOk=ctx.rv[i]>=(rvolMin||0)&&ctx.cl[i]<ctx.op[i]&&ctx.e9[i]<ctx.e20[i];
      if((stochOk&&barOk)||(ctx.rv[i]>=2.0&&impulseOk))
        return{dir:-1,regime:reg,stopMult:2.0,tpMult:bearTP};
    }

    // BULL: REMOVED in Option 1 (no long trades)

    // RANGING: VWAP fade (optional)
    if(includeRanging&&(reg==='RANGING'||reg==='RANGING_PREZONE')){
      const dist=ctx.cl[i]-ctx.vwap[i];
      const rvolOk=ctx.rv[i]>=(rvolMin||0.8);
      if(dist<-1.5*a&&prevSk<25&&sk>prevSk&&ctx.cl[i]>ctx.op[i]&&rvolOk)
        return{dir:1,regime:reg,stopMult:1.8,tpMult:rangeTP};
      if(dist>1.5*a&&prevSk>75&&sk<prevSk&&ctx.cl[i]<ctx.op[i]&&rvolOk)
        return{dir:-1,regime:reg,stopMult:1.8,tpMult:rangeTP};
    }
    return null;
  };
}

// Test matrix
const TESTS=[
  // Option 1 only: BEAR shorts, various TPs
  {id:'O1_bear_tp1.0', bearTP:1.0, rangeTP:1.0, includeRanging:false, label:'BEAR only TP=1.0R'},
  {id:'O1_bear_tp1.5', bearTP:1.5, rangeTP:1.5, includeRanging:false, label:'BEAR only TP=1.5R'},
  {id:'O1_bear_tp1.8', bearTP:1.8, rangeTP:1.8, includeRanging:false, label:'BEAR only TP=1.8R'},
  {id:'O1_bear_tp2.0', bearTP:2.0, rangeTP:2.0, includeRanging:false, label:'BEAR only TP=2.0R'},
  {id:'O1_bear_tp2.5', bearTP:2.5, rangeTP:2.5, includeRanging:false, label:'BEAR only TP=2.5R'},
  {id:'O1_bear_tp3.0', bearTP:3.0, rangeTP:3.0, includeRanging:false, label:'BEAR only TP=3.0R'},
  // Option 1+2: BEAR + RANGING, various TPs
  {id:'O12_tp1.5', bearTP:1.5, rangeTP:1.5, includeRanging:true, label:'BEAR+RANGE TP=1.5R'},
  {id:'O12_tp1.8', bearTP:1.8, rangeTP:1.8, includeRanging:true, label:'BEAR+RANGE TP=1.8R'},
  {id:'O12_tp2.0', bearTP:2.0, rangeTP:2.0, includeRanging:true, label:'BEAR+RANGE TP=2.0R'},
  {id:'O12_tp2.5', bearTP:2.5, rangeTP:2.5, includeRanging:true, label:'BEAR+RANGE TP=2.5R'},
  // Option 1+2 with RVOL filter on RANGING
  {id:'O12_tp1.8_rv1.2', bearTP:1.8, rangeTP:1.8, includeRanging:true, rvolMin:1.2, label:'BEAR+RANGE TP=1.8R RVOL>=1.2'},
  {id:'O12_tp2.0_rv1.2', bearTP:2.0, rangeTP:2.0, includeRanging:true, rvolMin:1.2, label:'BEAR+RANGE TP=2.0R RVOL>=1.2'},
];

// Run all tests on all windows
const allResults={};
for(const win of WINDOWS){
  const fromMs=Date.parse(win.from+'T00:00:00Z'), toMs=Date.parse(win.to+'T23:59:59Z');
  const DAYS=Math.ceil((toMs-fromMs)/86400000);
  const wf=new Date(fromMs-WBUF*900000).toISOString().slice(0,10);
  const c15=raw15m.filter(c=>c.openTime>=Date.parse(wf+'T00:00:00Z')&&c.openTime<=toMs);
  const c1m=raw1m.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);
  allResults[win.label]=[];
  for(const test of TESTS){
    const sigFn=makeSignal(test);
    const {trades,finalEquity}=run(c15,c1m,sigFn);
    const wt=trades.filter(t=>t.entryTime>=fromMs&&t.entryTime<=toMs);
    const s=stats(wt,DAYS);
    const ret=((finalEquity-EQUITY)/EQUITY*100);
    allResults[win.label].push({test,wt,s,ret,finalEquity});
  }
}

// ── Print comparison table ─────────────────────────────────────────────────
const P=(v,n)=>String(v).padStart(n), PL=(v,n)=>String(v).padEnd(n);
console.log('\n'+'='.repeat(120));
console.log('OPTIONS 1 + 2: Remove BULL signal + Optimize TP');
console.log('BULL signal removed (WR was 17.7% impulse, 7.0% pullback = catastrophic)');
console.log('='.repeat(120));
console.log(PL('Test',34)+' '+WINDOWS.map(w=>PL(w.label.slice(0,22),26)).join(''));
console.log(PL('',34)+' '+WINDOWS.map(()=>PL('n   WR%   avgR  Ret%',26)).join(''));
console.log('─'.repeat(120));

for(const test of TESTS){
  let line=PL(test.label,34)+' ';
  let anyPos=false;
  for(const win of WINDOWS){
    const r=allResults[win.label].find(x=>x.test.id===test.id);
    if(!r||!r.s.n){line+=PL('0',26);continue;}
    const retStr=(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%';
    if(r.ret>0)anyPos=true;
    const cell=`${String(r.s.n).padStart(3)} ${r.s.wr.toFixed(0).padStart(3)}% ${f(r.s.avgR).padStart(7)} ${retStr.padStart(7)}`;
    line+=PL(cell,26);
  }
  const mark=anyPos?' ←':'';
  console.log(line+mark);
}

// ── Detail any positive results ────────────────────────────────────────────
console.log('\n'+'='.repeat(80));
console.log('POSITIVE RESULTS (avgR > 0 in any window):');
let foundAny=false;
for(const win of WINDOWS){
  const res=allResults[win.label];
  const pos=res.filter(r=>r.ret>0&&r.s.n>=10);
  if(!pos.length)continue;
  for(const r of pos){
    foundAny=true;
    console.log(`\n✓ ${r.test.label} — ${win.label}`);
    console.log(`  Trades: ${r.s.n} | T/day: ${r.s.tpd.toFixed(1)} | WR: ${r.s.wr.toFixed(1)}% | L: ${r.s.longs}(WR${r.s.longWR.toFixed(0)}%) S: ${r.s.shorts}(WR${r.s.shortWR.toFixed(0)}%)`);
    console.log(`  avgR: ${f(r.s.avgR)} | PF: ${f(r.s.pf,2)} | t-stat: ${f(r.s.t,2)} | MaxDD: ${f(r.s.maxDD,1)}R`);
    console.log(`  $100 → $${r.finalEquity.toFixed(2)} (+${r.ret.toFixed(2)}%)`);
    console.log(`  Exits: ${Object.entries(r.s.reasons).map(([k,v])=>`${k}:${v}`).join(' ')}`);

    // Daily P&L for W2 and Combined
    if(win.label.includes('Jun')||win.label.includes('COMBINED')){
      const dayMap={};for(const t of r.wt){const d=new Date(t.entryTime).toISOString().slice(0,10);if(!dayMap[d])dayMap[d]={pnl:0,n:0};dayMap[d].pnl+=t.pnl;dayMap[d].n++;}
      let running=EQUITY;
      console.log('  Daily P&L:');
      for(const [d,v] of Object.entries(dayMap).sort()){
        running+=v.pnl;
        console.log(`    ${d} n=${v.n} P&L=${(v.pnl>=0?'+':'')+v.pnl.toFixed(2).padStart(7)} eq=$${running.toFixed(2)}`);
      }
    }

    // Monte Carlo
    if(r.s.n>=20){
      const m=monteCarlo(r.wt,2000,8);
      if(m){
        const rk=EQUITY*RISK;
        console.log(`  Monte Carlo (2000 iters):`);
        console.log(`    P5=$${(EQUITY+m.p5*rk).toFixed(2)} P25=$${(EQUITY+m.p25*rk).toFixed(2)} P50=$${(EQUITY+m.p50*rk).toFixed(2)} P75=$${(EQUITY+m.p75*rk).toFixed(2)} P95=$${(EQUITY+m.p95*rk).toFixed(2)}`);
        console.log(`    P95MaxDD=$${(m.p95DD*rk).toFixed(2)} | ProbProfit=${m.pProfit.toFixed(1)}%`);
      }
    }
  }
}
if(!foundAny){
  console.log('\nNo positive results found.');
  // Show least bad
  for(const win of WINDOWS){
    const best=allResults[win.label].filter(r=>r.s.n>=5).sort((a,b)=>b.ret-a.ret)[0];
    if(best)console.log(`  Least bad ${win.label}: ${best.test.label} → $${best.finalEquity.toFixed(2)} (${(best.ret>=0?'+':'')+best.ret.toFixed(1)}%)`);
  }
}

// ── Cross-window survivors ────────────────────────────────────────────────
console.log('\n'+'='.repeat(80));
console.log('CROSS-WINDOW: Tests positive in BOTH W1 and W2:');
const w1r=allResults[WINDOWS[0].label], w2r=allResults[WINDOWS[1].label];
const both=TESTS.map(t=>{
  const r1=w1r.find(r=>r.test.id===t.id), r2=w2r.find(r=>r.test.id===t.id);
  if(!r1||!r2||r1.s.n<5||r2.s.n<5)return null;
  return{id:t.id,label:t.label,r1,r2,sum:r1.ret+r2.ret};
}).filter(Boolean).filter(x=>x.r1.ret>0&&x.r2.ret>0);

if(both.length){
  console.log(`✓ ${both.length} test(s) profitable in BOTH windows:`);
  both.sort((a,b)=>b.sum-a.sum);
  for(const b of both){
    console.log(`  ${b.label}: W1 ${(b.r1.ret>=0?'+':'')+b.r1.ret.toFixed(1)}% W2 ${(b.r2.ret>=0?'+':'')+b.r2.ret.toFixed(1)}%`);
  }
} else {
  console.log('No test profitable in both windows.');
}

console.log('\n'+'='.repeat(80));
console.log('SUMMARY:');
console.log('  Option 1 (remove BULL): reduces trade count, focuses on BEAR fades');
console.log('  Option 2 (reduce TP): matches actual MFE reality (P50 MFE=0.55R)');
console.log('  ← marks tests with any positive window');
console.log('='.repeat(80));
