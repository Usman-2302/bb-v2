'use strict';

/**
 * BulletBrain v3.0 — Regime Detector
 * Phase D3 — Step 0.5
 *
 * Classifies market regime for each 4H BTC candle.
 * All strategies route through the regime engine before signal evaluation.
 *
 * Regime priority order:
 *   CRISIS > BULL > BEAR > RANGING_ZOMBIE > RANGING_PREZONE > RANGING
 *
 * Source: backtestplan.md lines 409-598 (Steps 0.5, 0.7)
 */

const { ema, emaSlopeDegrees, emaAtrSlope } = require('../indicators/ema');
const { atr, atrPct }                    = require('../indicators/atr');
const { efficiencyRatio, rollingEfficiencyRatio } = require('../indicators/efficiencyRatio');
const { REGIME }                         = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// CORE REGIME DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect regime for a single 4H candle index.
 * Uses ATR-normalized EMA slope — self-calibrating across volatility regimes.
 *
 * Classifier: slope only, threshold 0.011 (empirically derived).
 * One feature, one safety valve (price override in tagRegimes4H), one anti-flap wrapper.
 * Monthly accuracy: 64.6% on historical averages. Higher within regimes, lower at transitions.
 * Known limitation: 3-4 week lag on sharp reversals (EMA200 property, not fixable).
 *
 * @param {object[]} candles4H    - full array of 4H BTC candles
 * @param {number}   index        - current candle index
 * @param {number[]} ema200       - pre-computed EMA200 array (pass in for performance)
 * @param {number[]} atr14        - pre-computed ATR14 array (pass in for performance)
 * @param {number}   slopeThresh  - ATR-normalized slope threshold (default from config)
 * @returns {string} regime: 'BULL' | 'BEAR' | 'RANGING' | 'CRISIS'
 */
function detectRegimeRaw(candles4H, index, ema200, atr14, slopeThresh = REGIME.slopeThreshold) {
  if (index < REGIME.slopeLookback) return 'RANGING';

  const atrPcts = atrPct(candles4H.slice(0, index + 1), 14);

  // CRISIS overrides everything
  if (atrPcts[atrPcts.length - 1] > REGIME.crisisATRpct) return 'CRISIS';

  // ATR-normalized slope (primary classifier)
  const slope = emaAtrSlope(ema200, atr14, index, REGIME.slopeLookback);

  if (slope >  slopeThresh) return 'BULL';
  if (slope < -slopeThresh) return 'BEAR';
  return 'RANGING';
}

/**
 * Apply anti-flapping rule: regime only switches after N consecutive
 * 4H closes confirming the new regime.
 *
 * @param {string[]} rawRegimes  - raw regime per candle
 * @param {number}   minCandles  - consecutive candles required to switch (default 2)
 * @returns {string[]} smoothed regimes
 */
function applyAntiFlapping(rawRegimes, minCandles = REGIME.antiFlappingCandles) {
  if (rawRegimes.length === 0) return [];

  const result    = new Array(rawRegimes.length);
  result[0]       = rawRegimes[0];
  let currentRegime = rawRegimes[0];
  let pendingRegime = null;
  let pendingCount  = 0;

  for (let i = 1; i < rawRegimes.length; i++) {
    const raw = rawRegimes[i];

    // CRISIS always overrides immediately (no anti-flapping for crashes)
    if (raw === 'CRISIS') {
      currentRegime = 'CRISIS';
      pendingRegime = null;
      pendingCount  = 0;
      result[i]     = 'CRISIS';
      continue;
    }

    if (raw === currentRegime) {
      // Staying in same regime — reset pending
      pendingRegime = null;
      pendingCount  = 0;
      result[i]     = currentRegime;
    } else if (raw === pendingRegime) {
      // Consecutive confirmation of new regime
      pendingCount++;
      if (pendingCount >= minCandles) {
        currentRegime = pendingRegime;
        pendingRegime = null;
        pendingCount  = 0;
      }
      result[i] = currentRegime;
    } else {
      // New candidate regime — start counting
      pendingRegime = raw;
      pendingCount  = 1;
      result[i]     = currentRegime; // stay in current until confirmed
    }
  }

  return result;
}

