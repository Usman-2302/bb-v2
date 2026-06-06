'use strict';

/**
 * BulletBrain v3.0 — Signal-Strength Risk Engine
 * Phase: feat/conviction-correlation — SMART account
 *
 * Scores every trade on 3 pillars (0-2 points each, max 6):
 *   1. RVOL Quality — sweep volume vs time-normalized baseline
 *   2. Pool Depth — liquidity pool size vs historical median
 *   3. Regime Alignment — trade direction vs market trend
 *
 * Score → Risk Multiplier mapping:
 *   0-1 pts → SKIP (below minimum quality threshold)
 *   2 pts   → 0.5x risk (minimal — weak signal)
 *   3 pts   → 0.75x risk (low — below average)
 *   4 pts   → 1.0x risk (standard)
 *   5 pts   → 1.5x risk (high conviction)
 *   6 pts   → 2.0x risk (ultra conviction — capped by absoluteMaxRisk)
 *
 * ALL parameters in config.js. Zero hardcoded values.
 */

const { SIZING } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// SCORING FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score RVOL quality (0-2 points).
 * Genuine institutional sweeps have above-average volume.
 * Weak volume sweeps are noise or low-liquidity traps.
 *
 * @param {number} rvol - time-normalized RVOL at sweep candle
 * @param {object} cfg  - LEVERAGE config block
 * @returns {number} 0, 1, or 2
 */
function scoreRVOL(rvol, cfg) {
  if (rvol >= cfg.rvolHigh) return 2;
  if (rvol >= cfg.rvolMid) return 1;
  return 0;
}

/**
 * Score pool depth (0-2 points).
 * Deep liquidity pools (high volume between swing points) attract
 * stronger reversals. Shallow pools are less reliable magnets.
 *
 * @param {number} poolVolume - sum of candle volumes between swing lows
 * @param {number} medianVol   - median pool volume across all detected pools
 * @param {object} cfg         - LEVERAGE config block
 * @returns {number} 0, 1, or 2
 */
function scorePoolDepth(poolVolume, medianVol, cfg) {
  if (medianVol <= 0) return 1; // no baseline — neutral
  const ratio = poolVolume / medianVol;
  if (ratio >= cfg.poolDeep) return 2;
  if (ratio >= cfg.poolStandard) return 1;
  return 0;
}

/**
 * Score regime alignment (0-2 points).
 * Trades aligned with the macro trend have higher probability.
 * Counter-trend trades are higher risk.
 *
 * @param {string} regime   - current market regime
 * @param {string} side     - 'LONG' or 'SHORT'
 * @param {object} cfg      - LEVERAGE config block
 * @returns {number} 0, 1, or 2
 */
function scoreRegimeAlignment(regime, side, cfg) {
  // Long in BULL → perfect alignment
  if (side === 'LONG' && regime === 'BULL') return 2;
  // Short in BEAR → perfect alignment (future)
  if (side === 'SHORT' && regime === 'BEAR') return 2;
  // Long in RANGING or Short in RANGING → mean-reversion, acceptable
  if (regime === 'RANGING' || regime === 'RANGING_ZOMBIE') return 1;
  // Long in BEAR or Short in BULL → counter-trend, misaligned
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPOSITE SCORE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score → Risk Multiplier lookup (from config).
 * Default: { 0: 'SKIP', 1: 'SKIP', 2: 0.5, 3: 0.75, 4: 1.0, 5: 1.5, 6: 2.0 }
 */
function getRiskMultiplier(score, cfg) {
  // Score 0-1: skip entirely
  if (score < cfg.minTradeScore) return { multiplier: 0, verdict: 'SKIP', reason: `score_${score}_below_minimum_${cfg.minTradeScore}` };
  
  const map = cfg.scoreMap || { 2: 0.5, 3: 0.75, 4: 1.0, 5: 1.5, 6: 2.0 };
  const mult = map[score];
  
  if (mult === undefined) {
    // Fallback: interpolate
    if (score <= 2) return { multiplier: 0.5, verdict: 'LOW', reason: 'score_low_default' };
    if (score <= 3) return { multiplier: 0.75, verdict: 'LOW', reason: 'score_low_default' };
    if (score <= 4) return { multiplier: 1.0, verdict: 'STANDARD', reason: 'score_mid_default' };
    if (score <= 5) return { multiplier: 1.5, verdict: 'HIGH', reason: 'score_high_default' };
    return { multiplier: 2.0, verdict: 'ULTRA', reason: 'score_max_default' };
  }
  
  let verdict = 'STANDARD';
  if (mult >= 2.0) verdict = 'ULTRA';
  else if (mult >= 1.5) verdict = 'HIGH';
  else if (mult <= 0.5) verdict = 'LOW';
  
  return { multiplier: mult, verdict, reason: `score_${score}` };
}

/**
 * Compute the signal-strength score for a trade.
 *
 * @param {object} inputs
 * @param {number} inputs.rvol        - RVOL at sweep candle
 * @param {number} inputs.poolVolume  - pool volume (sum of candle volumes)
 * @param {number} inputs.medianPoolVol - median pool volume across dataset
 * @param {string} inputs.regime      - current market regime
 * @param {string} inputs.side         - 'LONG' or 'SHORT'
 * @param {object} cfg                - LEVERAGE config block from config.js
 * @returns {object} { score (0-6), breakdown: {rvol, pool, regime}, riskMultiplier, verdict }
 */
function computeSignalScore(inputs, cfg) {
  const { rvol = 1.0, poolVolume = 0, medianPoolVol = 0, regime = 'RANGING', side = 'LONG' } = inputs;

  const rvolScore = scoreRVOL(rvol, cfg);
  const poolScore = scorePoolDepth(poolVolume, medianPoolVol, cfg);
  const regimeScore = scoreRegimeAlignment(regime, side, cfg);

  const totalScore = rvolScore + poolScore + regimeScore;
  const riskResult = getRiskMultiplier(totalScore, cfg);

  return {
    score: totalScore,
    breakdown: {
      rvol: rvolScore,
      pool: poolScore,
      regime: regimeScore,
    },
    riskMultiplier: riskResult.multiplier,
    verdict: riskResult.verdict,
    reason: riskResult.reason,
  };
}

module.exports = {
  computeSignalScore,
  scoreRVOL,
  scorePoolDepth,
  scoreRegimeAlignment,
  getRiskMultiplier,
};
