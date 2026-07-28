'use strict';

/**
 * Candle loading, resampling and multi-timeframe alignment.
 *
 * The base store is 15m NDJSON. Higher timeframes are derived here rather than
 * downloaded separately so every timeframe is guaranteed to come from identical
 * underlying data — a common source of silent backtest/live divergence.
 */

const fs = require('fs');
const path = require('path');

const TF_MS = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const BASE_TF = '15m';

function loadBase(symbol, dataDir) {
  const p = path.join(dataDir || path.join(process.cwd(), 'data', 'historical'),
    `${symbol}_${BASE_TF}.ndjson`);
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

/**
 * Resample base candles into `tf` buckets aligned to the UTC epoch.
 * A bucket is emitted only when COMPLETE, so no partial bar can leak into a
 * backtest and create lookahead.
 */
function resample(base, tf) {
  const ms = TF_MS[tf];
  if (!ms) throw new Error('unsupported timeframe: ' + tf);
  if (tf === BASE_TF) return base.slice();
  const expected = ms / TF_MS[BASE_TF];
  const out = [];
  let cur = null, count = 0;
  for (const c of base) {
    const bucket = Math.floor(c.openTime / ms) * ms;
    if (!cur || cur.openTime !== bucket) {
      if (cur && count === expected) out.push(cur);
      cur = {
        openTime: bucket, closeTime: bucket + ms - 1,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, trades: c.trades || 0,
      };
      count = 0;
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
      cur.trades += (c.trades || 0);
    }
    count++;
  }
  if (cur && count === expected) out.push(cur);
  return out;
}

/**
 * For each candle of `tf`, the index of the most recent FULLY CLOSED candle of
 * `htf`. This is the only safe way to consume higher-timeframe context: at time
 * t you may use an HTF bar only if its closeTime <= t.
 *
 * Returns an Int32Array where -1 means "no closed HTF bar yet".
 */
function alignHTF(tfCandles, htfCandles) {
  const map = new Int32Array(tfCandles.length).fill(-1);
  let j = -1;
  for (let i = 0; i < tfCandles.length; i++) {
    // a bar is usable once its closeTime is at or before this bar's OPEN time
    while (j + 1 < htfCandles.length && htfCandles[j + 1].closeTime <= tfCandles[i].openTime) j++;
    map[i] = j;
  }
  return map;
}

function sliceByDate(candles, fromISO, toISO) {
  const a = fromISO ? Date.parse(fromISO + 'T00:00:00Z') : -Infinity;
  const b = toISO ? Date.parse(toISO + 'T23:59:59Z') : Infinity;
  return candles.filter(c => c.openTime >= a && c.openTime <= b);
}

module.exports = { TF_MS, BASE_TF, loadBase, resample, alignHTF, sliceByDate };
