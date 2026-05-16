'use strict';

/**
 * BulletBrain v3.0 — FVG (Fair Value Gap) Strategy
 * Phase D6 — Step 1.1
 *
 * Bullish FVG: gap between candle[i-1].high and candle[i+1].low
 * with impulse candle[i] confirming institutional participation.
 *
 * Source: backtestplan.md lines 607-707 (Steps 1.1, 1.2, 1.2b)
 */

const { FVG: FVG_CONFIG, SESSIONS } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// SESSION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a timestamp is in the Asian session (22:00-07:00 UTC).
 * FVG is DISABLED in Asian session — hard gate, no exceptions.
 */
function isAsianSession(openTime) {
  const hour = new Date(openTime).getUTCHours();
  return hour >= SESSIONS.asian.start || hour < SESSIONS.asian.end;
}

// ─────────────────────────────────────────────────────────────────────────────
// FVG DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect all bullish FVGs in a candle array.
 * NOTE: Detection is allowed in ALL sessions including Asian.
 * Entry is blocked during Asian session — checked separately in checkFVGEntry.
 * This allows FVGs formed during Asian session to be filled during London open.
 *
 * @param {object[]} candles   - array of { openTime, open, high, low, close, volume, rvol }
 * @param {number[]} atr14     - pre-computed ATR14 array (same length as candles)
 * @param {number[]} rvolVals  - pre-computed RVOL array (same length as candles)
 * @returns {object[]} FVG zones
 */
function detectBullishFVGs(candles, atr14, rvolVals) {
  const fvgs = [];

  // Need at least 3 candles: [i-1], [i], [i+1]
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // NOTE: Asian session gate removed from detection.
    // FVGs can form during Asian session — they may be valid when filled during London.
    // Entry gate is applied in checkFVGEntry() instead.

    // Gap condition: candle[i-1].high < candle[i+1].low
    if (prev.high >= next.low) continue;

    // Gap size filter: minimum gap as % of price
    const gapSize = (next.low - prev.high) / curr.close;
    if (gapSize < FVG_CONFIG.minGapSize) continue;

    // Body size filter: impulse candle body > bodyMultiplier × ATR14
    const body = Math.abs(curr.close - curr.open);
    if (body < FVG_CONFIG.bodyMultiplier * atr14[i]) continue;

    // RVOL filter: volume confirms institutional participation
    if (rvolVals[i] < FVG_CONFIG.rvolThreshold) continue;

    // Valid FVG
    const top    = next.low;
    const bottom = prev.high;
    const mid    = (top + bottom) / 2;

    fvgs.push({
      id:               `fvg_${curr.openTime}`,
      type:             'BULLISH',
      top,
      bottom,
      mid,
      formed_at:        i,
      formed_time:      curr.openTime,
      expires_at:       i + FVG_CONFIG.validityCandles,
      status:           'ACTIVE',
      fill_pct:         0,
      contested_touches: 0,
      impulse_candle:   i,
      atr_at_formation: atr14[i],
    });
  }

  return fvgs;
}

/**
 * Detect all bearish FVGs in a candle array.
 * Detection allowed in all sessions. Entry blocked during Asian session.
 */
function detectBearishFVGs(candles, atr14, rvolVals) {
  const fvgs = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // NOTE: Asian session gate removed from detection (same as bullish)

    // Gap condition: candle[i-1].low > candle[i+1].high
    if (prev.low <= next.high) continue;

    const gapSize = (prev.low - next.high) / curr.close;
    if (gapSize < FVG_CONFIG.minGapSize) continue;

    const body = Math.abs(curr.close - curr.open);
    if (body < FVG_CONFIG.bodyMultiplier * atr14[i]) continue;

    if (rvolVals[i] < FVG_CONFIG.rvolThreshold) continue;

    const top    = prev.low;
    const bottom = next.high;
    const mid    = (top + bottom) / 2;

    fvgs.push({
      id:               `fvg_bear_${curr.openTime}`,
      type:             'BEARISH',
      top,
      bottom,
      mid,
      formed_at:        i,
      formed_time:      curr.openTime,
      expires_at:       i + FVG_CONFIG.validityCandles,
      status:           'ACTIVE',
      fill_pct:         0,
      contested_touches: 0,
      impulse_candle:   i,
      atr_at_formation: atr14[i],
    });
  }

  return fvgs;
}

