'use strict';

/**
 * BulletBrain v3.0 — Conviction Score Engine
 * Phase: feat/conviction-correlation
 *
 * Replaces the fragile multiplier chain (OB confluence × 4H trend × CVD tier)
 * with a single normalized 0-1 score. Each gate contributes a weighted sub-score.
 *
 * Weights are derived from Phase D9 sensitivity matrix data:
 *   - Z=1.8/RVOL=2.5 produced PF 2.44 (highest non-spike PF in the grid)
 *   - CVD z-score was the dominant quality discriminator (PF range: 0.57 to 2.88)
 *   - Volume Profile structural confirmation added +2.6pp WR improvement
 *   - 4H trend alignment filtered 23% of bad trades
 *
 * Score → Size mapping is conservative by design:
 *   - Below 0.35: skip trade entirely (below minimum quality)
 *   - 0.35-0.50: 0.5× base risk (weak confluence — fragment of normal size)
 *   - 0.50-0.65: 0.8× base risk (standard quality)
 *   - 0.65-0.80: 1.0× base risk (high confluence — full size)
 *   - Above 0.80: 1.2× base risk (ultra confluence — rare, ~5% of trades)
 *
 * Hard cap: Never exceeds SIZING.absoluteMaxRisk (2.0%)
 */

const { SIZING } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCORE COMPUTATION (0-1 normalized)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CVD Z-score quality.
 * z ≥ 2.5 → 1.00 (institutional-quality sweep)
 * z ≥ 2.0 → 0.80
 * z ≥ 1.5 → 0.55
 * z ≥ 1.0 → 0.30
 * z < 1.0 → 0.00
 */
function scoreCVDZScore(zscore) {
  if (zscore == null || isNaN(zscore)) return 0;
  if (zscore >= 2.5) return 1.0;
  if (zscore >= 2.0) return 0.80;
  if (zscore >= 1.5) return 0.55;
  if (zscore >= 1.0) return 0.30;
  return 0.0;
}

/**
 * Volume Profile structural confirmation.
 * 1.0 if sweep below POC AND reclaim above VAL (deep discount absorption)
 * 0.0 otherwise — structural level not confirmed
 */
function scoreVolumeProfile(vpResult) {
  if (!vpResult) return 0;
  return vpResult.pass ? 1.0 : 0.0;
}

/**
 * 4H Trend alignment.
 * 1.0 Bullish (HH + HL) — full alignment
 * 0.5 Neutral / Mixed — unclear direction
 * 0.0 Bearish (LH + LL) — counter-trend for longs (BLOCKED by validateSignal)
 */
function score4HTrend(state) {
  if (state === 'BULLISH') return 1.0;
  if (state === 'NEUTRAL' || state === 'UNKNOWN') return 0.5;
  return 0.0;
}

/**
 * OB Confluence bonus.
 * 1.0 if sweep candle is inside an active bullish OB zone
 * 0.0 otherwise
 */
function scoreOBConfluence(insideOB) {
  return insideOB ? 1.0 : 0.0;
}

/**
 * Killzone timing quality.
 * 0.8 inside London/NY open (higher liquidity → better fills)
 * 0.4 outside killzone (adequate but not optimal)
 */
function scoreKillzone(inKillzone) {
  return inKillzone ? 0.8 : 0.4;
}

/**
 * RVOL quality — normalized to 0-1 range.
 * RVOL ≥ 3.0 → 1.00 (exceptional volume)
 * RVOL ≥ 2.0 → 0.70
 * RVOL ≥ 1.5 → 0.50
 * RVOL ≥ 1.0 → 0.30
 * RVOL < 1.0 → 0.00
 */
