'use strict';
/**
 * BulletBrain — Strategy Lab
 *
 * Tests multiple distinct signal hypotheses on recent ETHUSDT data (last 30 days
 * by default, adjustable via --days N). Full execution realism: next-bar-open
 * fills, real fee schedule, slippage, stop-first on ambiguous candles.
 *
 * For any strategy that clears a positive t-stat, runs a 1000-iteration block
 * bootstrap Monte Carlo to stress-test drawdown and confirm the edge is not
 * a single lucky run.
 *
 * Usage:
 *   node backtest_strategy_lab.js                   # July 2026 (last 30 days)
 *   node backtest_strategy_lab.js --days 60         # last 60 days
 *   node backtest_strategy_lab.js --days 90         # last 90 days
 *   node backtest_strategy_lab.js --symbol BTCUSDT  # BTC instead of ETH
 *   node backtest_strategy_lab.js --equity 80       # set starting equity
 */

const fs = require('fs');
const path = require('path');

// ── CLI ────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DAYS     = parseInt(arg('days', '30'), 10);
const SYMBOL   = arg('symbol', 'ETHUSDT');
const EQUITY   = parseFloat(arg('equity', '80'));
const RISK_PCT = parseFloat(arg('risk', '0.01'));     // 1% risk per trade

// ── Date window ────────────────────────────────────────────────────────────
const toDate   = new Date();
const fromDate = new Date(toDate.getTime() - DAYS * 86400000);
const fromISO  = fromDate.toISOString().split('T')[0];
const toISO    = toDate.toISOString().split('T')[0];

// ── Data loading ───────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
  const candles = raw.filter(Boolean).map(l => JSON.parse(l));
  candles.sort((a, b) => a.openTime - b.openTime);
  // dedup
  const out = [];
  for (const c of candles) {
    if (!out.length || out[out.length - 1].openTime !== c.openTime) out.push(c);
  }
  return out;
}

function sliceByDate(candles, from, to) {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to   + 'T23:59:59Z');
  return candles.filter(c => c.openTime >= a && c.openTime <= b);
}

// resample 15m → tf (only upsampling is needed here)
const TF_MS = { '15m': 900000, '1h': 3600000, '4h': 14400000 };
function resample(base, tf) {
  const ms = TF_MS[tf]; if (!ms || ms === 900000) return base.slice();
  const expected = ms / 900000;
  const out = []; let cur = null, cnt = 0;
  for (const c of base) {
    const bucket = Math.floor(c.openTime / ms) * ms;
    if (!cur || cur.openTime !== bucket) {
      if (cur && cnt === expected) out.push(cur);
      cur = { openTime: bucket, closeTime: bucket + ms - 1,
              open: c.open, high: c.high, low: c.low, close: c.close,
              volume: c.volume };
      cnt = 0;
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low  < cur.low)  cur.low  = c.low;
      cur.close   = c.close;
      cur.volume += c.volume;
    }
    cnt++;
  }
  if (cur && cnt === expected) out.push(cur);
  return out;
}

// ── Indicators ─────────────────────────────────────────────────────────────
function ema(prices, n) {
  const k = 2 / (n + 1), out = new Array(prices.length).fill(NaN);
  let v = prices[0]; out[0] = v;
  for (let i = 1; i < prices.length; i++) { v = prices[i] * k + v * (1 - k); out[i] = v; }
  return out;
}
function atr14(candles) {
  const out = new Array(candles.length).fill(NaN);
  let prev = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev), Math.abs(candles[i].low - prev));
    out[i] = i === 1 ? tr : out[i-1] * 13/14 + tr/14;
    prev = candles[i].close;
  }
  return out;
}
function rvol20(candles) {
  const vols = candles.map(c => c.volume);
  const out  = new Array(candles.length).fill(1);
  let sum    = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += vols[i];
    if (i >= 20) sum -= vols[i - 20];
    if (i >= 19) out[i] = (sum / 20) > 0 ? vols[i] / (sum / 20) : 1;
  }
  return out;
}
function rollingStd(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  let s = 0, ss = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i]; ss += vals[i] * vals[i];
    if (i >= n) { s -= vals[i-n]; ss -= vals[i-n]*vals[i-n]; }
    if (i >= n-1) { const m = s/n; out[i] = Math.sqrt(Math.max(0, ss/n - m*m)); }
  }
  return out;
}
function rollingMean(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i]; if (i >= n) s -= vals[i-n];
    if (i >= n-1) out[i] = s / n;
  }
  return out;
}
function rollingMax(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  for (let i = n-1; i < vals.length; i++) {
    let best = -Infinity;
    for (let j = i-n+1; j <= i; j++) if (vals[j] > best) best = vals[j];
    out[i] = best;
  }
  return out;
}
function rollingMin(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  for (let i = n-1; i < vals.length; i++) {
    let best = Infinity;
    for (let j = i-n+1; j <= i; j++) if (vals[j] < best) best = vals[j];
    out[i] = best;
  }
  return out;
}

