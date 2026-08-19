'use strict';
/**
 * Monthly breakdown — runs S7 and S9 on every calendar month in the 1m dataset
 * Shows: start equity, final equity, return%, trades/day, WR%
 * Starting equity $100, compounding within month, reset to $100 each month.
 * 
 * Usage: node backtest_monthly.js
 */

const fs   = require('fs');
const path = require('path');

const EQUITY = 100;
const RISK   = 0.01;
const TAKER  = 0.0005;
const MAKER  = 0.0002;
const SLIP   = 0.0006;
const WIN_COST  = TAKER + MAKER + 2 * SLIP;
const LOSS_COST = TAKER + TAKER + 2 * SLIP;

// ── Minimal indicators ────────────────────────────────────────────────────
function ema(prices, n) {
  const k = 2/(n+1); const out = Array(prices.length).fill(NaN); let v = NaN;
  for (let i = 0; i < prices.length; i++) {
    v = !isFinite(v) ? prices[i] : prices[i]*k + v*(1-k); out[i] = v;
  }
  return out;
}
function atrArr(c, n=14) {
  const out = Array(c.length).fill(NaN); let prev=c[0].close, s=NaN;
  for (let i=1;i<c.length;i++) {
    const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));
    s = !isFinite(s)?tr:s*(n-1)/n+tr/n; out[i]=s; prev=c[i].close;
  }
  return out;
}
function rvolArr(c, n=20) {
  const v=c.map(x=>x.volume); const out=Array(c.length).fill(1); let s=0;
  for (let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}
  return out;
}
function vwapArr(c) {
  const out=Array(c.length).fill(NaN); let day=null,pv=0,vv=0;
  for (let i=0;i<c.length;i++){
    const d=Math.floor(c[i].openTime/86400000)*86400000;
    if(d!==day){day=d;pv=0;vv=0;}
    const tp=(c[i].high+c[i].low+c[i].close)/3;
    pv+=tp*c[i].volume;vv+=c[i].volume;out[i]=vv>0?pv/vv:c[i].close;
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

function buildCtx(candles) {
  const close=candles.map(c=>c.close);
  const high=candles.map(c=>c.high);
  const low=candles.map(c=>c.low);
  const open=candles.map(c=>c.open);
  const volume=candles.map(c=>c.volume);
  const atr=atrArr(candles,14);
  const e9=ema(close,9); const e20=ema(close,20);
  const e50=ema(close,50); const e200=ema(close,200);
  const rv=rvolArr(candles,20);
  const vwap=vwapArr(candles);
  const rsi=rsiArr(close,14);
  return {candles,close,high,low,open,volume,atr,e9,e20,e50,e200,rv,vwap,rsi};
}

// ── Backtest engine ───────────────────────────────────────────────────────
function run(strategy, candles, startEquity) {
  const ctx=buildCtx(candles);
  const n=candles.length;
  let equity=startEquity; let open=null;
  const trades=[]; const rejects={};
  const rej=k=>{rejects[k]=(rejects[k]||0)+1;};

  for (let i=strategy.warmup||200; i<n-1; i++) {
    if (open) {
      const bar=candles[i]; const dir=open.dir;
      const gapped=dir>0?bar.open<=open.sl:bar.open>=open.sl;
      const hitSL=dir>0?bar.low<=open.sl:bar.high>=open.sl;
      const hitTP=dir>0?bar.high>=open.tp:bar.low<=open.tp;
      const timed=(i-open.idx)>=(strategy.maxBars||999);

      if (strategy.trail&&!gapped&&!hitSL&&!hitTP&&!timed) {
        const u=strategy.trail(open,ctx,i);
        if(u!==undefined)open.sl=u;
      }

      let exitPx=null,isMaker=false,reason=null;
      if(gapped){exitPx=bar.open;reason='SL_GAP';}
      else if(hitSL){exitPx=open.sl;reason='SL';}
      else if(hitTP){exitPx=open.tp;reason='TP';isMaker=true;}
      else if(timed){exitPx=bar.close;reason='TIME';}

      if(exitPx!==null){
        const exitFill=isMaker?exitPx:exitPx*(1+dir*SLIP);
        const gross=(exitFill-open.entry)*dir*open.qty;
        const exitFee=Math.abs(exitPx*open.qty)*(isMaker?MAKER:TAKER);
        const feesTotal=open.entryFee+exitFee;
        const pnl=gross-feesTotal;
        equity+=pnl;
        const stopD=Math.abs(open.entry-open.sl);
        trades.push({dir,reason,pnl,equity,
          rMult:stopD>0?pnl/(stopD*open.qty):NaN,
          fees:feesTotal,holdBars:i-open.idx,
          entry:open.entry,exit:exitFill,
          entryTime:open.entryTime,exitTime:bar.closeTime});
        open=null;
      }
    }
    if(open)continue;

    const sig=strategy.signal(ctx,i);
    if(!sig)continue;
    const nextBar=candles[i+1];
    const entry=nextBar.open*(1+sig.dir*SLIP);
    const sl=strategy.sl(ctx,i,sig,entry);
    const tp=strategy.tp(ctx,i,sig,entry,sl);
    if(!isFinite(sl)||!isFinite(tp)){rej('invalid');continue;}
    const stopD=Math.abs(entry-sl);
    if(stopD<=0){rej('zero_stop');continue;}
    if(sig.dir>0&&sl>=entry){rej('sl_side');continue;}
    if(sig.dir<0&&sl<=entry){rej('sl_side');continue;}
    const tpMove=Math.abs(tp-entry)/entry;
    if(tpMove<WIN_COST){rej('cost_floor');continue;}
    const riskAmt=equity*RISK;
    const perUnit=stopD+entry*(TAKER+TAKER);
    const qty=riskAmt/perUnit;
    const entryFee=entry*qty*TAKER;
    open={dir:sig.dir,entry,sl,tp,qty,entryFee,idx:i+1,entryTime:nextBar.openTime};
  }
  return {trades,rejects,finalEquity:equity};
}

// ── Strategies ────────────────────────────────────────────────────────────
const STRATEGIES = [

  {
    id: 'S7_HiVol_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:18,
    desc: 'RVOL≥2.5 impulse + EMA trend + ATR trail',
    signal: (ctx,i) => {
      if(!(ctx.rv[i]>=2.5)||!isFinite(ctx.e200[i]))return null;
      const isUp=ctx.close[i]>ctx.open[i];
      const tUp=ctx.e20[i]>ctx.e50[i]&&ctx.close[i]>ctx.e200[i];
      const tDn=ctx.e20[i]<ctx.e50[i]&&ctx.close[i]<ctx.e200[i];
      if(tUp&&isUp)return{dir:1};
      if(tDn&&!isUp)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.5,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*3.0,
    trail:(open,ctx,i)=>{
      const prog=(ctx.close[i]-open.entry)*open.dir;
      const risk=Math.abs(open.entry-open.sl);
      if(prog<risk*0.5)return undefined;
      const t=ctx.close[i]-open.dir*ctx.atr[i]*3.0;
      return open.dir>0?Math.max(open.sl,t):Math.min(open.sl,t);
    },
  },

  {
    id: 'S9_EMA_cross_3m', tf:'3m', tfMs:3*60*1000, warmup:200, maxBars:30,
    desc: 'EMA9 crosses EMA50 + EMA200 macro + ATR trail',
    signal: (ctx,i) => {
      if(!isFinite(ctx.e200[i])||!isFinite(ctx.e50[i]))return null;
      const macroUp=ctx.close[i]>ctx.e200[i];
      const macroDn=ctx.close[i]<ctx.e200[i];
      const xUp=ctx.e9[i]>ctx.e50[i]&&ctx.e9[i-1]<=ctx.e50[i-1];
      const xDn=ctx.e9[i]<ctx.e50[i]&&ctx.e9[i-1]>=ctx.e50[i-1];
      if(macroUp&&xUp&&ctx.rv[i]>=1.0)return{dir:1};
      if(macroDn&&xDn&&ctx.rv[i]>=1.0)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.5,
    trail:(open,ctx,i)=>{
      const prog=(ctx.close[i]-open.entry)*open.dir;
      const risk=Math.abs(open.entry-open.sl);
      if(prog<risk)return undefined;
      const t=ctx.close[i]-open.dir*ctx.atr[i]*2.5;
      return open.dir>0?Math.max(open.sl,t):Math.min(open.sl,t);
    },
  },

  {
    id: 'S4_HiVol_3m', tf:'3m', tfMs:3*60*1000, warmup:200, maxBars:30,
    desc: 'RVOL≥2.5 impulse 3m + EMA trend + ATR trail',
    signal: (ctx,i) => {
      if(!(ctx.rv[i]>=2.5)||!isFinite(ctx.e200[i]))return null;
      const isUp=ctx.close[i]>ctx.open[i];
      const tUp=ctx.e20[i]>ctx.e50[i]&&ctx.close[i]>ctx.e200[i];
      const tDn=ctx.e20[i]<ctx.e50[i]&&ctx.close[i]<ctx.e200[i];
      if(tUp&&isUp)return{dir:1};
      if(tDn&&!isUp)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.5,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*3.0,
    trail:(open,ctx,i)=>{
      const prog=(ctx.close[i]-open.entry)*open.dir;
      const risk=Math.abs(open.entry-open.sl);
      if(prog<risk*0.5)return undefined;
      const t=ctx.close[i]-open.dir*ctx.atr[i]*3.0;
      return open.dir>0?Math.max(open.sl,t):Math.min(open.sl,t);
    },
  },

  // COMBO: S7 logic but only enters when RSI is also not overbought in trend dir
  {
    id: 'S7_HiVol_RSI_filter_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:18,
    desc: 'S7 + RSI filter (not overbought on entry) — fewer but cleaner trades',
    signal: (ctx,i) => {
      if(!(ctx.rv[i]>=2.5)||!isFinite(ctx.e200[i])||!isFinite(ctx.rsi[i]))return null;
      const isUp=ctx.close[i]>ctx.open[i];
      const tUp=ctx.e20[i]>ctx.e50[i]&&ctx.close[i]>ctx.e200[i];
      const tDn=ctx.e20[i]<ctx.e50[i]&&ctx.close[i]<ctx.e200[i];
      // Don't enter if RSI is already extended (overbought for longs, oversold for shorts)
      const rsiOk_L = ctx.rsi[i] < 70;
      const rsiOk_S = ctx.rsi[i] > 30;
      if(tUp&&isUp&&rsiOk_L)return{dir:1};
      if(tDn&&!isUp&&rsiOk_S)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.5,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*3.0,
    trail:(open,ctx,i)=>{
      const prog=(ctx.close[i]-open.entry)*open.dir;
      const risk=Math.abs(open.entry-open.sl);
      if(prog<risk*0.5)return undefined;
      const t=ctx.close[i]-open.dir*ctx.atr[i]*3.0;
      return open.dir>0?Math.max(open.sl,t):Math.min(open.sl,t);
    },
  },

  // VWAP reclaim with trend + volume filter
  {
    id: 'S6_VWAP_trend_5m', tf:'5m', tfMs:5*60*1000, warmup:200, maxBars:18,
    desc: 'VWAP reclaim + EMA trend + bullish/bearish bar',
    signal: (ctx,i) => {
      if(!isFinite(ctx.vwap[i])||!isFinite(ctx.e50[i]))return null;
      const tUp=ctx.e20[i]>ctx.e50[i]&&ctx.close[i]>ctx.e50[i];
      const tDn=ctx.e20[i]<ctx.e50[i]&&ctx.close[i]<ctx.e50[i];
      const reclL=ctx.low[i]<ctx.vwap[i]&&ctx.close[i]>ctx.vwap[i]&&ctx.close[i]>ctx.open[i];
      const reclS=ctx.high[i]>ctx.vwap[i]&&ctx.close[i]<ctx.vwap[i]&&ctx.close[i]<ctx.open[i];
      if(tUp&&reclL&&ctx.rv[i]>=1.2)return{dir:1};
      if(tDn&&reclS&&ctx.rv[i]>=1.2)return{dir:-1};
      return null;
    },
    sl:(ctx,i,sig,entry)=>entry-sig.dir*ctx.atr[i]*2.0,
    tp:(ctx,i,sig,entry,sl)=>entry+sig.dir*Math.abs(entry-sl)*2.5,
  },
];

// ── Data loading ──────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out=[];
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;out.push(JSON.parse(line));
  }
  out.sort((a,b)=>a.openTime-b.openTime);
  const d=[];for(const c of out){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}
  return d;
}

function resample(base, tfMs) {
  const baseMs=base[1].openTime-base[0].openTime;
  if(tfMs===baseMs)return base.slice();
  const expected=tfMs/baseMs;
  const out=[];let cur=null,cnt=0;
  for(const c of base){
    const bucket=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bucket){
      if(cur&&cnt===expected)out.push(cur);
      cur={openTime:bucket,closeTime:bucket+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};
      cnt=0;
    } else {
      if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;
      cur.close=c.close;cur.volume+=c.volume;
    }
    cnt++;
  }
  if(cur&&cnt===expected)out.push(cur);
  return out;
}

function sliceByMonth(candles, year, month) {
  const from=new Date(Date.UTC(year,month-1,1)).getTime();
  const to  =new Date(Date.UTC(year,month,0,23,59,59,999)).getTime();
  return candles.filter(c=>c.openTime>=from&&c.openTime<=to);
}

// ── Run all months ────────────────────────────────────────────────────────
console.log('Loading 1m data...');
const raw1m = loadNDJSON(path.join(__dirname,'data','historical','ETHUSDT_1m.ndjson'));
const firstDate = new Date(raw1m[0].openTime);
const lastDate  = new Date(raw1m[raw1m.length-1].openTime);
console.log(`Range: ${firstDate.toISOString().slice(0,7)} → ${lastDate.toISOString().slice(0,7)}\n`);

// Build list of months
const months = [];
let y = firstDate.getUTCFullYear(), m = firstDate.getUTCMonth()+1;
while(y < lastDate.getUTCFullYear() || (y===lastDate.getUTCFullYear() && m<=lastDate.getUTCMonth()+1)) {
  months.push({y,m}); m++; if(m>12){m=1;y++;}
}

// Print header
const W = 200;
const P = (v,n) => String(v).padStart(n);
const PL = (v,n) => String(v).padEnd(n);
console.log('='.repeat(W));
console.log(
  PL('Month',9) +
  STRATEGIES.map(s=>PL(s.id,26)).join('') 
);
console.log(
  PL('',9) +
  STRATEGIES.map(()=>PL('Trades T/d WR%   Return$ Ret%',26)).join('')
);
console.log('─'.repeat(W));

const monthlyResults = {}; // id -> array of returns

for (const {y,m} of months) {
  const label = `${y}-${String(m).padStart(2,'0')}`;
  const monthCandles1m = sliceByMonth(raw1m, y, m);
  
  // Need warmup — grab 500 bars before this month
  const monthStart = new Date(Date.UTC(y,m-1,1)).getTime();
  const startIdx   = raw1m.findIndex(c=>c.openTime>=monthStart);
  const with500    = raw1m.slice(Math.max(0,startIdx-500));
  const monthEnd   = new Date(Date.UTC(y,m,0,23,59,59,999)).getTime();
  const fullSlice  = with500.filter(c=>c.openTime<=monthEnd);

  const daysInMonth = new Date(Date.UTC(y,m,0)).getUTCDate();

  let line = PL(label,9);

  for (const strat of STRATEGIES) {
    if(!monthlyResults[strat.id])monthlyResults[strat.id]=[];

    if(monthCandles1m.length < 1000) {
      line += PL('< data',26);
      continue;
    }

    const resampled = resample(fullSlice, strat.tfMs);
    // only count trades that opened during this month
    const warmupBars = resampled.filter(c=>c.openTime<monthStart).length;
    const modified = {...strat, warmup: warmupBars};

    const res = run(modified, resampled, EQUITY);
    
    // Filter to trades that actually opened in this month
    const monthTrades = res.trades.filter(t=>t.entryTime>=monthStart&&t.entryTime<=monthEnd);
    if(!monthTrades.length){line+=PL('0 trades',26);continue;}

    // Compute equity curve just for this month
    let eq = EQUITY;
    for(const t of monthTrades) eq += t.pnl * (EQUITY/100); // approximate
    // Better: rerun equity tracking
    let eq2=EQUITY;
    for(const t of res.trades){
      if(t.entryTime>=monthStart&&t.entryTime<=monthEnd) eq2+=t.pnl;
    }
    // Actually use the engine's equity at end, bounded to month
    const finalEq = monthTrades.length>0 ? EQUITY+(monthTrades.reduce((a,t)=>a+t.pnl,0)) : EQUITY;

    const ret = ((finalEq-EQUITY)/EQUITY*100).toFixed(1);
    const tpd = (monthTrades.length/daysInMonth).toFixed(1);
    const wr  = (monthTrades.filter(t=>t.pnl>0).length/monthTrades.length*100).toFixed(0);
    const sign = parseFloat(ret)>=0?'+':'';

    monthlyResults[strat.id].push(parseFloat(ret));
    line += PL(`${monthTrades.length} ${tpd} ${wr}% ${sign}${(finalEq-EQUITY).toFixed(0)}$ ${sign}${ret}%`, 26);
  }
  console.log(line);
}

// ── Summary stats per strategy ─────────────────────────────────────────────
console.log('\n' + '='.repeat(W));
console.log('SUMMARY ACROSS ALL MONTHS');
console.log('─'.repeat(W));
for (const strat of STRATEGIES) {
  const rs = monthlyResults[strat.id]||[];
  if(!rs.length)continue;
  const pos = rs.filter(r=>r>0).length;
  const avg = rs.reduce((a,b)=>a+b,0)/rs.length;
  const best = Math.max(...rs);
  const worst = Math.min(...rs);
  const over20 = rs.filter(r=>r>=20).length;
  const over30 = rs.filter(r=>r>=30).length;
  console.log(`\n${strat.id} — ${strat.desc}`);
  console.log(`  Months: ${rs.length} | Profitable: ${pos}/${rs.length} (${(pos/rs.length*100).toFixed(0)}%) | Avg return: ${avg.toFixed(1)}%`);
  console.log(`  Best month: +${best.toFixed(1)}% | Worst: ${worst.toFixed(1)}% | ≥20%: ${over20} months | ≥30%: ${over30} months`);
  console.log(`  All returns: ${rs.map(r=>(r>=0?'+':'')+r.toFixed(1)+'%').join('  ')}`);
}

console.log('\n' + '='.repeat(W));
console.log('GOAL: Find strategy with avg monthly return ≥20% and profitable ≥70% of months');
console.log('='.repeat(W));
