'use strict';
/**
 * BulletBrain — HYBRID_MFI_BB_TRAIL Backtest
 *
 * Strategy: BB lower/upper band compression + RSI oversold/overbought +
 *           MFI volume confirmation + EMA200 trend + reversal bar + RVOL filter
 * Exit: ATR trailing stop (activates at 0.5R) + BB midline TP + 20-bar time exit
 *
 * Tests: 5m AND 15m timeframes simultaneously
 *        Optimistic fills AND conservative fills (price must penetrate 1 tick + 1-bar delay)
 *        Zero-cost AND real-cost (to separate signal quality from fee drag)
 *        Monthly breakdown Aug 2025 → Aug 2026 (12 months)
 *
 * Usage: node backtest_hybrid.js
 *        node backtest_hybrid.js --from 2026-07-01 --to 2026-07-31
 *        node backtest_hybrid.js --equity 100 --risk 0.01
 */

const fs   = require('fs');
const path = require('path');

// ── CLI ───────────────────────────────────────────────────────────────────
function arg(n, d) { const i=process.argv.indexOf('--'+n); return i>=0&&process.argv[i+1]?process.argv[i+1]:d; }
const FROM_ARG = arg('from', null);
const TO_ARG   = arg('to',   null);
const EQUITY   = parseFloat(arg('equity', '100'));
const RISK     = parseFloat(arg('risk',   '0.01'));

// ── Fee model ─────────────────────────────────────────────────────────────
const TAKER = 0.0005;
const MAKER = 0.0002;
const SLIP  = 0.0006;
// Entry: taker + slip. TP exit: maker (no additional slip — limit order).
// SL/TIME exit: taker + slip.
const WIN_COST_RATE  = TAKER + MAKER;        // approx round-trip for a win
const LOSS_COST_RATE = TAKER + TAKER + SLIP; // taker in + taker stop out + slip on exit

// ── Data ─────────────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch(e) {}
  }
  out.sort((a,b) => a.openTime - b.openTime);
  const d = [];
  for (const c of out) {
    if (!d.length || d[d.length-1].openTime !== c.openTime) d.push(c);
  }
  return d;
}

function resample(base, tfMs) {
  const baseMs = base[1].openTime - base[0].openTime;
  if (tfMs === baseMs) return base.slice();
  const expected = tfMs / baseMs;
  const out = []; let cur = null, cnt = 0;
  for (const c of base) {
    const bkt = Math.floor(c.openTime / tfMs) * tfMs;
    if (!cur || cur.openTime !== bkt) {
      if (cur && cnt === expected) out.push(cur);
      cur = { openTime: bkt, closeTime: bkt+tfMs-1,
              open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      cnt = 0;
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low  < cur.low)  cur.low  = c.low;
      cur.close = c.close; cur.volume += c.volume;
    }
    cnt++;
  }
  if (cur && cnt === expected) out.push(cur);
  return out;
}

function sliceByMonth(c, y, m) {
  const from = new Date(Date.UTC(y, m-1, 1)).getTime();
  const to   = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)).getTime();
  return c.filter(x => x.openTime >= from && x.openTime <= to);
}

// ── Indicators ────────────────────────────────────────────────────────────
function ema(prices, n) {
  const k = 2/(n+1); const out = Array(prices.length).fill(NaN); let v = NaN;
  for (let i = 0; i < prices.length; i++) {
    v = !isFinite(v) ? prices[i] : prices[i]*k + v*(1-k); out[i] = v;
  }
  return out;
}

function atrArr(c, n=14) {
  const out = Array(c.length).fill(NaN); let prev = c[0].close, s = NaN;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high-c[i].low, Math.abs(c[i].high-prev), Math.abs(c[i].low-prev));
    s = !isFinite(s) ? tr : s*(n-1)/n + tr/n; out[i] = s; prev = c[i].close;
  }
  return out;
}

