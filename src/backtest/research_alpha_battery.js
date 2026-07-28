'use strict';

/**
 * BulletBrain v3.0 — Alpha Battery
 *
 * PURPOSE
 * -------
 * research_signal_alpha.js proved the liquidity-sweep signal has no predictive
 * power (negative alpha vs its own regime baseline at every horizon, on both
 * symbols). This file asks the follow-up the mandate requires: is there ANY
 * signal in 15m BTC/ETH data that this architecture could trade profitably?
 *
 * It tests a diverse battery of candidate alphas — trend, momentum, reversion,
 * volatility, structure, session — under one honest protocol.
 *
 * PROTOCOL (designed to make it HARD to find a false positive)
 * -----------------------------------------------------------
 *  1. Direction-signed forward log return, no stops, no costs.
 *  2. Alpha measured against an UNCONDITIONAL baseline over the same candles and
 *     same direction mix, so trend drift cannot be mistaken for skill.
 *  3. De-overlapped samples (signals >= h candles apart) so shared forward
 *     windows do not inflate t-stats.
 *  4. Three disjoint windows: TRAIN -> VALID -> OOS (OOS is the most recent
 *     data and is looked at last).
 *  5. Two symbols. A real effect should appear in both.
 *  6. Multiple-testing correction. We evaluate N hypotheses x 3 horizons, so the
 *     naive |t|>2 bar produces expected false positives. Bonferroni threshold is
 *     printed and enforced.
 *
 * SURVIVAL CRITERIA (all must hold):
 *    TRAIN: alpha > 0 and |t| > Bonferroni-corrected threshold
 *    VALID: alpha > 0
 *    OOS:   alpha > 0
 *    BOTH symbols agree in sign
 *
 * USAGE
 *   node src/backtest/research_alpha_battery.js
 */

const fs = require('fs');
const path = require('path');
const { atr } = require('../indicators/atr');
const { ema } = require('../indicators/ema');
const { cvd: cvdFn } = require('../indicators/cvd');

const SYMBOLS = ['ETHUSDT', 'BTCUSDT'];
const HORIZONS = [4, 8, 16];

// Disjoint, chronological. OOS is the most recent market conditions.
const WINDOWS = {
  TRAIN: ['2021-01-01', '2025-12-31'],
  VALID: ['2026-01-01', '2026-05-31'],
  OOS:   ['2026-06-01', '2026-12-31'],
};

