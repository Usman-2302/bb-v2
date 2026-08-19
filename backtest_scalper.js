'use strict';
/**
 * BulletBrain — Scalper Backtest (3m / 5m timeframes)
 *
 * Base data: ETHUSDT_1m.ndjson (resampled to 3m or 5m)
 * Window: July 2026 (2026-07-01 to 2026-07-31) by default
 * Goal: 3–10 trades/day, exit within 1–2 hours, compounding from $100
 *
 * Usage:
 *   node backtest_scalper.js
 *   node backtest_scalper.js --from 2026-07-01 --to 2026-07-31
 *   node backtest_scalper.js --equity 100
 */

const fs   = require('fs');
const path = require('path');

// ── CLI ───────────────────────────────────────────────────────────────────
function arg(n, d) { const i=process.argv.indexOf('--'+n); return i>=0&&process.argv[i+1]?process.argv[i+1]:d; }
const FROM   = arg('from',   '2026-07-01');
const TO     = arg('to',     '2026-07-31');
const EQUITY = parseFloat(arg('equity', '100'));
const RISK   = parseFloat(arg('risk',   '0.01'));   // 1% per trade

// ── Fees (real Binance rates from account fills) ──────────────────────────
const TAKER = 0.0005;
const MAKER = 0.0002;
const SLIP  = 0.0006;   // per side (conservative; measured from live fills)
// round-trip: taker in + slip + taker out + slip (stops always taker)
const LOSS_COST = TAKER + TAKER + 2 * SLIP;
const WIN_COST  = TAKER + MAKER + 2 * SLIP;

// ── Data loading ──────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  out.sort((a, b) => a.openTime - b.openTime);
  const dedup = [];
  for (const c of out) {
    if (!dedup.length || dedup[dedup.length-1].openTime !== c.openTime) dedup.push(c);
  }
  return dedup;
}

function slice(candles, from, to) {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to   + 'T23:59:59Z');
  return candles.filter(c => c.openTime >= a && c.openTime <= b);
}

function resample(base, tfMs) {
  const baseMs   = base[1].openTime - base[0].openTime;
  if (tfMs === baseMs) return base.slice();
  const expected = tfMs / baseMs;
  const out = []; let cur = null, cnt = 0;
  for (const c of base) {
    const bucket = Math.floor(c.openTime / tfMs) * tfMs;
    if (!cur || cur.openTime !== bucket) {
      if (cur && cnt === expected) out.push(cur);
      cur = { openTime: bucket, closeTime: bucket + tfMs - 1,
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

// ── Indicators ────────────────────────────────────────────────────────────
function ema(prices, n) {
  const k = 2 / (n + 1), out = Array(prices.length).fill(NaN);
  let v = NaN;
  for (let i = 0; i < prices.length; i++) {
    if (!isFinite(v)) v = prices[i];
    else v = prices[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function atrArr(candles, n = 14) {
  const out = Array(candles.length).fill(NaN);
  let prev = candles[0].close, smooth = NaN;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev));
    smooth = !isFinite(smooth) ? tr : smooth * (n-1)/n + tr/n;
    out[i] = smooth;
    prev = candles[i].close;
  }
  return out;
}

function rvolArr(candles, n = 20) {
  const v = candles.map(c => c.volume), out = Array(candles.length).fill(1);
  let s = 0;
  for (let i = 0; i < candles.length; i++) {
    s += v[i]; if (i >= n) s -= v[i-n];
    if (i >= n-1) out[i] = (s/n) > 0 ? v[i]/(s/n) : 1;
  }
  return out;
}

function rsiArr(closes, n = 14) {
  const out = Array(closes.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i <= n) { ag += g/n; al += l/n; if (i === n) out[i] = al===0 ? 100 : 100 - 100/(1+ag/al); }
    else { ag = (ag*(n-1)+g)/n; al = (al*(n-1)+l)/n; out[i] = al===0 ? 100 : 100-100/(1+ag/al); }
  }
  return out;
}

function rollingMax(vals, n) {
  const out = Array(vals.length).fill(NaN);
  for (let i = n-1; i < vals.length; i++) {
    let b = -Infinity;
    for (let j = i-n+1; j <= i; j++) if (vals[j] > b) b = vals[j];
    out[i] = b;
  }
  return out;
}
function rollingMin(vals, n) {
  const out = Array(vals.length).fill(NaN);
  for (let i = n-1; i < vals.length; i++) {
    let b = Infinity;
    for (let j = i-n+1; j <= i; j++) if (vals[j] < b) b = vals[j];
    out[i] = b;
  }
  return out;
}
function rollingMean(vals, n) {
  const out = Array(vals.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i]; if (i >= n) s -= vals[i-n];
    if (i >= n-1) out[i] = s/n;
  }
  return out;
}
function rollingSd(vals, n) {
  const out = Array(vals.length).fill(NaN);
  let s = 0, ss = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i]; ss += vals[i]*vals[i];
    if (i >= n) { s -= vals[i-n]; ss -= vals[i-n]*vals[i-n]; }
    if (i >= n-1) { const m=s/n; out[i]=Math.sqrt(Math.max(0,ss/n-m*m)); }
  }
  return out;
}

