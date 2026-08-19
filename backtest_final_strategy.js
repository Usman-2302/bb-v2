'use strict';
/**
 * BulletBrain — Final Regime-Adaptive Strategy
 *
 * STRATEGY: REGIME-ADAPTIVE (different signal per regime)
 *   BULL  → VF style: high-volume impulse with EMA stack alignment
 *           (momentum continuation — BULL market moves fast, need fast entry)
 *   BEAR  → VH style: stochastic overbought fade + EMA below
 *           (shorting bounces — BEAR market bounces to be faded)
 *   RANGING → VH style: stochastic extreme + VWAP deviation
 *           (range-bound oscillation)
 *   ZOMBIE/CRISIS → FLAT (no trades)
 *
 * POSITION SIZING (fully transparent):
 *   Equity: $100 | Risk: 1% = $1/trade
 *   Stop: 2.0×ATR (15m) — at ETH $1800, ATR≈$8, stop≈$16
 *   qty = $1 / ($16 + entry × 0.0022) ≈ 0.061 ETH
 *   Notional: ~$110 — ~1.1× equity (essentially unleveraged)
 *   If leveraged at 5×: maxNotional=$400 (RISK_PCT binds first)
 *   Fee model: taker 0.05% + slip 0.06%/side on entry/SL exits
 *              maker 0.02% on TP exits (resting limit order)
 *   Funding fee: ~$0.002/trade at current ETH rates (negligible, not modeled)
 *
 * TESTED ON:
 *   Combined: Mar 1 – Aug 30 2026 (6 months, both regimes)
 *   W1:       Mar 1 – May 30 2026 (BULL 40% / BEAR 36% / RANGING 21%)
 *   W2:       Jun 1 – Aug 1 2026  (BULL 37% / BEAR 55% / RANGING 8%)
 *
 * MONTE CARLO: 1000 iterations, 10-bar blocks
 * Usage: node backtest_final_strategy.js
 */

const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────
const EQUITY   = 100;
const RISK_PCT = 0.01;       // 1% risk per trade = $1 at $100 equity
const LEVERAGE = 5;          // cap (usually doesn't bind at 1% risk)
const TAKER    = 0.0005;     // 0.05% — from account's own userTrades fills
const MAKER    = 0.0002;     // 0.02% — limit TP exits
const SLIP     = 0.0006;     // 0.06%/side — market order slippage
const WIN_COST = TAKER + MAKER;
const LOSS_COST= TAKER*2 + SLIP*2;  // taker in + taker stop + 2×slip

// STOP/TP configuration per regime
const PARAMS = {
  BULL:    { stopMult: 2.0, tpMult: 2.5 },  // impulse trades, tighter hold
  BEAR:    { stopMult: 2.0, tpMult: 2.5 },  // fade bounces
  RANGING: { stopMult: 1.8, tpMult: 2.5 },  // range — smaller moves
  default: { stopMult: 2.0, tpMult: 2.5 },
};
const MAX_HOLD_BARS = 32;  // 8 hours max at 15m

// ── Data helpers ──────────────────────────────────────────────────────────
function loadNDJSON(f) {
  const o=[];for(const l of fs.readFileSync(f,'utf8').split('\n')){if(!l.trim())continue;try{o.push(JSON.parse(l));}catch(e){}}
  o.sort((a,b)=>a.openTime-b.openTime);const d=[];for(const c of o){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}return d;
}
function resample(base,tfMs){
  const bMs=base[1].openTime-base[0].openTime;if(tfMs===bMs)return base.slice();
  const exp=tfMs/bMs;const out=[];let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}
    else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}cnt++;
  }if(cur&&cnt===exp)out.push(cur);return out;
}