function loadCandles(symbol) {
  const p = path.join(process.cwd(), 'data', 'historical', `${symbol}_15m.ndjson`);
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  out.sort((a, b) => a.openTime - b.openTime);
  const d = [];
  for (const c of out) {
    if (d.length && d[d.length - 1].openTime === c.openTime) continue;
    d.push(c);
  }
  return d;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function sd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function bps(x) { return (x * 10000).toFixed(2); }

function rollingMean(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function rollingSd(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0, ss = 0;
    for (let j = i - n + 1; j <= i; j++) { s += arr[j]; ss += arr[j] * arr[j]; }
    const m = s / n;
    out[i] = Math.sqrt(Math.max(0, ss / n - m * m));
  }
  return out;
}

/**
 * Precompute every feature a hypothesis might reference.
 * All features at index i use ONLY data up to and including candle i.
 */
function buildFeatures(candles) {
  const n = candles.length;
  const close = candles.map(c => c.close);
  const atr14 = atr(candles, 14);
  const ema50 = ema(close, 50);
  const ema200 = ema(close, 200);
  const ema800 = ema(close, 800);    // ~200h, a 4H-EMA50 proxy
  const cvdV = cvdFn(candles);

  // per-candle log return
  const ret1 = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ret1[i] = Math.log(close[i] / close[i - 1]);

  // realised vol (20) and its 480-candle percentile-ish z
  const vol20 = rollingSd(ret1, 20);
  const volMean = rollingMean(vol20.map(v => isFinite(v) ? v : 0), 480);
  const volSd = rollingSd(vol20.map(v => isFinite(v) ? v : 0), 480);

  // volume: simple 20 SMA ratio, and time-normalised RVOL (same slot, last 20 days)
  const vol = candles.map(c => c.volume);
  const volSma20 = rollingMean(vol, 20);
  const rvolSimple = new Array(n).fill(1);
  for (let i = 0; i < n; i++) rvolSimple[i] = volSma20[i] > 0 ? vol[i] / volSma20[i] : 1;
  // time-normalised: compare to same 15m slot on previous 20 days (96 candles/day)
  const rvolTime = new Array(n).fill(1);
  for (let i = 96 * 20; i < n; i++) {
    let s = 0, c = 0;
    for (let k = 1; k <= 20; k++) { s += vol[i - 96 * k]; c++; }
    const avg = s / c;
    rvolTime[i] = avg > 0 ? vol[i] / avg : 1;
  }

  // daily-reset VWAP
  const vwap = new Array(n).fill(NaN);
  let dayKey = null, pv = 0, vv = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(candles[i].openTime / 86400000);
    if (k !== dayKey) { dayKey = k; pv = 0; vv = 0; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += tp * candles[i].volume; vv += candles[i].volume;
    vwap[i] = vv > 0 ? pv / vv : candles[i].close;
  }

  // N-candle momentum
  const mom16 = new Array(n).fill(0), mom96 = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i >= 16) mom16[i] = Math.log(close[i] / close[i - 16]);
    if (i >= 96) mom96[i] = Math.log(close[i] / close[i - 96]);
  }

  // 96-candle Donchian channel (excluding current candle)
  const hh96 = new Array(n).fill(NaN), ll96 = new Array(n).fill(NaN);
  for (let i = 96; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - 96; j < i; j++) { if (candles[j].high > h) h = candles[j].high; if (candles[j].low < l) l = candles[j].low; }
    hh96[i] = h; ll96[i] = l;
  }

  return { close, atr14, ema50, ema200, ema800, cvdV, ret1, vol20, volMean, volSd,
    rvolSimple, rvolTime, vwap, mom16, mom96, hh96, ll96 };
}

/**
 * Each hypothesis returns +1 (long), -1 (short) or 0 (no signal) for candle i.
 * Every one has a stated economic rationale — none are parameter sweeps.
 */
