'use strict';

/**
 * BulletBrain v3.0 — LSO Strategy (Liquidity Sweep + OI Flush)
 * Phase D8 — Steps 3.1, 3.2, 3.3
 *
 * Most complex strategy. Requires OI data (1H resolution, interpolated to 15m).
 * Three components:
 *   1. Equal highs/lows detector — identifies liquidity pools
 *   2. Sweep detector — identifies the wick-through-and-close-back pattern
 *   3. OI flush detector — confirms forced liquidations via OI drop
 *
 * Source: backtestplan.md lines 966-1111 (Phase 3, Steps 3.1-3.6)
 */

const { LSO: LSO_CONFIG, SESSIONS } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// SESSION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a timestamp is in the Asian session (22:00-07:00 UTC).
 * LSO is ALLOWED in Asian session (sweeps are valid — equal lows/highs get
 * hunted before London open, which is exactly what LSO detects).
 * This function is kept for documentation purposes.
 */
function isAsianSession(openTime) {
  const hour = new Date(openTime).getUTCHours();
  return hour >= SESSIONS.asian.start || hour < SESSIONS.asian.end;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3.1 — EQUAL HIGHS / LOWS DETECTOR
// Source: backtestplan.md lines 966-988
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all equal-lows liquidity pools in a candle array.
 *
 * Equal lows = two SWING LOWS within LSO_CONFIG.equalTolerance (0.3%) of each other,
 * at least LSO_CONFIG.equalMinGap (5) candles apart, within the last
 * LSO_CONFIG.equalLookback (50) candles, with neither low swept between them.
 *
 * SWING LOW definition (controlled by LSO_CONFIG.swingLookback):
 *   swingLookback=1: low[i] < low[i-1] AND low[i] < low[i+1]  (1-bar each side)
 *   swingLookback=2: low[i] < low[i±1] AND low[i] < low[i±2]  (2-bar each side)
 *
 * D8 finding: 2-bar produced only 14 trades over 4 years (too restrictive).
 * 1-bar is the correct balance — catches structural lows without noise.
 *
 * @param {object[]} candles - array of { openTime, open, high, low, close, volume }
 * @param {number}   index   - current candle index (scan backwards from here)
 * @returns {object[]} array of { level, formed_at, low_i, low_j }
 */
function findEqualLows(candles, index) {
  const pools = [];
  const lb    = LSO_CONFIG.swingLookback || 1; // 1-bar default (D8 fix)
  const start = Math.max(lb, index - LSO_CONFIG.equalLookback);

  // Collect swing lows in the lookback window
  const swingLowIndices = [];
  for (let i = start; i < index - lb; i++) {
    const low = candles[i].low;
    let isSwing = true;
    for (let d = 1; d <= lb; d++) {
      if (i - d < 0 || i + d >= candles.length) { isSwing = false; break; }
      if (low >= candles[i - d].low || low >= candles[i + d].low) { isSwing = false; break; }
    }
    if (isSwing) swingLowIndices.push(i);
  }

  // Find pairs of swing lows within tolerance
  for (let a = 0; a < swingLowIndices.length; a++) {
    for (let b = a + 1; b < swingLowIndices.length; b++) {
      const i = swingLowIndices[a];
      const j = swingLowIndices[b];

      if (j - i < LSO_CONFIG.equalMinGap) continue;

      const lowI = candles[i].low;
      const lowJ = candles[j].low;

      if (Math.abs(lowI - lowJ) / lowI >= LSO_CONFIG.equalTolerance) continue;

      // Neither low swept between i and j
      let swept = false;
      for (let k = i + 1; k < j; k++) {
        if (candles[k].low < Math.min(lowI, lowJ)) {
          swept = true;
          break;
        }
      }
      if (swept) continue;

      const level = (lowI + lowJ) / 2;
      pools.push({
        id:        `eql_${candles[i].openTime}_${candles[j].openTime}`,
        type:      'EQUAL_LOWS',
        level,
        low_i:     lowI,
        low_j:     lowJ,
        formed_at: j,
        formed_time: candles[j].openTime,
        index_i:   i,
        index_j:   j,
      });
    }
  }

  // Deduplicate: if two pools are within 0.1% of each other, keep the more recent
  const deduped = [];
  for (const pool of pools) {
    const dup = deduped.find(p =>
      Math.abs(p.level - pool.level) / pool.level < 0.001
    );
    if (!dup) {
      deduped.push(pool);
    } else if (pool.formed_at > dup.formed_at) {
      deduped.splice(deduped.indexOf(dup), 1, pool);
    }
  }

  return deduped;
}

/**
 * Find all equal-highs liquidity pools in a candle array.
 * Mirror of findEqualLows — identifies sell-side liquidity.
 * Uses LSO_CONFIG.swingLookback for swing high detection (same as findEqualLows).
 *
 * @param {object[]} candles
 * @param {number}   index
 * @returns {object[]}
 */
function findEqualHighs(candles, index) {
  const pools = [];
  const lb    = LSO_CONFIG.swingLookback || 1;
  const start = Math.max(lb, index - LSO_CONFIG.equalLookback);

  // Collect swing highs in the lookback window
  const swingHighIndices = [];
  for (let i = start; i < index - lb; i++) {
    const high = candles[i].high;
    let isSwing = true;
    for (let d = 1; d <= lb; d++) {
      if (i - d < 0 || i + d >= candles.length) { isSwing = false; break; }
      if (high <= candles[i - d].high || high <= candles[i + d].high) { isSwing = false; break; }
    }
    if (isSwing) swingHighIndices.push(i);
  }

  // Find pairs of swing highs within tolerance
  for (let a = 0; a < swingHighIndices.length; a++) {
    for (let b = a + 1; b < swingHighIndices.length; b++) {
      const i = swingHighIndices[a];
      const j = swingHighIndices[b];

      if (j - i < LSO_CONFIG.equalMinGap) continue;

      const highI = candles[i].high;
      const highJ = candles[j].high;

      if (Math.abs(highI - highJ) / highI >= LSO_CONFIG.equalTolerance) continue;

      // Neither high swept between i and j
      let swept = false;
      for (let k = i + 1; k < j; k++) {
        if (candles[k].high > Math.max(highI, highJ)) {
          swept = true;
          break;
        }
      }
      if (swept) continue;

      const level = (highI + highJ) / 2;
      pools.push({
        id:        `eqh_${candles[i].openTime}_${candles[j].openTime}`,
        type:      'EQUAL_HIGHS',
        level,
        high_i:    highI,
        high_j:    highJ,
        formed_at: j,
        formed_time: candles[j].openTime,
        index_i:   i,
        index_j:   j,
      });
    }
  }

  // Deduplicate
  const deduped = [];
  for (const pool of pools) {
    const dup = deduped.find(p =>
      Math.abs(p.level - pool.level) / pool.level < 0.001
    );
    if (!dup) {
      deduped.push(pool);
    } else if (pool.formed_at > dup.formed_at) {
      deduped.splice(deduped.indexOf(dup), 1, pool);
    }
  }

  return deduped;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3.2 — SWEEP DETECTOR
// Source: backtestplan.md lines 989-1004
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the current candle is a bullish sweep of an equal-lows pool.
 *
 * Bullish sweep conditions:
 *   - candle.low < pool.level  (wick below the pool)
 *   - candle.close > pool.level (closes back above — trap)
 *   - body/wick ratio < LSO_CONFIG.maxBodyWickRatio (wick-dominated candle)
 *
 * @param {object} candle - current candle
 * @param {object} pool   - equal-lows pool
 * @returns {boolean}
 */
function isBullishSweep(candle, pool) {
  if (pool.type !== 'EQUAL_LOWS') return false;

  // Wick below pool level
  if (candle.low >= pool.level) return false;

  // Closes back above pool level (trap)
  if (candle.close <= pool.level) return false;

  // Wick-dominated candle (body/wick ratio < threshold)
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const body = Math.abs(candle.close - candle.open);
  if (body / range >= LSO_CONFIG.maxBodyWickRatio) return false;

  return true;
}

/**
 * Check if the current candle is a bearish sweep of an equal-highs pool.
 * Mirror of bullish sweep — for SHORT-LSO (Phase D10).
 *
 * @param {object} candle
 * @param {object} pool
 * @returns {boolean}
 */
function isBearishSweep(candle, pool) {
  if (pool.type !== 'EQUAL_HIGHS') return false;

  // Wick above pool level
  if (candle.high <= pool.level) return false;

  // Closes back below pool level
  if (candle.close >= pool.level) return false;

  // Wick-dominated candle
  const range = candle.high - candle.low;
  if (range === 0) return false;
  const body = Math.abs(candle.close - candle.open);
  if (body / range >= LSO_CONFIG.maxBodyWickRatio) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3.3 — OI FLUSH DETECTOR (with 15m interpolation)
// Source: backtestplan.md lines 1005-1066
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interpolate OI to 15m resolution from 1H data.
 *
 * Linear interpolation between hourly OI values.
 * Returns null if data gap — do NOT fabricate.
 *
 * @param {string} symbol
 * @param {number} timestamp_15m - 15m candle openTime (ms)
 * @param {Map}    oiDataStore   - Map<symbol, Array<{timestamp, oi}>> at 1H resolution
 * @returns {number|null}
 */
function getInterpolatedOI(symbol, timestamp_15m, oiDataStore) {
  const oiData = oiDataStore.get(symbol);
  if (!oiData || oiData.length === 0) return null;

  const hourStart = Math.floor(timestamp_15m / 3600000) * 3600000;
  const hourEnd   = hourStart + 3600000;

  const oiOpen  = oiData.find(o => o.timestamp === hourStart);
  const oiClose = oiData.find(o => o.timestamp === hourEnd);

  if (!oiOpen || !oiClose) return null; // data gap — skip OI check

  const fraction = (timestamp_15m - hourStart) / 3600000; // 0.0 to 1.0
  return oiOpen.oi + (oiClose.oi - oiOpen.oi) * fraction;
}

/**
 * Check if OI flushed by the required threshold in the sweep candle's 15m window.
 *
 * Uses interpolated OI (not raw 1H bucket) to reduce false positive rate ~4×.
 * Default threshold: 3.0% (requires genuine forced liquidations, not noise).
 *
 * @param {string} symbol
 * @param {number} sweepTimestamp_15m - sweep candle openTime (ms)
 * @param {Map}    oiDataStore
 * @param {number} threshold          - OI drop threshold (default 0.030 = 3.0%)
 * @returns {boolean}
 */
function checkOIFlush(symbol, sweepTimestamp_15m, oiDataStore, threshold = 0.030) {
  const oi_at_sweep  = getInterpolatedOI(symbol, sweepTimestamp_15m, oiDataStore);
  const oi_prior_15m = getInterpolatedOI(symbol, sweepTimestamp_15m - 900000, oiDataStore);

  if (oi_at_sweep === null || oi_prior_15m === null) return false;
  if (oi_prior_15m === 0) return false;

  const oiDelta = (oi_at_sweep - oi_prior_15m) / oi_prior_15m;
  return oiDelta < -threshold; // OI dropped by threshold% in this 15m window
}

/**
 * OI Velocity Gate — replacement for CVD in Gate 7 when sweep-candle
 * CVD correlation fails (< 0.70).
 *
 * Measures the RATE of OI change — signature of real liquidations:
 *   - Fast OI drop (> 0.3% in 15m sweep window) = mass forced closings
 *   - OI decelerating after drop = liquidations exhausted, potential floor
 *   - OI continuing to drop = cascading continues, NOT a floor
 *
 * Source: backtestplan.md lines 1131-1175
 *
 * @param {string} symbol
 * @param {number} sweepTimestamp_15m
 * @param {Map}    oiDataStore
 * @returns {{ pass: boolean, reason: string }}
 */
function checkOIVelocityGate(symbol, sweepTimestamp_15m, oiDataStore) {
  const oi_now    = getInterpolatedOI(symbol, sweepTimestamp_15m, oiDataStore);
  const oi_minus1 = getInterpolatedOI(symbol, sweepTimestamp_15m - 900000, oiDataStore);
  const oi_minus2 = getInterpolatedOI(symbol, sweepTimestamp_15m - 1800000, oiDataStore);

  if (oi_now === null || oi_minus1 === null || oi_minus2 === null) {
    return { pass: false, reason: 'DATA_GAP' };
  }
  if (oi_minus1 === 0 || oi_minus2 === 0) {
    return { pass: false, reason: 'DATA_GAP' };
  }

  const velocity_sweep = (oi_now - oi_minus1) / oi_minus1;     // OI change in sweep candle
  const velocity_prior = (oi_minus1 - oi_minus2) / oi_minus2;  // OI change in prior candle

  // PASS: fast drop + decelerating (liquidation exhausting, not cascading)
  const fastDrop     = velocity_sweep < -0.003;   // > 0.3% drop in sweep candle
  const decelerating = velocity_sweep > velocity_prior; // less negative than prior = slowing
  const notCascading = velocity_sweep > -0.015;   // not still in freefall (> -1.5%)

  if (fastDrop && decelerating && notCascading) {
    return { pass: true, reason: 'OI_VELOCITY_ABSORPTION' };
  }

  if (velocity_sweep < -0.015) return { pass: false, reason: 'OI_CASCADE_CONTINUING' };
  if (!fastDrop)                return { pass: false, reason: 'OI_DROP_TOO_SMALL' };
  if (!decelerating)            return { pass: false, reason: 'OI_ACCELERATING' };
  return { pass: false, reason: 'OI_VELOCITY_INCONCLUSIVE' };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a bullish LSO entry signal from a sweep candle.
 *
 * ENTRY MODEL — "Level Reclaim" (Gemini D8 fix):
 * Do NOT enter inside the sweep candle. The sweep candle itself is the
 * liquidation event — entering during it means buying into the cascade.
 * Instead, wait for the sweep candle to CLOSE back above the pool level,
 * then enter on the NEXT candle at the pool level (the reclaim).
 *
 * This eliminates the structural cause of 78.6% toxic fills:
 *   OLD: limit at body midpoint of sweep candle → fills during cascade
 *   NEW: limit at pool level on next candle → fills on the reclaim bounce
 *
 * The reclaim entry is confirmed by the sweep candle's close > pool.level.
 * The isBullishSweep() check already verifies this condition.
 *
 * Entry:  limit at pool.level (the swept level becomes support)
 * Stop:   sweep candle low - (LSO_CONFIG.stopBuffer × ATR14_15m)
 *         (stop is still based on sweep candle low — the structural invalidation)
 *
 * @param {object} sweepCandle - the sweep candle (already closed above pool.level)
 * @param {object} pool        - the equal-lows pool that was swept
 * @param {number} atr14       - ATR14 at sweep candle
 * @returns {object} signal
 */
function buildBullishLSOSignal(sweepCandle, pool, atr14) {
  // Entry at pool level (reclaim) — not body midpoint
  // This is a limit order placed for the NEXT candle
  const limitPrice = pool.level;
  const stopPrice  = sweepCandle.low - LSO_CONFIG.stopBuffer * atr14;

  return {
    type:        'BULLISH_LSO',
    poolId:      pool.id,
    poolLevel:   pool.level,
    limitPrice,
    stopPrice,
    sweepLow:    sweepCandle.low,
    sweepClose:  sweepCandle.close,
    sweepTime:   sweepCandle.openTime,
    entryModel:  'LEVEL_RECLAIM',  // logged for analysis
  };
}

/**
 * Generate a bearish LSO entry signal from a sweep candle.
 * For SHORT-LSO (Phase D10).
 *
 * Entry at pool level (reclaim) — same logic as bullish, mirrored.
 * Stop at sweep candle high + shortStopBuffer × ATR14.
 *
 * @param {object} sweepCandle
 * @param {object} pool
 * @param {number} atr14
 * @returns {object} signal
 */
function buildBearishLSOSignal(sweepCandle, pool, atr14) {
  // Entry at pool level (reclaim) — not body midpoint
  const limitPrice = pool.level;
  const stopPrice  = sweepCandle.high + LSO_CONFIG.shortStopBuffer * atr14;

  return {
    type:        'BEARISH_LSO',
    poolId:      pool.id,
    poolLevel:   pool.level,
    limitPrice,
    stopPrice,
    sweepHigh:   sweepCandle.high,
    sweepClose:  sweepCandle.close,
    sweepTime:   sweepCandle.openTime,
    entryModel:  'LEVEL_RECLAIM',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// D7 DEFERRED ITEM 1 — OB CONFLUENCE CHECK
// Source: masterplan.md Phase D8 deferred items
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the sweep candle is inside an active OB zone.
 * If yes, apply 1.3× size multiplier (high confluence).
 *
 * @param {object}   sweepCandle - the sweep candle
 * @param {object[]} activeOBs   - array of active bullish OB zones
 * @returns {{ insideOB: boolean, obId: string|null }}
 */
function checkOBConfluence(sweepCandle, activeOBs) {
  if (!activeOBs || activeOBs.length === 0) {
    return { insideOB: false, obId: null };
  }

  for (const ob of activeOBs) {
    if (ob.type !== 'BULLISH') continue;
    if (ob.status !== 'ACTIVE') continue;

    // Sweep candle low is inside the OB zone
    if (sweepCandle.low >= ob.bottom && sweepCandle.low <= ob.top) {
      return { insideOB: true, obId: ob.id };
    }
    // Or the sweep pool level is inside the OB zone
    // (pool level may be slightly below sweep candle low)
  }

  return { insideOB: false, obId: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// D7 DEFERRED ITEM 3 — TIME-BASED BREAKEVEN GATE (LSO-specific)
// Source: masterplan.md Phase D8 deferred items
// Tested on OB in D7 — made results worse (PF 0.488 → 0.276).
// LSO sweeps are faster-resolving by nature — test with 8 candles (vs OB's 12).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an LSO trade should be closed due to no progress.
 * If trade has not reached 50% of TP1 distance within 8 candles → close at market.
 *
 * @param {object} trade        - open trade object
 * @param {number} candlesHeld  - candles since entry
 * @param {number} currentPrice - current candle close
 * @returns {{ exit: boolean, reason: string }|null}
 */
function checkLSOTimeBreakeven(trade, candlesHeld, currentPrice) {
  const LSO_BREAKEVEN_CANDLES = 8; // 2 hours at 15m — sweeps resolve faster than OB
  if (candlesHeld < LSO_BREAKEVEN_CANDLES) return null;
  if (trade.pastTP1) return null; // already past TP1, let it run

  const tp1Distance = Math.abs(trade.tp1 - trade.entryPrice);
  const progress    = trade.side === 'LONG'
    ? currentPrice - trade.entryPrice
    : trade.entryPrice - currentPrice;

  if (progress < 0.5 * tp1Distance) {
    return { exit: true, reason: 'lso_time_breakeven' };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC LIQUIDATION GATE (Gemini D8 Round 3 — CVD-Velocity Proxy)
// Source: Gemini D8 review — "Hybrid-Validation Engine"
//
// When OI data is absent, use CVD velocity z-score as a synthetic OI flush proxy.
// A genuine institutional sweep generates a Volume/CVD decoupling:
//   - Price wicks below the level (sweep)
//   - CVD velocity spikes sharply (aggressive buying absorbing the liquidations)
//   - The spike is statistically significant vs the 24H baseline
//
// This captures the "Exhaustion" phase of a liquidation event without OI data.
// It is NOT a replacement for OI — it is a fallback that preserves signal quality
// when the primary gate (OI_VELOCITY) cannot run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthetic Liquidation Gate using CVD velocity z-score.
 *
 * Computes the z-score of the current candle's CVD delta relative to
 * the 24H rolling baseline. A z-score > threshold indicates a statistically
 * significant buying spike — the signature of absorption after a sweep.
 *
 * @param {number}   currentIndex  - current candle index
 * @param {object}   cvdVals       - { delta: number[], cumulative: number[] }
 * @param {number}   threshold     - z-score threshold (default 2.5)
 * @param {number}   lookback      - candles for baseline (default 96 = 24H at 15m)
 * @returns {{ pass: boolean, reason: string, zscore: number }}
 */
function checkCVDVelocityGate(currentIndex, cvdVals, threshold = 2.5, lookback = 96) {
  if (!cvdVals || !cvdVals.delta || cvdVals.delta.length === 0) {
    return { pass: false, reason: 'NO_CVD_DATA', zscore: 0 };
  }

  const currentDelta = cvdVals.delta[currentIndex] || 0;

  // Need enough history for baseline
  if (currentIndex < lookback) {
    return { pass: false, reason: 'INSUFFICIENT_HISTORY', zscore: 0 };
  }

  // Compute 24H baseline: mean and std of CVD deltas
  const window = cvdVals.delta.slice(currentIndex - lookback, currentIndex);
  const mean   = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((s, d) => s + (d - mean) ** 2, 0) / window.length;
  const std    = Math.sqrt(variance);

  if (std === 0) {
    return { pass: false, reason: 'ZERO_VARIANCE', zscore: 0 };
  }

  const zscore = (currentDelta - mean) / std;

  // PASS: CVD velocity is significantly above baseline (buyers absorbing)
  if (zscore >= threshold) {
    return { pass: true, reason: 'CVD_VELOCITY_SPIKE', zscore };
  }

  return { pass: false, reason: 'CVD_VELOCITY_BELOW_THRESHOLD', zscore };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source: Gemini D8 review — "Session Highs/Lows as pools"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find session high/low liquidity pools from the previous day's range
 * and the London session open range.
 *
 * These are massive liquidity magnets — stops cluster at previous day H/L
 * and London open H/L regardless of swing pivot structure.
 *
 * Only active when LSO_CONFIG.useSessionPools = true.
 * OFF by default to preserve baseline comparability.
 *
 * @param {object[]} candles - full candle array
 * @param {number}   index   - current candle index
 * @returns {object[]} session pool objects
 */
function findSessionPools(candles, index) {
  if (!LSO_CONFIG.useSessionPools) return [];

  const pools = [];
  const currentTime = candles[index].openTime;
  const currentDay  = new Date(currentTime);
  currentDay.setUTCHours(0, 0, 0, 0);
  const todayStart  = currentDay.getTime();
  const prevDayStart = todayStart - 86400000;

  // Previous day's candles (00:00 UTC to 00:00 UTC)
  const prevDayCandles = candles.filter(c =>
    c.openTime >= prevDayStart && c.openTime < todayStart
  );

  if (prevDayCandles.length > 0) {
    const prevDayHigh = Math.max(...prevDayCandles.map(c => c.high));
    const prevDayLow  = Math.min(...prevDayCandles.map(c => c.low));
    const prevDayHighCandle = prevDayCandles.find(c => c.high === prevDayHigh);
    const prevDayLowCandle  = prevDayCandles.find(c => c.low  === prevDayLow);

    // Previous day high = sell-side liquidity pool (equal highs equivalent)
    pools.push({
      id:        `session_pdh_${todayStart}`,
      type:      'EQUAL_HIGHS',
      level:     prevDayHigh,
      formed_at: candles.findIndex(c => c.openTime === prevDayHighCandle?.openTime),
      formed_time: prevDayHighCandle?.openTime,
      source:    'PREV_DAY_HIGH',
    });

    // Previous day low = buy-side liquidity pool (equal lows equivalent)
    pools.push({
      id:        `session_pdl_${todayStart}`,
      type:      'EQUAL_LOWS',
      level:     prevDayLow,
      formed_at: candles.findIndex(c => c.openTime === prevDayLowCandle?.openTime),
      formed_time: prevDayLowCandle?.openTime,
      source:    'PREV_DAY_LOW',
    });
  }

  // London session open range (07:00-08:00 UTC today)
  const londonOpenStart = todayStart + 7 * 3600000;
  const londonOpenEnd   = todayStart + 8 * 3600000;
  const londonCandles   = candles.filter(c =>
    c.openTime >= londonOpenStart && c.openTime < londonOpenEnd
  );

  if (londonCandles.length > 0 && currentTime >= londonOpenEnd) {
    const londonHigh = Math.max(...londonCandles.map(c => c.high));
    const londonLow  = Math.min(...londonCandles.map(c => c.low));
    const londonHighCandle = londonCandles.find(c => c.high === londonHigh);
    const londonLowCandle  = londonCandles.find(c => c.low  === londonLow);

    pools.push({
      id:        `session_loh_${todayStart}`,
      type:      'EQUAL_HIGHS',
      level:     londonHigh,
      formed_at: candles.findIndex(c => c.openTime === londonHighCandle?.openTime),
      formed_time: londonHighCandle?.openTime,
      source:    'LONDON_OPEN_HIGH',
    });

    pools.push({
      id:        `session_lol_${todayStart}`,
      type:      'EQUAL_LOWS',
      level:     londonLow,
      formed_at: candles.findIndex(c => c.openTime === londonLowCandle?.openTime),
      formed_time: londonLowCandle?.openTime,
      source:    'LONDON_OPEN_LOW',
    });
  }

  return pools.filter(p => p.formed_at >= 0);
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GATE VP — VOLUME PROFILE STRUCTURAL CONFIRMATION (Phase D9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Volume Profile Gate — structural confirmation that a sweep happens at a
 * meaningful location.
 *
 * Bullish LSO: sweep low must be BELOW the POC (Point of Control / fair value),
 * and the sweep candle close must reclaim back ABOVE the Value Area Low (VAL).
 * This targets the 'Deep Discount' within the value area — a sweep below fair
 * value that reclaims above the lower boundary of the 70% volume zone.
 *
 * @param {object} candle          - sweep candle { high, low, close }
 * @param {number} sweepLow        - sweep candle low price
 * @param {number} sweepClose      - sweep candle close price
 * @param {object[]} volumeProfiles - rolling volume profiles per candle
 * @param {number} i               - candle index
 * @returns {{ pass: boolean, reason?: string }}
 */
function checkVolumeProfileGate(candle, sweepLow, sweepClose, volumeProfiles, i) {
  if (!volumeProfiles || i >= volumeProfiles.length) {
    return { pass: true, reason: 'vp_no_data' };  // soft-gate: pass if no data
  }

  const profile = volumeProfiles[i];
  if (!profile || !profile.buckets || profile.buckets.length === 0) {
    return { pass: true, reason: 'vp_empty_profile' };
  }

  // Compute Value Area from the volume profile
  const { computeValueArea } = require('../indicators/volumeProfile');
  const { val, poc } = computeValueArea(profile);

  if (val <= 0 || poc <= 0) {
    return { pass: true, reason: 'vp_flat_market' };
  }

  // Structural Gravity: sweep below POC (fair value), reclaim above VAL
  const sweptBelowPOC = sweepLow < poc;
  const reclaimedAboveVAL = sweepClose > val;

  if (!sweptBelowPOC) {
    return { pass: false, reason: 'vp_not_below_poc' };
  }

  if (!reclaimedAboveVAL) {
    return { pass: false, reason: 'vp_no_reclaim_above_val' };
  }

  return { pass: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4H TREND CHECK — MACRO ALIGNMENT (Phase D9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the 4H market structure is BULLISH (higher highs / higher lows).
 * Uses swing detection on 15m candles within a 160-candle macro window (40 hours)
 * to determine meaningful directional bias.
 *
 * Lookback per side = 4 (1H each side, 2H swing pivot context).
 * Window = last 160 candles (40 hours of 15m data) for macro trend determination.
 *
 * Returns size multiplier:
 *   - 1.0 if Bullish (HH + HL) — full size for longs
 *   - 0.0 if Bearish (LH + LL) — BLOCK the long trade entirely
 *   - 0.5 if Neutral/Unknown — reduced size (soft-block, trend unclear)
 *
 * @param {object[]} candles - 15m candles
 * @param {number}   i       - current candle index
 * @returns {{ multiplier: number, state: string, reason?: string }}
 */
function check4HTrendBullish(candles, i) {
  const swingLookback = 4;   // 4 × 15m = 1H each side, 2H swing context
  const macroWindow   = 160; // 160 × 15m = 40H macro lookback
  const startIdx      = Math.max(swingLookback, i - macroWindow);

  if (i < swingLookback * 3) {
    return { multiplier: 1.0, state: 'UNKNOWN', reason: 'insufficient_data' };
  }

  // Find swing highs and lows within the macro window
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

  // Need at least 2 swing highs and 2 swing lows to determine trend
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { multiplier: 0.5, state: 'UNKNOWN', reason: 'insufficient_swings' };
  }

  const last2HH = swingHighs.slice(-2);
  const last2LL = swingLows.slice(-2);

  const higherHighs = last2HH[1].price > last2HH[0].price;
  const higherLows  = last2LL[1].price > last2LL[0].price;
  const lowerHighs  = last2HH[1].price < last2HH[0].price;
  const lowerLows   = last2LL[1].price < last2LL[0].price;

  // Bullish: higher highs AND higher lows → 1.0x (full size)
  if (higherHighs && higherLows) {
    return { multiplier: 1.0, state: 'BULLISH', reason: '4h_hh_hl' };
  }

  // Bearish: lower highs AND lower lows → 0.0x (BLOCK trade)
  if (lowerHighs && lowerLows) {
    return { multiplier: 0.0, state: 'BEARISH', reason: '4h_lh_ll' };
  }

  // Mixed/neutral → 0.5x (reduced size)
  return { multiplier: 0.5, state: 'NEUTRAL', reason: '4h_mixed' };
}

module.exports = {
  // Equal highs/lows detection
  findEqualLows,
  findEqualHighs,
  findSessionPools,

  // Sweep detection
  isBullishSweep,
  isBearishSweep,

  // OI flush
  getInterpolatedOI,
  checkOIFlush,
  checkOIVelocityGate,

  // Synthetic liquidation gate (Gemini D8 Round 3)
  checkCVDVelocityGate,

  // Signal generation
  buildBullishLSOSignal,
  buildBearishLSOSignal,

  // D7 deferred items
  checkOBConfluence,
  checkLSOTimeBreakeven,

  // Phase D9: Volume Profile + 4H Trend gates
  checkVolumeProfileGate,
  check4HTrendBullish,

  // Phase D13: Ranging refinements
  checkLSORangingTimeExhaustion,

  // Session helper (exported for tests)
  isAsianSession,
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE D13 — TIME-EXHAUSTION GATE FOR RANGING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Close trades that haven't hit a target within 16 candles (4 hours) in RANGING.
 * In ranging markets, if price hasn't broken out within 4 hours, the range
 * rotation is likely complete and the trade should be closed at market.
 *
 * Designed to work with the timeBreakeven mechanism in tradeManager.js.
 *
 * @param {object} trade       - open trade object
 * @param {number} candlesHeld - how many candles the trade has been open
 * @param {number} currentClose - current candle close price
 * @returns {{ exit: boolean, reason?: string } | null}
 */
function checkLSORangingTimeExhaustion(trade, candlesHeld, currentClose) {
  const MAX_RANGING_CANDLES = 16; // 16 × 15m = 4 hours
  const regime = trade.regime || 'RANGING';

  if ((regime === 'RANGING' || regime === 'RANGING_ZOMBIE') && candlesHeld >= MAX_RANGING_CANDLES) {
    return { exit: true, reason: 'time_exhaustion_ranging' };
  }

  return null;
}