function buildCtx(candles) {
  const n      = candles.length;
  const close  = candles.map(c => c.close);
  const high   = candles.map(c => c.high);
  const low    = candles.map(c => c.low);
  const open   = candles.map(c => c.open);
  const volume = candles.map(c => c.volume);

  const ret1   = Array(n).fill(0);
  for (let i = 1; i < n; i++) ret1[i] = Math.log(close[i] / close[i-1]);

  const atr    = atrArr(candles, 14);
  const e9     = ema(close, 9);
  const e20    = ema(close, 20);
  const e50    = ema(close, 50);
  const e200   = ema(close, 200);
  const rv     = rvolArr(candles, 20);
  const rsi    = rsiArr(close, 14);

  // Volatility z-score
  const rv20    = rollingSd(ret1, 20);
  const rv100   = rollingMean(rv20.map(v => isFinite(v) ? v : 0), 100);
  const rvSd    = rollingSd(rv20.map(v => isFinite(v) ? v : 0), 100);
  const volZ    = Array(n).fill(NaN);
  for (let i = 0; i < n; i++)
    if (isFinite(rv20[i]) && rvSd[i] > 0) volZ[i] = (rv20[i] - rv100[i]) / rvSd[i];

  // Bollinger bands (20, 2)
  const bbMid = rollingMean(close, 20);
  const bbSd  = rollingSd(close, 20);
  const bbUp  = bbMid.map((m, i) => isFinite(m) ? m + 2 * bbSd[i] : NaN);
  const bbDn  = bbMid.map((m, i) => isFinite(m) ? m - 2 * bbSd[i] : NaN);

  // rolling highs/lows for swing levels
  const h10 = rollingMax(high, 10);
  const l10 = rollingMin(low,  10);
  const h20 = rollingMax(high, 20);
  const l20 = rollingMin(low,  20);

  // VWAP (session-anchored, resets each UTC day)
  const vwap = Array(n).fill(NaN);
  let dayMs = null, pv = 0, vv = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(candles[i].openTime / 86400000) * 86400000;
    if (d !== dayMs) { dayMs = d; pv = 0; vv = 0; }
    const tp = (high[i] + low[i] + close[i]) / 3;
    pv += tp * volume[i]; vv += volume[i];
    vwap[i] = vv > 0 ? pv / vv : close[i];
  }

  // Stochastic (14, 3)
  const stochK = Array(n).fill(50);
  for (let i = 14; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i-13; j <= i; j++) { if (high[j] > hh) hh = high[j]; if (low[j] < ll) ll = low[j]; }
    stochK[i] = hh !== ll ? (close[i] - ll) / (hh - ll) * 100 : 50;
  }
  const stochD = rollingMean(stochK, 3);

  return {
    candles, n, open, close, high, low, volume, ret1,
    atr, e9, e20, e50, e200, rv, rsi, volZ,
    bbUp, bbDn, bbMid,
    h10, l10, h20, l20,
    vwap, stochK, stochD,
  };
}