// ── Indicators ────────────────────────────────────────────────────────────
function ema(p,n){const k=2/(n+1);const o=Array(p.length).fill(NaN);let v=NaN;for(let i=0;i<p.length;i++){v=!isFinite(v)?p[i]:p[i]*k+v*(1-k);o[i]=v;}return o;}
function atrArr(c,n=14){const o=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));s=!isFinite(s)?tr:s*(n-1)/n+tr/n;o[i]=s;prev=c[i].close;}return o;}
function rsiArr(cl,n=14){const o=Array(cl.length).fill(50);let ag=0,al=0;for(let i=1;i<cl.length;i++){const d=cl[i]-cl[i-1];const g=d>0?d:0,l=d<0?-d:0;if(i<=n){ag+=g/n;al+=l/n;if(i===n)o[i]=al===0?100:100-100/(1+ag/al);}else{ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}
function rvolArr(c,n=20){const v=c.map(x=>x.volume);const o=Array(c.length).fill(1);let s=0;for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)o[i]=(s/n)>0?v[i]/(s/n):1;}return o;}
function vwapArr(c){const o=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;for(let i=0;i<c.length;i++){const d=Math.floor(c[i].openTime/86400000)*86400000;if(d!==day){day=d;pv=0;vv=0;}const tp=(c[i].high+c[i].low+c[i].close)/3;pv+=tp*c[i].volume;vv+=c[i].volume;o[i]=vv>0?pv/vv:c[i].close;}return o;}
function erArr(cl,n=10){const o=Array(cl.length).fill(0.5);for(let i=n;i<cl.length;i++){const net=Math.abs(cl[i]-cl[i-n]);let path=0;for(let j=i-n+1;j<=i;j++)path+=Math.abs(cl[j]-cl[j-1]);o[i]=path>0?net/path:0;}return o;}

// ── Validated 4H regime detector ─────────────────────────────────────────
function buildValidatedRegimes(c4h) {
  const cl=c4h.map(c=>c.close),e200=ema(cl,200),atr=atrArr(c4h,14),erv=erArr(cl,10);
  const n=c4h.length,LOOK=20,THR=0.011,AF=2,ZER=0.15,ZCD=3;
  const raw=Array(n).fill('RANGING');
  for(let i=LOOK;i<n;i++){
    const ap=(atr[i]||0)/c4h[i].close*100;if(ap>5){raw[i]='CRISIS';continue;}
    if(!isFinite(e200[i])||!isFinite(atr[i-LOOK])){continue;}
    const s=(e200[i]-e200[i-LOOK])/(atr[i]*LOOK);
    raw[i]=s>THR?'BULL':s<-THR?'BEAR':'RANGING';
  }
  const sm=Array(n).fill('RANGING');let cur='RANGING',pend=null,pc=0;sm[0]=raw[0];cur=raw[0];
  for(let i=1;i<n;i++){if(raw[i]==='CRISIS'){cur='CRISIS';pend=null;pc=0;sm[i]='CRISIS';continue;}if(raw[i]===cur){pend=null;pc=0;sm[i]=cur;}else if(raw[i]===pend){pc++;if(pc>=AF){cur=pend;pend=null;pc=0;}sm[i]=cur;}else{pend=raw[i];pc=1;sm[i]=cur;}}
  let zc=0,cc=0,za=false;const final=Array(n);
  for(let i=0;i<n;i++){if(sm[i]!=='RANGING'){zc=0;cc=0;za=false;final[i]=sm[i];continue;}if(erv[i]<ZER){zc++;cc=0;}else{cc++;zc=0;}if(!za&&zc>=ZCD)za=true;if(za&&cc>=ZCD)za=false;final[i]=za?'RANGING_ZOMBIE':'RANGING';}
  return final;
}
function build4hLookup(c4h,regs){
  return (t)=>{let lo=0,hi=c4h.length-1,idx=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(c4h[mid].closeTime<=t){idx=mid;lo=mid+1;}else hi=mid-1;}return idx>=0?regs[idx]:'RANGING';};
}