/**
 * Detect zombie sub-state within RANGING.
 * RANGING_ZOMBIE: ER < threshold → FVG/OB/VPB disabled.
 *
 * @param {object[]} candles4H
 * @param {number}   index
 * @returns {boolean}
 */
function isZombie(candles4H, index) {
  if (index < REGIME.erPeriod) return false;
  const er = efficiencyRatio(candles4H.slice(0, index + 1), REGIME.erPeriod);
  return er < REGIME.zombieERthreshold;
}

/**
 * Detect pre-zone sub-state within RANGING.
 * RANGING_PREZONE: ATR declining + near zombie threshold + ER declining.
 * → 50% size reduction, 2.5:1 R:R minimum.
 *
 * @param {object[]} candles4H
 * @param {number}   index
 * @param {number}   rangingATRavg - average ATR% during RANGING periods
 * @returns {boolean}
 */
function isPreZone(candles4H, index, rangingATRavg) {
  if (index < 15 || rangingATRavg <= 0) return false;

  const atrPcts = atrPct(candles4H, 14);

  // Condition 1: ATR declining for 3 consecutive checks
  const declining = (
    atrPcts[index]     < atrPcts[index - 1] &&
    atrPcts[index - 1] < atrPcts[index - 2] &&
    atrPcts[index - 2] < atrPcts[index - 3]
  );
  if (!declining) return false;

  // Condition 2: ATR below 70% of RANGING average
  if (atrPcts[index] >= REGIME.prezoneATRmultiple * rangingATRavg) return false;

  // Condition 3: ER declining and below 0.45
  const erCurrent = efficiencyRatio(candles4H.slice(0, index + 1), REGIME.erPeriod);
  const erPrior   = efficiencyRatio(candles4H.slice(0, index - 4), REGIME.erPeriod);
  return erCurrent < erPrior && erCurrent < REGIME.prezoneERthreshold;
}

/**
 * Full regime classification for a single candle index.
 * Applies zombie/prezone sub-states on top of base regime.
 *
 * @param {object[]} candles4H
 * @param {number}   index
 * @param {string}   baseRegime     - already anti-flapped base regime
 * @param {number}   rangingATRavg  - average ATR% during RANGING (computed externally)
 * @returns {string} final regime including sub-states
 */
function classifyRegime(candles4H, index, baseRegime, rangingATRavg = 0) {
  if (baseRegime !== 'RANGING') return baseRegime;

  // Check zombie first (stricter)
  if (isZombie(candles4H, index)) return 'RANGING_ZOMBIE';

  // Check pre-zone (softer)
  if (rangingATRavg > 0 && isPreZone(candles4H, index, rangingATRavg)) return 'RANGING_PREZONE';

  return 'RANGING';
}

// ─────────────────────────────────────────────────────────────────────────────
// VOL-SWITCH (IMMEDIATE CRISIS OVERRIDE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vol-switch: immediate CRISIS override on 15m candles.
 * Bypasses the 4H anti-flapping rule for flash crashes.
 *
 * @param {object[]} candles15m      - 15m candle array
 * @param {number}   index           - current 15m candle index
 * @param {number}   atr4HBaseline   - 30-day average of 4H ATR% (pre-calculated)
 * @returns {string|null} 'CRISIS' if triggered, null otherwise
 */
