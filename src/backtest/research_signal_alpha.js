'use strict';

/**
 * BulletBrain v3.0 — Signal Alpha Research
 *
 * PURPOSE
 * -------
 * Every backtest in this repo measures a full strategy: signal + stop + target +
 * sizing + costs, all entangled. When such a test loses you cannot tell WHICH
 * part is broken. This file isolates the only question that matters first:
 *
 *      Does the signal predict direction AT ALL?
 *
 * If forward returns after a "bullish sweep" are not reliably positive, then no
 * stop model, target model, filter or fee schedule can rescue the strategy —
 * there is nothing to harvest. If they ARE positive, the excursion profile
 * (MFE/MAE) tells us where stops and targets actually belong, instead of the
 * grid-searched 0.3xATR / 2.5R that was never derived from anything.
 *
 * METHOD
 * ------
 *  - Signals are detected with liveRunner.js's own logic (rolling pool window).
 *  - For each signal we measure DIRECTION-SIGNED forward log return at several
 *    horizons, plus MFE (max favourable excursion) and MAE (max adverse
 *    excursion) in ATR units over each horizon.
 *  - Each signal set is compared against a BASELINE: every candle in the same
 *    regime with the same direction. Alpha is (signal mean - baseline mean).
 *    Without this control, a long signal in a bull market looks predictive when
 *    it is only measuring the drift it sat in.
 *  - Overlapping windows inflate t-stats badly (consecutive signals share most
 *    of their forward window). Headline stats are computed on a DE-OVERLAPPED
 *    subset: signals kept only if >= h candles after the previously kept one.
 *  - No costs. No stops. This is pure signal quality.
 *
 * USAGE
 *   node src/backtest/research_signal_alpha.js [--symbol ETHUSDT] [--from 2026-01-01]
 *                                              [--to 2026-07-28] [--variant all]
 */

const fs = require('fs');
const path = require('path');

const { atr } = require('../indicators/atr');
const { ema } = require('../indicators/ema');
const { cvd: cvdFn } = require('../indicators/cvd');

const POOL_WINDOW = 600;
const HORIZONS = [1, 2, 4, 8, 16, 32, 48];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SYMBOL = arg('symbol', 'ETHUSDT');
const FROM = arg('from', null);
const TO = arg('to', null);

// ── data ────────────────────────────────────────────────────────────────────
function loadCandles(symbol) {
  const p = path.join(process.cwd(), 'data', 'historical', `${symbol}_15m.ndjson`);
  if (!fs.existsSync(p)) throw new Error('missing data file: ' + p);
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  out.sort((a, b) => a.openTime - b.openTime);
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].openTime === c.openTime) continue;
    dedup.push(c);
  }
  return dedup;
}

// ── liveRunner logic (verbatim) ─────────────────────────────────────────────
function simpleRvol(candles, period = 20) {
  const r = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let s = 0;
    for (let j = i - period; j < i; j++) s += candles[j].volume;
    r[i] = s / period > 0 ? candles[i].volume / (s / period) : 1.0;
  }
  return r;
}

function detectRegime(atr14, ema200Vals, candle, i) {
  if (i < 200) return 'RANGING';
  const e200 = ema200Vals[i], ePrev = ema200Vals[Math.max(0, i - 10)];
  if (!e200 || !ePrev) return 'RANGING';
  const priceAbove = candle.close > e200;
  const slope10 = (e200 - ePrev) / ePrev;
  const atrPct = (atr14[i] || 0) / candle.close * 100;
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.0005 && priceAbove) return 'BULL';
  if (slope10 < -0.0005 && !priceAbove) return 'BEAR';
  return 'RANGING';
}

