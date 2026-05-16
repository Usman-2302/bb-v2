'use strict';

/**
 * BulletBrain v3.0 — SHORT-LSO Strategy (Bearish Liquidity Sweep)
 * Phase D10 — Mirror of LSO for downside
 *
 * Shares detection functions from lso.js (findEqualHighs, isBearishSweep,
 * buildBearishLSOSignal, checkCVDVelocityGate).
 *
 * Adds bearish-mirror gates:
 *   - Gate VP Bearish: sweep high > POC, reclaim close < VAH
 *   - 4H Trend Bearish: only allow shorts in BEARISH market structure
 *   - Short-squeeze buffer: block if sweep candle > 2× average ATR
 *
 * Source: backtestplan.md lines 1369-1408, masterplan.md Phase D10
 */

const { computeValueArea } = require('../indicators/volumeProfile');

// ─────────────────────────────────────────────────────────────────────────────
// GATE VP BEARISH — STRUCTURAL CONFIRMATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bearish Volume Profile Gate — structural confirmation for SHORT-LSO.
 *
 * Bearish: sweep HIGH must be ABOVE the POC (Point of Control), and the
 * sweep candle close must reclaim back BELOW the Value Area High (VAH).
 * This targets the "Premium Rejection" — a sweep above fair value that
 * gets rejected back below the upper boundary of the 70% volume zone.
 *
 * @param {object} candle          - sweep candle { high, low, close }
 * @param {number} sweepHigh       - sweep candle high price
 * @param {number} sweepClose      - sweep candle close price
 * @param {object[]} volumeProfiles - rolling volume profiles per candle
 * @param {number} i               - candle index
 * @returns {{ pass: boolean, reason?: string }}
 */
function checkVolumeProfileGateBearish(candle, sweepHigh, sweepClose, volumeProfiles, i) {
  if (!volumeProfiles || i >= volumeProfiles.length) {
    return { pass: true, reason: 'vp_no_data' };
  }

  const profile = volumeProfiles[i];
  if (!profile || !profile.buckets || profile.buckets.length === 0) {
    return { pass: true, reason: 'vp_empty_profile' };
  }

  const { vah, poc } = computeValueArea(profile);

  if (vah <= 0 || poc <= 0) {
    return { pass: true, reason: 'vp_flat_market' };
  }

  // Bearish Structural Gravity: sweep above POC (fair value), reject below VAH
  const sweptAbovePOC = sweepHigh > poc;
  const rejectedBelowVAH = sweepClose < vah;

  if (!sweptAbovePOC) {
    return { pass: false, reason: 'vp_not_above_poc' };
  }

  if (!rejectedBelowVAH) {
    return { pass: false, reason: 'vp_no_rejection_below_vah' };
  }

  return { pass: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4H TREND BEARISH — MACRO ALIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the 4H market structure is BEARISH (lower highs / lower lows).
 * Mirror of check4HTrendBullish for short-side activation.
 *
 * Bearish 4H = last 2 swing highs are descending AND last 2 swing lows are descending.
 * Returns size multiplier:
 *   - 1.0 if Bearish (LH + LL) — full size for shorts
 *   - 0.0 if Bullish (HH + HL) — BLOCK the short trade entirely
 *   - 0.5 if Neutral/Unknown — reduced size
 *
 * @param {object[]} candles - 15m candles
 * @param {number}   i       - current candle index
 * @returns {{ multiplier: number, state: string, reason?: string }}
 */
function check4HTrendBearish(candles, i) {
  const swingLookback = 4;   // 4 × 15m = 1H each side, 2H swing context
  const macroWindow   = 160; // 160 × 15m = 40H macro lookback
  const startIdx      = Math.max(swingLookback, i - macroWindow);

  if (i < swingLookback * 3) {
    return { multiplier: 1.0, state: 'UNKNOWN', reason: 'insufficient_data' };
  }

  const swingHighs = [];
  const swingLows  = [];

  for (let j = startIdx; j < i - swingLookback; j++) {
    const high = candles[j].high;
    const low  = candles[j].low;

    let isSwingHigh = true;
    let isSwingLow  = true;

    for (let d = 1; d <= swingLookback; d++) {
      if (high <= candles[j - d].high || high <= candles[j + d].high) isSwingHigh = false;
      if (low  >= candles[j - d].low  || low  >= candles[j + d].low)  isSwingLow  = false;
    }

    if (isSwingHigh) swingHighs.push({ index: j, price: high });
    if (isSwingLow)  swingLows.push({ index: j, price: low });
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { multiplier: 0.5, state: 'UNKNOWN', reason: 'insufficient_swings' };
  }

  const last2HH = swingHighs.slice(-2);
  const last2LL = swingLows.slice(-2);

  const higherHighs = last2HH[1].price > last2HH[0].price;
  const higherLows  = last2LL[1].price > last2LL[0].price;
  const lowerHighs  = last2HH[1].price < last2HH[0].price;
  const lowerLows   = last2LL[1].price < last2LL[0].price;

  // Bearish: lower highs AND lower lows → 1.0x (full size)
  if (lowerHighs && lowerLows) {
    return { multiplier: 1.0, state: 'BEARISH', reason: '4h_lh_ll' };
  }

  // Bullish: higher highs AND higher lows → 0.0x (BLOCK short)
  if (higherHighs && higherLows) {
    return { multiplier: 0.0, state: 'BULLISH', reason: '4h_hh_hl' };
  }

  // Mixed/neutral → 0.5x (reduced size)
  return { multiplier: 0.5, state: 'NEUTRAL', reason: '4h_mixed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORT-SQUEEZE VOLATILITY BUFFER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Block short trades when the sweep candle is excessively volatile.
 * Short squeezes are violent — a sweep candle > 2× average ATR signals
 * a parabolic breakout where shorting is suicide.
 *
 * @param {number} atr14         - ATR14 value at this candle
 * @param {number} avgATR30      - 30-period average of ATR14
 * @returns {{ pass: boolean, reason?: string }}
 */
function checkShortSqueezeBuffer(atr14, avgATR30) {
  if (!avgATR30 || avgATR30 <= 0) return { pass: true };

  if (atr14 > 2.0 * avgATR30) {
    return { pass: false, reason: 'short_squeeze_volatility' };
  }

  return { pass: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORT-LSO BEAR REGIME PERSISTENCE CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check that BEAR regime has persisted for at least 6 hours (24 × 15m candles).
 * Prevents entering shorts on a single-candle regime flip.
 *
 * @param {object[]} candles - 15m candles
 * @param {number}   i       - current candle index
 * @param {number}   minCandles - minimum consecutive BEAR candles (default 24 = 6 hours)
 * @returns {boolean}
 */
function isBearRegimeStable(candles, i, minCandles = 24) {
  if (i < minCandles) return false;

  for (let j = i - minCandles + 1; j <= i; j++) {
    if (candles[j].regime !== 'BEAR') return false;
  }

  return true;
}

module.exports = {
  checkVolumeProfileGateBearish,
  check4HTrendBearish,
  checkShortSqueezeBuffer,
  isBearRegimeStable,
};
