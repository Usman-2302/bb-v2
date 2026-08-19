'use strict';
/**
 * BulletBrain — Regime-Switching Scalper Backtest
 *
 * Key insight from search results:
 *   - No single signal profitable in BOTH trend AND chop markets
 *   - In BULL trend: longs at EMA pullbacks work (R1_RSI, R8_Combined)
 *   - In BEAR trend: shorts at EMA pullbacks work (R12_BearShort)
 *   - In RANGING: VWAP fade works (R5) — fade both directions
 *   - In RANGING: No directional bias, fade extremes only
 *
 * STRATEGY: Regime-aware signal selection
 *   BULL  → LONG only: EMA20 pullback with RSI confirm
 *   BEAR  → SHORT only: EMA20 pullback with RSI confirm
 *   RANGING → BOTH: VWAP deviation fade (>1.5ATR from VWAP)
 *   CRISIS/ZOMBIE → FLAT: no trades
 *
 * TWO REGIME DETECTORS compared:
 *   LIVE: liveRunner.js style (15m EMA200, slope>0.0005, 10-bar window)
 *   VALIDATED: regimeDetector.js style (4H ATR-normalized slope, anti-flapping)
 *
 * Previous best strategies from registry also tested:
 *   - LSO-inspired: sweep + CVD gate (the validated backtest approach)
 *   - Pure EMA cross with regime gate
 *
 * Tested on:
 *   W1: Mar 1 – May 30 2026 (trending bull)
 *   W2: Jun 1 – Aug 1 2026 (choppy bear)
 *
 * Monte Carlo on best performers.
 *
 * Usage: node backtest_regime_switch.js
 */

const fs = require('fs');

// ── Constants ─────────────────────────────────────────────────────────────
const EQUITY = 100;
const RISK   = 0.01;
const TAKER  = 0.0005, MAKER = 0.0002, SLIP = 0.0006;
const WIN_COST  = TAKER + MAKER;
const LOSS_COST = TAKER + TAKER + 2*SLIP;

const WINDOWS = [
  { label: 'W1 Mar-May-2026', from: '2026-03-01', to: '2026-05-30' },
  { label: 'W2 Jun-Aug-2026', from: '2026-06-01', to: '2026-08-01' },
];
const WBUF = 700; // warmup bars (700×15m = 175h ≈ 7 days)

// ── Data helpers ──────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out = [];
  for (const line of fs.readFileSync(file,'utf8').split('\n')) {
    if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch(e) {}
  }
  out.sort((a,b)=>a.openTime-b.openTime);
  const d=[]; for(const c of out){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);} return d;
}
function resample(base, tfMs) {
  const bMs=base[1].openTime-base[0].openTime; if(tfMs===bMs)return base.slice();
  const exp=tfMs/bMs; const out=[]; let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}
    else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}cnt++;
  }if(cur&&cnt===exp)out.push(cur);return out;
}

// ── Indicators ────────────────────────────────────────────────────────────
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
// Efficiency Ratio (Kaufman) — measures trend quality 0=chop, 1=trend
function efficiencyRatio(closes, period=10) {
  const out=Array(closes.length).fill(0.5);
  for(let i=period;i<closes.length;i++){
    const netMove=Math.abs(closes[i]-closes[i-period]);
    let pathLen=0;for(let j=i-period+1;j<=i;j++)pathLen+=Math.abs(closes[j]-closes[j-1]);
    out[i]=pathLen>0?netMove/pathLen:0;
  }return out;
}

// ── REGIME DETECTORS ──────────────────────────────────────────────────────
/**
 * DETECTOR A: liveRunner.js style (15m EMA200, simple slope)
 * Known issues: flips every few bars, threshold too low for 15m noise
 */
function detectRegimeLive(candles15m, idx, ema200vals, atr14vals) {
  if (idx < 200) return 'RANGING';
  const e200 = ema200vals[idx], ePrev = ema200vals[Math.max(0, idx-10)];
  if (!e200||!ePrev) return 'RANGING';
  const slope10 = (e200-ePrev)/ePrev;
  const atrPct  = (atr14vals[idx]||0)/candles15m[idx].close*100;
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.0005 && candles15m[idx].close > e200) return 'BULL';
  if (slope10 < -0.0005 && candles15m[idx].close < e200) return 'BEAR';
  return 'RANGING';
}

/**
 * DETECTOR B: validated style (4H ATR-normalized slope, anti-flapping)
 * Uses the same logic as src/utils/regimeDetector.js but self-contained.
 * Operates on 4H candles derived from the same 15m base data.
 * Returns array of regimes per 4H candle.
 */
