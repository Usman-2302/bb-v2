'use strict';
/**
 * VWAP Fade + Funding Rate Filter — Cross-Validation Test
 *
 * Tests Claude's recommendations:
 *  1. Significance test on VWAP fade monthly returns (not just 9/13 count)
 *  2. BTC cross-validation (does the effect appear on a second pair?)
 *  3. Funding rate as a filter (fade only when funding is extreme = crowded side)
 *
 * Strategy: price > 1.5×ATR from session VWAP → fade back toward VWAP
 *   Variants:
 *     A) Base VWAP fade (no funding filter)
 *     B) VWAP fade + funding extreme filter (|rate| > threshold)
 *     C) VWAP fade + funding direction filter (fade against crowded side only)
 *
 * Both ETH and BTC, Aug 2025 – Aug 2026
 * Both zero-cost and real-cost
 * Conservative fills throughout
 *
 * Usage: node backtest_vwap_funding.js
 */

const fs   = require('fs');
const path = require('path');

const EQUITY = 100;
const RISK   = 0.01;
const TAKER  = 0.0005;
const MAKER  = 0.0002;
const SLIP   = 0.0006;
const WIN_COST = TAKER + MAKER;

// ── Indicators ────────────────────────────────────────────────────────────
function ema(prices, n) {
  const k = 2/(n+1); const out = Array(prices.length).fill(NaN); let v = NaN;
  for (let i=0;i<prices.length;i++){v=!isFinite(v)?prices[i]:prices[i]*k+v*(1-k);out[i]=v;}
  return out;
}
function atrArr(c, n=14) {
  const out=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;
  for(let i=1;i<c.length;i++){
    const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));
    s=!isFinite(s)?tr:s*(n-1)/n+tr/n;out[i]=s;prev=c[i].close;
  }
  return out;
}
function rvolArr(c,n=20){
  const v=c.map(x=>x.volume);const out=Array(c.length).fill(1);let s=0;
  for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}
  return out;
}
function vwapArr(c){
  const out=Array(c.length).fill(NaN);let day=null,pv=0,vv=0;
  for(let i=0;i<c.length;i++){
    const d=Math.floor(c[i].openTime/86400000)*86400000;
    if(d!==day){day=d;pv=0;vv=0;}
    const tp=(c[i].high+c[i].low+c[i].close)/3;
    pv+=tp*c[i].volume;vv+=c[i].volume;out[i]=vv>0?pv/vv:c[i].close;
  }
  return out;
}

function buildCtx(candles) {
  const close=candles.map(c=>c.close);
  const high=candles.map(c=>c.high);
  const low=candles.map(c=>c.low);
  const open=candles.map(c=>c.open);
  const atr=atrArr(candles,14);
  const e200=ema(close,200);
  const rv=rvolArr(candles,20);
  const vwap=vwapArr(candles);
  return {candles,close,high,low,open,atr,e200,rv,vwap};
}