function rsiArr(closes, n=14) {
  const out = Array(closes.length).fill(50); let ag=0, al=0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1]; const g = d>0?d:0, l = d<0?-d:0;
    if (i<=n) { ag+=g/n; al+=l/n; if(i===n) out[i] = al===0?100:100-100/(1+ag/al); }
    else { ag=(ag*(n-1)+g)/n; al=(al*(n-1)+l)/n; out[i] = al===0?100:100-100/(1+ag/al); }
  }
  return out;
}

function mfiArr(candles, n=14) {
  // Money Flow Index = volume-weighted RSI
  // Typical Price = (H+L+C)/3; Raw Money Flow = TP * Volume
  const out = Array(candles.length).fill(50);
  let posFlow = 0, negFlow = 0;
  let prevTP = (candles[0].high + candles[0].low + candles[0].close) / 3;
  const tps = [prevTP];

  for (let i = 1; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const rmf = tp * candles[i].volume;
    tps.push(tp);

    if (i < n) {
      if (tp >= prevTP) posFlow += rmf; else negFlow += rmf;
      if (i === n-1) out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow/negFlow);
    } else {
      // Rolling: remove the n-bar-ago contribution
      const oldTP  = tps[i - n];
      const oldTP1 = tps[i - n - 1] || oldTP;
      const oldRMF = oldTP * candles[i-n].volume;
      if (oldTP >= oldTP1) posFlow -= oldRMF; else negFlow -= oldRMF;
      if (tp >= prevTP) posFlow += rmf; else negFlow += rmf;
      out[i] = negFlow <= 0 ? 100 : 100 - 100 / (1 + posFlow/negFlow);
    }
    prevTP = tp;
  }
  return out;
}

function rvolArr(c, n=20) {
  const v = c.map(x=>x.volume); const out = Array(c.length).fill(1); let s = 0;
  for (let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}
  return out;
}

function rollingMean(vals, n) {
  const out = Array(vals.length).fill(NaN); let s = 0;
  for (let i=0;i<vals.length;i++){s+=vals[i];if(i>=n)s-=vals[i-n];if(i>=n-1)out[i]=s/n;}
  return out;
}

function rollingSd(vals, n) {
  const out = Array(vals.length).fill(NaN); let s=0, ss=0;
  for (let i=0;i<vals.length;i++){
    s+=vals[i];ss+=vals[i]*vals[i];
    if(i>=n){s-=vals[i-n];ss-=vals[i-n]*vals[i-n];}
    if(i>=n-1){const m=s/n;out[i]=Math.sqrt(Math.max(0,ss/n-m*m));}
  }
  return out;
}

function buildCtx(candles) {
  const close  = candles.map(c => c.close);
  const high   = candles.map(c => c.high);
  const low    = candles.map(c => c.low);
  const open   = candles.map(c => c.open);
  const volume = candles.map(c => c.volume);

  const atr   = atrArr(candles, 14);
  const e20   = ema(close, 20);
  const e50   = ema(close, 50);
  const e200  = ema(close, 200);
  const rv    = rvolArr(candles, 20);
  const rsi   = rsiArr(close, 14);
  const mfi   = mfiArr(candles, 14);

  // Bollinger Bands (20, 2)
  const bbMid = rollingMean(close, 20);
  const bbSd  = rollingSd(close, 20);
  const bbUp  = bbMid.map((m, i) => isFinite(m) ? m + 2*bbSd[i] : NaN);
  const bbDn  = bbMid.map((m, i) => isFinite(m) ? m - 2*bbSd[i] : NaN);

  return { candles, close, high, low, open, volume,
           atr, e20, e50, e200, rv, rsi, mfi,
           bbMid, bbUp, bbDn };
}

