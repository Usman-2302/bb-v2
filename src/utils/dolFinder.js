'use strict';

/**
 * BulletBrain v3.0 — DOL (Draw on Liquidity) Target Finder
 * Phase D6 — Step 1.2
 *
 * Finds the nearest unmitigated structural target above/below entry.
 * Priority: equal highs/lows cluster > bearish/bullish OB > bearish/bullish FVG
 *
 * LOOKAHEAD BIAS GUARD: only considers candles with openTime < signalOpenTime.
 *
 * Source: backtestplan.md lines 644-707 (Step 1.2)
 */

const { DOL } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// EQUAL HIGHS/LOWS CLUSTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find equal highs clusters (sell-side liquidity pools).
 * Minimum 2 highs within tolerance to form a cluster.
 *
 * @param {object[]} candles   - valid candles (already filtered for lookahead)
 * @param {object}   options   - { tolerance, minTouches, lookback }
 * @returns {object[]} clusters [{ level, touches, indices }]
 */
function findEqualHighsClusters(candles, options = {}) {
  const tolerance  = options.tolerance  || DOL.tolerance;
  const minTouches = options.minTouches || DOL.minTouches;
  const lookback   = options.lookback   || DOL.lookback;

  const start    = Math.max(0, candles.length - lookback);
  const slice    = candles.slice(start);
  const clusters = [];

  for (let i = 0; i < slice.length; i++) {
    const baseHigh = slice[i].high;
    const group    = [i];

    for (let j = i + 1; j < slice.length; j++) {
      if (Math.abs(slice[j].high - baseHigh) / baseHigh < tolerance) {
        group.push(j);
      }
    }

    if (group.length >= minTouches) {
      const avgLevel = group.reduce((s, idx) => s + slice[idx].high, 0) / group.length;
      clusters.push({
        level:   avgLevel,
        touches: group.length,
        type:    'EQUAL_HIGHS',
      });
    }
  }

  // Deduplicate clusters that are within tolerance of each other
  const deduped = [];
  clusters.forEach(c => {
    const existing = deduped.find(d => Math.abs(d.level - c.level) / c.level < tolerance);
    if (!existing) deduped.push(c);
    else if (c.touches > existing.touches) {
      existing.level   = c.level;
      existing.touches = c.touches;
    }
  });

  return deduped;
}

/**
 * Find equal lows clusters (buy-side liquidity pools).
 */