// ── Funding rate helpers ──────────────────────────────────────────────────
function loadFunding(file) {
  const out = [];
  for (const line of fs.readFileSync(file,'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch(e) {}
  }
  out.sort((a,b) => a.timestamp - b.timestamp);
  return out;
}

/**
 * Build a per-bar funding rate lookup.
 * Returns array same length as candles where each entry = most recent funding rate
 * known at that bar's open time.
 */
function buildFundingLookup(candles, fundingRates) {
  const out = Array(candles.length).fill(0);
  let fi = 0;
  for (let i = 0; i < candles.length; i++) {
    const barTime = candles[i].openTime;
    // advance funding cursor to last rate published before this bar
    while (fi + 1 < fundingRates.length && fundingRates[fi + 1].timestamp <= barTime) fi++;
    out[i] = fi >= 0 && fundingRates[fi].timestamp <= barTime ? fundingRates[fi].rate : 0;
  }
  return out;
}

// ── Engine ────────────────────────────────────────────────────────────────
function run(candles, fundingLookup, startEquity, opts = {}) {
  const {
    warmup      = 200,
    zeroCost    = false,
    atrMult     = 1.5,    // VWAP distance threshold
    fundingMode = 'none', // 'none' | 'extreme' | 'direction'
    fundingThreshold = 0.0003, // ~0.03% per 8h = elevated
  } = opts;

  const ctx  = buildCtx(candles);
  const n    = candles.length;
  let equity = startEquity;
  let open   = null;
  const trades = []; const rejects = {};
  const rej = k => { rejects[k]=(rejects[k]||0)+1; };
  const taker = zeroCost ? 0 : TAKER;
  const maker = zeroCost ? 0 : MAKER;
  const slip  = zeroCost ? 0 : SLIP;

  for (let i = warmup; i < n - 1; i++) {
    // ── manage open position ─────────────────────────────────────────────
    if (open) {
      const bar = candles[i];
      const dir = open.dir;
      const hitSL  = dir > 0 ? bar.low  <= open.sl : bar.high >= open.sl;
      const hitTP  = dir > 0 ? bar.high >= open.tp : bar.low  <= open.tp;
      const timed  = (i - open.idx) >= 16; // 80 min at 5m

      // Conservative TP: price must penetrate 1 tick through
      const tickSz = 0.01;
      const tpFilled = hitTP && (dir > 0 ? bar.high >= open.tp + tickSz : bar.low <= open.tp - tickSz);

      let exitPx = null, isMaker = false, reason = null;
      const gapped = dir > 0 ? bar.open <= open.sl : bar.open >= open.sl;
      if (gapped)       { exitPx = bar.open;  reason = 'SL_GAP'; }
      else if (hitSL)   { exitPx = open.sl;   reason = 'SL'; }
      else if (tpFilled){ exitPx = open.tp;   reason = 'TP'; isMaker = true; }
      else if (timed)   { exitPx = bar.close; reason = 'TIME'; }

      if (exitPx !== null) {
        const exitFill = isMaker ? exitPx : exitPx * (1 + dir * slip);
        const gross    = (exitFill - open.entry) * dir * open.qty;
        const exitFee  = Math.abs(exitPx * open.qty) * (isMaker ? maker : taker);
        const pnl      = gross - open.entryFee - exitFee;
        equity += pnl;
        const stopD = Math.abs(open.entry - open.sl);
        trades.push({
          dir, reason, pnl, equity,
          rMult:    stopD > 0 ? pnl / (stopD * open.qty) : NaN,
          fees:     open.entryFee + exitFee,
          holdBars: i - open.idx,
          entryTime: open.entryTime, exitTime: bar.closeTime,
        });
        open = null;
      }
    }
    if (open) continue;

    // ── VWAP fade signal ─────────────────────────────────────────────────
    const vwap = ctx.vwap[i];
    const atr  = ctx.atr[i];
    if (!isFinite(vwap) || !atr) continue;

    const dist = ctx.close[i] - vwap;
    const threshold = atr * atrMult;

    // Price is far from VWAP AND reversal bar (close improves toward VWAP)
    const longFade  = dist < -threshold && ctx.close[i] > ctx.open[i]; // below VWAP, bullish close
    const shortFade = dist >  threshold && ctx.close[i] < ctx.open[i]; // above VWAP, bearish close

    if (!longFade && !shortFade) continue;
    if (ctx.rv[i] < 0.8) { rej('low_rvol'); continue; }

    const dir = longFade ? 1 : -1;

    // ── Funding rate filter ───────────────────────────────────────────────
    if (fundingMode !== 'none' && fundingLookup) {
      const fr = fundingLookup[i];
      if (fundingMode === 'extreme') {
        // Only trade when funding is extreme (crowded = reversal more likely)
        if (Math.abs(fr) < fundingThreshold) { rej('funding_not_extreme'); continue; }
      } else if (fundingMode === 'direction') {
        // Only fade when fading against the crowded side:
        // Positive funding = longs paying shorts = longs are crowded → prefer shorts
        // Negative funding = shorts paying longs = shorts are crowded → prefer longs
        if (fr > fundingThreshold && dir !== -1) { rej('funding_direction'); continue; }
        if (fr < -fundingThreshold && dir !== 1) { rej('funding_direction'); continue; }
        if (Math.abs(fr) < fundingThreshold) { rej('funding_neutral'); continue; }
      }
    }

    // Entry: market taker
    const nextBar = candles[i + 1];
    const entry   = nextBar.open * (1 + dir * slip);

    // Stop: 2.0 × ATR from entry
    const sl = entry - dir * atr * 2.0;
    const stopD = Math.abs(entry - sl);
    if (stopD <= 0) { rej('zero_stop'); continue; }
    if (dir > 0 && sl >= entry) { rej('sl_side'); continue; }
    if (dir < 0 && sl <= entry) { rej('sl_side'); continue; }

    // TP: VWAP itself (mean-reversion target) — but cap at 2.5R
    const tpNatural = vwap;
    const tpCapped  = entry + dir * stopD * 2.5;
    let tp;
    if (dir > 0) tp = Math.min(tpNatural, tpCapped);  // long: TP = min(vwap, +2.5R)
    else         tp = Math.max(tpNatural, tpCapped);  // short: TP = max(vwap, -2.5R)

    // Cost floor
    if (!zeroCost) {
      const tpMove = Math.abs(tp - entry) / entry;
      if (tpMove < WIN_COST) { rej('cost_floor'); continue; }
    }

    // Sizing
    const riskAmt  = equity * RISK;
    const perUnit  = stopD + entry * (taker + taker);
    const qty      = riskAmt / perUnit;
    const entryFee = entry * qty * taker;

    open = { dir, entry, sl, tp, qty, entryFee, idx: i+1, entryTime: nextBar.openTime };
  }
  return { trades, rejects, finalEquity: equity };
}

// ── Statistics + significance test ───────────────────────────────────────
function tTest(values) {
  // One-sample t-test: H0: mean = 0
  if (values.length < 3) return { t: NaN, p: NaN };
  const n = values.length;
  const mean = values.reduce((a,b)=>a+b,0)/n;
  const sd = Math.sqrt(values.reduce((a,v)=>a+(v-mean)**2,0)/(n-1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  // Approximate p-value using t-distribution (two-tailed, df=n-1)
  // Simple approximation sufficient for our purposes
  const df = n - 1;
  const x = df / (df + t*t);
  // Beta incomplete function approximation
  let p = 1.0;
  if (isFinite(t) && t !== 0) {
    // Use normal approximation for df > 30, otherwise rough t-dist
    if (df >= 30) {
      p = 2 * (1 - normCdf(Math.abs(t)));
    } else {
      p = 2 * roughTCdf(Math.abs(t), df);
    }
  }
  return { t, p, mean, sd, n };
}

function normCdf(z) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p*z);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-z*z);
  return 0.5 * (1 + sign*y);
}