function checkVolSwitch(candles15m, index, atr4HBaseline) {
  if (index < 14 || atr4HBaseline <= 0) return null;

  const atrPcts15m = atrPct(candles15m.slice(0, index + 1), 14);
  const current    = atrPcts15m[atrPcts15m.length - 1];

  if (current > REGIME.volSwitchMultiple * atr4HBaseline) {
    return 'CRISIS';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL REGIME TAGGING PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tag all 4H BTC candles with regime.
 * Returns array of regime strings, one per candle.
 * Pre-computes indicators once for O(n) performance.
 *
 * Classifier: ATR-normalized slope (threshold 0.011), anti-flapping, zombie/prezone sub-states.
 *
 * @param {object[]} candles4H    - full 4H BTC candle array
 * @param {number}   slopeThresh  - ATR-normalized slope threshold
 * @returns {string[]} regime per candle
 */
function tagRegimes4H(candles4H, slopeThresh = REGIME.slopeThreshold) {
  const n = candles4H.length;

  // Pre-compute indicators once
  const closes   = candles4H.map(c => c.close);
  const ema200   = ema(closes, 200);
  const atr14    = atr(candles4H, 14);
  const atrPcts  = atrPct(candles4H, 14);
  const erValues = rollingEfficiencyRatio(candles4H, REGIME.erPeriod);

  // Step 1: raw regime per candle (O(n))
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i < REGIME.slopeLookback) { raw[i] = 'RANGING'; continue; }

    // CRISIS check
    if (atrPcts[i] > REGIME.crisisATRpct) { raw[i] = 'CRISIS'; continue; }

    // ATR-normalized slope (primary classifier)
    const slope = emaAtrSlope(ema200, atr14, i, REGIME.slopeLookback);

    if (slope >  slopeThresh) { raw[i] = 'BULL'; continue; }
    if (slope < -slopeThresh) { raw[i] = 'BEAR'; continue; }
    raw[i] = 'RANGING';
  }

  // Step 2: apply anti-flapping
  const smoothed = applyAntiFlapping(raw);

  // Step 3: compute average ATR% during RANGING periods
  let rangingATRsum = 0;
  let rangingATRcount = 0;
  for (let i = 0; i < n; i++) {
    if (smoothed[i] === 'RANGING') {
      rangingATRsum += atrPcts[i];
      rangingATRcount++;
    }
  }
  const rangingATRavg = rangingATRcount > 0 ? rangingATRsum / rangingATRcount : 0;

  // Step 4: apply zombie/prezone sub-states (O(n) using pre-computed ER and ATR)
  // HYSTERESIS: zombie must persist for N candles before activating, and
  // must clear for N candles before deactivating. Prevents state flickering
  // when ER hovers near the threshold.
  const ZOMBIE_COOLDOWN = 3; // 3 × 4H = 12 hours minimum hold
  const result = new Array(n);
  let zombieConsecutive = 0;
  let clearConsecutive  = 0;
  let zombieActive      = false;

  for (let i = 0; i < n; i++) {
    if (smoothed[i] !== 'RANGING') {
      result[i] = smoothed[i];
      zombieConsecutive = 0;
      clearConsecutive  = 0;
      zombieActive      = false;
      continue;
    }

    // Check zombie condition using pre-computed ER
    const isZombieCandle = erValues[i] < REGIME.zombieERthreshold;

    if (isZombieCandle) {
      zombieConsecutive++;
      clearConsecutive = 0;
      // Activate zombie only after N consecutive zombie candles
      if (zombieConsecutive >= ZOMBIE_COOLDOWN) zombieActive = true;
    } else {
      clearConsecutive++;
      zombieConsecutive = 0;
      // Deactivate zombie only after N consecutive clear candles
      if (clearConsecutive >= ZOMBIE_COOLDOWN) zombieActive = false;
    }

    if (zombieActive) {
      result[i] = 'RANGING_ZOMBIE';
      continue;
    }

    // Pre-zone check using pre-computed ATR (no hysteresis needed — size reduction only)
    if (rangingATRavg > 0 && i >= 3) {
      const declining = (
        atrPcts[i]     < atrPcts[i - 1] &&
        atrPcts[i - 1] < atrPcts[i - 2] &&
        atrPcts[i - 2] < atrPcts[i - 3]
      );
      const nearThreshold = atrPcts[i] < REGIME.prezoneATRmultiple * rangingATRavg;
      const erPrior = i >= 15 ? erValues[i - 5] : 0;
      const erDeclining = erValues[i] < erPrior && erValues[i] < REGIME.prezoneERthreshold;

      if (declining && nearThreshold && erDeclining) {
        result[i] = 'RANGING_PREZONE';
        continue;
      }
    }

    result[i] = 'RANGING';
  }

  return result;
}

/**
 * Propagate 4H regime tags to lower timeframe candles.
 * Each lower-TF candle gets the regime of the 4H candle it belongs to.
 *
 * @param {object[]} candlesLow   - lower timeframe candles (15m or 1H)
 * @param {object[]} candles4H    - 4H candles with .regime field already set
 * @returns {string[]} regime per lower-TF candle
 */