// ── Stochastic %K ─────────────────────────────────────────────────────────
function stochK(hi,lo,cl,i,period=14){
  if(i<period)return 50;
  let hh=-Infinity,ll=Infinity;
  for(let j=i-period+1;j<=i;j++){if(hi[j]>hh)hh=hi[j];if(lo[j]<ll)ll=lo[j];}
  return hh!==ll?(cl[i]-ll)/(hh-ll)*100:50;
}

// ── FINAL SIGNAL FUNCTION ─────────────────────────────────────────────────
/**
 * Regime-adaptive signal:
 *   BULL:    VF — High-volume impulse with EMA9>EMA20 alignment (momentum continuation)
 *   BEAR:    VH — Stochastic >70 fade short + EMA50 breakdown confirmation
 *   RANGING: VH — Stochastic extreme (<25 long / >75 short) + VWAP deviation
 *
 * Returns: { dir, regime, stopMult, tpMult } or null
 */
function buildFinalSignal(getReg) {
  return (ctx, i) => {
    const regime = getReg(ctx.c[i].openTime);
    if (regime === 'RANGING_ZOMBIE' || regime === 'CRISIS') return null;

    const a   = ctx.a15[i]; if (!a || a <= 0) return null;
    const e9  = ctx.e9[i], e20 = ctx.e20[i], e50 = ctx.e50[i];
    const rsi = ctx.r15[i];
    if (!isFinite(e9) || !isFinite(e20) || !isFinite(e50)) return null;

    // Stochastic %K and prev %K
    const sk  = stochK(ctx.hi, ctx.lo, ctx.cl, i, 14);
    const skP = stochK(ctx.hi, ctx.lo, ctx.cl, i-1, 14);
    const p   = PARAMS[regime] || PARAMS.default;

    if (regime === 'BULL') {
      // VF: High-volume impulse in BULL direction
      // Requires: RVOL≥2.0, EMA9>EMA20 (fast stack bullish), bullish bar
      // Alternative lower-frequency: 3-bar pullback resumption
      const impulse = ctx.rv[i] >= 2.0 && ctx.cl[i] > ctx.op[i] && e9 > e20;
      const pullback3 = i>=3 && ctx.cl[i-3]>ctx.cl[i-2] && ctx.cl[i-2]>ctx.cl[i-1]  // 3 down bars
                     && ctx.cl[i]>ctx.op[i] && ctx.cl[i]>ctx.cl[i-1]                  // resume up
                     && ctx.cl[i]>e20 && ctx.rv[i]>=0.8 && rsi<60;
      if (impulse)   return { dir:1, regime, stopMult:p.stopMult, tpMult:p.tpMult };
      if (pullback3) return { dir:1, regime, stopMult:p.stopMult, tpMult:p.tpMult };
    }

    if (regime === 'BEAR') {
      // VH: Stochastic overbought fade SHORT
      // Requires: stoch was >70 and turning down, bearish bar, price below EMA20
      const stochFade = skP > 70 && sk < skP && ctx.cl[i] < ctx.op[i] && ctx.cl[i] < e20;
      // Also allow: high-volume impulse DOWN
      const impulse   = ctx.rv[i] >= 2.0 && ctx.cl[i] < ctx.op[i] && e9 < e20;
      if (stochFade) return { dir:-1, regime, stopMult:p.stopMult, tpMult:p.tpMult };
      if (impulse)   return { dir:-1, regime, stopMult:p.stopMult, tpMult:p.tpMult };
    }

    if (regime === 'RANGING' || regime === 'RANGING_PREZONE') {
      const vwap = ctx.vwap[i];
      if (!isFinite(vwap)) return null;
      const dist = ctx.cl[i] - vwap;
      // LONG fade: price below VWAP by 1.5ATR, stoch oversold turning up, bullish bar
      const longFade  = dist < -1.5*a && skP < 25 && sk > skP && ctx.cl[i] > ctx.op[i];
      // SHORT fade: price above VWAP by 1.5ATR, stoch overbought turning down, bearish bar
      const shortFade = dist >  1.5*a && skP > 75 && sk < skP && ctx.cl[i] < ctx.op[i];
      if (longFade)  return { dir:1,  regime, stopMult:p.stopMult, tpMult:p.tpMult };
      if (shortFade) return { dir:-1, regime, stopMult:p.stopMult, tpMult:p.tpMult };
    }

    return null;
  };
}

