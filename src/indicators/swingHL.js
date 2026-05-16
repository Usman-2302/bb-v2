'use strict';

/**
 * BulletBrain v3.0 — Swing High / Low Detector
 * Phase D2 — Step 0.3
 *
 * Algorithmic definition (not visual):
 * SwingHigh[i] = high[i] > high[i-1] AND high[i] > high[i-2]
 *                AND high[i] > high[i+1] AND high[i] > high[i+2]
 * SwingLow[i]  = low[i] < low[i-1] AND low[i] < low[i-2]
 *                AND low[i] < low[i+1] AND low[i] < low[i+2]
 *
 * Lookback: 2 candles each side (configurable).
 * Source: backtestplan.md lines 153-162
 */

/**
 * Detect swing highs and lows in a candle array.
 *
 * @param {object[]} candles  - array of { high, low }
 * @param {number}   lookback - candles each side to compare (default 2)
 * @returns {{ swingHighs: boolean[], swingLows: boolean[] }}
 *   swingHighs[i] = true if candle i is a swing high
 *   swingLows[i]  = true if candle i is a swing low
 *   First and last `lookback` candles are always false (insufficient context)
 */
function swingHL(candles, lookback = 2) {
  if (!candles || candles.length === 0) {
    return { swingHighs: [], swingLows: [] };
  }

  const n          = candles.length;
  const swingHighs = new Array(n).fill(false);
  const swingLows  = new Array(n).fill(false);

  for (let i = lookback; i < n - lookback; i++) {
    const high = candles[i].high;
    const low  = candles[i].low;

    // Check swing high: higher than all candles within lookback on both sides
    let isHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (high <= candles[i - j].high || high <= candles[i + j].high) {
        isHigh = false;
        break;
      }
    }
    swingHighs[i] = isHigh;

    // Check swing low: lower than all candles within lookback on both sides
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (low >= candles[i - j].low || low >= candles[i + j].low) {
        isLow = false;
        break;
      }
    }
    swingLows[i] = isLow;
  }

  return { swingHighs, swingLows };
}

/**
 * Get all swing high price levels from a candle array.
 * Returns array of { index, price } for each swing high.
 *
 * @param {object[]} candles
 * @param {number}   lookback
 * @returns {{ index: number, price: number }[]}
 */
function getSwingHighs(candles, lookback = 2) {
  const { swingHighs } = swingHL(candles, lookback);
  return swingHighs
    .map((isHigh, i) => isHigh ? { index: i, price: candles[i].high } : null)
    .filter(Boolean);
}

/**
 * Get all swing low price levels from a candle array.
 *
 * @param {object[]} candles
 * @param {number}   lookback
 * @returns {{ index: number, price: number }[]}
 */
function getSwingLows(candles, lookback = 2) {
  const { swingLows } = swingHL(candles, lookback);
  return swingLows
    .map((isLow, i) => isLow ? { index: i, price: candles[i].low } : null)
    .filter(Boolean);
}

module.exports = { swingHL, getSwingHighs, getSwingLows };
