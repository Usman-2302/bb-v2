'use strict';

/**
 * BulletBrain v3.0 — Efficiency Ratio (ER)
 * Phase D2 — Step 0.3
 *
 * ER = directional move / sum of absolute moves over period
 * ER near 1.0 = strong trend (efficient, directional movement)
 * ER near 0.0 = choppy/zombie (inefficient, random movement)
 *
 * Used by zombie detection in regime engine:
 * If ER < 0.3 → RANGING_ZOMBIE (FVG/OB disabled)
 *
 * Source: backtestplan.md lines 476-490
 */

/**
 * Calculate Efficiency Ratio for a single window of candles.
 *
 * @param {object[]} candles - array of { close }
 * @param {number}   period  - lookback period (default 10)
 * @returns {number} ER value between 0 and 1
 */
function efficiencyRatio(candles, period = 10) {
  if (!candles || candles.length < period + 1) return 0;

  const start = candles.length - period - 1;
  const end   = candles.length - 1;

  // Directional move: absolute distance from start to end
  const directional = Math.abs(candles[end].close - candles[start].close);

  // Total path: sum of absolute moves between consecutive candles
  let totalPath = 0;
  for (let i = start + 1; i <= end; i++) {
    totalPath += Math.abs(candles[i].close - candles[i - 1].close);
  }

  return totalPath === 0 ? 0 : directional / totalPath;
}

/**
 * Calculate rolling Efficiency Ratio for each candle in an array.
 *
 * @param {object[]} candles - array of { close }
 * @param {number}   period  - lookback period (default 10)
 * @returns {number[]} ER values, same length as candles
 *   First `period` values are 0 (insufficient data)
 */
function rollingEfficiencyRatio(candles, period = 10) {
  if (!candles || candles.length === 0) return [];

  return candles.map((_, i) => {
    if (i < period) return 0;
    return efficiencyRatio(candles.slice(0, i + 1), period);
  });
}

module.exports = { efficiencyRatio, rollingEfficiencyRatio };