// ── Engine with 1m intrabar precision ─────────────────────────────────────
function runBacktest(c15, c1m, sigFn, warmup) {
  const n=c15.length, cl=c15.map(c=>c.close), hi=c15.map(c=>c.high), lo=c15.map(c=>c.low), op=c15.map(c=>c.open);
  const a15=atrArr(c15,14), r15=rsiArr(cl,14), rv=rvolArr(c15,20);
  const e9=ema(cl,9), e20=ema(cl,20), e50=ema(cl,50), e200=ema(cl,200);
  const vwap=vwapArr(c15);
  const ctx={cl,hi,lo,op,a15,r15,rv,e9,e20,e50,e200,vwap,c:c15};

  const m1map=new Map(); if(c1m)for(const m of c1m)m1map.set(m.openTime,m);
  const g1m=(a,b)=>{const r=[];for(let t=a;t<b;t+=60000){const m=m1map.get(t);if(m)r.push(m);}return r;};

  let eq=EQUITY, open=null;
  const trades=[], rejects={};
  const rej=k=>{rejects[k]=(rejects[k]||0)+1;};

  for(let i=warmup;i<n-1;i++){
    if(open){
      const b=c15[i], dir=open.dir, mins=g1m(b.openTime,b.closeTime+1);
      let ep=null,im=false,reason=null,et=b.closeTime;
      if(mins.length>0){
        for(const m of mins){
          const g=dir>0?m.open<=open.sl:m.open>=open.sl;
          const hsl=dir>0?m.low<=open.sl:m.high>=open.sl;
          const htp=dir>0?m.high>=open.tp:m.low<=open.tp;
          if(g){ep=m.open;reason='SL_GAP';et=m.openTime;break;}
          if(hsl&&htp){ep=open.sl;reason='SL';et=m.openTime;break;}
          if(hsl){ep=open.sl;reason='SL';et=m.openTime;break;}
          if(htp){ep=open.tp;im=true;reason='TP';et=m.openTime;break;}
        }
        if(!ep&&(i-open.eb)>=MAX_HOLD_BARS){ep=b.close;reason='TIME';}
      }else{
        const g=dir>0?b.open<=open.sl:b.open>=open.sl,hsl=dir>0?b.low<=open.sl:b.high>=open.sl,htp=dir>0?b.high>=open.tp:b.low<=open.tp,to=(i-open.eb)>=MAX_HOLD_BARS;
        if(g){ep=b.open;reason='SL_GAP';}else if(hsl&&htp){ep=open.sl;reason='SL';}else if(hsl){ep=open.sl;reason='SL';}else if(htp){ep=open.tp;im=true;reason='TP';}else if(to){ep=b.close;reason='TIME';}
      }
      if(ep!==null){
        const ef=im?ep:ep*(1+dir*SLIP), gr=(ef-open.entry)*dir*open.qty, fee=Math.abs(ep*open.qty)*(im?MAKER:TAKER), pnl=gr-open.entryFee-fee;
        eq+=pnl;
        const sd=Math.abs(open.entry-open.sl);
        // Position size info stored on trade for inspection
        const notional=open.entry*open.qty;
        const leverage=notional/EQUITY;
        trades.push({dir,reason,pnl,equity:eq,rMult:sd>0?pnl/(sd*open.qty):NaN,
          fees:open.entryFee+fee,holdBars:i-open.eb,
          entry:open.entry,exit:ef,sl:open.sl,tp:open.tp,qty:open.qty,
          notional,leverage,
          entryTime:open.entryTime,exitTime:et,
          regime:open.regime,ls:dir>0?'L':'S'});
        open=null;
      }
    }
    if(open)continue;

    const sig=sigFn(ctx,i); if(!sig)continue;
    const nb=c15[i+1], entry=nb.open*(1+sig.dir*SLIP), aa=a15[i];
    if(!aa||aa<=0){rej('no_atr');continue;}

    const sm=sig.stopMult||2.0, tp=sig.tpMult||2.5;
    const sl=entry-sig.dir*aa*sm, tpp=entry+sig.dir*aa*sm*tp, stopD=Math.abs(entry-sl);
    if(stopD<=0||!isFinite(sl)||!isFinite(tpp)){rej('invalid');continue;}
    if(sig.dir>0&&sl>=entry){rej('sl_side');continue;}
    if(sig.dir<0&&sl<=entry){rej('sl_side');continue;}
    if(Math.abs(tpp-entry)/entry<WIN_COST){rej('cost_floor');continue;}

    // Position sizing: risk-based, leverage-capped
    const riskAmt = eq * RISK_PCT;
    const perUnit = stopD + entry * LOSS_COST;
    const riskQty = riskAmt / perUnit;
    const maxQty  = eq * 0.8 * LEVERAGE / entry;  // leverage cap
    const qty     = Math.min(riskQty, maxQty);
    const cappedBy = maxQty < riskQty ? 'LEVERAGE' : 'RISK_PCT';

    const entryFee = entry * qty * TAKER;
    open={dir:sig.dir,entry,sl,tp:tpp,qty,entryFee,eb:i+1,entryTime:nb.openTime,regime:sig.regime,cappedBy};
  }
  return{trades,rejects,finalEquity:eq};
}