function roughTCdf(t, df) {
  // Rough upper tail probability for t-distribution
  // Sufficient for df in [5,30] range
  const x = df / (df + t*t);
  let p = 0.5 * incompleteBeta(x, df/2, 0.5);
  return Math.max(0, Math.min(1, p));
}

function incompleteBeta(x, a, b) {
  // Simple continued fraction approximation
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a+b);
  const front = Math.exp(Math.log(x)*a + Math.log(1-x)*b - lbeta) / a;
  // Lentz continued fraction
  let c = 1, d = 1 - (a+b)*x/(a+1); if (Math.abs(d)<1e-30)d=1e-30; d=1/d;
  let h = d;
  for (let m=1;m<=100;m++) {
    const m2=2*m;
    let num = m*(b-m)*x/((a+m2-1)*(a+m2));
    d=1+num*d;if(Math.abs(d)<1e-30)d=1e-30;c=1+num/c;if(Math.abs(c)<1e-30)c=1e-30;
    d=1/d;h*=d*c;
    num = -(a+m)*(a+b+m)*x/((a+m2)*(a+m2+1));
    d=1+num*d;if(Math.abs(d)<1e-30)d=1e-30;c=1+num/c;if(Math.abs(c)<1e-30)c=1e-30;
    d=1/d;const delta=d*c;h*=delta;
    if(Math.abs(delta-1)<1e-10)break;
  }
  return front*h;
}