// Build full feature set for a candle array
function buildCtx(candles) {
  const n       = candles.length;
  const close   = candles.map(c => c.close);
  const high    = candles.map(c => c.high);
  const low     = candles.map(c => c.low);
  const volume  = candles.map(c => c.volume);
  const ret1    = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ret1[i] = Math.log(close[i] / close[i-1]);

  const a14  = atr14(candles);
  const e20  = ema(close, 20);
  const e50  = ema(close, 50);
  const e200 = ema(close, 200);
  const rv   = rvol20(candles);

  const rv20arr = rollingStd(ret1, 20);
  const rv100   = rollingMean(rv20arr.map(v => isFinite(v) ? v : 0), 100);
  const rvSd    = rollingStd(rv20arr.map(v => isFinite(v) ? v : 0), 100);
  const volZ    = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++)
    if (isFinite(rv20arr[i]) && rvSd[i] > 0) volZ[i] = (rv20arr[i] - rv100[i]) / rvSd[i];

  // Donchian channel (96-bar looback, excludes current bar)
  const donH = rollingMax(high.map((h, i) => i < high.length - 1 ? h : -Infinity), 96);
  const donL = rollingMin(low.map((l, i) => i < low.length - 1 ? l : Infinity), 96);
  // Shifted: donH[i] = max of previous 96 bars (not current)
  const donHigh = [NaN, ...donH.slice(0, -1)];
  const donLow  = [NaN, ...donL.slice(0, -1)];

  // RSI-14
  const rsi14 = new Array(n).fill(NaN);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < n; i++) {
    const delta = close[i] - close[i-1];
    const gain  = delta > 0 ? delta : 0;
    const loss  = delta < 0 ? -delta : 0;
    if (i <= 14) {
      avgGain += gain / 14; avgLoss += loss / 14;
      if (i === 14) rsi14[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      rsi14[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  // Bollinger Bands (20, 2)
  const bbMid = rollingMean(close, 20);
  const bbStd = rollingStd(close, 20);
  const bbUp  = bbMid.map((m, i) => isFinite(m) ? m + 2 * bbStd[i] : NaN);
  const bbDn  = bbMid.map((m, i) => isFinite(m) ? m - 2 * bbStd[i] : NaN);

  // Rolling high/low (20 bars)
  const high20 = rollingMax(high, 20);
  const low20  = rollingMin(low,  20);

  const open = candles.map(c => c.open);

  return {
    candles, n, open, close, high, low, volume, ret1,
    a14, e20, e50, e200, rv, volZ, rv20arr,
    donHigh, donLow, rsi14,
    bbMid, bbUp, bbDn,
    high20, low20,
  };
}

// ── Cost model ─────────────────────────────────────────────────────────────
const TAKER  = 0.0005;
const MAKER  = 0.0002;
const SLIP   = 0.0006;   // per side
const WIN_COST  = TAKER + MAKER + 2 * SLIP;   // taker in + slip in + slip out (maker)
const LOSS_COST = TAKER + TAKER + 2 * SLIP;   // taker in + slip in + taker out + slip out

// ── Core backtest engine ───────────────────────────────────────────────────
/**
 * strategy: {
 *   name, timeframe,
 *   signal(ctx, i): {dir:1|-1} | null   — signal on bar i, fills at bar i+1 open
 *   stop(ctx, i, sig, entry): price
 *   target(ctx, i, sig, entry, stop): price | null
 *   maxHoldBars?: number
 * }
 */
function runBacktest(strategy, candles, opts = {}) {
  const equity    = opts.equity    || EQUITY;
  const riskPct   = opts.riskPct   || RISK_PCT;
  const warmup    = opts.warmup    || 250;

  const ctx    = buildCtx(candles);
  const n      = candles.length;
  const trades = [];
  const rejects = {};
  let open = null;

  const rej = k => { rejects[k] = (rejects[k] || 0) + 1; };

  for (let i = warmup; i < n - 1; i++) {
    // ── manage open position ─────────────────────────────────────────────
    if (open) {
      const bar = candles[i];
      const dir = open.dir;
      const gapped = dir > 0 ? bar.open <= open.stop : bar.open >= open.stop;
      const hitSL  = dir > 0 ? bar.low  <= open.stop : bar.high >= open.stop;
      const hitTP  = open.target !== null &&
                     (dir > 0 ? bar.high >= open.target : bar.low <= open.target);
      const timed  = strategy.maxHoldBars && (i - open.entryIdx) >= strategy.maxHoldBars;

      let exitPrice = null, isMaker = false, reason = null;
      if (gapped)  { exitPrice = bar.open;    reason = 'SL_GAP'; }
      else if (hitSL) { exitPrice = open.stop;   reason = 'SL';     }
      else if (hitTP) { exitPrice = open.target; reason = 'TP'; isMaker = true; }
      else if (timed) { exitPrice = bar.close;   reason = 'TIME';   }

      if (exitPrice !== null) {
        const fillExit = isMaker ? exitPrice : exitPrice * (1 + dir * SLIP);
        const gross   = (fillExit - open.entry) * dir * open.qty;
        const fees    = open.entry * open.qty * TAKER +
                        Math.abs(fillExit * open.qty) * (isMaker ? MAKER : TAKER) +
                        (open.entry * open.qty) * SLIP +   // entry slip cost
                        Math.abs(fillExit * open.qty) * SLIP * (isMaker ? 0 : 1);
        const pnl     = gross - fees;
        const stopD   = Math.abs(open.entry - open.stop);
        trades.push({
          dir, reason, pnl,
          rMult:    stopD > 0 ? pnl / (stopD * open.qty) : NaN,
          fees,
          holdBars: i - open.entryIdx,
          entry:    open.entry,
          exit:     fillExit,
          entryTime: open.entryTime,
          exitTime:  bar.closeTime,
        });
        open = null;
      }
    }
    if (open) continue;

    // ── look for new signal ─────────────────────────────────────────────
    const sig = strategy.signal(ctx, i);
    if (!sig) continue;

    const nextBar = candles[i + 1];
    const entry   = nextBar.open * (1 + sig.dir * SLIP);   // market fill + slippage

    const stop   = strategy.stop(ctx, i, sig, entry);
    if (!isFinite(stop) || stop === entry) { rej('no_stop'); continue; }
    const stopD  = Math.abs(entry - stop);
    if (sig.dir > 0 && stop >= entry) { rej('stop_wrong_side'); continue; }
    if (sig.dir < 0 && stop <= entry) { rej('stop_wrong_side'); continue; }

    const target = strategy.target ? strategy.target(ctx, i, sig, entry, stop) : null;

    // cost floor: TP must move enough to cover both fee legs
    if (target !== null) {
      const move = Math.abs(target - entry) / entry;
      if (move < WIN_COST) { rej('below_cost_floor'); continue; }
    }

    // risk-based sizing: riskDollars = full expected loss including fees
    const riskAmt   = equity * riskPct;
    const perUnit   = stopD + entry * LOSS_COST;
    const qty       = riskAmt / perUnit;
    const entryFee  = entry * qty * TAKER + entry * qty * SLIP;

    open = {
      dir: sig.dir, entry, stop, target, qty, entryFee,
      entryIdx: i + 1, entryTime: nextBar.openTime,
    };
  }

  return { trades, rejects };
}

// ── Statistics ─────────────────────────────────────────────────────────────
function summarise(trades) {
  if (!trades.length) return { trades: 0, winRate: 0, avgR: 0, profitFactor: 0, tStat: 0, maxDD: 0, sharpe: 0 };
  const rs     = trades.map(t => t.rMult).filter(isFinite);
  const wins   = rs.filter(r => r > 0);
  const losses = rs.filter(r => r <= 0);
  const avgR   = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sdR    = Math.sqrt(rs.reduce((a, r) => a + (r - avgR) ** 2, 0) / rs.length);
  const tStat  = sdR > 0 ? avgR / (sdR / Math.sqrt(rs.length)) : 0;
  const pf     = losses.reduce((a, b) => a + Math.abs(b), 0) > 0
    ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))
    : wins.length > 0 ? Infinity : 0;

  // equity curve max drawdown (in R)
  let peak = 0, dd = 0, eq = 0;
  for (const r of rs) { eq += r; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }

  const sharpe = sdR > 0 ? avgR / sdR * Math.sqrt(252) : 0; // annualised on per-trade basis

  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: wins.length / trades.length * 100,
    avgR, sdR, tStat, profitFactor: pf, maxDD: dd, sharpe,
    totalR: rs.reduce((a, b) => a + b, 0),
  };
}