function buildValidatedRegimes(candles4h) {
  const closes = candles4h.map(c=>c.close);
  const e200_4h = ema(closes, 200);
  const atr_4h  = atrArr(candles4h, 14);
  const er_4h   = efficiencyRatio(closes, 10);
  const SLOPE_LOOKBACK = 20;
  const SLOPE_THRESH   = 0.011;  // config.js REGIME.slopeThreshold
  const CRISIS_ATR_PCT = 5.0;
  const ANTI_FLAP      = 2;      // 2 consecutive 4H closes to switch
  const ZOMBIE_ER      = 0.15;   // below this = zombie
  const ZOMBIE_CD      = 3;

  const n = candles4h.length;
  const raw = Array(n).fill('RANGING');

  for (let i=SLOPE_LOOKBACK;i<n;i++) {
    const atrPctVal = atr_4h[i]/candles4h[i].close*100;
    if (atrPctVal>CRISIS_ATR_PCT){raw[i]='CRISIS';continue;}
    if (!isFinite(e200_4h[i])||!isFinite(atr_4h[i])){raw[i]='RANGING';continue;}
    // ATR-normalized slope: (ema[i]-ema[i-20]) / (atr[i]*20)
    const slopeNum = e200_4h[i] - e200_4h[i-SLOPE_LOOKBACK];
    const slopeDen = atr_4h[i] * SLOPE_LOOKBACK;
    const slope    = slopeDen>0 ? slopeNum/slopeDen : 0;
    if (slope > SLOPE_THRESH)  {raw[i]='BULL';continue;}
    if (slope < -SLOPE_THRESH) {raw[i]='BEAR';continue;}
    raw[i]='RANGING';
  }

  // Anti-flapping: require ANTI_FLAP consecutive closes to confirm switch
  const smoothed = Array(n).fill('RANGING');
  let current='RANGING', pending=null, pendingCnt=0;
  smoothed[0]=raw[0]; current=raw[0];
  for (let i=1;i<n;i++) {
    if (raw[i]==='CRISIS'){current='CRISIS';pending=null;pendingCnt=0;smoothed[i]='CRISIS';continue;}
    if (raw[i]===current){pending=null;pendingCnt=0;smoothed[i]=current;}
    else if (raw[i]===pending){pendingCnt++;if(pendingCnt>=ANTI_FLAP){current=pending;pending=null;pendingCnt=0;}smoothed[i]=current;}
    else{pending=raw[i];pendingCnt=1;smoothed[i]=current;}
  }

  // Add zombie sub-state (ranges with ER < 0.15 = very choppy)
  let zombieCnt=0, clearCnt=0, zombieActive=false;
  const final = Array(n);
  for (let i=0;i<n;i++) {
    if (smoothed[i]!=='RANGING'){zombieCnt=0;clearCnt=0;zombieActive=false;final[i]=smoothed[i];continue;}
    if (er_4h[i]<ZOMBIE_ER){zombieCnt++;clearCnt=0;}else{clearCnt++;zombieCnt=0;}
    if (!zombieActive&&zombieCnt>=ZOMBIE_CD)zombieActive=true;
    if (zombieActive&&clearCnt>=ZOMBIE_CD)zombieActive=false;
    final[i]=zombieActive?'RANGING_ZOMBIE':'RANGING';
  }
  return final;
}

/**
 * Build per-15m-bar regime lookup from 4H regime array.
 * Returns a function: get4hRegime(barOpenTime) → regime string
 */
function build4hRegimeLookup(candles4h, regimes4h) {
  return (barOpenTime) => {
    let lo=0,hi=candles4h.length-1,idx=-1;
    while(lo<=hi){const mid=(lo+hi)>>1;
      if(candles4h[mid].closeTime<=barOpenTime){idx=mid;lo=mid+1;}else hi=mid-1;}
    return idx>=0?regimes4h[idx]:'RANGING';
  };
}