function lgamma(z) {
  const c=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,
    0.1208650973866179e-2,-0.5395239384953e-5];
  let y=z,x=z,tmp=x+5.5;
  tmp=(x+0.5)*Math.log(tmp)-tmp;
  let ser=1.000000000190015;
  for(const co of c){ser+=co/(++y);}
  return tmp+Math.log(2.5066282746310005*ser/x);
}

function monthStats(trades, daysInMonth) {
  if (!trades.length) return null;
  const rs = trades.map(t => t.rMult).filter(isFinite);
  if (!rs.length) return null;
  const wins = rs.filter(r => r > 0);
  const avgR = rs.reduce((a,b)=>a+b,0)/rs.length;
  const pnlPct = trades.reduce((a,t)=>a+t.pnl,0) / EQUITY * 100;
  const wr = wins.length/rs.length*100;
  const pf = wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  const reasons = {}; for(const t of trades) reasons[t.reason]=(reasons[t.reason]||0)+1;
  return { n: trades.length, tpd: trades.length/daysInMonth, wr, avgR, pnlPct, pf, reasons };
}

// ── Data loading ──────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out=[];
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;try{out.push(JSON.parse(line));}catch(e){}
  }
  out.sort((a,b)=>a.openTime-b.openTime);
  const d=[];for(const c of out){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}
  return d;
}
function resample(base,tfMs){
  const baseMs=base[1].openTime-base[0].openTime;
  if(tfMs===baseMs)return base.slice();
  const exp=tfMs/baseMs;const out=[];let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};cnt=0;}
    else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}
    cnt++;
  }if(cur&&cnt===exp)out.push(cur);return out;
}
function sliceByMonth(c,y,m){
  const from=new Date(Date.UTC(y,m-1,1)).getTime();
  const to=new Date(Date.UTC(y,m,0,23,59,59,999)).getTime();
  return c.filter(x=>x.openTime>=from&&x.openTime<=to);
}

// ── Load all data ─────────────────────────────────────────────────────────
console.log('Loading data...');
const eth1m = loadNDJSON('data/historical/ETHUSDT_1m.ndjson');
const btc1m = loadNDJSON('data/historical/BTCUSDT_1m.ndjson');
const eth5m = resample(eth1m, 5*60*1000);
const btc5m = resample(btc1m, 5*60*1000);

const ethFunding = loadFunding('data/funding/ETHUSDT_8h_recent.ndjson');
const btcFunding = loadFunding('data/funding/BTCUSDT_8h_recent.ndjson');
console.log(`ETH funding records: ${ethFunding.length} | BTC: ${btcFunding.length}`);

// Build months list
const firstDate = new Date(eth1m[0].openTime);
const lastDate  = new Date(eth1m[eth1m.length-1].openTime);
const months = [];
let y = firstDate.getUTCFullYear(), m = firstDate.getUTCMonth()+1;
while(y < lastDate.getUTCFullYear() || (y===lastDate.getUTCFullYear() && m<=lastDate.getUTCMonth()+1)){
  months.push({y,m}); m++; if(m>12){m=1;y++;}
}

// ── Variants to test ──────────────────────────────────────────────────────
const VARIANTS = [
  { id: 'A_base',        fundingMode: 'none',      zeroCost: false },
  { id: 'A_base_zero',   fundingMode: 'none',      zeroCost: true  },
  { id: 'B_extreme',     fundingMode: 'extreme',   zeroCost: false },
  { id: 'B_extreme_zero',fundingMode: 'extreme',   zeroCost: true  },
  { id: 'C_direction',   fundingMode: 'direction', zeroCost: false },
  { id: 'C_direction_zero', fundingMode: 'direction', zeroCost: true },
];

// ── Run all months × variants × symbols ───────────────────────────────────
const SYMBOLS = [
  { name: 'ETH', candles: eth5m, funding: ethFunding },
  { name: 'BTC', candles: btc5m, funding: btcFunding },
];

const allMonthlyRets = {}; // key: sym_varId → [monthly ret%]
for (const sym of SYMBOLS)
  for (const v of VARIANTS)
    allMonthlyRets[`${sym.name}_${v.id}`] = [];

