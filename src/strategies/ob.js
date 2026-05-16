'use strict';

/**
 * BulletBrain v3.0 — Order Block (OB) Strategy
 * Phase D7 — Step 2.1
 *
 * Bullish OB: last bearish candle before a significant move UP.
 * Entry when price returns to the OB zone from above (OB top = entry level).
 *
 * Source: backtestplan.md lines 965-1050 (Step 2.1)
 */

const { OB: OB_CONFIG, SESSIONS } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// SESSION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a timestamp is in the Asian session (22:00-07:00 UTC).
 * OB is DISABLED in Asian session — hard gate, same as FVG.
 */
function isAsianSession(openTime) {
  const hour = new Date(openTime).getUTCHours();
  return hour >= SESSIONS.asian.start || hour < SESSIONS.asian.end;
}

// ─────────────────────────────────────────────────────────────────────────────
// OB DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect all bullish Order Blocks in a candle array.
 *
 * A bullish OB is the last bearish candle before a significant move UP.
 * The "significant move" candle must have:
 *   - body >= OB_CONFIG.moveMultiplier × ATR14
 *   - volume >= OB_CONFIG.rvolThreshold × RVOL baseline
 *
 * Detection is allowed in all sessions (same as FVG).
 * Entry is blocked during Asian session — checked in checkOBEntry().
 *
 * @param {object[]} candles   - array of { openTime, open, high, low, close, volume }
 * @param {number[]} atr14     - pre-computed ATR14 (same length as candles)
 * @param {number[]} rvolVals  - pre-computed RVOL (same length as candles)
 * @returns {object[]} OB zones
 */
function detectBullishOBs(candles, atr14, rvolVals) {
  const obs = [];

  // Need at least 2 candles: [i] = bearish OB candidate, [i+1] = significant move
  for (let i = 0; i < candles.length - 1; i++) {
    const obCandle   = candles[i];
    const moveCandle = candles[i + 1];

    // OB candle must be bearish (close < open)
    if (obCandle.close >= obCandle.open) continue;

    // Move candle must be bullish (close > open)
    if (moveCandle.close <= moveCandle.open) continue;

    // Move candle body must be significant
    const moveBody = Math.abs(moveCandle.close - moveCandle.open);
    if (moveBody < OB_CONFIG.moveMultiplier * atr14[i + 1]) continue;

    // Move candle volume must confirm institutional participation
    if (rvolVals[i + 1] < OB_CONFIG.rvolThreshold) continue;

    // Valid bullish OB
    obs.push({
      id:               `ob_bull_${obCandle.openTime}`,
      type:             'BULLISH',
      top:              obCandle.high,
      bottom:           obCandle.low,
      mid:              (obCandle.high + obCandle.low) / 2,
      formed_at:        i,
      formed_time:      obCandle.openTime,
      expires_at:       i + OB_CONFIG.validityCandles,
      status:           'ACTIVE',
      contested_touches: 0,
      atr_at_formation: atr14[i],
      move_candle_index: i + 1,
    });
  }

  return obs;
}

/**
 * Detect all bearish Order Blocks in a candle array.
 * Mirror of bullish logic — last bullish candle before significant move DOWN.
 *
 * @param {object[]} candles
 * @param {number[]} atr14
 * @param {number[]} rvolVals
 * @returns {object[]} OB zones
 */
function detectBearishOBs(candles, atr14, rvolVals) {
  const obs = [];

  for (let i = 0; i < candles.length - 1; i++) {
    const obCandle   = candles[i];
    const moveCandle = candles[i + 1];

    // OB candle must be bullish
    if (obCandle.close <= obCandle.open) continue;

    // Move candle must be bearish
    if (moveCandle.close >= moveCandle.open) continue;

    const moveBody = Math.abs(moveCandle.close - moveCandle.open);
    if (moveBody < OB_CONFIG.moveMultiplier * atr14[i + 1]) continue;

    if (rvolVals[i + 1] < OB_CONFIG.rvolThreshold) continue;

    obs.push({
      id:               `ob_bear_${obCandle.openTime}`,
      type:             'BEARISH',
      top:              obCandle.high,
      bottom:           obCandle.low,
      mid:              (obCandle.high + obCandle.low) / 2,
      formed_at:        i,
      formed_time:      obCandle.openTime,
      expires_at:       i + OB_CONFIG.validityCandles,
      status:           'ACTIVE',
      contested_touches: 0,
      atr_at_formation: atr14[i],
      move_candle_index: i + 1,
    });
  }

  return obs;
}

// ─────────────────────────────────────────────────────────────────────────────
// OB STATE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update OB zone status based on current candle.
 * Tracks expiry, invalidation, and contested touches.
 *
 * @param {object} ob     - OB zone object (mutated in place)
 * @param {object} candle - current candle { high, low, close }
 * @param {number} index  - current candle index
 */
function updateOBStatus(ob, candle, index) {
  if (ob.status === 'INVALIDATED' || ob.status === 'EXPIRED') return;

  // Expiry check
  if (index >= ob.expires_at) {
    ob.status = 'EXPIRED';
    return;
  }

  // Invalidation: price closes BELOW OB low (bullish) or ABOVE OB high (bearish)
  if (ob.type === 'BULLISH' && candle.close < ob.bottom) {
    ob.status = 'INVALIDATED';
    return;
  }
  if (ob.type === 'BEARISH' && candle.close > ob.top) {
    ob.status = 'INVALIDATED';
    return;
  }

  // Contested touches: price enters zone but doesn't invalidate
  if (ob.type === 'BULLISH') {
    if (candle.low <= ob.top && candle.close > ob.bottom) {
      ob.contested_touches++;
    }
  } else {
    if (candle.high >= ob.bottom && candle.close < ob.top) {
      ob.contested_touches++;
    }
  }
}

/**
 * Check if an OB is tradeable (ACTIVE only — no partial fill concept for OB).
 */
function isOBTradeable(ob) {
  return ob.status === 'ACTIVE';
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if current candle triggers an OB entry signal.
 * Bullish OB: price returns to OB top from above.
 * Entry level = OB top (the high of the bearish OB candle).
 *
 * @param {object} ob     - OB zone (must be tradeable)
 * @param {object} candle - current candle
 * @returns {object|null} signal or null
 */
function checkOBEntry(ob, candle) {
  if (!isOBTradeable(ob)) return null;

  // Asian session ENTRY gate — hard block
  if (isAsianSession(candle.openTime)) return null;

  if (ob.type === 'BULLISH') {
    // Entry when price reaches OB top from above
    // candle.low must touch or penetrate OB top, close must stay above OB bottom
    if (candle.low <= ob.top && candle.close > ob.bottom) {
      return {
        type:       'BULLISH_OB',
        obId:       ob.id,
        limitPrice: ob.top,
        stopPrice:  ob.bottom - OB_CONFIG.stopBuffer * ob.atr_at_formation,
        obTop:      ob.top,
        obBottom:   ob.bottom,
        obMid:      ob.mid,
      };
    }
  }

  if (ob.type === 'BEARISH') {
    // Entry when price reaches OB bottom from below
    if (candle.high >= ob.bottom && candle.close < ob.top) {
      return {
        type:       'BEARISH_OB',
        obId:       ob.id,
        limitPrice: ob.bottom,
        stopPrice:  ob.top + OB_CONFIG.stopBuffer * ob.atr_at_formation,
        obTop:      ob.top,
        obBottom:   ob.bottom,
        obMid:      ob.mid,
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  detectBullishOBs,
  detectBearishOBs,
  updateOBStatus,
  isOBTradeable,
  checkOBEntry,
  isAsianSession,
};
