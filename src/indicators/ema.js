'use strict';

/**
 * BulletBrain v3.0 — EMA Indicator
 * Phase D2 — Step 0.3
 *
 * Pure function: (closes[], period) → values[]
 * No side effects. No globals.
 * Source: backtestplan.md lines 135-145
 */

/**
 * Exponential Moving Average
 * @param {number[]} closes - array of close prices
 * @param {number}   period - EMA period
 * @returns {number[]} EMA values, same length as closes
 */
function ema(closes, period) {
  if (!closes || closes.length === 0) return [];
  if (period <= 0) throw new Error(`EMA period must be > 0, got ${period}`);

  const k      = 2 / (period + 1);
  const result = new Array(closes.length);
  result[0]    = closes[0];

  for (let i = 1; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

/**
 * ATR-normalized EMA slope.
 * Measures how many ATRs the EMA200 moved per candle over the lookback window.
 * Self-calibrating: works across different volatility regimes.
 *
 * Geometric meaning: slope of 0.011 means EMA200 moved 0.22 ATRs over 20 candles.
 * Empirically derived from BTC 4H 2021-2024 data (30th percentile of bull months).
 * Source: results/regime_calibration.json + tests/slope_distribution.js
 *
 * @param {number[]} ema200Values - pre-calculated EMA200 array
 * @param {number[]} atr14Values  - pre-calculated ATR14 array
 * @param {number}   index        - current index
 * @param {number}   lookback     - periods to measure slope over (default 20 = 5 days at 4H)
 * @returns {number} ATR-normalized slope (dimensionless)
 */
function emaAtrSlope(ema200Values, atr14Values, index, lookback = 20) {
  if (index < lookback) return 0;
  const emaChange   = ema200Values[index] - ema200Values[index - lookback];
  const atrBaseline = atr14Values[index];
  if (atrBaseline === 0) return 0;
  return emaChange / (atrBaseline * lookback);
}

/**
 * EMA slope in degrees over last N periods.
 * Uses percentage-based slope to be price-scale independent.
 * Used by regime detection to classify BULL/BEAR.
 *
 * @param {number[]} emaValues - pre-calculated EMA array
 * @param {number}   index     - current index
 * @param {number}   lookback  - number of periods to measure slope over
 * @returns {number} slope angle in degrees
 */
function emaSlopeDegrees(emaValues, index, lookback = 10) {
  if (index < lookback) return 0;

  const current  = emaValues[index];
  const previous = emaValues[index - lookback];
  if (previous === 0) return 0;

  // Percentage change per period (price-scale independent)
  const pctChangePerPeriod = ((current - previous) / previous) / lookback;

  // Convert to degrees: atan of percentage change scaled to be meaningful
  // Multiply by 100 so that 1% per period ≈ 45° (intuitive scaling)
  const slopeAngle = Math.atan(pctChangePerPeriod * 100) * (180 / Math.PI);
  return slopeAngle;
}

module.exports = { ema, emaSlopeDegrees, emaAtrSlope };