const P  = (v,n) => String(v).padStart(n);
const PL = (v,n) => String(v).padEnd(n);
const pct = v => (v>=0?'+':'')+v.toFixed(1)+'%';

console.log('\n'+'='.repeat(120));
console.log('VWAP FADE + FUNDING FILTER — Monthly Returns | ETH & BTC 5m | Aug 2025 – Aug 2026');
console.log('A=base | B=extreme funding filter | C=direction funding filter | _zero=no fees');
console.log('='.repeat(120));
console.log(PL('Month',8) +
  PL('──── ETH ─────────────────────────────────────────────────────────────',72) +
  PL('──── BTC ─────────────────────────────────────────────────────────────',72));
console.log(PL('',8) +
  ['A_base','A_zero','B_ext','B_zero','C_dir','C_zero'].map(s=>P(s,12)).join('') +
  ['A_base','A_zero','B_ext','B_zero','C_dir','C_zero'].map(s=>P(s,12)).join(''));
console.log('─'.repeat(152));

for (const {y,m} of months) {
  const label = `${y}-${String(m).padStart(2,'0')}`;
  const fromMs = new Date(Date.UTC(y,m-1,1)).getTime();
  const toMs   = new Date(Date.UTC(y,m,0,23,59,59,999)).getTime();
  const daysInMonth = new Date(Date.UTC(y,m,0)).getUTCDate();

  let line = PL(label,8);

  for (const sym of SYMBOLS) {
    const startIdx = sym.candles.findIndex(c => c.openTime >= fromMs);
    if (startIdx < 0) { line += PL('no data',72); continue; }
    const warmup  = startIdx;
    const slice   = sym.candles.filter(c => c.openTime <= toMs);
    const fundLookup = buildFundingLookup(slice, sym.funding);

    for (const v of VARIANTS) {
      const res = run(slice, fundLookup, EQUITY, {
        warmup,
        zeroCost: v.zeroCost,
        fundingMode: v.fundingMode,
        atrMult: 1.5,
        fundingThreshold: 0.0003,
      });
      const monthTrades = res.trades.filter(t => t.entryTime >= fromMs && t.entryTime <= toMs);
      const pnl = monthTrades.reduce((a,t) => a+t.pnl, 0);
      const retPct = pnl/EQUITY*100;
      allMonthlyRets[`${sym.name}_${v.id}`].push(retPct);
      line += P(pct(retPct), 12);
    }
  }
  console.log(line);
}

// ── Summary + significance tests ─────────────────────────────────────────
console.log('\n'+'='.repeat(120));
console.log('SUMMARY + SIGNIFICANCE TEST');
console.log('t-stat: one-sample t-test vs 0 on monthly return series');
console.log('p-value: two-tailed, H0: mean monthly return = 0');
console.log('Interpretation: p < 0.05 = statistically significant edge | p < 0.10 = suggestive');
console.log('─'.repeat(120));

const LABEL_MAP = {
  'A_base':         'VWAP fade (real cost)',
  'A_base_zero':    'VWAP fade (zero cost)',
  'B_extreme':      'VWAP fade + extreme funding (real)',
  'B_extreme_zero': 'VWAP fade + extreme funding (zero)',
  'C_direction':    'VWAP fade + funding direction (real)',
  'C_direction_zero':'VWAP fade + funding direction (zero)',
};

for (const sym of SYMBOLS) {
  console.log(`\n${sym.name}USDT:`);
  for (const v of VARIANTS) {
    const rets = allMonthlyRets[`${sym.name}_${v.id}`];
    if (!rets.length) continue;
    const {t, p, mean, sd, n} = tTest(rets);
    const pos = rets.filter(r=>r>0).length;
    const sig = p < 0.05 ? '✓ SIGNIFICANT' : p < 0.10 ? '~ suggestive' : '✗ not significant';
    const rets_str = rets.map(r => pct(r)).join(' ');
    console.log(`  ${LABEL_MAP[v.id] || v.id}`);
    console.log(`    n=${n} months | pos=${pos}/${n} | avg=${mean.toFixed(2)}%/mo | sd=${sd.toFixed(2)}% | t=${t.toFixed(2)} | p=${isFinite(p)?p.toFixed(3):'?'} → ${sig}`);
    console.log(`    returns: ${rets_str}`);
  }
}

