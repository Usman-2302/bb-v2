'use strict';

/**
 * BulletBrain v3.0 — Time-Normalized RVOL Indicator
 * Phase D2 — Step 0.3
 *
 * RVOL = current_volume / avg_volume_same_time_slot_last_N_days
 *
 * NOT a simple SMA of volume. Each candle is compared to the average
 * volume of candles at the same time-of-day slot over the last N days.
 * This prevents Asian session candles from appearing as high RVOL
 * relative to killzone candles — they are compared to their own baseline.
 *
 * Source: backtestplan.md lines 153-160
 */

/**
 * Get the time slot key for a candle.
 * For 15m candles: 96 slots per day (0-95)
 * For 1H candles: 24 slots per day (0-23)
 *
 * @param {number} openTime - candle open timestamp in ms
 * @param {string} interval - '15m', '1h', '4h', '1d'
 * @returns {number} slot index within the day
 */
function getTimeSlot(openTime, interval) {
  const date        = new Date(openTime);
  const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();

  const slotMinutes = {
    '15m': 15,
    '1h':  60,
    '4h':  240,
    '1d':  1440,
  };

  const mins = slotMinutes[interval] || 60;
  return Math.floor(minuteOfDay / mins);
}

/**
 * Calculate time-normalized RVOL for each candle.
 *
 * @param {object[]} candles  - array of { openTime, volume }
 * @param {string}   interval - candle interval ('15m', '1h', etc.)
 * @param {number}   days     - lookback days for baseline (default 20)
 * @returns {number[]} RVOL values, same length as candles
 */
function rvol(candles, interval = '1h', days = 20) {
  if (!candles || candles.length === 0) return [];

  const result = new Array(candles.length).fill(1.0);

  // Determine candles per day based on interval
  const candlesPerDay = {
    '15m': 96,
    '1h':  24,
    '4h':  6,
    '1d':  1,
  };
  const cpd = candlesPerDay[interval] || 24;
  const lookbackCandles = days * cpd;

  for (let i = 0; i < candles.length; i++) {
    const slot = getTimeSlot(candles[i].openTime, interval);

    // Collect volumes from same time slot in lookback window
    const slotVolumes = [];
    const start = Math.max(0, i - lookbackCandles);

    for (let j = start; j < i; j++) {
      if (getTimeSlot(candles[j].openTime, interval) === slot) {
        slotVolumes.push(candles[j].volume);
      }
    }

    if (slotVolumes.length === 0) {
      result[i] = 1.0; // no baseline yet — neutral
      continue;
    }

    const avgVol = slotVolumes.reduce((a, b) => a + b, 0) / slotVolumes.length;
    result[i] = avgVol > 0 ? candles[i].volume / avgVol : 1.0;
  }

  return result;
}

module.exports = { rvol, getTimeSlot };