// ── Engine ────────────────────────────────────────────────────────────────
function runBacktest(candles15m, candles1m, signalFn, {warmup=WBUF,stopMult=2.0,tpMult=2.5,maxBars=32}={}) {
  const n=candles15m.length;
  const cl=candles15m.map(c=>c.close);
  const hi=candles15m.map(c=>c.high);
  const lo=candles15m.map(c=>c.low);
  const op=candles15m.map(c=>c.open);
  const atr15=atrArr(candles15m,14);
  const rsi15=rsiArr(cl,14);
  const rv15=rvolArr(candles15m,20);
  const e9=ema(cl,9), e20=ema(cl,20), e50=ema(cl,50), e200=ema(cl,200);
  const bbm=rollingMean(cl,20), bbs=rollingSd(cl,20);
  const bbUp=bbm.map((m,i)=>isFinite(m)?m+2*bbs[i]:NaN);
  const bbDn=bbm.map((m,i)=>isFinite(m)?m-2*bbs[i]:NaN);
  const vwap15=vwapArr(candles15m);

  const m1map=new Map();
  if(candles1m)for(const m of candles1m)m1map.set(m.openTime,m);
  const get1m=(open,close)=>{const r=[];for(let t=open;t<close;t+=60000){const m=m1map.get(t);if(m)r.push(m);}return r;};

  const ctx={cl,hi,lo,op,atr15,rsi15,rv15,e9,e20,e50,e200,bbUp,bbDn,vwap15,candles:candles15m};

  let equity=EQUITY,open=null;
  const trades=[],rejects={};
  const rej=k=>{rejects[k]=(rejects[k]||0)+1;};

  for(let i=warmup;i<n-1;i++){
    if(open){
      const bar=candles15m[i];const dir=open.dir;
      const mins=get1m(bar.openTime,bar.closeTime+1);
      let ep=null,im=false,reason=null,et=bar.closeTime;
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
        if(!ep&&(i-open.eb)>=maxBars){ep=bar.close;reason='TIME';et=bar.closeTime;}
      }else{
        const g=dir>0?bar.open<=open.sl:bar.open>=open.sl;
        const hsl=dir>0?bar.low<=open.sl:bar.high>=open.sl;
        const htp=dir>0?bar.high>=open.tp:bar.low<=open.tp;
        const to=(i-open.eb)>=maxBars;
        if(g){ep=bar.open;reason='SL_GAP';}
        else if(hsl&&htp){ep=open.sl;reason='SL';}
        else if(hsl){ep=open.sl;reason='SL';}
        else if(htp){ep=open.tp;im=true;reason='TP';}
        else if(to){ep=bar.close;reason='TIME';}
      }
      if(ep!==null){
        const ef=im?ep:ep*(1+dir*SLIP);
        const gr=(ef-open.entry)*dir*open.qty;
        const fee=Math.abs(ep*open.qty)*(im?MAKER:TAKER);
        const pnl=gr-open.entryFee-fee;
        equity+=pnl;
        const sd=Math.abs(open.entry-open.sl);
        trades.push({dir,reason,pnl,equity,rMult:sd>0?pnl/(sd*open.qty):NaN,
          fees:open.entryFee+fee,holdBars:i-open.eb,
          entry:open.entry,exit:ef,entryTime:open.entryTime,exitTime:et,
          regime:open.regime,longShort:dir>0?'L':'S'});
        open=null;
      }
    }
    if(open)continue;
    const sig=signalFn(ctx,i);
    if(!sig)continue;
    const nb=candles15m[i+1];
    const entry=nb.open*(1+sig.dir*SLIP);
    const a=atr15[i];if(!a||a<=0){rej('no_atr');continue;}
    const sl=entry-sig.dir*a*stopMult;
    const tp=entry+sig.dir*a*stopMult*tpMult;
    const sd=Math.abs(entry-sl);
    if(sd<=0||!isFinite(sl)||!isFinite(tp)){rej('invalid');continue;}
    if(sig.dir>0&&sl>=entry){rej('sl_side');continue;}
    if(sig.dir<0&&sl<=entry){rej('sl_side');continue;}
    if(Math.abs(tp-entry)/entry<WIN_COST){rej('cost_floor');continue;}
    const ra=equity*RISK;
    const qty=ra/(sd+entry*(TAKER+TAKER));
    const ef=entry*qty*TAKER;
    open={dir:sig.dir,entry,sl,tp,qty,entryFee:ef,eb:i+1,entryTime:nb.openTime,regime:sig.regime||'?'};
  }
  return{trades,rejects,finalEquity:equity};
}

// ── Stats ─────────────────────────────────────────────────────────────────
function stats(trades,days){
  if(!trades.length)return{n:0,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0,longs:0,shorts:0,longWR:0,shortWR:0};
  const rs=trades.map(t=>t.rMult).filter(isFinite);
  if(!rs.length)return{n:trades.length,wr:0,avgR:0,pf:0,t:0,tpd:0,maxDD:0,longs:0,shorts:0,longWR:0,shortWR:0};
  const wins=rs.filter(r=>r>0);
  const avgR=rs.reduce((a,b)=>a+b,0)/rs.length;
  const sd=Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t=sd>0?avgR/(sd/Math.sqrt(rs.length)):0;
  const pf=wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak=0,dd=0,eq=0;for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  const reasons={};for(const t2 of trades)reasons[t2.reason]=(reasons[t2.reason]||0)+1;
  const regimes={};for(const t2 of trades)regimes[t2.regime]=(regimes[t2.regime]||0)+1;
  const L=trades.filter(t=>t.dir>0).length, S=trades.filter(t=>t.dir<0).length;
  const lwr=trades.filter(t=>t.dir>0&&t.pnl>0).length/(L||1)*100;
  const swr=trades.filter(t=>t.dir<0&&t.pnl>0).length/(S||1)*100;
  return{n:trades.length,wr:wins.length/rs.length*100,avgR,sd,t,pf,tpd:trades.length/days,
         maxDD:dd,reasons,regimes,longs:L,shorts:S,longWR:lwr,shortWR:swr};
}

function monteCarlo(trades,iters=1000,block=10){
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
  return{p5:finals[Math.floor(0.05*iters)],p25:finals[Math.floor(0.25*iters)],
    p50:finals[Math.floor(0.50*iters)],p75:finals[Math.floor(0.75*iters)],
    p95:finals[Math.floor(0.95*iters)],p95DD:dds[Math.floor(0.95*iters)],
    pProfit:finals.filter(f=>f>0).length/iters*100};
}