function detectPools(window, base, type) {
  const pools = [], sw = [];
  for (let j = 1; j < window.length - 1; j++) {
    if (type === 'LONG' && window[j].low < window[j - 1].low && window[j].low < window[j + 1].low) sw.push(j);
    if (type === 'SHORT' && window[j].high > window[j - 1].high && window[j].high > window[j + 1].high) sw.push(j);
  }
  for (let a = 0; a < sw.length; a++) {
    for (let b = a + 1; b < sw.length; b++) {
      const si = sw[a], sj = sw[b];
      if (sj - si > 80) break;
      if (sj - si < 2) continue;
      const v1 = type === 'LONG' ? window[si].low : window[si].high;
      const v2 = type === 'LONG' ? window[sj].low : window[sj].high;
      if (Math.abs(v1 - v2) / v1 >= 0.005) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) {
        const cv = type === 'LONG' ? window[k].low : window[k].high;
        if (type === 'LONG' ? cv < Math.min(v1, v2) : cv > Math.max(v1, v2)) { swept = true; break; }
      }
      if (swept) continue;
      pools.push({ level: (v1 + v2) / 2, formed: base + sj, expires: base + sj + 500 });
    }
  }
  return pools;
}

// ── stats ───────────────────────────────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function sd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function tstat(a) {
  if (a.length < 2) return NaN;
  const s = sd(a);
  return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : NaN;
}
function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function bps(x) { return (x * 10000).toFixed(2); }

/**
 * Direction-signed forward return, plus excursions in ATR units.
 * dir = +1 long, -1 short.
 */
function forwardStats(candles, atr14, i, h, dir) {
  const entry = candles[i].close;
  const end = Math.min(i + h, candles.length - 1);
  if (end <= i) return null;
  const a = atr14[i];
  if (!(a > 0)) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = i + 1; k <= end; k++) {
    if (candles[k].high > hi) hi = candles[k].high;
    if (candles[k].low < lo) lo = candles[k].low;
  }
  const ret = dir * Math.log(candles[end].close / entry);
  // favourable = in trade direction; adverse = against it
  const mfe = dir > 0 ? (hi - entry) / a : (entry - lo) / a;
  const mae = dir > 0 ? (entry - lo) / a : (hi - entry) / a;
  return { ret, mfe, mae };
}

// ── signal variants ─────────────────────────────────────────────────────────
// Each returns true/false for candle i given precomputed context.
const VARIANTS = {
  // exactly what liveRunner.js trades today
  live: (ctx) => ctx.sweptReclaim && ctx.rvol >= 0.3 && ctx.cvdOk,

  // ablations — isolate what each gate contributes
  sweep_only: (ctx) => ctx.sweptOnly,
  sweep_reclaim: (ctx) => ctx.sweptReclaim,
  reclaim_rvol03: (ctx) => ctx.sweptReclaim && ctx.rvol >= 0.3,
  reclaim_rvol12: (ctx) => ctx.sweptReclaim && ctx.rvol >= 1.2,
  reclaim_rvol20: (ctx) => ctx.sweptReclaim && ctx.rvol >= 2.0,
  reclaim_cvd: (ctx) => ctx.sweptReclaim && ctx.cvdOk,

  // does requiring a decisive close (displacement) help?
  reclaim_disp50: (ctx) => ctx.sweptReclaim && ctx.closePos >= 0.5,
  reclaim_disp70: (ctx) => ctx.sweptReclaim && ctx.closePos >= 0.7,
  reclaim_rvol12_disp70: (ctx) => ctx.sweptReclaim && ctx.rvol >= 1.2 && ctx.closePos >= 0.7,
};