const HYPOTHESES = {
  // --- TREND / MOMENTUM -----------------------------------------------------
  // Multi-timeframe trend alignment: slow EMA stack agrees, trade continuation.
  h01_ema_stack_trend: (f, i) => {
    if (!(f.ema50[i] && f.ema200[i] && f.ema800[i])) return 0;
    if (f.ema50[i] > f.ema200[i] && f.ema200[i] > f.ema800[i]) return 1;
    if (f.ema50[i] < f.ema200[i] && f.ema200[i] < f.ema800[i]) return -1;
    return 0;
  },
  // Cross-sectional-free momentum: 1-day momentum continuation.
  h02_mom96_continuation: (f, i) => {
    if (!f.mom96[i]) return 0;
    return f.mom96[i] > 0 ? 1 : -1;
  },
  // Donchian breakout: close beyond 24h extreme = initiation of a move.
  h03_donchian_breakout: (f, i) => {
    if (!isFinite(f.hh96[i])) return 0;
    if (f.close[i] > f.hh96[i]) return 1;
    if (f.close[i] < f.ll96[i]) return -1;
    return 0;
  },
  // Pullback in an established uptrend: price dips below EMA50 but trend intact.
  h04_trend_pullback: (f, i) => {
    if (!(f.ema50[i] && f.ema800[i])) return 0;
    const up = f.ema50[i] > f.ema800[i];
    if (up && f.close[i] < f.ema50[i]) return 1;
    if (!up && f.close[i] > f.ema50[i]) return -1;
    return 0;
  },

  // --- MEAN REVERSION -------------------------------------------------------
  // Short-horizon overextension reverts (market-maker inventory effect).
  h05_ret_zscore_revert: (f, i) => {
    if (!(f.vol20[i] > 0)) return 0;
    const z = f.ret1[i] / f.vol20[i];
    if (z < -2.5) return 1;
    if (z > 2.5) return -1;
    return 0;
  },
  // VWAP reversion: price far from session VWAP pulls back toward it.
  h06_vwap_revert: (f, i) => {
    if (!(f.vwap[i] > 0 && f.atr14[i] > 0)) return 0;
    const d = (f.close[i] - f.vwap[i]) / f.atr14[i];
    if (d < -2) return 1;
    if (d > 2) return -1;
    return 0;
  },
  // Donchian failure: poke beyond the 24h extreme then close back inside.
  h07_failed_breakout_revert: (f, i, candles) => {
    if (!isFinite(f.hh96[i])) return 0;
    if (candles[i].high > f.hh96[i] && f.close[i] < f.hh96[i]) return -1;
    if (candles[i].low < f.ll96[i] && f.close[i] > f.ll96[i]) return 1;
    return 0;
  },

  // --- VOLATILITY -----------------------------------------------------------
  // Volatility contraction then expansion: trade the expansion direction.
  h08_vol_expansion: (f, i) => {
    if (!(f.volSd[i] > 0 && f.vol20[i] > 0)) return 0;
    const z = (f.vol20[i] - f.volMean[i]) / f.volSd[i];
    if (z < 1) return 0;                     // only when vol is expanding
    return f.ret1[i] > 0 ? 1 : -1;
  },
  // Low-volatility drift: in quiet regimes, trend persists more cleanly.
  h09_lowvol_trend: (f, i) => {
    if (!(f.volSd[i] > 0 && f.ema200[i])) return 0;
    const z = (f.vol20[i] - f.volMean[i]) / f.volSd[i];
    if (z > -0.5) return 0;
    return f.close[i] > f.ema200[i] ? 1 : -1;
  },

  // --- ORDER FLOW -----------------------------------------------------------
  // Volume-confirmed directional candle (time-normalised RVOL).
  h10_rvol_direction: (f, i) => {
    if (!(f.rvolTime[i] >= 2)) return 0;
    return f.ret1[i] > 0 ? 1 : -1;
  },
  // CVD divergence: price down but candle-CVD up = absorption.
  h11_cvd_divergence: (f, i) => {
    const d = (f.cvdV.delta[i] || 0);
    if (!d) return 0;
    if (f.ret1[i] < 0 && d > 0) return 1;
    if (f.ret1[i] > 0 && d < 0) return -1;
    return 0;
  },

  // --- SESSION --------------------------------------------------------------
  // Killzone continuation: London/NY opens carry directional information.
  h12_killzone_momentum: (f, i, candles) => {
    const h = new Date(candles[i].openTime).getUTCHours();
    const inKz = (h >= 7 && h < 9) || (h >= 13 && h < 15);
    if (!inKz) return 0;
    if (!f.mom16[i]) return 0;
    return f.mom16[i] > 0 ? 1 : -1;
  },
};

function forwardRet(candles, i, h, dir) {
  const end = Math.min(i + h, candles.length - 1);
  if (end <= i) return null;
  return dir * Math.log(candles[end].close / candles[i].close);
}

function windowMask(candles, w) {
  const a = Date.parse(w[0] + 'T00:00:00Z'), b = Date.parse(w[1] + 'T23:59:59Z');
  return i => candles[i].openTime >= a && candles[i].openTime <= b;
}