// ── Backtest engine ────────────────────────────────────────────────────────
function run(strategy, candles, startEquity) {
  const ctx    = buildCtx(candles);
  const n      = candles.length;
  const trades = []; const rejects = {};
  let equity   = startEquity;
  let open     = null;
  const rej    = k => { rejects[k] = (rejects[k]||0)+1; };

  for (let i = strategy.warmup || 200; i < n - 1; i++) {

    // ── manage open position ─────────────────────────────────────────────
    if (open) {
      const bar  = candles[i];
      const dir  = open.dir;
      const gapped = dir > 0 ? bar.open <= open.sl : bar.open >= open.sl;
      const hitSL  = dir > 0 ? bar.low  <= open.sl : bar.high >= open.sl;
      const hitTP  = dir > 0 ? bar.high >= open.tp : bar.low  <= open.tp;
      const timed  = (i - open.idx) >= (strategy.maxBars || 999);

      // trailing stop update before checking exit
      if (strategy.trail && !gapped && !hitSL && !hitTP && !timed) {
        const updated = strategy.trail(open, ctx, i);
        if (updated !== undefined) open.sl = updated;
      }

      let exitPx = null, isMaker = false, reason = null;
      if (gapped)  { exitPx = bar.open;  reason = 'SL_GAP'; }
      else if (hitSL) { exitPx = open.sl;  reason = 'SL'; }
      else if (hitTP) { exitPx = open.tp;  reason = 'TP'; isMaker = true; }
      else if (timed) { exitPx = bar.close; reason = 'TIME'; }

      if (exitPx !== null) {
        // Exit fill: TP is a resting LIMIT (maker, no additional slip).
        // SL/TIME/GAP is a market order: exit price already AT the stop level,
        // slippage is an ADDITIONAL cost on top — not baked into exitPx.
        // So: exitFill = exitPx for TP (limit), exitPx ± slip for market exits.
        const exitFill  = isMaker ? exitPx : exitPx * (1 + dir * SLIP);
        // Gross is price move in our favour (positive = win)
        const gross     = (exitFill - open.entry) * dir * open.qty;
        // Fees:
        //   - entryFee already computed at open (taker fee on entry notional, no double-slip)
        //   - exit: maker fee only (TP), or taker fee only (SL/TIME) — slip is in exitFill already
        const exitFee   = Math.abs(exitPx * open.qty) * (isMaker ? MAKER : TAKER);
        const feesTotal = open.entryFee + exitFee;
        const pnl  = gross - feesTotal;
        equity    += pnl;
        const stopD = Math.abs(open.entry - open.sl);
        trades.push({
          dir, reason, pnl, equity,
          rMult:    stopD > 0 ? pnl / (stopD * open.qty) : NaN,
          fees:     feesTotal,
          holdBars: i - open.idx,
          entry:    open.entry, exit: exitFill,
          entryTime: open.entryTime, exitTime: bar.closeTime,
        });
        open = null;
      }
    }
    if (open) continue;

    // ── signal ───────────────────────────────────────────────────────────
    const sig = strategy.signal(ctx, i);
    if (!sig) continue;

    const nextBar = candles[i + 1];
    // Entry is a market order: fill = open + one-way slippage
    const rawOpen = nextBar.open;
    const entry   = rawOpen * (1 + sig.dir * SLIP);   // slippage cost baked into fill price
    const sl      = strategy.sl(ctx, i, sig, entry);
    const tp      = strategy.tp(ctx, i, sig, entry, sl);

    if (!isFinite(sl) || !isFinite(tp)) { rej('invalid_sltp'); continue; }
    const stopD = Math.abs(entry - sl);
    if (stopD <= 0) { rej('zero_stop'); continue; }
    if (sig.dir > 0 && sl >= entry) { rej('sl_wrong_side'); continue; }
    if (sig.dir < 0 && sl <= entry) { rej('sl_wrong_side'); continue; }

    // cost floor: TP must cover both fee legs
    const tpMove = Math.abs(tp - entry) / entry;
    if (tpMove < WIN_COST) { rej('cost_floor'); continue; }

    // Risk sizing: riskAmt covers full expected max loss (price move to SL + fees)
    // LOSS_COST = TAKER+TAKER (two taker fees), slip is already in the fill prices
    const riskAmt  = equity * RISK;
    const perUnit  = stopD + entry * (TAKER + TAKER);  // only fee rates, slip already in prices
    const qty      = riskAmt / perUnit;
    const entryFee = entry * qty * TAKER;               // taker fee only, slip already in entry price

    open = {
      dir: sig.dir, entry, sl, tp, qty, entryFee,
      idx: i + 1, entryTime: nextBar.openTime,
    };
  }
  return { trades, rejects, finalEquity: equity };
}

// ── Stats ─────────────────────────────────────────────────────────────────
function stats(trades, days) {
  if (!trades.length) return { n: 0 };
  const rs    = trades.map(t => t.rMult).filter(isFinite);
  const wins  = rs.filter(r => r > 0);
  const avgR  = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sdR   = Math.sqrt(rs.reduce((a, r) => a + (r-avgR)**2, 0) / rs.length);
  const tStat = sdR > 0 ? avgR / (sdR / Math.sqrt(rs.length)) : 0;
  const pf    = wins.reduce((a,b)=>a+b,0) /
                Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  let peak = 0, dd = 0, eq = 0;
  for (const r of rs) { eq += r; if (eq > peak) peak = eq; if (peak-eq > dd) dd = peak-eq; }
  const wpct  = wins.length / rs.length * 100;
  const tpd   = trades.length / days;
  // avg hold in minutes — inferred from holdBars
  const avgHold = trades.reduce((a, t) => a + t.holdBars, 0) / trades.length;
  return {
    n: trades.length, wins: wins.length, losses: rs.length - wins.length,
    wr: wpct, avgR, sdR, tStat, pf, maxDD: dd, tpd, avgHold,
    totalR: rs.reduce((a,b)=>a+b,0),
  };
}

// Block bootstrap Monte Carlo
function mc(trades, iters = 2000, block = 15) {
  const rs = trades.map(t => t.rMult).filter(isFinite);
  if (rs.length < block * 2) return null;
  const finals = [], dds = [];
  for (let it = 0; it < iters; it++) {
    const sim = [];
    while (sim.length < rs.length) {
      const s = Math.floor(Math.random() * (rs.length - block));
      for (let j = 0; j < block && sim.length < rs.length; j++) sim.push(rs[s+j]);
    }
    let eq = 0, peak = 0, dd = 0;
    for (const r of sim) { eq += r; if (eq > peak) peak = eq; if (peak-eq > dd) dd = peak-eq; }
    finals.push(eq); dds.push(dd);
  }
  finals.sort((a,b)=>a-b); dds.sort((a,b)=>a-b);
  return {
    p5:  finals[Math.floor(0.05*iters)],
    p50: finals[Math.floor(0.50*iters)],
    p95: finals[Math.floor(0.95*iters)],
    p95DD: dds[Math.floor(0.95*iters)],
    pProfit: finals.filter(f=>f>0).length/iters*100,
  };
}