function findEqualLowsClusters(candles, options = {}) {
  const tolerance  = options.tolerance  || DOL.tolerance;
  const minTouches = options.minTouches || DOL.minTouches;
  const lookback   = options.lookback   || DOL.lookback;

  const start    = Math.max(0, candles.length - lookback);
  const slice    = candles.slice(start);
  const clusters = [];

  for (let i = 0; i < slice.length; i++) {
    const baseLow = slice[i].low;
    const group   = [i];

    for (let j = i + 1; j < slice.length; j++) {
      if (Math.abs(slice[j].low - baseLow) / baseLow < tolerance) {
        group.push(j);
      }
    }

    if (group.length >= minTouches) {
      const avgLevel = group.reduce((s, idx) => s + slice[idx].low, 0) / group.length;
      clusters.push({
        level:   avgLevel,
        touches: group.length,
        type:    'EQUAL_LOWS',
      });
    }
  }

  const deduped = [];
  clusters.forEach(c => {
    const existing = deduped.find(d => Math.abs(d.level - c.level) / c.level < tolerance);
    if (!existing) deduped.push(c);
    else if (c.touches > existing.touches) {
      existing.level   = c.level;
      existing.touches = c.touches;
    }
  });

  return deduped;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMED SWING PIVOTS (Fix 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the highest confirmed swing high in candles[startIndex..endIndex].
 * A confirmed swing high requires leftBars candles with strictly lower highs
 * to the left AND rightBars candles with strictly lower highs to the right.
 * This prevents single spike candles from being used as DOL targets.
 *
 * @param {object[]} candles
 * @param {number}   startIndex  - inclusive
 * @param {number}   endIndex    - exclusive
 * @param {number}   leftBars    - candles required on left (default 3)
 * @param {number}   rightBars   - candles required on right (default 3)
 * @returns {number|null} highest confirmed swing high price, or null
 */
function findConfirmedSwingHigh(candles, startIndex, endIndex, leftBars = 3, rightBars = 3) {
  let best = null;

  for (let i = startIndex + leftBars; i < endIndex - rightBars; i++) {
    const pivot = candles[i].high;
    const leftOk  = candles.slice(i - leftBars,  i).every(c => c.high < pivot);
    const rightOk = candles.slice(i + 1, i + rightBars + 1).every(c => c.high < pivot);
    if (leftOk && rightOk) {
      if (best === null || pivot > best) best = pivot;
    }
  }

  return best;
}

/**
 * Find the lowest confirmed swing low in candles[startIndex..endIndex].
 */
function findConfirmedSwingLow(candles, startIndex, endIndex, leftBars = 3, rightBars = 3) {
  let best = null;

  for (let i = startIndex + leftBars; i < endIndex - rightBars; i++) {
    const pivot = candles[i].low;
    const leftOk  = candles.slice(i - leftBars,  i).every(c => c.low > pivot);
    const rightOk = candles.slice(i + 1, i + rightBars + 1).every(c => c.low > pivot);
    if (leftOk && rightOk) {
      if (best === null || pivot < best) best = pivot;
    }
  }

  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DOL FINDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the nearest valid DOL target for a trade.
 * Two-tier hierarchy (Fix 3: Tier 3 removed):
 *   Tier 1: Equal highs/lows cluster (minTouches=2, highest quality)
 *   Tier 2: Confirmed swing high/low in last 72 candles (3-bar pivot, min 0.5% from entry)
 *   No target → DOL_NOT_FOUND → trade skipped (no artificial ATR target)
 *
 * @param {object[]} candles      - full candle array
 * @param {number}   signalIndex  - index of the signal candle
 * @param {number}   entryPrice   - proposed entry price
 * @param {number}   stopPrice    - proposed stop price
 * @param {string}   direction    - 'LONG' | 'SHORT'
 * @param {object[]} [activeFVGs] - active FVG zones for FVG-as-DOL check
 * @param {number[]} [atr14]      - unused (kept for API compatibility)
 * @returns {{ dol, type, rr, tier }|null}
 */
function findDOL(candles, signalIndex, entryPrice, stopPrice, direction, activeFVGs = [], atr14 = []) {
  const signalOpenTime = candles[signalIndex].openTime;

  // LOOKAHEAD BIAS GUARD: only use candles strictly before signal
  const validCandles = candles.filter(c => c.openTime < signalOpenTime);

  if (process.env.NODE_ENV === 'development') {
    validCandles.forEach(c => {
      console.assert(c.openTime < signalOpenTime, 'DOL lookahead bias detected');
    });
  }

  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (riskDistance === 0) return null;

  // ── TIER 1: Equal highs/lows clusters ──────────────────────────────────
  let candidates = [];

  if (direction === 'LONG') {
    const highClusters = findEqualHighsClusters(validCandles);
    highClusters
      .filter(c => c.level > entryPrice)
      .forEach(c => candidates.push({ level: c.level, type: 'EQUAL_HIGHS', tier: 1 }));

    activeFVGs
      .filter(f => f.type === 'BEARISH' && f.bottom > entryPrice &&
                   (f.status === 'ACTIVE' || f.status === 'PARTIALLY_FILLED'))
      .forEach(f => candidates.push({ level: f.mid, type: 'BEARISH_FVG', tier: 1 }));

  } else {
    const lowClusters = findEqualLowsClusters(validCandles);
    lowClusters
      .filter(c => c.level < entryPrice)
      .forEach(c => candidates.push({ level: c.level, type: 'EQUAL_LOWS', tier: 1 }));

    activeFVGs
      .filter(f => f.type === 'BULLISH' && f.top < entryPrice &&
                   (f.status === 'ACTIVE' || f.status === 'PARTIALLY_FILLED'))
      .forEach(f => candidates.push({ level: f.mid, type: 'BULLISH_FVG', tier: 1 }));
  }

  // ── TIER 2: Confirmed swing high/low in last 72 candles ────────────────
  // Fix 3 (Phase D6 Recovery): replaced "highest wick" with a confirmed swing
  // pivot (3 lower highs on each side). Prevents single spike candles from
  // being used as DOL. Also enforces min 0.5% and max 5% distance from entry.
  if (candidates.length === 0) {
    const lookbackStart = Math.max(0, validCandles.length - 72);
    const lookbackEnd   = validCandles.length;

    if (direction === 'LONG') {
      const swingHigh = findConfirmedSwingHigh(validCandles, lookbackStart, lookbackEnd, 3, 3);
      if (swingHigh) {
        const distPct = (swingHigh - entryPrice) / entryPrice;
        if (swingHigh > entryPrice && distPct >= 0.005 && distPct < 0.05) {
          candidates.push({ level: swingHigh, type: 'SWING_HIGH', tier: 2 });
        }
      }
    } else {
      const swingLow = findConfirmedSwingLow(validCandles, lookbackStart, lookbackEnd, 3, 3);
      if (swingLow) {
        const distPct = (entryPrice - swingLow) / entryPrice;
        if (swingLow < entryPrice && distPct >= 0.005 && distPct < 0.05) {
          candidates.push({ level: swingLow, type: 'SWING_LOW', tier: 2 });
        }
      }
    }
  }

  // ── TIER 3 REMOVED ──────────────────────────────────────────────────────
  // Fix 3: ATR-based target (entry ± 2×ATR) was not a structural level.
  // It produced invalid R:R calculations and arbitrary profit targets.
  // If Tier 1 and Tier 2 both fail → no trade. Log as DOL_NOT_FOUND.

  // Filter: DOL must be within maxDistance of entry
  const maxDist = entryPrice * DOL.maxDistance;
  candidates = candidates.filter(c =>
    Math.abs(c.level - entryPrice) <= maxDist
  );

  if (candidates.length === 0) return null;

  // Sort by distance from entry (nearest first)
  candidates.sort((a, b) =>
    Math.abs(a.level - entryPrice) - Math.abs(b.level - entryPrice)
  );

  // Find first candidate with R:R >= minRR
  for (const candidate of candidates) {
    const reward = Math.abs(candidate.level - entryPrice);
    const rr     = reward / riskDistance;

    if (rr >= DOL.minRR) {
      return {
        dol:  candidate.level,
        type: candidate.type,
        tier: candidate.tier,
        rr:   parseFloat(rr.toFixed(2)),
      };
    }
  }

  return null; // no valid DOL found
}

module.exports = {
  findDOL,
  findEqualHighsClusters,
  findEqualLowsClusters,
  findConfirmedSwingHigh,
  findConfirmedSwingLow,
};