function evaluate(candles, feats, fn, h, inWin) {
  const rets = [];
  let last = -Infinity;
  let longs = 0, shorts = 0;
  for (let i = 900; i < candles.length - h; i++) {
    if (!inWin(i)) continue;
    const dir = fn(feats, i, candles) || 0;
    if (dir !== 0 && i - last >= h) {
      const r = forwardRet(candles, i, h, dir);
      if (r !== null) { rets.push(r); last = i; if (dir > 0) longs++; else shorts++; }
    }
  }
  const total = longs + shorts;
  const longShare = total > 0 ? longs / total : 0.5;

  // BASELINE: the exact expected return of holding the SAME long/short mix over
  // the SAME window with no timing skill. A directionless control would credit a
  // long-biased signal for market drift, so we mix-match it exactly:
  //   baseline = longShare * E[longRet] + (1 - longShare) * E[shortRet]
  // and since shortRet = -longRet, this reduces to (2*longShare - 1) * E[longRet].
  const longRets = [];
  let lastB = -Infinity;
  for (let i = 900; i < candles.length - h; i++) {
    if (!inWin(i)) continue;
    if (i - lastB < h) continue;
    lastB = i;
    const r = forwardRet(candles, i, h, 1);
    if (r !== null) longRets.push(r);
  }
  const eLong = mean(longRets);
  const baseMean = (2 * longShare - 1) * eLong;

  const m = mean(rets), s = sd(rets);
  return {
    n: rets.length,
    mean: m,
    baseMean,
    alpha: m - baseMean,
    t: s > 0 && rets.length > 1 ? m / (s / Math.sqrt(rets.length)) : NaN,
    hit: rets.length ? rets.filter(r => r > 0).length / rets.length * 100 : NaN,
    longShare: longShare * 100,
  };
}