// ── Load all data once ─────────────────────────────────────────────────────
console.log('Loading data...');
const raw15m = loadNDJSON('data/historical/ETHUSDT_15m.ndjson');
const raw1m  = loadNDJSON('data/historical/ETHUSDT_1m.ndjson');
const raw4h  = resample(raw15m, 14400000);
const raw60m = resample(raw15m, 3600000);

// Build validated 4H regime array ONCE (for the full dataset)
console.log('Computing validated 4H regimes...');
const regimes4h = buildValidatedRegimes(raw4h);
const get4hRegime = build4hRegimeLookup(raw4h, regimes4h);

// Show regime distribution for the two windows
for(const win of WINDOWS){
  const from=Date.parse(win.from+'T00:00:00Z'), to=Date.parse(win.to+'T23:59:59Z');
  const w4h=raw4h.filter(c=>c.openTime>=from&&c.openTime<=to);
  const wReg=w4h.map(c=>get4hRegime(c.openTime));
  const dist={};for(const r of wReg)dist[r]=(dist[r]||0)+1;
  const total=wReg.length||1;
  console.log(`${win.label} regime: ${Object.entries(dist).map(([k,v])=>`${k}:${(v/total*100).toFixed(0)}%`).join(' ')}`);
}

// ── STRATEGY VARIANTS ─────────────────────────────────────────────────────
// Each variant is: {id, desc, stopMult, tpMult, detectorType, signalFn}
// signalFn receives (ctx, i, regime) where regime comes from the selected detector.

// Helper: get validated regime for a 15m bar
const getVReg = (barOpenTime) => get4hRegime(barOpenTime);

// Helper: get liveRunner regime for a 15m bar using pre-computed arrays
// (built per-run since it needs context arrays)
const buildLiveRegimeFn = (candles15m, e200vals, atr14vals) =>
  (i) => detectRegimeLive(candles15m, i, e200vals, atr14vals);