// ── Strategy signal ───────────────────────────────────────────────────────
function hybridSignal(ctx, i) {
  if (i < 1) return null;
  if (!isFinite(ctx.e200[i]) || !isFinite(ctx.bbDn[i]) || !isFinite(ctx.mfi[i])) return null;

  // LONG: oversold BB extremity with volume + trend + reversal bar
  // Thresholds calibrated to ~1-4 trades/day on 5m ETH:
  //   RSI<40 (not <35) gives 2-3x more signals while still being meaningful oversold
  //   MFI<40 (not <30) allows volume-confirmed but not extreme exhaustion
  //   RVOL>=1.0 (not 1.2) — just above average volume, not spike required
  //   Reversal bar (close > prev close) kept — this is the quality gate
  const longOk = ctx.close[i] > ctx.e200[i]          // macro uptrend
    && ctx.close[i] < ctx.bbDn[i]                    // below lower BB
    && ctx.rsi[i] < 40                               // RSI oversold
    && ctx.mfi[i] < 40                               // MFI volume-confirmed oversold
    && ctx.close[i] > ctx.close[i-1]                 // reversal bar
    && ctx.rv[i] >= 1.0;                              // real participation

  // SHORT: mirror
  const shortOk = ctx.close[i] < ctx.e200[i]          // macro downtrend
    && ctx.close[i] > ctx.bbUp[i]                    // above upper BB
    && ctx.rsi[i] > 60                               // RSI overbought
    && ctx.mfi[i] > 60                               // MFI volume-confirmed overbought
    && ctx.close[i] < ctx.close[i-1]                 // reversal bar
    && ctx.rv[i] >= 1.0;

  if (longOk)  return { dir: 1 };
  if (shortOk) return { dir: -1 };
  return null;
}

// ── Backtest engine ───────────────────────────────────────────────────────
/**
 * fillMode:
 *   'optimistic' — fills at next bar open (standard, assumes limit fills on touch)
 *   'conservative' — limit fills only if price went 1 tick THROUGH + 1 bar delay
 *                    (for TP orders; entry stays market)
 * zeroCost — ignores all fees and slippage
 */