function run() {
  const nTests = Object.keys(HYPOTHESES).length * HORIZONS.length;
  // two-sided Bonferroni at family alpha 0.05 -> per-test alpha 0.05/nTests
  // z threshold via inverse normal approximation
  const perTest = 0.05 / nTests;
  const zBar = Math.sqrt(2) * inverseErf(1 - perTest);

  console.log('='.repeat(104));
  console.log('ALPHA BATTERY — can ANY signal be traded on 15m BTC/ETH?');
  console.log('='.repeat(104));
  console.log('hypotheses  : ' + Object.keys(HYPOTHESES).length +
    '   horizons: ' + HORIZONS.join(',') + '   tests: ' + nTests);
  console.log('windows     : TRAIN ' + WINDOWS.TRAIN.join('..') +
    ' | VALID ' + WINDOWS.VALID.join('..') + ' | OOS ' + WINDOWS.OOS.join('..'));
  console.log('multiple-testing bar: |t| > ' + zBar.toFixed(2) +
    '  (Bonferroni, family alpha 0.05 over ' + nTests + ' tests)');
  console.log('note        : naive |t|>2 would admit ~' + (nTests * 0.05).toFixed(1) +
    ' false positives across this battery');

  const data = {};
  for (const sym of SYMBOLS) {
    const candles = loadCandles(sym);
    data[sym] = { candles, feats: buildFeatures(candles) };
    console.log('loaded ' + sym + ': ' + candles.length + ' candles');
  }

  const results = [];
  for (const [name, fn] of Object.entries(HYPOTHESES)) {
    for (const h of HORIZONS) {
      const row = { name, h, per: {} };
      for (const sym of SYMBOLS) {
        const { candles, feats } = data[sym];
        row.per[sym] = {};
        for (const [wname, w] of Object.entries(WINDOWS)) {
          row.per[sym][wname] = evaluate(candles, feats, fn, h, windowMask(candles, w));
        }
      }
      results.push(row);
    }
  }

  // ── per-hypothesis detail ──
  for (const [name] of Object.entries(HYPOTHESES)) {
    console.log('\n' + '-'.repeat(104));
    console.log('HYPOTHESIS: ' + name);
    console.log('-'.repeat(104));
    console.log('  sym       h   window      n      alpha(bps)   t-stat   hit%    long%');
    for (const row of results.filter(r => r.name === name)) {
      for (const sym of SYMBOLS) {
        for (const wname of Object.keys(WINDOWS)) {
          const r = row.per[sym][wname];
          console.log('  ' + sym.replace('USDT', '').padEnd(9) + String(row.h).padStart(2) +
            '   ' + wname.padEnd(8) + String(r.n).padStart(7) +
            '   ' + bps(r.alpha).padStart(10) +
            '   ' + (isFinite(r.t) ? r.t.toFixed(2) : 'n/a').padStart(6) +
            '  ' + (isFinite(r.hit) ? r.hit.toFixed(1) : 'n/a').padStart(5) + '%' +
            '  ' + r.longShare.toFixed(0).padStart(5) + '%');
        }
      }
    }
  }

  // ── survivors ──
  console.log('\n' + '='.repeat(104));
  console.log('SURVIVORS — alpha>0 & |t|>' + zBar.toFixed(2) + ' in TRAIN, alpha>0 in VALID and OOS, both symbols');
  console.log('='.repeat(104));
  const survivors = results.filter(r =>
    SYMBOLS.every(s =>
      r.per[s].TRAIN.alpha > 0 && Math.abs(r.per[s].TRAIN.t) > zBar &&
      r.per[s].VALID.alpha > 0 && r.per[s].OOS.alpha > 0));
  if (!survivors.length) {
    console.log('  NONE.');
    console.log('  No hypothesis in this battery produced a positive, statistically');
    console.log('  significant, cross-symbol, out-of-sample-persistent edge.');
  } else {
    for (const r of survivors) {
      console.log('  ' + r.name + ' @ h=' + r.h);
      for (const s of SYMBOLS) {
        console.log('      ' + s + '  TRAIN a=' + bps(r.per[s].TRAIN.alpha) + ' t=' + r.per[s].TRAIN.t.toFixed(2) +
          ' | VALID a=' + bps(r.per[s].VALID.alpha) + ' | OOS a=' + bps(r.per[s].OOS.alpha));
      }
    }
  }

  // ── near misses, for honesty ──
  console.log('\nNEAR MISSES — positive TRAIN alpha on both symbols (regardless of significance)');
  const near = results.filter(r => SYMBOLS.every(s => r.per[s].TRAIN.alpha > 0));
  if (!near.length) console.log('  none');
  for (const r of near) {
    const bits = SYMBOLS.map(s => s.replace('USDT', '') + ' a=' + bps(r.per[s].TRAIN.alpha) +
      ' t=' + (isFinite(r.per[s].TRAIN.t) ? r.per[s].TRAIN.t.toFixed(2) : 'n/a') +
      ' V=' + bps(r.per[s].VALID.alpha) + ' O=' + bps(r.per[s].OOS.alpha));
    console.log('  ' + (r.name + ' h=' + r.h).padEnd(34) + bits.join('  |  '));
  }

  // ── cost context ──
  console.log('\n' + '='.repeat(104));
  console.log('COST CONTEXT — what any edge must clear');
  console.log('='.repeat(104));
  console.log('  Binance USD-M taker 5.0 bps / maker 2.0 bps.');
  console.log('  MARKET in + LIMIT out  = 7.0 bps round trip');
  console.log('  MARKET in + STOP_MARKET out = 10.0 bps round trip');
  console.log('  => a tradeable signal needs alpha comfortably above ~7-10 bps PER TRADE.');
  console.log('  For scale: the unconditional 8-candle drift in this data is ~1.5 bps.');

  const outDir = path.join(process.cwd(), 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'alpha_battery.json'),
    JSON.stringify({ windows: WINDOWS, horizons: HORIZONS, zBar, nTests, results, survivors: survivors.length }, null, 2));
  console.log('\nwritten: results/alpha_battery.json');
}

// Abramowitz-Stegun inverse error function approximation (good to ~4e-4)
function inverseErf(x) {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}

run();
