'use strict';

/**
 * BulletBrain v3.0 — CVD (Cumulative Volume Delta) Indicator
 * Phase D2 — Step 0.3
 *
 * Candle-level approximation — no tick data required.
 * Assumes volume is distributed proportionally across the candle range.
 *
 * buyVol  = volume × (close - low)  / (high - low)
 * sellVol = volume × (high - close) / (high - low)
 * cvdDelta = buyVol - sellVol
 * cumulativeCVD resets at 00:00 UTC daily
 *
 * Source: backtestplan.md lines 162-172
 *
 * KNOWN LIMITATION (from backtestplan.md Step 4.1):
 * On sweep candles (wick > body), this formula overestimates buy volume
 * because close ≈ high → (close-low)/(high-low) ≈ 1.
 * Real tick CVD on sweep candles is often negative despite formula showing positive.
 * Validate with aggTrades correlation test before using in Gate 7.
 */

/**
 * Calculate CVD delta for a single candle.
 *
 * @param {object} candle - { open, high, low, close, volume }
 * @returns {number} cvdDelta (positive = net buying, negative = net selling)
 */
function cvdDeltaCandle(candle) {
  const range = candle.high - candle.low;
  if (range === 0) return 0; // doji — no directional information

  const buyVol  = candle.volume * (candle.close - candle.low)  / range;
  const sellVol = candle.volume * (candle.high  - candle.close) / range;
  return buyVol - sellVol;
}

/**
 * Calculate CVD for an array of candles.
 * Cumulative CVD resets at 00:00 UTC daily.
 *
 * @param {object[]} candles - array of { openTime, open, high, low, close, volume }
 * @returns {{ delta: number[], cumulative: number[] }}
 *   delta:      per-candle CVD delta
 *   cumulative: running cumulative CVD (resets daily)
 */
function cvd(candles) {
  if (!candles || candles.length === 0) return { delta: [], cumulative: [] };

  const delta      = new Array(candles.length);
  const cumulative = new Array(candles.length);

  let runningCVD   = 0;
  let currentDay   = null;

  for (let i = 0; i < candles.length; i++) {
    const c   = candles[i];
    const day = new Date(c.openTime).toISOString().slice(0, 10); // 'YYYY-MM-DD'

    // Reset at start of new UTC day
    if (day !== currentDay) {
      runningCVD = 0;
      currentDay = day;
    }

    const d    = cvdDeltaCandle(c);
    runningCVD += d;

    delta[i]      = d;
    cumulative[i] = runningCVD;
  }

  return { delta, cumulative };
}

/**
 * Check if a candle is a sweep candle (wick-dominated).
 * Used for the sweep-candle-specific CVD correlation test (Step 4.1).
 *
 * @param {object} candle - { open, high, low, close }
 * @returns {boolean}
 */
function isSweepCandle(candle) {
  const range = candle.high - candle.low;
  const body  = Math.abs(candle.close - candle.open);
  return range > 0 && body / range < 0.4; // body < 40% of range = wick-dominated
}

module.exports = { cvd, cvdDeltaCandle, isSweepCandle };