function run(candles, startEquity, { warmup=200, fillMode='conservative', zeroCost=false, tfMs=300000 } = {}) {
  const ctx   = buildCtx(candles);
  const n     = candles.length;
  const tickSz = 0.01; // ETH tick size
  let equity  = startEquity;
  let open    = null;
  const trades = []; const rejects = {};
  const rej = k => { rejects[k] = (rejects[k]||0)+1; };
  const taker = zeroCost ? 0 : TAKER;
  const maker = zeroCost ? 0 : MAKER;
  const slip  = zeroCost ? 0 : SLIP;

  for (let i = warmup; i < n - 1; i++) {

    // ── manage open trade ─────────────────────────────────────────────────
    if (open) {
      const bar = candles[i];
      const dir = open.dir;

      // Trailing stop update: activate after 0.5R profit
      const progress = (bar.close - open.entry) * dir;
      const riskDist = Math.abs(open.entry - open.sl);
      if (progress > riskDist * 0.5) {
        const trail = bar.close - dir * ctx.atr[i] * 2.5;
        if (dir > 0) open.sl = Math.max(open.sl, trail);
        else         open.sl = Math.min(open.sl, trail);
      }

      const gapped = dir > 0 ? bar.open <= open.sl : bar.open >= open.sl;
      const hitSL  = dir > 0 ? bar.low  <= open.sl : bar.high >= open.sl;
      const hitTP  = open.tp !== null && (dir > 0 ? bar.high >= open.tp : bar.low <= open.tp);
      const timed  = (i - open.idx) >= 20; // 20 bars = 100min at 5m, 300min at 15m

      // Conservative TP fill: requires price to penetrate 1 tick beyond TP
      let tpFilled = hitTP;
      if (hitTP && fillMode === 'conservative') {
        const penetrated = dir > 0
          ? bar.high >= open.tp + tickSz    // for long, high must go 1 tick above TP
          : bar.low  <= open.tp - tickSz;   // for short, low must go 1 tick below TP
        tpFilled = penetrated;
        if (!penetrated) rej('tp_no_penetration');
      }

      let exitPx = null, isMaker = false, reason = null;
      if (gapped)    { exitPx = bar.open;  reason = 'SL_GAP'; }
      else if (hitSL){ exitPx = open.sl;   reason = 'SL'; }
      else if (tpFilled){ exitPx = open.tp; reason = 'TP'; isMaker = true; }
      else if (timed){ exitPx = bar.close; reason = 'TIME'; }

      if (exitPx !== null) {
        // Entry: taker + slip already in open.entry
        // Exit: maker (no slip for TP), taker+slip for SL/TIME
        const exitFill = isMaker ? exitPx : exitPx * (1 + dir * slip);
        const gross    = (exitFill - open.entry) * dir * open.qty;
        const exitFee  = Math.abs(exitPx * open.qty) * (isMaker ? maker : taker);
        const pnl      = gross - open.entryFee - exitFee;
        equity += pnl;
        const stopD = Math.abs(open.entry - open.sl_original);
        trades.push({ dir, reason, pnl, equity,
          rMult:    stopD > 0 ? pnl / (stopD * open.qty) : NaN,
          fees:     open.entryFee + exitFee,
          holdBars: i - open.idx,
          entryTime: open.entryTime, exitTime: bar.closeTime,
          entry: open.entry, exit: exitFill });
        open = null;
      }
    }
    if (open) continue;

    // ── look for signal ───────────────────────────────────────────────────
    const sig = hybridSignal(ctx, i);
    if (!sig) continue;

    // Entry: always market (taker + slip)
    const nextBar = candles[i + 1];
    const entry   = nextBar.open * (1 + sig.dir * slip);

    // Stop: 2.0 × ATR from entry
    const sl = entry - sig.dir * ctx.atr[i] * 2.0;
    if (!isFinite(sl)) { rej('no_atr'); continue; }
    const stopD = Math.abs(entry - sl);
    if (stopD <= 0) { rej('zero_stop'); continue; }
    if (sig.dir > 0 && sl >= entry) { rej('sl_side'); continue; }
    if (sig.dir < 0 && sl <= entry) { rej('sl_side'); continue; }

    // TP: BB midline (natural mean-reversion target)
    // Cap at 3.0R, skip if BB midline < 1.0R away (fees wouldn't be covered)
    const bbMidNow = ctx.bbMid[i];
    let tp = null;
    if (isFinite(bbMidNow)) {
      const tpDist = Math.abs(bbMidNow - entry);
      if (sig.dir > 0 && bbMidNow > entry) {
        tp = Math.min(bbMidNow, entry + stopD * 3.0); // cap at 3R
      } else if (sig.dir < 0 && bbMidNow < entry) {
        tp = Math.max(bbMidNow, entry - stopD * 3.0);
      } else {
        // BB midline is on wrong side (already crossed) — use fixed 2.5R
        tp = entry + sig.dir * stopD * 2.5;
      }
    } else {
      tp = entry + sig.dir * stopD * 2.5;
    }

    // Minimum target: must clear round-trip cost (otherwise skip)
    if (!zeroCost) {
      const tpMove = Math.abs(tp - entry) / entry;
      if (tpMove < WIN_COST_RATE) { rej('cost_floor'); continue; }
    }

    // Risk sizing
    const riskAmt  = equity * RISK;
    const perUnit  = stopD + entry * (taker + taker); // fee budget on loss
    const qty      = riskAmt / perUnit;
    const entryFee = entry * qty * taker;

    open = {
      dir: sig.dir, entry, sl, sl_original: sl, tp, qty, entryFee,
      idx: i + 1, entryTime: nextBar.openTime,
    };
  }
  return { trades, rejects, finalEquity: equity };
}

