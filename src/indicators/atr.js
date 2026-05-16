'use strict';

/**
 * BulletBrain v3.0 — ATR Indicator
 * Phase D2 — Step 0.3
 *
 * Pure function: (candles[], period) → values[]
 * Source: backtestplan.md lines 147-151
 */

const { ema } = require('./ema');

/**
 * True Range for a single candle.
 * TR = max(high-low, |high-prevClose|, |low-prevClose|)
 *
 * @param {object} candle     - { high, low, close }
 * @param {number} prevClose  - previous candle's close
 * @returns {number} true range
 */
function trueRange(candle, prevClose) {
  const hl  = candle.high - candle.low;
  const hpc = Math.abs(candle.high - prevClose);
  const lpc = Math.abs(candle.low  - prevClose);
  return Math.max(hl, hpc, lpc);
}

/**
 * Average True Range (ATR)
 * Uses EMA smoothing (Wilder's method approximated via EMA).
 *
 * @param {object[]} candles - array of { high, low, close }
 * @param {number}   period  - ATR period (default 14)
 * @returns {number[]} ATR values, same length as candles
 */
function atr(candles, period = 14) {
  if (!candles || candles.length === 0) return [];
  if (period <= 0) throw new Error(`ATR period must be > 0, got ${period}`);

  // Calculate True Range for each candle
  const trValues = new Array(candles.length);
  trValues[0] = candles[0].high - candles[0].low; // first candle: no prev close

  for (let i = 1; i < candles.length; i++) {
    trValues[i] = trueRange(candles[i], candles[i - 1].close);
  }

  // Smooth with EMA
  return ema(trValues, period);
}

/**
 * ATR as percentage of close price.
 * Used by regime detection (CRISIS threshold: ATR% > 5%).
 *
 * @param {object[]} candles - array of { high, low, close }
 * @param {number}   period  - ATR period
 * @returns {number[]} ATR% values
 */
function atrPct(candles, period = 14) {
  const atrValues = atr(candles, period);
  return atrValues.map((a, i) => {
    const close = candles[i].close;
    return close > 0 ? (a / close) * 100 : 0;
  });
}

module.exports = { atr, atrPct, trueRange };