const VARIANTS = [

  // ── V1: Validated regime + best signals per regime ────────────────────
  {
    id: 'V1_validated_rsiFade',
    desc: 'VALIDATED regime: BULL→Long RSI pullback | BEAR→Short RSI pullback | RANGE→VWAP fade | ZOMBIE→flat',
    stopMult: 2.0, tpMult: 2.5, detector: 'validated',
    buildSignal: (ctx) => (ctx2, i) => {
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime==='RANGING_ZOMBIE'||regime==='CRISIS') return null;
      const e20=ctx2.e20[i], rsi=ctx2.rsi15[i], a=ctx2.atr15[i];
      if (!isFinite(e20)||!isFinite(rsi)||!a) return null;

      if (regime==='BULL') {
        // LONG: EMA20 pullback + RSI turning from oversold
        const ok=ctx2.cl[i]>e20&&ctx2.cl[i-1]<=ctx2.e20[i-1]&&rsi<42&&ctx2.rsi15[i]>ctx2.rsi15[i-1]&&ctx2.cl[i]>ctx2.op[i]&&ctx2.rv15[i]>=0.9;
        if(ok) return {dir:1, regime};
      }
      if (regime==='BEAR') {
        // SHORT: EMA20 bounce back down + RSI turning from overbought
        const ok=ctx2.cl[i]<e20&&ctx2.cl[i-1]>=ctx2.e20[i-1]&&rsi>58&&ctx2.rsi15[i]<ctx2.rsi15[i-1]&&ctx2.cl[i]<ctx2.op[i]&&ctx2.rv15[i]>=0.9;
        if(ok) return {dir:-1, regime};
      }
      if (regime==='RANGING'||regime==='RANGING_PREZONE') {
        // BOTH: VWAP fade — fade overextension in either direction
        const dist=ctx2.cl[i]-ctx2.vwap15[i];
        const lf=dist<-1.5*a&&ctx2.cl[i]>ctx2.op[i]&&ctx2.rv15[i]>=0.8;
        const sf=dist>1.5*a&&ctx2.cl[i]<ctx2.op[i]&&ctx2.rv15[i]>=0.8;
        if(lf) return {dir:1, regime};
        if(sf) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V2: liveRunner regime + same signals ──────────────────────────────
  {
    id: 'V2_live_rsiFade',
    desc: 'LIVE regime: BULL→Long RSI pullback | BEAR→Short RSI pullback | RANGE→VWAP fade',
    stopMult: 2.0, tpMult: 2.5, detector: 'live',
    buildSignal: (ctx, liveRegimeFn) => (ctx2, i) => {
      const regime = liveRegimeFn(i);
      if (regime==='CRISIS') return null;
      const e20=ctx2.e20[i], rsi=ctx2.rsi15[i], a=ctx2.atr15[i];
      if (!isFinite(e20)||!isFinite(rsi)||!a) return null;
      if (regime==='BULL') {
        const ok=ctx2.cl[i]>e20&&ctx2.cl[i-1]<=ctx2.e20[i-1]&&rsi<42&&ctx2.rsi15[i]>ctx2.rsi15[i-1]&&ctx2.cl[i]>ctx2.op[i]&&ctx2.rv15[i]>=0.9;
        if(ok) return {dir:1, regime};
      }
      if (regime==='BEAR') {
        const ok=ctx2.cl[i]<e20&&ctx2.cl[i-1]>=ctx2.e20[i-1]&&rsi>58&&ctx2.rsi15[i]<ctx2.rsi15[i-1]&&ctx2.cl[i]<ctx2.op[i]&&ctx2.rv15[i]>=0.9;
        if(ok) return {dir:-1, regime};
      }
      if (regime==='RANGING') {
        const dist=ctx2.cl[i]-ctx2.vwap15[i];
        const lf=dist<-1.5*a&&ctx2.cl[i]>ctx2.op[i]&&ctx2.rv15[i]>=0.8;
        const sf=dist>1.5*a&&ctx2.cl[i]<ctx2.op[i]&&ctx2.rv15[i]>=0.8;
        if(lf) return {dir:1, regime};
        if(sf) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V3: Validated regime + wider RSI thresholds (more trades) ────────
  {
    id: 'V3_validated_wider',
    desc: 'VALIDATED regime + relaxed RSI (<48/>52) for more signals',
    stopMult: 2.0, tpMult: 2.5, detector: 'validated',
    buildSignal: () => (ctx2, i) => {
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime==='RANGING_ZOMBIE'||regime==='CRISIS') return null;
      const e20=ctx2.e20[i], rsi=ctx2.rsi15[i], a=ctx2.atr15[i];
      if (!isFinite(e20)||!isFinite(rsi)||!a) return null;
      if (regime==='BULL') {
        const ok=ctx2.cl[i]>e20&&ctx2.cl[i-1]<=ctx2.e20[i-1]&&rsi<48&&ctx2.cl[i]>ctx2.op[i];
        if(ok) return {dir:1, regime};
      }
      if (regime==='BEAR') {
        const ok=ctx2.cl[i]<e20&&ctx2.cl[i-1]>=ctx2.e20[i-1]&&rsi>52&&ctx2.cl[i]<ctx2.op[i];
        if(ok) return {dir:-1, regime};
      }
      if (regime==='RANGING'||regime==='RANGING_PREZONE') {
        const dist=ctx2.cl[i]-ctx2.vwap15[i];
        if(dist<-1.5*a&&ctx2.cl[i]>ctx2.op[i]) return {dir:1, regime};
        if(dist>1.5*a&&ctx2.cl[i]<ctx2.op[i]) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V4: Validated regime + trend-only (no ranging trades) ────────────
  {
    id: 'V4_validated_trendonly',
    desc: 'VALIDATED regime: trend trades only, no ranging (highest quality)',
    stopMult: 2.0, tpMult: 3.0, detector: 'validated',
    buildSignal: () => (ctx2, i) => {
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime!=='BULL'&&regime!=='BEAR') return null;
      const e20=ctx2.e20[i], rsi=ctx2.rsi15[i], a=ctx2.atr15[i];
      if (!isFinite(e20)||!isFinite(rsi)||!a) return null;
      if (regime==='BULL') {
        const ok=ctx2.cl[i]>e20&&ctx2.cl[i-1]<=ctx2.e20[i-1]&&rsi<42&&ctx2.rsi15[i]>ctx2.rsi15[i-1]&&ctx2.cl[i]>ctx2.op[i]&&ctx2.rv15[i]>=0.9;
        if(ok) return {dir:1, regime};
      }
      if (regime==='BEAR') {
        const ok=ctx2.cl[i]<e20&&ctx2.cl[i-1]>=ctx2.e20[i-1]&&rsi>58&&ctx2.rsi15[i]<ctx2.rsi15[i-1]&&ctx2.cl[i]<ctx2.op[i]&&ctx2.rv15[i]>=0.9;
        if(ok) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V5: Validated regime + stochastic (instead of RSI) ───────────────
  {
    id: 'V5_validated_stoch',
    desc: 'VALIDATED regime: stochastic %K oversold/overbought confirm',
    stopMult: 2.0, tpMult: 2.5, detector: 'validated',
    buildSignal: () => (ctx2, i) => {
      if (i<15) return null;
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime==='RANGING_ZOMBIE'||regime==='CRISIS') return null;
      const e20=ctx2.e20[i], a=ctx2.atr15[i];
      if (!isFinite(e20)||!a) return null;
      // Stochastic %K
      let hh=-Infinity,ll=Infinity;for(let j=i-13;j<=i;j++){if(ctx2.hi[j]>hh)hh=ctx2.hi[j];if(ctx2.lo[j]<ll)ll=ctx2.lo[j];}
      const stK=hh!==ll?(ctx2.cl[i]-ll)/(hh-ll)*100:50;
      let ph=-Infinity,pl=Infinity;for(let j=i-14;j<=i-1;j++){if(ctx2.hi[j]>ph)ph=ctx2.hi[j];if(ctx2.lo[j]<pl)pl=ctx2.lo[j];}
      const prevK=ph!==pl?(ctx2.cl[i-1]-pl)/(ph-pl)*100:50;

      if (regime==='BULL'&&prevK<25&&stK>prevK&&ctx2.cl[i]>e20&&ctx2.cl[i]>ctx2.op[i]) return {dir:1, regime};
      if (regime==='BEAR'&&prevK>75&&stK<prevK&&ctx2.cl[i]<e20&&ctx2.cl[i]<ctx2.op[i]) return {dir:-1, regime};
      if ((regime==='RANGING'||regime==='RANGING_PREZONE')) {
        const dist=ctx2.cl[i]-ctx2.vwap15[i];
        if(dist<-1.5*a&&prevK<25&&stK>prevK&&ctx2.cl[i]>ctx2.op[i]) return {dir:1, regime};
        if(dist>1.5*a&&prevK>75&&stK<prevK&&ctx2.cl[i]<ctx2.op[i]) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V6: Validated regime + EMA cross (simple but fast entries) ────────
  {
    id: 'V6_validated_emacross',
    desc: 'VALIDATED regime: 15m EMA9/20 cross in regime direction',
    stopMult: 2.0, tpMult: 2.5, detector: 'validated',
    buildSignal: () => (ctx2, i) => {
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime==='RANGING_ZOMBIE'||regime==='CRISIS') return null;
      const e9=ctx2.e9[i], e20=ctx2.e20[i];
      if (!isFinite(e9)||!isFinite(e20)) return null;
      const xUp=e9>e20&&ctx2.e9[i-1]<=ctx2.e20[i-1];
      const xDn=e9<e20&&ctx2.e9[i-1]>=ctx2.e20[i-1];
      if (regime==='BULL'&&xUp&&ctx2.rv15[i]>=1.0) return {dir:1, regime};
      if (regime==='BEAR'&&xDn&&ctx2.rv15[i]>=1.0) return {dir:-1, regime};
      if ((regime==='RANGING'||regime==='RANGING_PREZONE')) {
        // In ranging: use VWAP fade not EMA cross (cross is too whippy in ranges)
        const dist=ctx2.cl[i]-ctx2.vwap15[i];const a=ctx2.atr15[i];
        if(dist<-1.5*a&&ctx2.cl[i]>ctx2.op[i]&&ctx2.rv15[i]>=0.8) return {dir:1, regime};
        if(dist>1.5*a&&ctx2.cl[i]<ctx2.op[i]&&ctx2.rv15[i]>=0.8) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V7: Validated regime + HV impulse continuation ────────────────────
  {
    id: 'V7_validated_hvimpulse',
    desc: 'VALIDATED regime: RVOL≥2.0 impulse in regime direction',
    stopMult: 2.5, tpMult: 3.0, detector: 'validated',
    buildSignal: () => (ctx2, i) => {
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime==='RANGING_ZOMBIE'||regime==='RANGING_PREZONE'||regime==='CRISIS') return null;
      if (ctx2.rv15[i]<2.0) return null;
      const e9=ctx2.e9[i], e20=ctx2.e20[i];
      if (!isFinite(e9)||!isFinite(e20)) return null;
      const isUp=ctx2.cl[i]>ctx2.op[i];
      if (regime==='BULL'&&isUp&&e9>e20) return {dir:1, regime};
      if (regime==='BEAR'&&!isUp&&e9<e20) return {dir:-1, regime};
      // In ranging: high-volume impulse = potential breakout, fade it
      if (regime==='RANGING') {
        const dist=ctx2.cl[i]-ctx2.vwap15[i]; const a=ctx2.atr15[i];
        if(dist<-2*a&&ctx2.cl[i]>ctx2.op[i]) return {dir:1, regime};
        if(dist>2*a&&ctx2.cl[i]<ctx2.op[i]) return {dir:-1, regime};
      }
      return null;
    },
  },

  // ── V8: Validated regime + triple bar pattern ──────────────────────────
  {
    id: 'V8_validated_3bar',
    desc: 'VALIDATED regime: 3-bar pullback then resumption in trend',
    stopMult: 2.0, tpMult: 2.5, detector: 'validated',
    buildSignal: () => (ctx2, i) => {
      if (i<5) return null;
      const regime = getVReg(ctx2.candles[i].openTime);
      if (regime==='RANGING_ZOMBIE'||regime==='CRISIS') return null;
      if (regime==='BULL') {
        const pullback=ctx2.cl[i-3]>ctx2.cl[i-2]&&ctx2.cl[i-2]>ctx2.cl[i-1];
        const resume=ctx2.cl[i]>ctx2.op[i]&&ctx2.cl[i]>ctx2.cl[i-1]&&ctx2.cl[i]>ctx2.e20[i];
        if(pullback&&resume&&ctx2.rv15[i]>=0.8) return {dir:1, regime};
      }
      if (regime==='BEAR') {
        const pullback=ctx2.cl[i-3]<ctx2.cl[i-2]&&ctx2.cl[i-2]<ctx2.cl[i-1];
        const resume=ctx2.cl[i]<ctx2.op[i]&&ctx2.cl[i]<ctx2.cl[i-1]&&ctx2.cl[i]<ctx2.e20[i];
        if(pullback&&resume&&ctx2.rv15[i]>=0.8) return {dir:-1, regime};
      }
      if (regime==='RANGING'||regime==='RANGING_PREZONE') {
        const dist=ctx2.cl[i]-ctx2.vwap15[i]; const a=ctx2.atr15[i];
        if(dist<-1.5*a&&ctx2.cl[i]>ctx2.op[i]) return {dir:1, regime};
        if(dist>1.5*a&&ctx2.cl[i]<ctx2.op[i]) return {dir:-1, regime};
      }
      return null;
    },
  },
];

// ── Run all variants on all windows ───────────────────────────────────────
const P=(v,n)=>String(v).padStart(n), PL=(v,n)=>String(v).padEnd(n);
const f=(v,d=3)=>isFinite(v)?v.toFixed(d):'N/A';
const allResults = {};

for (const win of WINDOWS) {
  const fromMs=Date.parse(win.from+'T00:00:00Z'), toMs=Date.parse(win.to+'T23:59:59Z');
  const DAYS=Math.ceil((toMs-fromMs)/86400000);
  const wFrom=new Date(fromMs-WBUF*900000).toISOString().slice(0,10);
  const c15=raw15m.filter(c=>c.openTime>=Date.parse(wFrom+'T00:00:00Z')&&c.openTime<=toMs);
  const c1m=raw1m.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);

  // Precompute liveRunner-style indicators for this slice
  const cl15=c15.map(c=>c.close);
  const e200_live=ema(cl15,200);
  const atr14_live=atrArr(c15,14);
  const liveRegimeFn=buildLiveRegimeFn(c15,e200_live,atr14_live);

  console.log(`\n${'='.repeat(110)}`);
  console.log(`WINDOW: ${win.label} | ${win.from}→${win.to} | ${DAYS} days`);
  console.log(`Bars: ${c15.length} (incl warmup) | 1m: ${c1m.length}`);
  console.log('='.repeat(110));
  console.log(PL('Variant',26)+P('Det',5)+P('n',5)+P('T/d',5)+P('WR',5)+P('L-WR',6)+P('S-WR',6)+
              P('L/S',8)+P('avgR',8)+P('PF',6)+P('t',7)+P('MaxDD',7)+P('$Final',8)+P('Ret%',7));
  console.log('─'.repeat(110));

  const results=[];
  for (const v of VARIANTS) {
    const signalFn = v.detector==='live'
      ? v.buildSignal(null, liveRegimeFn)
      : v.buildSignal(null);
    const {trades,finalEquity}=runBacktest(c15,c1m,signalFn,{stopMult:v.stopMult,tpMult:v.tpMult});
    const wt=trades.filter(t=>t.entryTime>=fromMs&&t.entryTime<=toMs);
    const s=stats(wt,DAYS);
    const ret=((finalEquity-EQUITY)/EQUITY*100);
    results.push({v,trades:wt,s,ret,finalEquity});
  }

  results.sort((a,b)=>(b.s.avgR||0)-(a.s.avgR||0));
  allResults[win.label]=results;

  for(const r of results){
    const s=r.s;
    if(!s.n){console.log(PL(r.v.id,26)+P(r.v.detector.slice(0,4),5)+P('0',5));continue;}
    const lsStr=`${s.longs}L/${s.shorts}S`;
    const retStr=(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%';
    const tMark=s.t>1.5?'★':s.t>0.5?'~':' ';
    console.log(PL(r.v.id,26)+P(r.v.detector.slice(0,4),5)+P(s.n,5)+P(s.tpd.toFixed(1),5)+P(s.wr.toFixed(0)+'%',5)+
      P(s.longWR.toFixed(0)+'%',6)+P(s.shortWR.toFixed(0)+'%',6)+P(lsStr,8)+
      P(f(s.avgR),8)+P(f(s.pf,2),6)+P(f(s.t,2)+tMark,7)+P(f(s.maxDD,1)+'R',7)+
      P('$'+r.finalEquity.toFixed(2),8)+P(retStr,7));
  }
}

// ── Cross-window: find strategies positive in BOTH ────────────────────────
console.log('\n'+'='.repeat(110));
console.log('CROSS-WINDOW — Positive in both W1 (trending) and W2 (bear/chop)');
console.log('─'.repeat(110));
const wLabels=WINDOWS.map(w=>w.label);
const crossWin=[];
const w1r=allResults[wLabels[0]], w2r=allResults[wLabels[1]];
for(const r1 of w1r){
  const r2=w2r.find(r=>r.v.id===r1.v.id); if(!r2) continue;
  if(r1.s.n>=5&&r2.s.n>=5){
    crossWin.push({id:r1.v.id,desc:r1.v.desc,
      avgR1:r1.s.avgR,t1:r1.s.t,n1:r1.s.n,ret1:r1.ret,
      avgR2:r2.s.avgR,t2:r2.s.t,n2:r2.s.n,ret2:r2.ret});
  }
}
crossWin.sort((a,b)=>(a.avgR1+a.avgR2)-(b.avgR1+b.avgR2)*-1); // both positive first
const bothPos=crossWin.filter(c=>c.avgR1>0&&c.avgR2>0);
if(bothPos.length){
  console.log(`✓ ${bothPos.length} variant(s) positive in BOTH windows:`);
  for(const c of bothPos){
    console.log(`  ${c.id} [${c.desc.slice(0,60)}]`);
    console.log(`    W1: avgR=${f(c.avgR1)} t=${f(c.t1,2)} n=${c.n1} ret=${(c.ret1>=0?'+':'')+c.ret1.toFixed(1)}%`);
    console.log(`    W2: avgR=${f(c.avgR2)} t=${f(c.t2,2)} n=${c.n2} ret=${(c.ret2>=0?'+':'')+c.ret2.toFixed(1)}%`);
  }
} else {
  console.log('No variant positive in both windows.');
  // Show best of each
  const b1=w1r.find(r=>r.s.n>=5), b2=w2r.find(r=>r.s.n>=5);
  if(b1)console.log(`Best W1: ${b1.v.id} avgR=${f(b1.s.avgR)} t=${f(b1.s.t,2)} ret=${(b1.ret>=0?'+':'')+b1.ret.toFixed(1)}%`);
  if(b2)console.log(`Best W2: ${b2.v.id} avgR=${f(b2.s.avgR)} t=${f(b2.s.t,2)} ret=${(b2.ret>=0?'+':'')+b2.ret.toFixed(1)}%`);
}

// ── Regime breakdown for best variant ─────────────────────────────────────
for(const win of WINDOWS){
  const res=allResults[win.label];
  const best=res.find(r=>r.s.n>=10);
  if(!best)continue;
  console.log(`\n── ${win.label} | Best: ${best.v.id} | By regime:`);
  const byR={};
  for(const t of best.trades){byR[t.regime]=byR[t.regime]||{n:0,wins:0};byR[t.regime].n++;if(t.pnl>0)byR[t.regime].wins++;}
  for(const [r,d] of Object.entries(byR)){
    console.log(`   ${r.padEnd(20)} n=${d.n} WR=${(d.wins/d.n*100).toFixed(0)}%`);}
}

// ── Monte Carlo for top 3 from each window ────────────────────────────────
for(const win of WINDOWS){
  const res=allResults[win.label];
  const cands=res.filter(r=>r.s.n>=15&&r.s.t>0.3).slice(0,3);
  if(!cands.length){console.log(`\n${win.label}: no MC candidates`);continue;}
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`MONTE CARLO — ${win.label}`);
  for(const r of cands){
    const mc=monteCarlo(r.trades,1000,10); if(!mc)continue;
    const rk=EQUITY*RISK;
    console.log(`\n  ${r.v.id} [${r.v.detector}]`);
    console.log(`  n=${r.s.n} T/d=${r.s.tpd.toFixed(1)} WR=${r.s.wr.toFixed(1)}% L=${r.s.longs}(${r.s.longWR.toFixed(0)}%) S=${r.s.shorts}(${r.s.shortWR.toFixed(0)}%) avgR=${f(r.s.avgR)} t=${f(r.s.t,2)}`);
    console.log(`  $100→$${r.finalEquity.toFixed(2)} (${(r.ret>=0?'+':'')+r.ret.toFixed(2)}%)`);
    console.log(`  MC P5=$${(EQUITY+mc.p5*rk).toFixed(2)} P25=$${(EQUITY+mc.p25*rk).toFixed(2)} P50=$${(EQUITY+mc.p50*rk).toFixed(2)} P75=$${(EQUITY+mc.p75*rk).toFixed(2)} P95=$${(EQUITY+mc.p95*rk).toFixed(2)}`);
    console.log(`  MC P95MaxDD=$${(mc.p95DD*rk).toFixed(2)} ProbProfit=${mc.pProfit.toFixed(1)}%`);
    console.log(`  Regime breakdown: ${Object.entries(r.s.regimes||{}).map(([k,v])=>`${k}:${v}`).join(' ')}`);
    console.log(`  Exits: ${Object.entries(r.s.reasons||{}).map(([k,v])=>`${k}:${v}`).join(' ')}`);
  }
}

console.log('\n'+'='.repeat(110));
console.log('KEY: ★=t>1.5 (sig) ~=t>0.5 (promising) | validated=4H ATR slope | live=15m EMA200 slope');
console.log('If positive avgR + t>1.5 in BOTH windows → ready for liveRunner port');
console.log('='.repeat(110));