// ── Stats ─────────────────────────────────────────────────────────────────
function stats(trades,days){
  if(!trades.length)return{n:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite); if(!rs.length)return{n:trades.length,wr:0,avgR:0,pf:0,t:0};
  const wins=rs.filter(r=>r>0), avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sd>0?avgR/(sd/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak=0,dd=0,eq=0;for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  const reasons={},regimes={};
  for(const t2 of trades){reasons[t2.reason]=(reasons[t2.reason]||0)+1;regimes[t2.regime]=(regimes[t2.regime]||0)+1;}
  const L=trades.filter(t=>t.dir>0).length,S=trades.filter(t=>t.dir<0).length;
  const lwr=trades.filter(t=>t.dir>0&&t.pnl>0).length/(L||1)*100;
  const swr=trades.filter(t=>t.dir<0&&t.pnl>0).length/(S||1)*100;
  const avgNotional=trades.reduce((a,t)=>a+t.notional,0)/trades.length;
  const avgLev=trades.reduce((a,t)=>a+t.leverage,0)/trades.length;
  const totalFees=trades.reduce((a,t)=>a+t.fees,0);
  const avgHold=trades.reduce((a,t)=>a+t.holdBars,0)/trades.length*15;
  return{n:trades.length,wr:wins.length/rs.length*100,avgR,sd,t,pf,tpd:trades.length/days,
         maxDD:dd,reasons,regimes,longs:L,shorts:S,longWR:lwr,shortWR:swr,
         avgNotional,avgLev,totalFees,avgHold};
}

function monteCarlo(trades,iters=1000,block=10){
  const rs=trades.map(t=>t.rMult).filter(isFinite); if(rs.length<block*2)return null;
  const finals=[],dds=[];
  for(let it=0;it<iters;it++){
    const sim=[];while(sim.length<rs.length){const s=Math.floor(Math.random()*(rs.length-block));for(let j=0;j<block&&sim.length<rs.length;j++)sim.push(rs[s+j]);}
    let eq=0,peak=0,dd=0;for(const r of sim){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
    finals.push(eq);dds.push(dd);
  }
  finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);
  return{p5:finals[Math.floor(0.05*iters)],p25:finals[Math.floor(0.25*iters)],
    p50:finals[Math.floor(0.50*iters)],p75:finals[Math.floor(0.75*iters)],
    p95:finals[Math.floor(0.95*iters)],p95DD:dds[Math.floor(0.95*iters)],
    pProfit:finals.filter(f=>f>0).length/iters*100};
}

// ── Load data ─────────────────────────────────────────────────────────────
console.log('Loading data...');
const raw15m = loadNDJSON('data/historical/ETHUSDT_15m.ndjson');
const raw1m  = loadNDJSON('data/historical/ETHUSDT_1m.ndjson');
const raw4h  = resample(raw15m, 14400000);

console.log('Computing 4H regimes...');
const regs4h = buildValidatedRegimes(raw4h);
const getReg = build4hLookup(raw4h, regs4h);
const finalSignal = buildFinalSignal(getReg);

// ── Test windows ─────────────────────────────────────────────────────────
const WINDOWS = [
  { label: 'COMBINED Mar–Aug 2026', from:'2026-03-01', to:'2026-08-30' },
  { label: 'W1 Mar–May 2026',       from:'2026-03-01', to:'2026-05-30' },
  { label: 'W2 Jun–Aug 2026',       from:'2026-06-01', to:'2026-08-01' },
];
const WBUF = 700;
const f = (v,d=3) => isFinite(v)?v.toFixed(d):'N/A';

for(const win of WINDOWS){
  const fromMs=Date.parse(win.from+'T00:00:00Z'), toMs=Date.parse(win.to+'T23:59:59Z');
  const DAYS=Math.ceil((toMs-fromMs)/86400000);
  const wf=new Date(fromMs-WBUF*900000).toISOString().slice(0,10);
  const c15=raw15m.filter(c=>c.openTime>=Date.parse(wf+'T00:00:00Z')&&c.openTime<=toMs);
  const c1m=raw1m.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);

  // Regime distribution
  const c4w=raw4h.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);
  const dist={};c4w.forEach(c=>{const r=getReg(c.openTime);dist[r]=(dist[r]||0)+1;});
  const tot=c4w.length||1;
  const distStr=Object.entries(dist).map(([k,v])=>`${k}:${(v/tot*100).toFixed(0)}%`).join(' ');

  const {trades,rejects,finalEquity}=runBacktest(c15,c1m,finalSignal,WBUF);
  const wt=trades.filter(t=>t.entryTime>=fromMs&&t.entryTime<=toMs);
  const s=stats(wt,DAYS);
  const ret=((finalEquity-EQUITY)/EQUITY*100);

  console.log('\n'+'='.repeat(80));
  console.log(`${win.label} | ${win.from} → ${win.to} | ${DAYS} days`);
  console.log(`Regime: ${distStr}`);
  console.log('='.repeat(80));

  if(!s.n){console.log('No trades fired.');continue;}

  // Position sizing breakdown (first 5 trades as examples)
  console.log('\n── POSITION SIZING (example trades) ──');
  console.log('  Equity  | Risk$  | Notional | Leverage | Stop$  | Qty ETH | CappedBy');
  for(const t of wt.slice(0,5)){
    const stopDist=Math.abs(t.entry-t.sl);
    console.log(`  $${t.equity.toFixed(2).padStart(6)} | $${(t.equity*RISK_PCT).toFixed(2).padStart(4)} | $${t.notional.toFixed(2).padStart(7)} | ${t.leverage.toFixed(2).padStart(7)}x | $${stopDist.toFixed(2).padStart(5)} | ${t.qty.toFixed(4).padStart(8)} | ${(wt[0]?.cappedBy||'?')}`);
  }

  console.log('\n── PERFORMANCE ──');
  console.log(`  Trades: ${s.n} | T/day: ${s.tpd.toFixed(1)} | AvgHold: ${s.avgHold.toFixed(0)}min`);
  console.log(`  WR: ${s.wr.toFixed(1)}% | Long WR: ${s.longWR.toFixed(1)}% | Short WR: ${s.shortWR.toFixed(1)}%`);
  console.log(`  Longs: ${s.longs} | Shorts: ${s.shorts} | L+S both active`);
  console.log(`  avgR: ${f(s.avgR)} | PF: ${f(s.pf,2)} | t-stat: ${f(s.t,2)} | MaxDD: ${f(s.maxDD,1)}R`);
  console.log(`  $${EQUITY} → $${finalEquity.toFixed(2)} (${(ret>=0?'+':'')+ret.toFixed(2)}%)`);
  console.log(`  Total fees paid: $${s.totalFees.toFixed(2)} | Avg notional: $${s.avgNotional.toFixed(2)} | Avg leverage: ${s.avgLev.toFixed(2)}x`);
  console.log(`  Exit reasons: ${Object.entries(s.reasons).map(([k,v])=>`${k}:${v}`).join(' ')}`);
  console.log(`  By regime: ${Object.entries(s.regimes).map(([k,v])=>`${k}:${v}`).join(' ')}`);

  // Funding fee estimate
  const fundingPerHour=0.0001/8;  // ETH ~0.01%/8h = 0.000125/hr
  const estFunding=wt.reduce((a,t)=>a+t.notional*fundingPerHour*(t.holdBars*15/60),0);
  console.log(`  Funding fee estimate: $${estFunding.toFixed(4)} total ($${(estFunding/s.n).toFixed(5)}/trade) — NEGLIGIBLE`);

  // Monte Carlo
  if(s.n>=15){
    const m=monteCarlo(wt,1000,10); if(m){
      const rk=EQUITY*RISK_PCT;
      console.log(`\n── MONTE CARLO (1000 iters, 10-bar blocks) ──`);
      console.log(`  P5:  $${(EQUITY+m.p5*rk).toFixed(2)}`);
      console.log(`  P25: $${(EQUITY+m.p25*rk).toFixed(2)}`);
      console.log(`  P50: $${(EQUITY+m.p50*rk).toFixed(2)}`);
      console.log(`  P75: $${(EQUITY+m.p75*rk).toFixed(2)}`);
      console.log(`  P95: $${(EQUITY+m.p95*rk).toFixed(2)}`);
      console.log(`  P95 MaxDD: $${(m.p95DD*rk).toFixed(2)}`);
      console.log(`  Probability of profit: ${m.pProfit.toFixed(1)}%`);
    }
  }

  // Daily P&L
  const dayMap={};
  for(const t of wt){const d=new Date(t.entryTime).toISOString().slice(0,10);if(!dayMap[d])dayMap[d]={pnl:0,n:0};dayMap[d].pnl+=t.pnl;dayMap[d].n++;}
  let running=EQUITY;
  console.log(`\n── DAILY P&L ──`);
  for(const [d,v] of Object.entries(dayMap).sort()){
    running+=v.pnl;
    const sign=v.pnl>=0?'+':'';
    console.log(`  ${d}  n=${v.n}  P&L=${sign+v.pnl.toFixed(2).padStart(7)}  eq=$${running.toFixed(2)}`);
  }
}

console.log('\n'+'='.repeat(80));
console.log('POSITION SIZING SUMMARY:');
console.log(`  Equity: $${EQUITY} | Risk: ${RISK_PCT*100}% = $${EQUITY*RISK_PCT}/trade`);
console.log(`  Leverage cap: ${LEVERAGE}x (maxNotional = $${EQUITY*LEVERAGE})`);
console.log(`  Typical stop: 2×ATR ≈ $16 at ETH $1800`);
console.log(`  Typical qty: $1/($16+$0.40 fees) ≈ 0.061 ETH`);
console.log(`  Typical notional: 0.061×$1800 = $110 (1.1× equity — effectively unleveraged)`);
console.log(`  RISK_PCT binds first — leverage cap never hit at 5× with 1% risk`);
console.log(`  Funding fee: ~$0.002/trade at current ETH rates — NOT modeled (negligible)`);
console.log('='.repeat(80));