// Block bootstrap Monte Carlo
function monteCarlo(trades, iters = 1000, blockSize = 20) {
  const rs = trades.map(t => t.rMult).filter(isFinite);
  if (rs.length < blockSize * 2) return null;
  const dds = [], finals = [], avgRs = [];
  for (let it = 0; it < iters; it++) {
    // draw blocks with replacement
    const sim = [];
    while (sim.length < rs.length) {
      const start = Math.floor(Math.random() * (rs.length - blockSize));
      for (let j = 0; j < blockSize && sim.length < rs.length; j++) sim.push(rs[start + j]);
    }
    let eq = 0, peak = 0, dd = 0;
    for (const r of sim) { eq += r; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
    dds.push(dd); finals.push(eq);
    avgRs.push(sim.reduce((a, b) => a + b, 0) / sim.length);
  }
  dds.sort((a, b) => a - b); finals.sort((a, b) => a - b);
  return {
    p95DD:      dds[Math.floor(0.95 * iters)],
    p5Final:    finals[Math.floor(0.05 * iters)],
    p50Final:   finals[Math.floor(0.50 * iters)],
    p95Final:   finals[Math.floor(0.95 * iters)],
    probProfit: finals.filter(f => f > 0).length / iters * 100,
    avgR_p5:    avgRs.sort((a,b)=>a-b)[Math.floor(0.05*iters)],
  };
}

// ── Strategy Definitions ───────────────────────────────────────────────────
// Each strategy has a clear economic rationale and respects the cost floor.
// Entry is always on the NEXT bar's open after the signal bar closes.

const STRATEGIES_15M = [

  {
    name: 'EMA_trend_pullback_15m',
    timeframe: '15m',
    rationale: 'EMA50/200 stack defines trend; price touching EMA20 from trend-side is the entry. Classic continuation after reversion to value.',
    maxHoldBars: 16,  // 4 hours
    signal: (ctx, i) => {
      if (!(ctx.e50[i] && ctx.e200[i])) return null;
      const up = ctx.e50[i] > ctx.e200[i] && ctx.close[i] > ctx.e200[i];
      const dn = ctx.e50[i] < ctx.e200[i] && ctx.close[i] < ctx.e200[i];
      // close crosses back to trend side from EMA20
      if (up && ctx.close[i] > ctx.e20[i] && ctx.close[i-1] <= ctx.e20[i-1] && ctx.rv[i] >= 0.8) return { dir: 1 };
      if (dn && ctx.close[i] < ctx.e20[i] && ctx.close[i-1] >= ctx.e20[i-1] && ctx.rv[i] >= 0.8) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => {
      const a = ctx.a14[i];
      return entry - sig.dir * a * 1.5;
    },
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.5,
  },

  {
    name: 'RSI_oversold_trend_15m',
    timeframe: '15m',
    rationale: 'RSI dips into oversold (<35) inside an uptrend — institutional buyers defending EMA200. Combines momentum exhaustion with trend context.',
    maxHoldBars: 20,
    signal: (ctx, i) => {
      if (!isFinite(ctx.rsi14[i])) return null;
      const up = ctx.e200[i] && ctx.close[i] > ctx.e200[i];
      const dn = ctx.e200[i] && ctx.close[i] < ctx.e200[i];
      if (up && ctx.rsi14[i] < 35 && ctx.rsi14[i-1] < 35 && ctx.rsi14[i] > ctx.rsi14[i-1]) return { dir: 1 };
      if (dn && ctx.rsi14[i] > 65 && ctx.rsi14[i-1] > 65 && ctx.rsi14[i] < ctx.rsi14[i-1]) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => {
      const a = ctx.a14[i];
      return entry - sig.dir * a * 2.0;
    },
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.0,
  },

  {
    name: 'BB_squeeze_breakout_15m',
    timeframe: '15m',
    rationale: 'Bollinger Band squeeze then breakout: when volatility contracts (bands narrow) and then price closes beyond the band, trend continuation follows. Volatility clustering effect.',
    maxHoldBars: 24,
    signal: (ctx, i) => {
      if (!isFinite(ctx.bbUp[i]) || !isFinite(ctx.bbUp[i-5])) return null;
      // squeeze: current width < previous width by 20%
      const curWidth  = ctx.bbUp[i]   - ctx.bbDn[i];
      const prevWidth = ctx.bbUp[i-5] - ctx.bbDn[i-5];
      const squeezed  = curWidth < prevWidth * 0.85;
      if (!squeezed) return null;
      if (ctx.close[i] > ctx.bbUp[i] && ctx.close[i-1] <= ctx.bbUp[i-1] && ctx.rv[i] >= 1.0) return { dir: 1 };
      if (ctx.close[i] < ctx.bbDn[i] && ctx.close[i-1] >= ctx.bbDn[i-1] && ctx.rv[i] >= 1.0) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => {
      const a = ctx.a14[i];
      return entry - sig.dir * a * 1.5;
    },
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.0,
  },

  {
    name: 'Donchian_breakout_15m',
    timeframe: '15m',
    rationale: 'Classic 20-bar channel breakout with trend alignment. Only trades when breakout aligns with EMA200 direction — filters counter-trend chases.',
    maxHoldBars: 32,
    signal: (ctx, i) => {
      if (!isFinite(ctx.high20[i-1]) || !ctx.e200[i]) return null;
      const trendUp = ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.close[i] < ctx.e200[i];
      if (trendUp && ctx.close[i] > ctx.high20[i-1] && ctx.rv[i] >= 1.2) return { dir: 1 };
      if (trendDn && ctx.close[i] < ctx.low20[i-1]  && ctx.rv[i] >= 1.2) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => {
      const a = ctx.a14[i];
      return entry - sig.dir * a * 2.0;
    },
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 3.0,
  },

  {
    name: 'VWAP_bounce_15m',
    timeframe: '15m',
    rationale: 'VWAP acts as institutional execution benchmark. A wick below/above VWAP that closes back on the trend side = defended level. High RVOL confirms real absorption.',
    maxHoldBars: 16,
    signal: (ctx, i) => {
      if (!isFinite(ctx.e200[i])) return null;
      // compute intraday VWAP approximately (simple volume-weighted close)
      const dayStart = Math.floor(ctx.candles[i].openTime / 86400000) * 86400000;
      let pv = 0, vol = 0;
      for (let k = i; k >= 0 && ctx.candles[k].openTime >= dayStart; k--) {
        const tp = (ctx.high[k] + ctx.low[k] + ctx.close[k]) / 3;
        pv += tp * ctx.volume[k]; vol += ctx.volume[k];
      }
      const vwap = vol > 0 ? pv / vol : ctx.close[i];
      const trendUp = ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.close[i] < ctx.e200[i];
      // wick through VWAP, close back on trend side
      if (trendUp && ctx.low[i] < vwap && ctx.close[i] > vwap && ctx.rv[i] >= 1.0) return { dir: 1 };
      if (trendDn && ctx.high[i] > vwap && ctx.close[i] < vwap && ctx.rv[i] >= 1.0) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 1.5,
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.0,
  },

  {
    name: 'HighVol_momentum_15m',
    timeframe: '15m',
    rationale: 'Very high RVOL (≥2.0) bar in trend direction = institutional impulse. Enter continuation on next bar. Wide stop to survive initial retracement.',
    maxHoldBars: 20,
    signal: (ctx, i) => {
      if (!(ctx.rv[i] >= 2.0) || !ctx.e200[i]) return null;
      const isUp  = ctx.close[i] > ctx.open[i];
      const trendUp = ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.close[i] < ctx.e200[i];
      if (trendUp && isUp) return { dir: 1 };
      if (trendDn && !isUp) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 2.5,
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.0,
  },

  {
    name: 'EMA_cross_15m',
    timeframe: '15m',
    rationale: 'Classic EMA20/50 crossover filtered by EMA200 direction. Only takes the cross in the direction of the macro trend to avoid whipsaws.',
    maxHoldBars: 32,
    signal: (ctx, i) => {
      if (!(ctx.e20[i] && ctx.e50[i] && ctx.e200[i])) return null;
      const crossed_up = ctx.e20[i] > ctx.e50[i] && ctx.e20[i-1] <= ctx.e50[i-1];
      const crossed_dn = ctx.e20[i] < ctx.e50[i] && ctx.e20[i-1] >= ctx.e50[i-1];
      const trendUp = ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.close[i] < ctx.e200[i];
      if (crossed_up && trendUp) return { dir: 1 };
      if (crossed_dn && trendDn) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 2.0,
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.5,
  },

  {
    name: 'LowVol_trend_15m',
    timeframe: '15m',
    rationale: 'Best near-miss from the full QUANT-REVIEW battery: trend-following in low-volatility regimes. At 15m volatility is half-normal — extended trend moves with low noise. Same logic as lowvol_trend_4h but at 15m for higher frequency.',
    maxHoldBars: 24,
    signal: (ctx, i) => {
      if (!isFinite(ctx.volZ[i]) || !ctx.e200[i]) return null;
      if (ctx.volZ[i] > -0.3) return null;   // quiet market only
      const dir = ctx.close[i] > ctx.e200[i] ? 1 : -1;
      // require RVOL to be at least moderate (participation confirms direction)
      if (ctx.rv[i] < 0.6) return null;
      return { dir };
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 2.5,
    target: null,
    manage: (open, ctx, i) => {
      // chandelier trail after 1R profit
      const prog = (ctx.close[i] - open.entry) * open.dir;
      const risk = Math.abs(open.entry - open.stop);
      if (prog < risk) return {};
      const trail = ctx.close[i] - open.dir * ctx.a14[i] * 3;
      return { stop: open.dir > 0 ? Math.max(open.stop, trail) : Math.min(open.stop, trail) };
    },
    maxHoldBars: 32,
  },
];

const STRATEGIES_1H = [

  {
    name: 'Donchian_breakout_1h',
    timeframe: '1h',
    rationale: '4x the move size vs 15m at same fee. Classic Donchian with EMA200 macro filter. Low frequency but better fee-to-signal ratio.',
    maxHoldBars: 24,
    signal: (ctx, i) => {
      if (!isFinite(ctx.high20[i-1]) || !ctx.e200[i]) return null;
      const trendUp = ctx.close[i] > ctx.e200[i];
      const trendDn = ctx.close[i] < ctx.e200[i];
      if (trendUp && ctx.close[i] > ctx.high20[i-1] && ctx.rv[i] >= 1.0) return { dir: 1 };
      if (trendDn && ctx.close[i] < ctx.low20[i-1]  && ctx.rv[i] >= 1.0) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 2.0,
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 3.0,
  },

  {
    name: 'EMA_trend_pullback_1h',
    timeframe: '1h',
    rationale: 'Same pullback logic as 15m version but at 1h — larger ATR means stops are ~4% of entry, well above the cost floor.',
    maxHoldBars: 12,
    signal: (ctx, i) => {
      if (!(ctx.e50[i] && ctx.e200[i])) return null;
      const up = ctx.e50[i] > ctx.e200[i] && ctx.close[i] > ctx.e200[i];
      const dn = ctx.e50[i] < ctx.e200[i] && ctx.close[i] < ctx.e200[i];
      if (up && ctx.close[i] > ctx.e20[i] && ctx.close[i-1] <= ctx.e20[i-1]) return { dir: 1 };
      if (dn && ctx.close[i] < ctx.e20[i] && ctx.close[i-1] >= ctx.e20[i-1]) return { dir: -1 };
      return null;
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 1.5,
    target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2.5,
  },

  {
    name: 'LowVol_trend_1h',
    timeframe: '1h',
    rationale: 'Promoted from 15m: lowvol trend at 1h where move sizes are ~4x larger. More likely to clear cost floor comfortably.',
    maxHoldBars: 16,
    signal: (ctx, i) => {
      if (!isFinite(ctx.volZ[i]) || !ctx.e200[i]) return null;
      if (ctx.volZ[i] > -0.3) return null;
      const dir = ctx.close[i] > ctx.e200[i] ? 1 : -1;
      return { dir };
    },
    stop: (ctx, i, sig, entry) => entry - sig.dir * ctx.a14[i] * 2.5,
    target: null,
    manage: (open, ctx, i) => {
      const prog = (ctx.close[i] - open.entry) * open.dir;
      const risk = Math.abs(open.entry - open.stop);
      if (prog < risk) return {};
      const trail = ctx.close[i] - open.dir * ctx.a14[i] * 3;
      return { stop: open.dir > 0 ? Math.max(open.stop, trail) : Math.min(open.stop, trail) };
    },
    maxHoldBars: 20,
  },
];

// Combo: take a signal only when BOTH timeframes agree
function makeCombo(name15m, name1h) {
  const s15 = STRATEGIES_15M.find(s => s.name === name15m);
  const s1h  = STRATEGIES_1H.find(s => s.name === name1h);
  return {
    name: `COMBO_${name15m}_${name1h}`,
    timeframe: '15m',
    rationale: `Combo: ${name15m} signal only taken when ${name1h} also agrees at 1h.`,
    maxHoldBars: s15.maxHoldBars,
    stop: s15.stop,
    target: s15.target,
    _s15: s15,
    _ctx1h: null,  // will be set before running
    signal: function(ctx, i) {
      const sig15 = this._s15.signal(ctx, i);
      if (!sig15) return null;
      if (!this._ctx1h) return null;
      // find corresponding 1h bar (last closed 1h before this 15m bar)
      const barTime = ctx.candles[i].openTime;
      const h1Idx   = this._ctx1h.n - 1 -
        [...Array(this._ctx1h.n)].findIndex((_, k) =>
          this._ctx1h.candles[this._ctx1h.n - 1 - k].closeTime <= barTime
        );
      if (h1Idx < 0 || h1Idx >= this._ctx1h.n) return null;
      const sig1h = s1h.signal(this._ctx1h, h1Idx);
      if (!sig1h || sig1h.dir !== sig15.dir) return null;
      return sig15;
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
const dataFile = path.join(__dirname, 'data', 'historical', `${SYMBOL}_15m.ndjson`);
if (!fs.existsSync(dataFile)) {
  console.error(`Missing: ${dataFile}`);
  process.exit(1);
}

// Keep 500 warmup bars before the date window to seed indicators
const all15m  = loadNDJSON(dataFile);
const window  = sliceByDate(all15m, fromISO, toISO);
// Add warmup: 500 bars before fromDate
const warmupNeeded = 500;
const fromIdx = all15m.indexOf(window[0]);
const withWarmup = all15m.slice(Math.max(0, fromIdx - warmupNeeded));

console.log(`\n${'='.repeat(80)}`);
console.log(`STRATEGY LAB — ${SYMBOL} | ${fromISO} → ${toISO} (${DAYS} days)`);
console.log(`Equity: $${EQUITY} | Risk/trade: ${(RISK_PCT*100).toFixed(1)}%`);
console.log(`Cost model: taker ${TAKER*1e4}bps + maker ${MAKER*1e4}bps + slip ${SLIP*1e4}bps/side`);
console.log(`Break-even move: ${(WIN_COST*1e4).toFixed(1)}bps per round-trip`);
console.log(`15m bars in window: ${window.length} | With warmup: ${withWarmup.length}`);
console.log('='.repeat(80));

const results = [];

// 15m strategies
for (const strat of STRATEGIES_15M) {
  const res = runBacktest(strat, withWarmup, { equity: EQUITY, riskPct: RISK_PCT, warmup: warmupNeeded });
  const sum = summarise(res.trades);
  const avgHoldMin = res.trades.length > 0
    ? (res.trades.reduce((a, t) => a + t.holdBars, 0) / res.trades.length * 15).toFixed(0)
    : 'N/A';
  results.push({ strat, res, sum, avgHoldMin, tf: '15m' });
}

// 1h strategies
const withWarmup1h = resample(withWarmup, '1h');
for (const strat of STRATEGIES_1H) {
  const res = runBacktest(strat, withWarmup1h, { equity: EQUITY, riskPct: RISK_PCT, warmup: Math.floor(warmupNeeded / 4) });
  const sum = summarise(res.trades);
  const avgHoldMin = res.trades.length > 0
    ? (res.trades.reduce((a, t) => a + t.holdBars, 0) / res.trades.length * 60).toFixed(0)
    : 'N/A';
  results.push({ strat, res, sum, avgHoldMin, tf: '1h' });
}

// Sort by t-stat descending
results.sort((a, b) => b.sum.tStat - a.sum.tStat);

// ── Print ranking table ─────────────────────────────────────────────────────
const pad = (s, n) => String(s).padStart(n);
const padL = (s, n) => String(s).padEnd(n);
console.log(`\n${'─'.repeat(110)}`);
console.log(`RANKING (sorted by t-stat)`);
console.log(`${'─'.repeat(110)}`);
console.log(
  padL('Strategy', 38) +
  pad('TF', 5) +
  pad('Trades', 8) +
  pad('WR%', 7) +
  pad('avgR', 8) +
  pad('PF', 7) +
  pad('t-stat', 8) +
  pad('MaxDD(R)', 10) +
  pad('AvgHold', 10) +
  pad('Rejects', 16)
);
console.log('─'.repeat(110));
for (const r of results) {
  const s = r.sum;
  const rejectStr = Object.entries(r.res.rejects).map(([k,v])=>`${k}:${v}`).join(' ').slice(0, 14);
  console.log(
    padL(r.strat.name, 38) +
    pad(r.tf, 5) +
    pad(s.trades, 8) +
    pad(s.trades ? s.winRate.toFixed(0)+'%' : '-', 7) +
    pad(s.trades ? s.avgR.toFixed(4) : '-', 8) +
    pad(s.trades ? s.profitFactor.toFixed(2) : '-', 7) +
    pad(s.trades ? s.tStat.toFixed(2) : '-', 8) +
    pad(s.trades ? s.maxDD.toFixed(1) : '-', 10) +
    pad(r.avgHoldMin + 'min', 10) +
    pad(rejectStr, 16)
  );
}

// ── Detail on positives ─────────────────────────────────────────────────────
const positives = results.filter(r => r.sum.tStat > 0.5 && r.sum.trades >= 5);

if (positives.length) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`STRATEGIES WITH POSITIVE t-STAT (t > 0.5, trades ≥ 5)`);
  console.log('═'.repeat(80));

  for (const r of positives) {
    const s = r.sum;
    console.log(`\n▶  ${r.strat.name} [${r.tf}]`);
    console.log(`   Rationale: ${r.strat.rationale}`);
    console.log(`   Trades: ${s.trades} | WR: ${s.winRate.toFixed(1)}% | avgR: ${s.avgR.toFixed(4)} | PF: ${s.profitFactor.toFixed(2)} | t: ${s.tStat.toFixed(2)}`);
    console.log(`   MaxDD(R): ${s.maxDD.toFixed(2)} | TotalR: ${s.totalR.toFixed(2)} | AvgHold: ${r.avgHoldMin}min`);
    console.log(`   Rejects: ${JSON.stringify(r.res.rejects)}`);

    // Translate R-multiple to dollar P&L on $80 equity
    const riskPerTrade = EQUITY * RISK_PCT;
    const estPnL = s.avgR * riskPerTrade;
    console.log(`   At $${EQUITY} equity / ${(RISK_PCT*100).toFixed(1)}% risk: ~$${riskPerTrade.toFixed(2)} risk/trade, est avg P&L/trade = $${estPnL.toFixed(2)}`);

    // Trades-per-day
    const tpd = s.trades / DAYS;
    console.log(`   Frequency: ${tpd.toFixed(1)} trades/day`);

    // Monte Carlo
    if (s.trades >= 20) {
      const mc = monteCarlo(r.res.trades);
      if (mc) {
        console.log(`   Monte Carlo (1000 iters, 20-bar blocks):`);
        console.log(`     P95 MaxDD: ${mc.p95DD.toFixed(2)}R | P5 Final: ${mc.p5Final.toFixed(2)}R | P50: ${mc.p50Final.toFixed(2)}R | P95: ${mc.p95Final.toFixed(2)}R`);
        console.log(`     Prob. profit: ${mc.probProfit.toFixed(1)}% | P5 avgR: ${mc.avgR_p5.toFixed(4)}`);
      }
    }
  }
} else {
  console.log('\n⚠  No strategy showed positive t-stat with ≥5 trades in this window.');
  console.log('   This confirms the cost floor problem: 15m signals cannot pay for themselves on recent data.');
  console.log('   Recommended: try --days 90 for more data, or consider 1h/4h strategies.');
}

// ── Worst 3 ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('BOTTOM 3 (avoid):');
results.slice(-3).forEach(r => {
  console.log(`  ${r.strat.name}: avgR=${r.sum.avgR.toFixed(4)} t=${r.sum.tStat.toFixed(2)} trades=${r.sum.trades}`);
});

console.log('\n' + '='.repeat(80));
console.log('NEXT STEPS:');
console.log('  1. Any strategy with t > 1.5 + trades ≥ 10 → candidate for liveRunner');
console.log('  2. Wire the best one in as a new signal in src/live/liveRunner.js');
console.log('  3. Paper test: node src/live/liveRunner.js (no BB_LIVE=true)');
console.log('  4. Run again with --days 90 for more statistical confidence');
console.log('='.repeat(80));