function scoreRVOL(rvol) {
  if (rvol == null || isNaN(rvol)) return 0;
  if (rvol >= 3.0) return 1.0;
  if (rvol >= 2.0) return 0.70;
  if (rvol >= 1.5) return 0.50;
  if (rvol >= 1.0) return 0.30;
  return 0.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHTED AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weights calibrated from Phase D9 CVD sensitivity matrix:
 *
 *   CVD z-score:    0.30  ← dominant quality discriminator (PF range 0.57→2.88)
 *   Volume Profile: 0.25  ← structural confirmation (+2.6pp WR in D9)
 *   4H Trend:       0.20  ← macro alignment (filters 23% of bad trades)
 *   OB Confluence:  0.10  ← confluence bonus (modest, 72% of LSO trades)
 *   Killzone:       0.05  ← timing factor (minor WR impact in D6)
 *   RVOL Quality:   0.10  ← volume confirmation
 *
 * Total: 1.00
 */
const WEIGHTS = {
  cvd_zscore:     0.30,
  volume_profile: 0.25,
  trend_4h:       0.20,
  ob_confluence:  0.10,
  killzone:       0.05,
  rvol_quality:   0.10,
};

/**
 * Compute the unified Conviction Score from individual gate results.
 *
 * @param {object} inputs
 * @param {number} inputs.zscore       - CVD velocity z-score from gate7
 * @param {object} inputs.vpResult     - { pass: boolean } from Volume Profile gate
 * @param {string} inputs.trend4hState - 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN'
 * @param {boolean} inputs.insideOB    - sweep candle inside active OB zone
 * @param {boolean} inputs.inKillzone  - candle is in London/NY killzone
 * @param {number} inputs.rvol         - time-normalized RVOL value
 * @returns {object} { score: 0-1, breakdown: { component: score }, sizeMult: 0-1.2 }
 */
function computeConvictionScore(inputs) {
  const {
    zscore = 0,
    vpResult = null,
    trend4hState = 'UNKNOWN',
    insideOB = false,
    inKillzone = false,
    rvol = 1.0,
  } = inputs;

  const subscores = {
    cvd_zscore:     scoreCVDZScore(zscore),
    volume_profile: scoreVolumeProfile(vpResult),
    trend_4h:       score4HTrend(trend4hState),
    ob_confluence:  scoreOBConfluence(insideOB),
    killzone:       scoreKillzone(inKillzone),
    rvol_quality:   scoreRVOL(rvol),
  };

  // Weighted sum
  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    score += (subscores[key] || 0) * weight;
  }

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // Map score → size multiplier
  let sizeMult;
  if (score < 0.35) {
    sizeMult = 0;        // skip trade
  } else if (score < 0.50) {
    sizeMult = 0.50;     // weak confluence
  } else if (score < 0.65) {
    sizeMult = 0.80;     // standard quality
  } else if (score < 0.80) {
    sizeMult = 1.00;     // high confluence
  } else {
    sizeMult = 1.20;     // ultra confluence (rare)
  }

  return {
    score,
    breakdown: subscores,
    sizeMult,
    verdict: score < 0.35 ? 'SKIP' : sizeMult >= 1.0 ? 'STRONG' : 'STANDARD',
  };
}

/**
 * Compute conviction score from live shadow runner context.
 * Extracts the necessary inputs from the gate results and candle context.
 *
 * @param {object} ctx — accumulated context during signal processing
 * @param {object} ctx.extra  — contains _cvdZscore, _4hMultiplier, _vpResult, etc.
 * @param {number} rvol       — RVOL at current candle
 * @param {boolean} inKillzone
 * @returns {object} conviction score result
 */
function computeFromContext(ctx, rvol, inKillzone) {
  const extra = ctx.extra || {};

  return computeConvictionScore({
    zscore:        extra._cvdZscore || 0,
    vpResult:      extra._vpResult || null,
    trend4hState:  extra._trend4hState || 'UNKNOWN',
    insideOB:      extra._insideOB || false,
    inKillzone,
    rvol,
  });
}

module.exports = {
  computeConvictionScore,
  computeFromContext,
  scoreCVDZScore,
  scoreVolumeProfile,
  score4HTrend,
  scoreOBConfluence,
  scoreKillzone,
  scoreRVOL,
  WEIGHTS,
};