// ─────────────────────────────────────────────────────────────────────────────
// FVG STATE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update FVG zone status based on current candle.
 * Tracks partial fills, invalidation, expiry, and contested touches.
 *
 * @param {object} fvg    - FVG zone object (mutated in place)
 * @param {object} candle - current candle { high, low, close }
 * @param {number} index  - current candle index
 */
function updateFVGStatus(fvg, candle, index) {
  if (fvg.status === 'FILLED' || fvg.status === 'EXPIRED' || fvg.status === 'CONTESTED') {
    return; // already terminal state
  }

  // Expiry check
  if (index >= fvg.expires_at) {
    fvg.status = 'EXPIRED';
    return;
  }

  // Invalidation: price closes below FVG bottom (bullish) or above FVG top (bearish)
  if (fvg.type === 'BULLISH' && candle.close < fvg.bottom) {
    fvg.status = 'FILLED';
    return;
  }
  if (fvg.type === 'BEARISH' && candle.close > fvg.top) {
    fvg.status = 'FILLED';
    return;
  }

  // Partial fill tracking: candle overlaps with FVG zone
  const zoneRange = fvg.top - fvg.bottom;
  if (zoneRange > 0 && candle.low <= fvg.top && candle.high >= fvg.bottom) {
    const overlapMin = Math.max(candle.low,  fvg.bottom);
    const overlapMax = Math.min(candle.high, fvg.top);
    const overlap    = overlapMax - overlapMin;
    const newFillPct = (overlap / zoneRange) * 100;

    // Track contested touches (price enters zone but doesn't fill)
    if (candle.close > fvg.bottom && candle.close < fvg.top) {
      // Price is inside zone but didn't close below bottom
      fvg.contested_touches++;
    }

    fvg.fill_pct += newFillPct;

    if (fvg.fill_pct >= 50) {
      fvg.status = 'PARTIALLY_FILLED';
    }

    // Contested zone: 3+ touches without filling → skip
    if (fvg.contested_touches >= FVG_CONFIG.maxContested) {
      fvg.status = 'CONTESTED';
    }
  }
}

/**
 * Check if an FVG is tradeable (ACTIVE or PARTIALLY_FILLED).
 */
function isTradeable(fvg) {
  return fvg.status === 'ACTIVE' || fvg.status === 'PARTIALLY_FILLED';
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if current candle triggers an FVG entry signal.
 * Price must reach the FVG midpoint.
 *
 * @param {object} fvg    - FVG zone (must be tradeable)
 * @param {object} candle - current candle
 * @returns {object|null} signal or null
 */
function checkFVGEntry(fvg, candle) {
  if (!isTradeable(fvg)) return null;

  // Asian session ENTRY gate — hard block regardless of FVG detection time
  // FVGs detected during Asian session can still be filled during London open
  if (isAsianSession(candle.openTime)) return null;

  // Calculate entry price based on entryOffset
  // 0.50 = midpoint (default), 0.25 = 25% into zone (more conservative, higher fill rate)
  const entryOffset = FVG_CONFIG.entryOffset || 0.50;

  if (fvg.type === 'BULLISH') {
    // Entry level: fvg.top - entryOffset × zone_size
    const entryLevel = fvg.top - entryOffset * (fvg.top - fvg.bottom);

    if (candle.low <= entryLevel && candle.close > fvg.bottom) {
      return {
        type:        'BULLISH_FVG',
        fvgId:       fvg.id,
        limitPrice:  entryLevel,
        stopPrice:   fvg.bottom - FVG_CONFIG.stopBuffer * fvg.atr_at_formation,
        fvgTop:      fvg.top,
        fvgBottom:   fvg.bottom,
        fvgMid:      fvg.mid,
        entryOffset,
        fillQuality: null,
      };
    }
  }

  if (fvg.type === 'BEARISH') {
    const entryLevel = fvg.bottom + entryOffset * (fvg.top - fvg.bottom);

    if (candle.high >= entryLevel && candle.close < fvg.top) {
      return {
        type:        'BEARISH_FVG',
        fvgId:       fvg.id,
        limitPrice:  entryLevel,
        stopPrice:   fvg.top + FVG_CONFIG.stopBuffer * fvg.atr_at_formation,
        fvgTop:      fvg.top,
        fvgBottom:   fvg.bottom,
        fvgMid:      fvg.mid,
        entryOffset,
        fillQuality: null,
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  detectBullishFVGs,
  detectBearishFVGs,
  updateFVGStatus,
  isTradeable,
  checkFVGEntry,
  isAsianSession,
};