function run() {
  const all = loadCandles(SYMBOL);
  const fromMs = FROM ? Date.parse(FROM + 'T00:00:00Z') : -Infinity;
  const toMs = TO ? Date.parse(TO + 'T23:59:59Z') : Infinity;

  const atr14 = atr(all, 14);
  const rvolVals = simpleRvol(all, 20);
  const cvdVals = cvdFn(all);
  const ema200Vals = ema(all.map(c => c.close), 200);

  console.log('='.repeat(96));
  console.log('SIGNAL ALPHA RESEARCH — ' + SYMBOL + ' 15m');
  console.log('='.repeat(96));
  console.log('sample      : ' + new Date(all[0].openTime).toISOString().slice(0, 10) +
    ' -> ' + new Date(all[all.length - 1].openTime).toISOString().slice(0, 10) +
    '  (' + all.length + ' candles)');
  if (FROM || TO) console.log('window      : ' + (FROM || 'start') + ' -> ' + (TO || 'end'));
  console.log('measurement : direction-signed forward log return, NO stops, NO costs');
  console.log('control     : same-regime same-direction baseline (removes trend drift)');

  // Collect per-candle context and signal membership
  const signals = {};   // variant -> [{i, dir}]
  for (const v of Object.keys(VARIANTS)) signals[v] = [];
  const baseline = { LONG: [], SHORT: [] };

  for (let i = 200; i < all.length; i++) {
    const candle = all[i];
    if (candle.openTime < fromMs || candle.openTime > toMs) continue;
    const regime = detectRegime(atr14, ema200Vals, candle, i);
    if (regime !== 'BULL' && regime !== 'BEAR') continue;
    const dirType = regime === 'BULL' ? 'LONG' : 'SHORT';
    const dir = regime === 'BULL' ? 1 : -1;

    // baseline: every tradeable-regime candle, same direction
    baseline[dirType].push(i);

    const from = Math.max(0, i - POOL_WINDOW);
    const pools = detectPools(all.slice(from, i + 1), from, dirType);

    let sweptOnly = false, sweptReclaim = false;
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (dirType === 'LONG') {
        if (candle.low < pool.level) sweptOnly = true;
        if (candle.low < pool.level && candle.close > pool.level) { sweptReclaim = true; break; }
      } else {
        if (candle.high > pool.level) sweptOnly = true;
        if (candle.high > pool.level && candle.close < pool.level) { sweptReclaim = true; break; }
      }
    }
    if (!sweptOnly && !sweptReclaim) continue;

    const rng = candle.high - candle.low;
    // where the close sits in the candle range, in trade direction (1 = decisive)
    const closePos = rng > 0
      ? (dir > 0 ? (candle.close - candle.low) / rng : (candle.high - candle.close) / rng)
      : 0.5;
    const cvdDelta = (cvdVals.delta[i] || 0) - (cvdVals.delta[i - 1] || 0);
    const ctx = {
      sweptOnly, sweptReclaim,
      rvol: rvolVals[i] || 0,
      cvdOk: dir > 0 ? cvdDelta > 0 : cvdDelta < 0,
      closePos,
    };
    for (const [name, fn] of Object.entries(VARIANTS)) {
      if (fn(ctx)) signals[name].push({ i, dir });
    }
  }

  // baseline forward stats per horizon
  const baseStats = {};
  for (const h of HORIZONS) {
    const rets = [];
    for (const dirType of ['LONG', 'SHORT']) {
      const dir = dirType === 'LONG' ? 1 : -1;
      // de-overlap the baseline the same way for a fair comparison
      let last = -Infinity;
      for (const i of baseline[dirType]) {
        if (i - last < h) continue;
        last = i;
        const f = forwardStats(all, atr14, i, h, dir);
        if (f) rets.push(f.ret);
      }
    }
    baseStats[h] = { n: rets.length, mean: mean(rets), sd: sd(rets) };
  }

  console.log('\n' + '-'.repeat(96));
  console.log('BASELINE — unconditional forward return in tradeable regimes (de-overlapped)');
  console.log('-'.repeat(96));
  console.log('  horizon      n        mean(bps)   sd(bps)');
  for (const h of HORIZONS) {
    const b = baseStats[h];
    console.log('  ' + String(h + 'c').padEnd(11) + String(b.n).padStart(6) +
      '   ' + bps(b.mean).padStart(10) + '  ' + bps(b.sd).padStart(9));
  }

  // per-variant
  const summary = [];
  for (const [name, list] of Object.entries(signals)) {
    if (!list.length) { console.log('\n[' + name + '] no signals'); continue; }
    console.log('\n' + '-'.repeat(96));
    console.log('VARIANT: ' + name + '   (raw signals: ' + list.length + ')');
    console.log('-'.repeat(96));
    console.log('  horizon    n(deov)   mean(bps)   alpha(bps)  t-stat   hit%    MFE(atr) MAE(atr)  MFE/MAE');
    for (const h of HORIZONS) {
      const rets = [], mfes = [], maes = [];
      let last = -Infinity;
      for (const s of list) {
        if (s.i - last < h) continue;   // de-overlap
        last = s.i;
        const f = forwardStats(all, atr14, s.i, h, s.dir);
        if (!f) continue;
        rets.push(f.ret); mfes.push(f.mfe); maes.push(f.mae);
      }
      if (rets.length < 20) {
        console.log('  ' + String(h + 'c').padEnd(9) + String(rets.length).padStart(7) + '   (n<20, skipped)');
        continue;
      }
      const m = mean(rets);
      const alpha = m - baseStats[h].mean;
      const t = tstat(rets);
      const hit = rets.filter(r => r > 0).length / rets.length * 100;
      const mf = median(mfes), ma = median(maes);
      console.log('  ' + String(h + 'c').padEnd(9) + String(rets.length).padStart(7) +
        '   ' + bps(m).padStart(9) + '  ' + bps(alpha).padStart(11) +
        '  ' + (isFinite(t) ? t.toFixed(2) : 'n/a').padStart(6) +
        '  ' + hit.toFixed(1).padStart(5) + '%  ' +
        mf.toFixed(3).padStart(8) + ' ' + ma.toFixed(3).padStart(8) +
        '  ' + (ma > 0 ? (mf / ma).toFixed(3) : 'inf').padStart(7));
      if (h === 8) summary.push({ name, n: rets.length, mean: m, alpha, t, hit, mfe: mf, mae: ma });
    }
  }

  console.log('\n' + '='.repeat(96));
  console.log('VARIANT RANKING at h=8 candles (2h) — alpha vs same-regime baseline');
  console.log('='.repeat(96));
  summary.sort((a, b) => b.alpha - a.alpha);
  console.log('  variant                    n     mean(bps)  alpha(bps)  t-stat   hit%   MFE/MAE');
  for (const s of summary) {
    console.log('  ' + s.name.padEnd(24) + String(s.n).padStart(6) +
      '  ' + bps(s.mean).padStart(9) + '  ' + bps(s.alpha).padStart(10) +
      '  ' + (isFinite(s.t) ? s.t.toFixed(2) : 'n/a').padStart(6) +
      '  ' + s.hit.toFixed(1).padStart(5) + '%  ' +
      (s.mae > 0 ? (s.mfe / s.mae).toFixed(3) : 'inf').padStart(8));
  }

  console.log('\nINTERPRETATION GUIDE');
  console.log('  alpha <= 0            -> the signal adds nothing over sitting in the regime');
  console.log('  |t| < 2               -> indistinguishable from noise at this sample size');
  console.log('  MFE/MAE < 1           -> price moves AGAINST you more than for you first;');
  console.log('                           any fixed stop tighter than MAE will be hit first');
  console.log('  A viable strategy needs alpha > 0, |t| > 2, and MFE/MAE > 1.');

  const outDir = path.join(process.cwd(), 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `signal_alpha_${SYMBOL}${FROM ? '_' + FROM : ''}${TO ? '_' + TO : ''}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    symbol: SYMBOL, window: { from: FROM, to: TO },
    horizons: HORIZONS, baseline: baseStats,
    variants: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, v.length])),
    rankingAtH8: summary,
  }, null, 2));
  console.log('\nwritten: ' + path.relative(process.cwd(), outFile));
}

run();