// ── SCALPER STRATEGIES ─────────────────────────────────────────────────────
// All designed for 3m or 5m. Target: 3-10 trades/day, hold 15–90 min.
// Key insight from results: need WR ≥ 40% at 2R to be profitable.
// Approaches: tighter entry conditions, require confluence of 2+ signals,
// only enter with-trend AND after a confirmed structure point.
// ──────────────────────────────────────────────────────────────────────────

const SCALPERS = [

  // ── S1: EMA Stack Pullback — require 3 EMAs aligned + touch bounce ────
  {
    name: 'S1_EMA_stack_pullback_3m',
    tf: '3m', tfMs: 3 * 60 * 1000,
    desc: 'All 3 EMAs (9>20>50) aligned = strong trend. Price pulls back exactly to EMA20 (low touches, close above). RVOL ≥ 1.0. Tight stop just below EMA50. 2.5R target.',
    warmup: 200, maxBars: 30,
    signal: (ctx, i) => {
      if (!isFinite(ctx.e50[i]) || !isFinite(ctx.e200[i])) return null;
      // Strong aligned trend
      const strongUp = ctx.e9[i] > ctx.e20[i] && ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e200[i];
      const strongDn = ctx.e9[i] < ctx.e20[i] && ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e200[i];
      // Price touched EMA20 and reclaimed — clean pullback entry
      const touchLong  = ctx.low[i] <= ctx.e20[i] && ctx.close[i] > ctx.e20[i] && ctx.close[i] > ctx.open[i];
      const touchShort = ctx.high[i] >= ctx.e20[i] && ctx.close[i] < ctx.e20[i] && ctx.close[i] < ctx.open[i];
      if (strongUp && touchLong  && ctx.rv[i] >= 1.0) return { dir: 1 };
      if (strongDn && touchShort && ctx.rv[i] >= 1.0) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => {
      // Stop below EMA50 — structural level
      const structStop = sig.dir > 0 ? ctx.e50[i] - ctx.atr[i] * 0.3 : ctx.e50[i] + ctx.atr[i] * 0.3;
      const atrStop    = entry - sig.dir * ctx.atr[i] * 1.5;
      // Use whichever is tighter but still valid
      if (sig.dir > 0) return Math.min(structStop, atrStop);
      return Math.max(structStop, atrStop);
    },
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
  },

  // ── S2: VWAP Reclaim + EMA trend alignment ────────────────────────────
  {
    name: 'S2_VWAP_reclaim_trend_3m',
    tf: '3m', tfMs: 3 * 60 * 1000,
    desc: 'VWAP reclaim (wick through, close back) PLUS EMAs confirm trend direction. Both conditions required. This filters out counter-trend fades.',
    warmup: 200, maxBars: 25,
    signal: (ctx, i) => {
      if (!isFinite(ctx.vwap[i]) || !isFinite(ctx.e50[i])) return null;
      const trendUp = ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e50[i];
      const trendDn = ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e50[i];
      // Reclaim: wick through VWAP but close on trend side, bullish/bearish bar
      const reclaimL = ctx.low[i] < ctx.vwap[i] && ctx.close[i] > ctx.vwap[i] && ctx.close[i] > ctx.open[i];
      const reclaimS = ctx.high[i] > ctx.vwap[i] && ctx.close[i] < ctx.vwap[i] && ctx.close[i] < ctx.open[i];
      if (trendUp && reclaimL && ctx.rv[i] >= 1.2) return { dir: 1 };
      if (trendDn && reclaimS && ctx.rv[i] >= 1.2) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 2.0,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
  },

  // ── S3: RSI divergence from oversold/overbought ───────────────────────
  {
    name: 'S3_RSI_turn_trend_3m',
    tf: '3m', tfMs: 3 * 60 * 1000,
    desc: 'RSI oversold (<35) turning up, inside uptrend. Requires RSI to have been declining for 3+ bars before turning = real exhaustion, not noise.',
    warmup: 200, maxBars: 30,
    signal: (ctx, i) => {
      if (!isFinite(ctx.rsi[i]) || !isFinite(ctx.e200[i])) return null;
      const trendUp = ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e200[i];
      // RSI was declining for 3 bars then turns from extreme
      const rsiDeclined3 = ctx.rsi[i-3] > ctx.rsi[i-2] && ctx.rsi[i-2] > ctx.rsi[i-1];
      const rsiRose3     = ctx.rsi[i-3] < ctx.rsi[i-2] && ctx.rsi[i-2] < ctx.rsi[i-1];
      const longOk  = trendUp && rsiDeclined3 && ctx.rsi[i-1] < 35 && ctx.rsi[i] > ctx.rsi[i-1];
      const shortOk = trendDn && rsiRose3     && ctx.rsi[i-1] > 65 && ctx.rsi[i] < ctx.rsi[i-1];
      if (longOk)  return { dir: 1 };
      if (shortOk) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 2.0,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.0,
  },

  // ── S4: High-Volume Impulse with Trailing Stop (3m) ───────────────────
  {
    name: 'S4_HiVol_impulse_trail_3m',
    tf: '3m', tfMs: 3 * 60 * 1000,
    desc: 'RVOL ≥ 2.5 (very high volume) impulse bar with EMA trend alignment. Ride with 3×ATR trail. Highest confidence version of momentum signal.',
    warmup: 200, maxBars: 30,
    signal: (ctx, i) => {
      if (!(ctx.rv[i] >= 2.5) || !isFinite(ctx.e200[i])) return null;
      const isUp = ctx.close[i] > ctx.open[i];
      const trendUp = ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e200[i];
      if (trendUp && isUp)  return { dir: 1 };
      if (trendDn && !isUp) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 2.5,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 3.0,
    trail: (open, ctx, i) => {
      const prog = (ctx.close[i] - open.entry) * open.dir;
      const risk = Math.abs(open.entry - open.sl);
      if (prog < risk * 0.5) return undefined;
      const t = ctx.close[i] - open.dir * ctx.atr[i] * 3.0;
      return open.dir > 0 ? Math.max(open.sl, t) : Math.min(open.sl, t);
    },
  },

  // ── S5: 5m EMA Stack Pullback ─────────────────────────────────────────
  {
    name: 'S5_EMA_stack_pullback_5m',
    tf: '5m', tfMs: 5 * 60 * 1000,
    desc: 'Same logic as S1 but on 5m. Larger ATR = bigger stop distance = easier to clear cost floor. Lower frequency but better signal quality.',
    warmup: 200, maxBars: 18,
    signal: (ctx, i) => {
      if (!isFinite(ctx.e50[i]) || !isFinite(ctx.e200[i])) return null;
      const strongUp = ctx.e9[i] > ctx.e20[i] && ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e200[i];
      const strongDn = ctx.e9[i] < ctx.e20[i] && ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e200[i];
      const touchLong  = ctx.low[i] <= ctx.e20[i] && ctx.close[i] > ctx.e20[i] && ctx.close[i] > ctx.open[i];
      const touchShort = ctx.high[i] >= ctx.e20[i] && ctx.close[i] < ctx.e20[i] && ctx.close[i] < ctx.open[i];
      if (strongUp && touchLong  && ctx.rv[i] >= 1.0) return { dir: 1 };
      if (strongDn && touchShort && ctx.rv[i] >= 1.0) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => {
      const structStop = sig.dir > 0 ? ctx.e50[i] - ctx.atr[i] * 0.3 : ctx.e50[i] + ctx.atr[i] * 0.3;
      const atrStop    = entry - sig.dir * ctx.atr[i] * 1.5;
      if (sig.dir > 0) return Math.min(structStop, atrStop);
      return Math.max(structStop, atrStop);
    },
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
  },

  // ── S6: 5m VWAP reclaim + trend ──────────────────────────────────────
  {
    name: 'S6_VWAP_reclaim_trend_5m',
    tf: '5m', tfMs: 5 * 60 * 1000,
    desc: 'Same as S2 at 5m. Bigger candles = more reliable wick/reclaim signal. VWAP defense is stronger at 5m because it represents 5 min of volume-weighted flow.',
    warmup: 200, maxBars: 18,
    signal: (ctx, i) => {
      if (!isFinite(ctx.vwap[i]) || !isFinite(ctx.e50[i])) return null;
      const trendUp = ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e50[i];
      const trendDn = ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e50[i];
      const reclaimL = ctx.low[i] < ctx.vwap[i] && ctx.close[i] > ctx.vwap[i] && ctx.close[i] > ctx.open[i];
      const reclaimS = ctx.high[i] > ctx.vwap[i] && ctx.close[i] < ctx.vwap[i] && ctx.close[i] < ctx.open[i];
      if (trendUp && reclaimL && ctx.rv[i] >= 1.2) return { dir: 1 };
      if (trendDn && reclaimS && ctx.rv[i] >= 1.2) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 2.0,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
  },

  // ── S7: 5m High-Volume Impulse + Trail ────────────────────────────────
  {
    name: 'S7_HiVol_impulse_trail_5m',
    tf: '5m', tfMs: 5 * 60 * 1000,
    desc: 'RVOL ≥ 2.5 impulse at 5m with ATR trail. 5m impulse moves are larger (~0.4-0.8% vs 0.2-0.4% at 3m) — better fee coverage.',
    warmup: 200, maxBars: 18,
    signal: (ctx, i) => {
      if (!(ctx.rv[i] >= 2.5) || !isFinite(ctx.e200[i])) return null;
      const isUp = ctx.close[i] > ctx.open[i];
      const trendUp = ctx.e20[i] > ctx.e50[i] && ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.e20[i] < ctx.e50[i] && ctx.close[i] < ctx.e200[i];
      if (trendUp && isUp)  return { dir: 1 };
      if (trendDn && !isUp) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 2.5,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 3.0,
    trail: (open, ctx, i) => {
      const prog = (ctx.close[i] - open.entry) * open.dir;
      const risk = Math.abs(open.entry - open.sl);
      if (prog < risk * 0.5) return undefined;
      const t = ctx.close[i] - open.dir * ctx.atr[i] * 3.0;
      return open.dir > 0 ? Math.max(open.sl, t) : Math.min(open.sl, t);
    },
  },

  // ── S8: 3m Stochastic oversold + EMA alignment ────────────────────────
  {
    name: 'S8_Stoch_oversold_aligned_3m',
    tf: '3m', tfMs: 3 * 60 * 1000,
    desc: 'Stoch %K crosses up from below 25 (deep oversold) while EMAs are bullish-aligned. Requires bullish close bar on the signal. Mirror for shorts.',
    warmup: 200, maxBars: 25,
    signal: (ctx, i) => {
      if (!isFinite(ctx.stochD[i]) || !isFinite(ctx.e50[i])) return null;
      const alignUp = ctx.e9[i] > ctx.e20[i] && ctx.e20[i] > ctx.e50[i];
      const alignDn = ctx.e9[i] < ctx.e20[i] && ctx.e20[i] < ctx.e50[i];
      const deepOsBull = ctx.stochK[i-1] < 25 && ctx.stochK[i] > ctx.stochK[i-1] && ctx.close[i] > ctx.open[i];
      const deepOsBear = ctx.stochK[i-1] > 75 && ctx.stochK[i] < ctx.stochK[i-1] && ctx.close[i] < ctx.open[i];
      if (alignUp && deepOsBull) return { dir: 1 };
      if (alignDn && deepOsBear) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 1.8,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
  },

  // ── S9: 3m EMA9/50 cross only in strong trend ─────────────────────────
  {
    name: 'S9_EMA9_50_cross_strongtrend_3m',
    tf: '3m', tfMs: 3 * 60 * 1000,
    desc: 'EMA9 crosses EMA50 (bigger separation than 9/20) in direction of EMA200 macro trend. Stronger signal with less noise. Trail with 2.5×ATR.',
    warmup: 200, maxBars: 30,
    signal: (ctx, i) => {
      if (!isFinite(ctx.e200[i]) || !isFinite(ctx.e50[i])) return null;
      const macroUp = ctx.close[i] > ctx.e200[i];
      const macroDn = ctx.close[i] < ctx.e200[i];
      const xUp = ctx.e9[i] > ctx.e50[i] && ctx.e9[i-1] <= ctx.e50[i-1];
      const xDn = ctx.e9[i] < ctx.e50[i] && ctx.e9[i-1] >= ctx.e50[i-1];
      if (macroUp && xUp && ctx.rv[i] >= 1.0) return { dir: 1 };
      if (macroDn && xDn && ctx.rv[i] >= 1.0) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => entry - sig.dir * ctx.atr[i] * 2.0,
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
    trail: (open, ctx, i) => {
      const prog = (ctx.close[i] - open.entry) * open.dir;
      const risk = Math.abs(open.entry - open.sl);
      if (prog < risk) return undefined;
      const t = ctx.close[i] - open.dir * ctx.atr[i] * 2.5;
      return open.dir > 0 ? Math.max(open.sl, t) : Math.min(open.sl, t);
    },
  },

  // ── S10: 5m 3-bar pullback in strong trend ────────────────────────────
  {
    name: 'S10_3bar_pullback_5m',
    tf: '5m', tfMs: 5 * 60 * 1000,
    desc: '3 consecutive bearish bars (lower closes) in an uptrend = pullback. 4th bar closes bullish = resumption. Simple price action, no indicator lag. Mirror for shorts.',
    warmup: 200, maxBars: 18,
    signal: (ctx, i) => {
      if (!isFinite(ctx.e50[i]) || !isFinite(ctx.e200[i])) return null;
      const trendUp = ctx.close[i] > ctx.e50[i] && ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.close[i] < ctx.e50[i] && ctx.close[i] < ctx.e200[i];
      // 3 declining bars then bullish reversal bar
      const pullbackLong  = ctx.close[i-3] > ctx.close[i-2] && ctx.close[i-2] > ctx.close[i-1]
                         && ctx.close[i] > ctx.open[i] && ctx.close[i] > ctx.close[i-1]
                         && ctx.close[i] > ctx.e20[i];
      const pullbackShort = ctx.close[i-3] < ctx.close[i-2] && ctx.close[i-2] < ctx.close[i-1]
                         && ctx.close[i] < ctx.open[i] && ctx.close[i] < ctx.close[i-1]
                         && ctx.close[i] < ctx.e20[i];
      if (trendUp && pullbackLong  && ctx.rv[i] >= 0.8) return { dir: 1 };
      if (trendDn && pullbackShort && ctx.rv[i] >= 0.8) return { dir: -1 };
      return null;
    },
    sl:  (ctx, i, sig, entry) => {
      // Stop below the lowest low of the 3 pullback bars
      const pullLow  = Math.min(ctx.low[i-1], ctx.low[i-2], ctx.low[i-3]);
      const pullHigh = Math.max(ctx.high[i-1], ctx.high[i-2], ctx.high[i-3]);
      const structural = sig.dir > 0 ? pullLow - ctx.atr[i] * 0.2 : pullHigh + ctx.atr[i] * 0.2;
      const atrSl = entry - sig.dir * ctx.atr[i] * 2.0;
      return sig.dir > 0 ? Math.min(structural, atrSl) : Math.max(structural, atrSl);
    },
    tp:  (ctx, i, sig, entry, sl) => entry + sig.dir * Math.abs(entry - sl) * 2.5,
  },

];

// ── Load and prepare data ─────────────────────────────────────────────────
const file1m = path.join(__dirname, 'data', 'historical', 'ETHUSDT_1m.ndjson');
if (!fs.existsSync(file1m)) {
  console.error('Missing ETHUSDT_1m.ndjson — run data downloader first');
  process.exit(1);
}

console.log('Loading 1m data...');
const raw1m = loadNDJSON(file1m);

// Use July 2026 as the primary test window, add warmup buffer
const windowFrom  = FROM;
const windowTo    = TO;
const DAYS        = Math.ceil((Date.parse(windowTo+'T23:59:59Z') - Date.parse(windowFrom+'T00:00:00Z')) / 86400000);
const WARMUP_BARS = 500;  // 500 bars of the base TF before the window

const windowCandles = slice(raw1m, windowFrom, windowTo);
const fromIdx = raw1m.indexOf(windowCandles[0]);
const withWarmup1m = raw1m.slice(Math.max(0, fromIdx - WARMUP_BARS));

console.log(`Window: ${windowFrom} → ${windowTo} (${DAYS} days)`);
console.log(`1m bars in window: ${windowCandles.length} | with warmup: ${withWarmup1m.length}`);

// Pre-build resampled candles for each unique TF
const tfCache = { '1m': withWarmup1m };
for (const s of SCALPERS) {
  if (!tfCache[s.tf]) tfCache[s.tf] = resample(withWarmup1m, s.tfMs);
}

// Count warmup bars per TF
const warmupPerTf = {};
for (const [tf, candles] of Object.entries(tfCache)) {
  if (tf === '1m') continue;
  const cutoff = Date.parse(windowFrom + 'T00:00:00Z');
  warmupPerTf[tf] = candles.filter(c => c.openTime < cutoff).length;
}

Object.entries(tfCache).forEach(([tf, c]) => {
  if (tf !== '1m') console.log(`  ${tf}: ${c.length} bars (${warmupPerTf[tf]} warmup + ${c.length - warmupPerTf[tf]} window)`);
});

// ── Run all strategies ────────────────────────────────────────────────────
console.log(`\nStarting equity: $${EQUITY} | Risk/trade: ${(RISK*100).toFixed(1)}% | Compounding ON`);
console.log(`Fees: taker ${TAKER*1e4}bps + slip ${SLIP*1e4}bps/side | Cost floor: ${(WIN_COST*1e4).toFixed(0)}bps\n`);

const results = [];
for (const strat of SCALPERS) {
  const candles = tfCache[strat.tf];
  const warmup  = warmupPerTf[strat.tf] || strat.warmup;
  const modified = { ...strat, warmup };
  const res = run(modified, candles, EQUITY);
  const s   = stats(res.trades, DAYS);
  const barMin = strat.tfMs / 60000;
  const avgHoldMin = s.n > 0 ? (s.avgHold * barMin).toFixed(0) : 'N/A';
  results.push({ strat, res, s, avgHoldMin, barMin });
}

results.sort((a, b) => (b.s.avgR || -Infinity) - (a.s.avgR || -Infinity));

// ── Print ranking ─────────────────────────────────────────────────────────
const P = (v, n) => String(v).padStart(n);
const PL = (v, n) => String(v).padEnd(n);
const $ = v => '$' + (isFinite(v) ? v.toFixed(2) : '?');

console.log('='.repeat(120));
console.log(`SCALPER BACKTEST — ETHUSDT — ${windowFrom} to ${windowTo}`);
console.log(`$100 compounding, 1% risk/trade, real fees+slip included`);
console.log('='.repeat(120));
console.log(
  PL('Strategy', 36) +
  P('TF',4) + P('Trades',8) + P('T/day',7) + P('WR%',6) +
  P('avgR',8) + P('PF',6) + P('t',6) + P('MaxDD',8) +
  P('AvgHold',9) + P('Final$',10) + P('Return',8)
);
console.log('─'.repeat(120));

for (const r of results) {
  const s = r.s;
  if (!s.n) { console.log(PL(r.strat.name,36) + P(r.strat.tf,4) + P('0',8)); continue; }
  const ret = ((r.res.finalEquity - EQUITY) / EQUITY * 100).toFixed(1);
  console.log(
    PL(r.strat.name, 36) +
    P(r.strat.tf, 4) +
    P(s.n, 8) +
    P(s.tpd.toFixed(1), 7) +
    P(s.wr.toFixed(0)+'%', 6) +
    P(s.avgR.toFixed(4), 8) +
    P(s.pf.toFixed(2), 6) +
    P(s.tStat.toFixed(2), 6) +
    P(s.maxDD.toFixed(1)+'R', 8) +
    P(r.avgHoldMin+'min', 9) +
    P($(r.res.finalEquity), 10) +
    P(ret+'%', 8)
  );
}

// ── Detail on best strategies ─────────────────────────────────────────────
console.log('\n' + '='.repeat(80));
console.log('TOP 3 DETAILED BREAKDOWN');
console.log('='.repeat(80));

for (const r of results.slice(0, 3)) {
  const s = r.s;
  if (!s.n) continue;
  const barMin = r.barMin;
  const ret = ((r.res.finalEquity - EQUITY) / EQUITY * 100).toFixed(2);

  console.log(`\n▶  ${r.strat.name} [${r.strat.tf}]`);
  console.log(`   ${r.strat.desc}`);
  console.log(`   Period: ${windowFrom} → ${windowTo} (${DAYS} days)`);
  console.log(`   Trades: ${s.n} | T/day: ${s.tpd.toFixed(1)} | WR: ${s.wr.toFixed(1)}%`);
  console.log(`   avgR: ${s.avgR.toFixed(4)} | PF: ${s.pf.toFixed(2)} | t-stat: ${s.tStat.toFixed(2)}`);
  console.log(`   MaxDD: ${s.maxDD.toFixed(2)}R | AvgHold: ${r.avgHoldMin}min`);
  console.log(`   Start: $${EQUITY} → Final: ${$(r.res.finalEquity)} (${ret}%)`);
  console.log(`   Rejects: ${JSON.stringify(r.res.rejects)}`);

  // Exit reason breakdown
  const reasons = {};
  for (const t of r.res.trades) reasons[t.reason] = (reasons[t.reason]||0)+1;
  console.log(`   Exit reasons: ${JSON.stringify(reasons)}`);

  // P&L per trade sample (last 10)
  const last10 = r.res.trades.slice(-10);
  console.log(`   Last 10 trades (P&L, equity after):`);
  for (const t of last10) {
    const sign = t.pnl >= 0 ? '+' : '';
    const ts   = new Date(t.entryTime).toISOString().slice(5,16);
    console.log(`     ${ts} ${t.dir>0?'L':'S'} ${t.reason.padEnd(8)} ${sign}${$(t.pnl).padStart(8)}  eq=${$(t.equity)}`);
  }

  // Monte Carlo
  if (s.n >= 20) {
    const m = mc(r.res.trades);
    if (m) {
      const riskPerTrade = EQUITY * RISK;
      console.log(`   Monte Carlo (2000 iters, 15-bar blocks):`);
      console.log(`     P5 outcome: ${$(EQUITY + m.p5 * riskPerTrade)} | P50: ${$(EQUITY + m.p50 * riskPerTrade)} | P95: ${$(EQUITY + m.p95 * riskPerTrade)}`);
      console.log(`     P95 MaxDD: ${$(m.p95DD * riskPerTrade)} | Prob profit: ${m.pProfit.toFixed(1)}%`);
    }
  }
}

// ── Daily P&L summary (best strategy) ─────────────────────────────────────
if (results[0] && results[0].s.n > 0) {
  const best = results[0];
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`DAILY P&L — ${best.strat.name}`);
  console.log('─'.repeat(60));
  const byDay = {};
  for (const t of best.res.trades) {
    const day = new Date(t.entryTime).toISOString().split('T')[0];
    if (!byDay[day]) byDay[day] = { pnl: 0, trades: 0 };
    byDay[day].pnl += t.pnl; byDay[day].trades++;
  }
  let running = EQUITY;
  for (const [day, d] of Object.entries(byDay).sort()) {
    running += d.pnl;
    const sign = d.pnl >= 0 ? '+' : '';
    console.log(`  ${day}  trades=${d.trades}  P&L=${sign}${d.pnl.toFixed(2).padStart(7)}  running=${$(running)}`);
  }
  console.log(`  FINAL: ${$(best.res.finalEquity)} (${((best.res.finalEquity-EQUITY)/EQUITY*100).toFixed(2)}%)`);
}

console.log('\n' + '='.repeat(80));
console.log('INTERPRETATION GUIDE:');
console.log('  t-stat > 2.0 + trades ≥ 30 → statistically significant edge');
console.log('  t-stat 1.0–2.0 → promising, needs more data');
console.log('  t-stat < 0 → loses money (avoid)');
console.log('  PF > 1.5 → good risk/reward ratio');
console.log('  MaxDD in R: multiply by (equity × risk%) to get dollar drawdown');
console.log('  e.g. MaxDD 5R × ($80 × 1%) = $4 max drawdown');
console.log('='.repeat(80));