// ── Cross-symbol consistency ───────────────────────────────────────────────
console.log('\n'+'='.repeat(120));
console.log('CROSS-SYMBOL CONSISTENCY CHECK');
console.log('For an edge to be real (not data-mined), it should appear on BOTH ETH and BTC');
console.log('─'.repeat(120));
for (const v of VARIANTS) {
  const ethRets = allMonthlyRets[`ETH_${v.id}`];
  const btcRets = allMonthlyRets[`BTC_${v.id}`];
  if (!ethRets.length || !btcRets.length) continue;
  const ethPos = ethRets.filter(r=>r>0).length;
  const btcPos = btcRets.filter(r=>r>0).length;
  const ethMean = ethRets.reduce((a,b)=>a+b,0)/ethRets.length;
  const btcMean = btcRets.reduce((a,b)=>a+b,0)/btcRets.length;
  const bothPos = ethPos >= Math.ceil(ethRets.length*0.55) && btcPos >= Math.ceil(btcRets.length*0.55);
  const bothMeanPos = ethMean > 0 && btcMean > 0;
  const verdict = bothPos && bothMeanPos ? '✓ CONSISTENT (both pairs positive)' : '✗ inconsistent';
  console.log(`  ${(LABEL_MAP[v.id]||v.id).padEnd(45)} ETH: ${ethMean.toFixed(1)}%/mo ${ethPos}/${ethRets.length} pos | BTC: ${btcMean.toFixed(1)}%/mo ${btcPos}/${btcRets.length} pos → ${verdict}`);
}

// ── Final verdict ──────────────────────────────────────────────────────────
console.log('\n'+'='.repeat(120));
console.log('VERDICT');
console.log('─'.repeat(120));
for (const v of VARIANTS.filter(v => !v.id.includes('zero'))) {
  const ethRets = allMonthlyRets[`ETH_${v.id}`];
  const btcRets = allMonthlyRets[`BTC_${v.id}`];
  const ethZ    = allMonthlyRets[`ETH_${v.id}_zero`] || allMonthlyRets[`ETH_${v.id.replace('zero','')}zero`] || [];
  const zeroId  = v.id + '_zero';
  const zRets   = allMonthlyRets[`ETH_${zeroId}`] || [];

  const ethT = tTest(ethRets); const btcT = tTest(btcRets); const zT = tTest(zRets);
  const ethMean = ethRets.reduce((a,b)=>a+b,0)/(ethRets.length||1);
  const btcMean = btcRets.reduce((a,b)=>a+b,0)/(btcRets.length||1);
  const zMean   = zRets.reduce((a,b)=>a+b,0)/(zRets.length||1);

  console.log(`\n${LABEL_MAP[v.id] || v.id}:`);
  console.log(`  Zero-cost (signal quality):  avg ${zMean.toFixed(2)}%/mo | t=${zT.t.toFixed(2)} | p=${isFinite(zT.p)?zT.p.toFixed(3):'?'}`);
  console.log(`  Real-cost ETH:               avg ${ethMean.toFixed(2)}%/mo | t=${ethT.t.toFixed(2)} | p=${isFinite(ethT.p)?ethT.p.toFixed(3):'?'}`);
  console.log(`  Real-cost BTC:               avg ${btcMean.toFixed(2)}%/mo | t=${btcT.t.toFixed(2)} | p=${isFinite(btcT.p)?btcT.p.toFixed(3):'?'}`);
  const hasEdge = zMean > 0 && zT.p < 0.15 && ethMean > 0 && btcMean > 0;
  console.log(`  → ${hasEdge ? '✓ HAS EDGE — proceed to Phase 2 (exit optimization)' : '✗ NO RELIABLE EDGE at this configuration'}`);
}
console.log('\n'+'='.repeat(120));