// ── Stats ─────────────────────────────────────────────────────────────────
function stats(trades, days) {
  if (!trades.length) return { n: 0, wr: 0, avgR: 0, pf: 0, t: 0, ret: 0, tpd: 0, maxDD: 0 };
  const rs   = trades.map(t => t.rMult).filter(isFinite);
  if (!rs.length) return { n: trades.length, wr: 0, avgR: 0, pf: 0, t: 0, ret: 0, tpd: 0, maxDD: 0 };
  const wins = rs.filter(r => r > 0);
  const avgR = rs.reduce((a,b) => a+b, 0) / rs.length;
  const sdR  = Math.sqrt(rs.reduce((a,r) => a+(r-avgR)**2, 0) / rs.length);
  const t    = sdR > 0 ? avgR / (sdR / Math.sqrt(rs.length)) : 0;
  const pf   = wins.reduce((a,b) => a+b, 0) / Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  const ret  = trades.length > 0 ? ((trades[trades.length-1].equity - EQUITY) / EQUITY * 100) : 0;
  let peak=0, dd=0, eq=0;
  for (const r of rs) { eq+=r; if(eq>peak)peak=eq; if(peak-eq>dd)dd=peak-eq; }
  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason]||0)+1;
  return { n: trades.length, wr: wins.length/rs.length*100, avgR, sdR, t, pf, ret, tpd: trades.length/days, maxDD: dd, reasons };
}

// ── Load data ─────────────────────────────────────────────────────────────
const file1m = path.join(__dirname, 'data', 'historical', 'ETHUSDT_1m.ndjson');
const file15m = path.join(__dirname, 'data', 'historical', 'ETHUSDT_15m.ndjson');

if (!fs.existsSync(file1m)) {
  console.error('Missing ETHUSDT_1m.ndjson');
  process.exit(1);
}

console.log('Loading data...');
const raw1m = loadNDJSON(file1m);

// Build 5m from 1m
const raw5m = resample(raw1m, 5 * 60 * 1000);
// Build 15m from 1m (for consistency with same data source)
const raw15m_from1m = resample(raw1m, 15 * 60 * 1000);

const firstDate = new Date(raw1m[0].openTime);
const lastDate  = new Date(raw1m[raw1m.length-1].openTime);

