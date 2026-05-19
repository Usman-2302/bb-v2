'use strict';

/**
 * BulletBrain v3.0 — Circuit Breaker (Logging-Only Phase)
 * Phase: feat/conviction-correlation
 *
 * Three-tier circuit breaker that LOGS ONLY — no trade intervention.
 * After 14 days of log data, the logs will be reviewed to decide which
 * tiers should be activated for automatic pause/size-reduction.
 *
 * DESIGN PRINCIPLE (from collaborator directive):
 *   "Set the thresholds WIDE. It should be a guardrail for catastrophes,
 *    not a manager of daily variance."
 *
 * Thresholds are deliberately loose:
 *   - Tier 1: fires on genuine cold streaks, not normal variance
 *   - Tier 2: fires on sustained underperformance
 *   - Tier 3: fires on capital-threatening events only
 *
 * All events are written to logs/circuit_breaker.log with:
 *   - Timestamp
 *   - Account name
 *   - Tier that would have triggered
 *   - The metrics that triggered it
 *   - What action WOULD have been taken
 */

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join('logs', 'circuit_breaker.log');

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLDS (wide — for catastrophe detection, not variance management)
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = {
  1: {
    name: 'SOFT_WARNING',
    rollingTrades: 10,
    minWR: 0.25,           // 25% WR over 10 trades → cold streak
    maxConsecutiveLoss: 4,
    wouldDo: 'Log deep-dive data. No sizing change.',
  },
  2: {
    name: 'SIZE_REDUCTION',
    rollingTrades: 20,
    minWR: 0.20,           // 20% WR over 20 trades → sustained underperformance
    maxConsecutiveLoss: 6,
    maxDailyLoss: 0.04,    // 4% daily loss
    wouldDo: 'Halve position sizes. Disable pyramiding. Require 5 winning trades to clear.',
  },
  3: {
    name: 'HARD_PAUSE',
    rollingTrades: 30,
    minPF: 0.70,           // PF < 0.7 over 30 trades → capital destruction
    maxDrawdown: 0.12,     // 12% drawdown → something is broken
    maxDailyLoss: 0.06,    // 6% daily loss
    wouldDo: 'Close all positions. Pause new entries. Telegram alert. Require manual review.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// METRIC COMPUTATION
// ─────────────────────────────────────────────────────────────────────────────

function countConsecutiveLosses(closedTrades) {
  let count = 0;
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    if ((closedTrades[i].realizedPnl || 0) < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function computeRollingWR(closedTrades, n) {
  const recent = closedTrades.slice(-n);
  if (recent.length < n) return null; // not enough trades
  const wins = recent.filter(t => (t.realizedPnl || 0) > 0).length;
  return wins / recent.length;
}

function computeRollingPF(closedTrades, n) {
  const recent = closedTrades.slice(-n);
  if (recent.length < n) return null;
  let grossWins = 0, grossLosses = 0;
  for (const t of recent) {
    if ((t.realizedPnl || 0) > 0) grossWins += t.realizedPnl;
    else grossLosses += Math.abs(t.realizedPnl || 0);
  }
  return grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// BREAKER CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check all circuit breaker tiers for an account.
 * Logs what WOULD have happened. Does NOT modify any state.
 *
 * @param {string} accountName  - 'SNIPER' or 'SCALPER'
 * @param {object} acct         - account state object
 * @param {number} candleCount  - total candles processed
 * @returns {object|null} the highest triggered tier, or null
 */
function checkCircuitBreaker(accountName, acct, candleCount) {
  const { closedTrades, equity } = acct;
  const consecutiveLosses = countConsecutiveLosses(closedTrades);
  const dailyLoss = equity.dailyPnl / (equity.capital || 1);
  const drawdown = equity.maxDrawdown;

  let highestTriggered = null;

  // Tier 1 check
  const wr10 = computeRollingWR(closedTrades, TIERS[1].rollingTrades);
  if (wr10 !== null && wr10 < TIERS[1].minWR) {
    highestTriggered = { tier: 1, reason: `WR_10=${(wr10*100).toFixed(0)}%_below_${(TIERS[1].minWR*100).toFixed(0)}%` };
  }
  if (consecutiveLosses >= TIERS[1].maxConsecutiveLoss) {
    highestTriggered = { tier: 1, reason: `${consecutiveLosses}_consecutive_losses` };
  }

  // Tier 2 check
  const wr20 = computeRollingWR(closedTrades, TIERS[2].rollingTrades);
  if (wr20 !== null && wr20 < TIERS[2].minWR) {
    highestTriggered = { tier: 2, reason: `WR_20=${(wr20*100).toFixed(0)}%_below_${(TIERS[2].minWR*100).toFixed(0)}%` };
  }
  if (consecutiveLosses >= TIERS[2].maxConsecutiveLoss) {
    highestTriggered = { tier: 2, reason: `${consecutiveLosses}_consecutive_losses` };
  }
  if (dailyLoss < -TIERS[2].maxDailyLoss) {
    highestTriggered = { tier: 2, reason: `daily_loss=${(dailyLoss*100).toFixed(1)}%` };
  }

  // Tier 3 check
  const pf30 = computeRollingPF(closedTrades, TIERS[3].rollingTrades);
  if (pf30 !== null && pf30 < TIERS[3].minPF) {
    highestTriggered = { tier: 3, reason: `PF_30=${pf30.toFixed(2)}_below_${TIERS[3].minPF}` };
  }
  if (drawdown > TIERS[3].maxDrawdown) {
    highestTriggered = { tier: 3, reason: `DD=${(drawdown*100).toFixed(1)}%_exceeds_${(TIERS[3].maxDrawdown*100).toFixed(0)}%` };
  }
  if (dailyLoss < -TIERS[3].maxDailyLoss) {
    highestTriggered = { tier: 3, reason: `daily_loss=${(dailyLoss*100).toFixed(1)}%` };
  }

  // Log if any tier triggered
  if (highestTriggered) {
    const tier = TIERS[highestTriggered.tier];
    const logEntry = [
      `[${new Date().toISOString()}]`,
      `${accountName.padEnd(8)}`,
      `TIER_${highestTriggered.tier}(${tier.name})`,
      `trigger:${highestTriggered.reason}`,
      `trades:${closedTrades.length}`,
      `consecLoss:${consecutiveLosses}`,
      `DD:${(drawdown*100).toFixed(2)}%`,
      `dailyPnL:${(dailyLoss*100).toFixed(2)}%`,
      `capital:$${equity.capital.toFixed(0)}`,
      `candles:${candleCount}`,
      `WOULD_DO: ${tier.wouldDo}`,
    ].join(' | ');

    // Ensure log directory exists
    const logDir = path.dirname(LOG_PATH);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    fs.appendFileSync(LOG_PATH, logEntry + '\n');

    // Also print to console so it's visible during live runs
    console.log(`[BREAKER] ${logEntry}`);
  }

  return highestTriggered;
}

/**
 * Generate a summary of circuit breaker activity from the log file.
 * Run this periodically (e.g., every 24 hours) to assess whether
 * thresholds are correctly calibrated.
 */
function summarizeLog() {
  if (!fs.existsSync(LOG_PATH)) return 'No circuit breaker events logged yet.';

  const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const byTier = { 1: 0, 2: 0, 3: 0 };
  const byAccount = { SNIPER: 0, SCALPER: 0 };

  for (const line of lines) {
    for (let t = 1; t <= 3; t++) {
      if (line.includes(`TIER_${t}`)) byTier[t]++;
    }
    if (line.includes('SNIPER')) byAccount.SNIPER++;
    if (line.includes('SCALPER')) byAccount.SCALPER++;
  }

  return {
    totalEvents: lines.length,
    byTier,
    byAccount,
    logPath: LOG_PATH,
  };
}

module.exports = {
  checkCircuitBreaker,
  summarizeLog,
  countConsecutiveLosses,
  computeRollingWR,
  computeRollingPF,
  TIERS,
  LOG_PATH,
};