function propagateRegime(candlesLow, candles4H) {
  const regimes = new Array(candlesLow.length).fill('RANGING');

  // Build a sorted array of 4H candle open times for binary search
  const times4H = candles4H.map(c => c.openTime);

  for (let i = 0; i < candlesLow.length; i++) {
    const ts = candlesLow[i].openTime;

    // Find the 4H candle that contains this lower-TF candle
    // (last 4H candle whose openTime <= ts)
    let lo = 0;
    let hi = times4H.length - 1;
    let idx4H = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times4H[mid] <= ts) {
        idx4H = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    regimes[i] = candles4H[idx4H].regime || 'RANGING';
  }

  return regimes;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOPE THRESHOLD CALIBRATION (Step 0.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run slope threshold calibration.
 * Tests ATR-normalized slope thresholds and returns metrics for each.
 *
 * @param {object[]} candles4H - full 4H BTC candle array
 * @returns {object[]} calibration results per threshold
 */
function calibrateSlopeThreshold(candles4H) {
  const thresholds = [0.005, 0.008, 0.011, 0.015, 0.020, 0.025, 0.030];
  const results    = [];

  // Pre-compute once
  const closes = candles4H.map(c => c.close);
  const ema200 = ema(closes, 200);
  const atr14  = atr(candles4H, 14);
  const atrPcts = atrPct(candles4H, 14);

  for (const thresh of thresholds) {
    const regimes = new Array(candles4H.length);
    for (let i = 0; i < candles4H.length; i++) {
      if (i < REGIME.slopeLookback) { regimes[i] = 'RANGING'; continue; }
      if (atrPcts[i] > REGIME.crisisATRpct) { regimes[i] = 'CRISIS'; continue; }
      const slope = emaAtrSlope(ema200, atr14, i, REGIME.slopeLookback);
      if (slope >  thresh) { regimes[i] = 'BULL'; continue; }
      if (slope < -thresh) { regimes[i] = 'BEAR'; continue; }
      regimes[i] = 'RANGING';
    }

    const smoothed = applyAntiFlapping(regimes);
    const counts = { BULL: 0, BEAR: 0, RANGING: 0, CRISIS: 0 };
    smoothed.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    const total = smoothed.length;

    // Price-direction proxy WR
    let bullWins = 0, bullTotal = 0;
    let rangingWins = 0, rangingTotal = 0;
    for (let i = 0; i < smoothed.length - 1; i++) {
      const nextUp = candles4H[i + 1].close > candles4H[i].close;
      if (smoothed[i] === 'BULL')    { bullTotal++;    if (nextUp) bullWins++; }
      if (smoothed[i] === 'RANGING') { rangingTotal++; if (nextUp) rangingWins++; }
    }

    const bullWR    = bullTotal    > 0 ? bullWins    / bullTotal    : 0;
    const rangingWR = rangingTotal > 0 ? rangingWins / rangingTotal : 0;

    results.push({
      threshold:     thresh,
      bull_pct:      ((counts.BULL    || 0) / total * 100).toFixed(1),
      bear_pct:      ((counts.BEAR    || 0) / total * 100).toFixed(1),
      ranging_pct:   ((counts.RANGING || 0) / total * 100).toFixed(1),
      crisis_pct:    ((counts.CRISIS  || 0) / total * 100).toFixed(1),
      bull_wr:       (bullWR    * 100).toFixed(1),
      ranging_wr:    (rangingWR * 100).toFixed(1),
      wr_delta:      ((bullWR - rangingWR) * 100).toFixed(2),
      bull_count:    counts.BULL    || 0,
      bear_count:    counts.BEAR    || 0,
      ranging_count: counts.RANGING || 0,
    });
  }

  return results;
}

module.exports = {
  detectRegimeRaw,
  applyAntiFlapping,
  isZombie,
  isPreZone,
  classifyRegime,
  checkVolSwitch,
  tagRegimes4H,
  propagateRegime,
  calibrateSlopeThreshold,
};
