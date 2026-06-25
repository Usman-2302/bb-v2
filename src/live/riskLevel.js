'use strict';
/**
 * BulletBrain v3.0 — Dynamic Risk Level Engine
 * 
 * Outputs a risk level 1-4 based on three factors:
 *   1. Signal Quality (from signalScorer) — how good is this specific trade?
 *   2. Coin Health — how is this coin performing recently?
 *   3. Volume Health — is there enough market volume?
 * 
 * Risk Level → Position Size:
 *   1 → 1% of capital (weak signal or poor coin health)
 *   2 → 2% (standard — baseline)
 *   3 → 3% (strong signal + good health)
 *   4 → 4% (ultra signal + excellent health — rare)
 */

const { LEVERAGE } = require('../../config');

/**
 * Compute risk level for a trade.
 * 
 * @param {object} inputs
 * @param {object} inputs.signalScore  - result from computeSignalScore (score 0-6, breakdown)
 * @param {object} inputs.coinHealth   - { pf, wr, trades, ghostRate }
 * @param {number} inputs.volumeRatio  - current volume / 30-day average volume
 * @returns {object} { level: 1-4, label, factors: {signal, coin, volume} }
 */
function computeRiskLevel(inputs) {
  const { signalScore, coinHealth, volumeRatio } = inputs;
  
  // Factor 1: Signal Quality (0-1)
  // Maps signal score 0-6 → 0-1
  const sigScore = signalScore?.score || 0;
  let signalFactor;
  if (sigScore >= 6) signalFactor = 1.0;       // Ultra conviction
  else if (sigScore >= 5) signalFactor = 0.8;   // High conviction
  else if (sigScore >= 4) signalFactor = 0.6;   // Standard
  else if (sigScore >= 3) signalFactor = 0.4;   // Below average
  else signalFactor = 0.2;                       // Minimal
  
  // Factor 2: Coin Health (0-1)
  // Based on rolling 30-trade PF
  const pf = coinHealth?.pf || 0;
  const trades = coinHealth?.trades || 0;
  let coinFactor;
  if (trades < 5) coinFactor = 0.5;             // Not enough data — neutral
  else if (pf >= 2.0) coinFactor = 1.0;         // Excellent
  else if (pf >= 1.5) coinFactor = 0.8;         // Strong
  else if (pf >= 1.2) coinFactor = 0.6;         // Good
  else if (pf >= 1.0) coinFactor = 0.5;         // Breakeven
  else if (pf >= 0.8) coinFactor = 0.3;         // Weak
  else coinFactor = 0.1;                         // Losing — near minimum
  
  // Factor 3: Volume Health (0-1)
  // Current volume vs 30-day average
  const vol = volumeRatio || 0.5;
  let volumeFactor;
  if (vol >= 1.5) volumeFactor = 1.0;           // High volume — great
  else if (vol >= 1.0) volumeFactor = 0.7;      // Normal volume
  else if (vol >= 0.5) volumeFactor = 0.5;      // Low volume — cautious
  else volumeFactor = 0.3;                       // Dead volume — very cautious
  
  // Weighted combination
  // Signal quality is most important (50%), then coin health (30%), then volume (20%)
  const combined = (signalFactor * 0.50) + (coinFactor * 0.30) + (volumeFactor * 0.20);
  
  // Map to risk level 1-4
  let level, label;
  if (combined >= 0.75)      { level = 4; label = 'MAX'; }
  else if (combined >= 0.55) { level = 3; label = 'HIGH'; }
  else if (combined >= 0.35) { level = 2; label = 'STD'; }
  else                       { level = 1; label = 'LOW'; }
  
  // Safety: if signal score is 0-1 (SKIP from signalScorer), force level 0 (don't trade)
  if (signalScore?.verdict === 'SKIP') {
    return { level: 0, label: 'SKIP', riskPct: 0,
      factors: { signal: signalFactor, coin: coinFactor, volume: volumeFactor },
      combined };
  }
  
  const riskPctMap = { 1: 1, 2: 2, 3: 3, 4: 4 };
  
  return {
    level,
    label,
    riskPct: riskPctMap[level],
    factors: { signal: signalFactor, coin: coinFactor, volume: volumeFactor },
    combined,
  };
}

module.exports = { computeRiskLevel };
