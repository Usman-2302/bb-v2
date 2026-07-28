'use strict';

/**
 * Feature computation.
 *
 * Contract, enforced by construction: every value at index i uses ONLY candles
 * 0..i. Any feature that peeks forward invalidates every downstream result, so
 * each rolling helper is written to close at i inclusive and nothing else.
 *
 * Reuses the repo's proven pure indicators (ema/atr/cvd) rather than
 * reimplementing them.
 */

const { ema } = require('../../indicators/ema');
const { atr } = require('../../indicators/atr');
const { cvd: cvdFn } = require('../../indicators/cvd');

function rollingMean(a, n) {
  const out = new Array(a.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function rollingSd(a, n) {
  const out = new Array(a.length).fill(NaN);
  let s = 0, ss = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]; ss += a[i] * a[i];
    if (i >= n) { s -= a[i - n]; ss -= a[i - n] * a[i - n]; }
    if (i >= n - 1) {
      const m = s / n;
      out[i] = Math.sqrt(Math.max(0, ss / n - m * m));
    }
  }
  return out;
}

/** Rolling extreme over the PREVIOUS n bars (excludes bar i — no self-reference). */
function rollingExtreme(a, n, cmp) {
  const out = new Array(a.length).fill(NaN);
  for (let i = n; i < a.length; i++) {
    let best = a[i - n];
    for (let j = i - n + 1; j < i; j++) if (cmp(a[j], best)) best = a[j];
    out[i] = best;
  }
  return out;
}

/**
 * Swing pivots confirmed with `k` bars either side. A pivot at index p is only
 * KNOWN at p+k, so `confirmedAt` is exposed and consumers must respect it.
 */
function swings(candles, k = 2) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isH = false;
      if (candles[j].low <= candles[i].low) isL = false;
    }
    if (isH) highs.push({ idx: i, price: candles[i].high, confirmedAt: i + k });
    if (isL) lows.push({ idx: i, price: candles[i].low, confirmedAt: i + k });
  }
  return { highs, lows };
}

/**
 * Market structure state per bar: higher-highs/higher-lows etc, plus BOS/CHOCH
 * flags. Only pivots already CONFIRMED at bar i are considered.
 */
function marketStructure(candles, k = 2) {
  const { highs, lows } = swings(candles, k);
  const n = candles.length;
  const trend = new Array(n).fill(0);        // +1 up, -1 down, 0 undetermined
  const bos = new Array(n).fill(0);          // break of structure this bar
  const choch = new Array(n).fill(0);        // change of character this bar
  const lastSwingHigh = new Array(n).fill(NaN);
  const lastSwingLow = new Array(n).fill(NaN);

  let hi = 0, lo = 0;                        // cursors into confirmed pivots
  let prevH = null, curH = null, prevL = null, curL = null;
  let state = 0;

  for (let i = 0; i < n; i++) {
    while (hi < highs.length && highs[hi].confirmedAt <= i) {
      prevH = curH; curH = highs[hi]; hi++;
    }
    while (lo < lows.length && lows[lo].confirmedAt <= i) {
      prevL = curL; curL = lows[lo]; lo++;
    }
    lastSwingHigh[i] = curH ? curH.price : NaN;
    lastSwingLow[i] = curL ? curL.price : NaN;

    if (prevH && curH && prevL && curL) {
      const hh = curH.price > prevH.price;
      const hl = curL.price > prevL.price;
      const lh = curH.price < prevH.price;
      const ll = curL.price < prevL.price;
      const newState = (hh && hl) ? 1 : (lh && ll) ? -1 : state;
      if (newState !== state && state !== 0) choch[i] = newState;
      state = newState;
    }
    trend[i] = state;

    // BOS: close beyond the most recent confirmed swing in the trend direction
    if (curH && candles[i].close > curH.price) bos[i] = 1;
    if (curL && candles[i].close < curL.price) bos[i] = -1;
  }
  return { trend, bos, choch, lastSwingHigh, lastSwingLow, highs, lows };
}

/** Session-anchored VWAP (resets each UTC day) plus deviation in sigma. */
function sessionVWAP(candles) {
  const n = candles.length;
  const vwap = new Array(n).fill(NaN);
  const dev = new Array(n).fill(NaN);
  let day = null, pv = 0, vv = 0, sq = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(candles[i].openTime / 86400000);
    if (d !== day) { day = d; pv = 0; vv = 0; sq = 0; cnt = 0; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += tp * candles[i].volume; vv += candles[i].volume;
    const w = vv > 0 ? pv / vv : candles[i].close;
    vwap[i] = w;
    sq += (tp - w) * (tp - w); cnt++;
    const sigma = cnt > 1 ? Math.sqrt(sq / cnt) : NaN;
    dev[i] = sigma > 0 ? (candles[i].close - w) / sigma : NaN;
  }
  return { vwap, dev };
}

/** UTC session tag. Crypto has no official sessions but liquidity clusters. */
function sessionOf(openTime) {
  const h = new Date(openTime).getUTCHours();
  if (h >= 0 && h < 7) return 'ASIA';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 13 && h < 21) return 'NY';
  return 'LATE';
}

/**
 * Build the full feature set for one timeframe.
 * Additional context from higher timeframes is attached separately by the engine.
 */
function build(candles) {
  const n = candles.length;
  const close = candles.map(c => c.close);
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const volume = candles.map(c => c.volume);

  const ret1 = new Array(n).fill(0);
  for (let i = 1; i < n; i++) ret1[i] = Math.log(close[i] / close[i - 1]);

  const atr14 = atr(candles, 14);
  const ema20 = ema(close, 20);
  const ema50 = ema(close, 50);
  const ema200 = ema(close, 200);

  const rv20 = rollingSd(ret1, 20);
  const rv100 = rollingMean(rv20.map(v => Number.isFinite(v) ? v : 0), 100);
  const rvSd = rollingSd(rv20.map(v => Number.isFinite(v) ? v : 0), 100);
  const volZ = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(rv20[i]) && rvSd[i] > 0) volZ[i] = (rv20[i] - rv100[i]) / rvSd[i];
  }

  const volSma20 = rollingMean(volume, 20);
  const rvol = new Array(n).fill(1);
  for (let i = 0; i < n; i++) rvol[i] = volSma20[i] > 0 ? volume[i] / volSma20[i] : 1;

  const donHigh = rollingExtreme(high, 96, (a, b) => a > b);
  const donLow = rollingExtreme(low, 96, (a, b) => a < b);

  const atrPct = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (close[i] > 0) atrPct[i] = (atr14[i] || 0) / close[i];

  const struct = marketStructure(candles, 2);
  const vw = sessionVWAP(candles);
  const cvdV = cvdFn(candles);

  const session = candles.map(c => sessionOf(c.openTime));

  return {
    candles, n, close, high, low, volume,
    ret1, atr14, atrPct, ema20, ema50, ema200,
    rv20, volZ, rvol,
    donHigh, donLow,
    trend: struct.trend, bos: struct.bos, choch: struct.choch,
    swingHigh: struct.lastSwingHigh, swingLow: struct.lastSwingLow,
    vwap: vw.vwap, vwapDev: vw.dev,
    cvdDelta: cvdV.delta,
    session,
  };
}

module.exports = {
  build, rollingMean, rollingSd, rollingExtreme, swings, marketStructure,
  sessionVWAP, sessionOf,
};