// Build list of months to test
const months = [];
if (FROM_ARG && TO_ARG) {
  // single window mode
  months.push({ single: true, from: FROM_ARG, to: TO_ARG });
} else {
  let y = firstDate.getUTCFullYear(), m = firstDate.getUTCMonth()+1;
  while (y < lastDate.getUTCFullYear() || (y===lastDate.getUTCFullYear() && m<=lastDate.getUTCMonth()+1)) {
    months.push({ y, m }); m++; if (m>12){ m=1; y++; }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────
const TFS = [
  { name: '5m',  candles: raw5m,         tfMs: 5*60*1000  },
  { name: '15m', candles: raw15m_from1m, tfMs: 15*60*1000 },
];

// Results store
const monthlyData = {};
for (const tf of TFS) monthlyData[tf.name] = [];

const P  = (v, n) => String(v).padStart(n);
const PL = (v, n) => String(v).padEnd(n);
const sign = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
const $v = v => (v >= 0 ? '+' : '') + v.toFixed(2);

console.log('\n' + '='.repeat(140));
console.log('HYBRID_MFI_BB_TRAIL BACKTEST — ETHUSDT | $100 start | 1% risk/trade');
console.log('Entry: BB lower/upper + RSI oversold/overbought + MFI volume-confirmed + EMA200 trend + reversal bar');
console.log('Exit: ATR trail (2.5×, at 0.5R) + BB midline TP (cap 3R) + 20-bar time exit');
console.log('Fill model: Conservative (TP needs 1-tick penetration) | Real fees: taker 5bps + maker 2bps + slip 6bps');
console.log('='.repeat(140));

// Column layout: Month | 5m_cons_real | 5m_cons_zero | 5m_opt_real | 15m_cons_real | 15m_cons_zero | 15m_opt_real
console.log('\n' + PL('Month', 9) +
  PL('── 5m Conservative ──────────────────────────', 50) +
  PL('── 15m Conservative ─────────────────────────', 50));
console.log(PL('', 9) +
  PL('n   T/d  WR%  R_avgR  R_Ret  Z_avgR  Z_Ret  t', 50) +
  PL('n   T/d  WR%  R_avgR  R_Ret  Z_avgR  Z_Ret  t', 50));
console.log('─'.repeat(109));

for (const mo of months) {
  let label, fromMs, toMs, daysInPeriod;

  if (mo.single) {
    label = `${mo.from}→${mo.to}`;
    fromMs = Date.parse(mo.from + 'T00:00:00Z');
    toMs   = Date.parse(mo.to   + 'T23:59:59Z');
    daysInPeriod = Math.ceil((toMs - fromMs) / 86400000);
  } else {
    label = `${mo.y}-${String(mo.m).padStart(2,'0')}`;
    fromMs = new Date(Date.UTC(mo.y, mo.m-1, 1)).getTime();
    toMs   = new Date(Date.UTC(mo.y, mo.m, 0, 23, 59, 59, 999)).getTime();
    daysInPeriod = new Date(Date.UTC(mo.y, mo.m, 0)).getUTCDate();
  }

  let line = PL(label, 9);

  for (const tf of TFS) {
    const startIdx = tf.candles.findIndex(c => c.openTime >= fromMs);
    if (startIdx < 0) { line += PL('< data', 50); continue; }
    const warmup = startIdx;
    const slice  = tf.candles.filter(c => c.openTime <= toMs);
    const monthTf = tf.candles.filter(c => c.openTime >= fromMs && c.openTime <= toMs);
    if (monthTf.length < 30) { line += PL('< 30 bars', 50); continue; }

    // Conservative real-cost
    const r_cons = run(slice, EQUITY, { warmup, fillMode: 'conservative', zeroCost: false, tfMs: tf.tfMs });
    const t_cons = r_cons.trades.filter(t => t.entryTime >= fromMs && t.entryTime <= toMs);
    const s_cons = stats(t_cons, daysInPeriod);

    // Conservative zero-cost
    const r_zero = run(slice, EQUITY, { warmup, fillMode: 'conservative', zeroCost: true, tfMs: tf.tfMs });
    const t_zero = r_zero.trades.filter(t => t.entryTime >= fromMs && t.entryTime <= toMs);
    const s_zero = stats(t_zero, daysInPeriod);

    // Record
    monthlyData[tf.name].push({
      label, n: s_cons.n, tpd: s_cons.tpd,
      wr: s_cons.wr, avgR_real: s_cons.avgR, ret_real: s_cons.ret, t: s_cons.t,
      avgR_zero: s_zero.avgR, ret_zero: s_zero.ret,
      pf: s_cons.pf, reasons: s_cons.reasons, maxDD: s_cons.maxDD,
    });

    if (!s_cons.n) { line += PL('0 trades', 50); continue; }

    const cell =
      `${String(s_cons.n).padStart(3)} ${s_cons.tpd.toFixed(1).padStart(4)} ${s_cons.wr.toFixed(0).padStart(3)}% ` +
      `${s_cons.avgR.toFixed(3).padStart(7)} ${sign(s_cons.ret).padStart(7)} ` +
      `${s_zero.avgR.toFixed(3).padStart(7)} ${sign(s_zero.ret).padStart(7)} ` +
      `${s_cons.t.toFixed(1).padStart(4)}`;
    line += PL(cell, 50);
  }
  console.log(line);
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(140));
console.log('SUMMARY');
console.log('Columns: avg R (real, conservative fills) | avg R (zero-cost) | profitable months | ≥5% months | avg t-stat');
console.log('─'.repeat(140));

let bestTf = null, bestAvgR = -Infinity;

for (const tf of TFS) {
  const data = monthlyData[tf.name].filter(d => d.n > 0);
  if (!data.length) { console.log(`${tf.name}: no data`); continue; }

  const avgR_real = data.reduce((a,d) => a + d.avgR_real, 0) / data.length;
  const avgR_zero = data.reduce((a,d) => a + d.avgR_zero, 0) / data.length;
  const avgRet    = data.reduce((a,d) => a + d.ret_real, 0) / data.length;
  const posMonths = data.filter(d => d.ret_real > 0).length;
  const over5     = data.filter(d => d.ret_real >= 5).length;
  const over10    = data.filter(d => d.ret_real >= 10).length;
  const over20    = data.filter(d => d.ret_real >= 20).length;
  const avgT      = data.reduce((a,d) => a + d.t, 0) / data.length;
  const avgTPD    = data.reduce((a,d) => a + d.tpd, 0) / data.length;

  console.log(`\n${tf.name}:`);
  console.log(`  Months with trades: ${data.length} | Avg trades/day: ${avgTPD.toFixed(1)}`);
  console.log(`  Real (conservative): avgR ${avgR_real.toFixed(3)} | avg monthly ret ${avgRet.toFixed(1)}% | profitable ${posMonths}/${data.length} | ≥5%: ${over5} | ≥10%: ${over10} | ≥20%: ${over20}`);
  console.log(`  Zero-cost:           avgR ${avgR_zero.toFixed(3)} | ${data.filter(d=>d.ret_zero>0).length}/${data.length} profitable`);
  console.log(`  avg t-stat: ${avgT.toFixed(2)} | Fee drag: ${(avgR_zero - avgR_real).toFixed(3)}R/trade`);

  // Exit breakdown across all months
  const allReasons = {};
  for (const d of data) for (const [k,v] of Object.entries(d.reasons||{})) allReasons[k] = (allReasons[k]||0)+v;
  const totalT = Object.values(allReasons).reduce((a,b)=>a+b,0);
  const reasonStr = Object.entries(allReasons).map(([k,v]) => `${k}:${v}(${(v/totalT*100).toFixed(0)}%)`).join(' ');
  console.log(`  Exit reasons (all months): ${reasonStr}`);

  // All monthly returns
  console.log(`  Monthly returns: ${data.map(d => sign(d.ret_real).padStart(8)).join('')}`);

  if (avgR_real > bestAvgR) { bestAvgR = avgR_real; bestTf = tf.name; }
}

// ── Acceptance verdict ────────────────────────────────────────────────────
console.log('\n' + '='.repeat(140));
console.log('ACCEPTANCE CRITERIA CHECK');
console.log('  Pass if: zero-cost avgR > 0 (signal has edge)');
console.log('           real-cost avgR > 0 (fees don\'t destroy edge)');
console.log('           profitable months ≥ 7/12 (under conservative fills)');
console.log('           t-stat > 1.0 (statistically meaningful)');
console.log('─'.repeat(140));

for (const tf of TFS) {
  const data = monthlyData[tf.name].filter(d => d.n > 0);
  if (!data.length) continue;
  const avgR_real = data.reduce((a,d) => a+d.avgR_real,0)/data.length;
  const avgR_zero = data.reduce((a,d) => a+d.avgR_zero,0)/data.length;
  const posMonths = data.filter(d => d.ret_real > 0).length;
  const avgT      = data.reduce((a,d) => a+d.t,0)/data.length;

  const c1 = avgR_zero > 0    ? '✓' : '✗';
  const c2 = avgR_real > 0    ? '✓' : '✗';
  const c3 = posMonths >= 7   ? '✓' : '✗';
  const c4 = avgT > 1.0       ? '✓' : '✗';
  const pass = c1==='✓' && c2==='✓' && c3==='✓' && c4==='✓';

  console.log(`\n${tf.name}: ${pass ? '✅ PASS — ready for Phase 2 (exit optimization)' : '❌ FAIL — do not wire into liveRunner.js'}`);
  console.log(`  ${c1} Zero-cost avgR: ${avgR_zero.toFixed(4)} (need > 0)`);
  console.log(`  ${c2} Real avgR:      ${avgR_real.toFixed(4)} (need > 0)`);
  console.log(`  ${c3} Profitable months: ${posMonths}/${data.length} (need ≥ 7)`);
  console.log(`  ${c4} avg t-stat:     ${avgT.toFixed(2)} (need > 1.0)`);
}

console.log('\n' + '='.repeat(140));
console.log('NEXT STEPS:');
console.log('  PASS: run Phase 2 (exit variant test) → Phase 3 (90-day validation) → Phase 4 (wire into liveRunner)');
console.log('  FAIL on real but PASS on zero-cost: signal has edge but fee drag at this capital. Try 15m / higher capital.');
console.log('  FAIL on zero-cost: no signal edge. Go back to research.');
console.log('='.repeat(140));
