'use strict';

/**
 * BulletBrain v3.0 — Backtest Engine Core
 * Phase D4 — Step 0.4
 *
 * Chronological candle replay engine with full cost model.
 * Build once. Test thoroughly. Never change after Phase D6 starts.
 *
 * Source: backtestplan.md lines 194-408 (Step 0.4)
 *        backtestplan.md lines 1469-1606 (exit conditions)
 */

const { COSTS, EXECUTION_PARAMS, TICK_SIZES, TRADE, SIZING } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// FILL SIMULATION
// Source: backtestplan.md lines 296-370
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify fill quality using ATR-relative penetration thresholds.
 *
 * Fix 1 (Phase D6 Recovery): replaces the hardcoded 0.10% threshold which was
 * calibrated for 15m candles and incorrectly applied to 1H data.
 * On 1H BTC (ATR ~0.35%), the old 0.10% threshold = 29% of ATR — nearly every
 * fill candle exceeds it, producing 100% TOXIC. ATR-relative thresholds scale
 * automatically across timeframes.
 *
 * Thresholds as fraction of ATR14:
 *   CLEAN    < 5%  of ATR  (barely past limit — absorption possible)
 *   MARGINAL < 20% of ATR  (moderate penetration — testing the level)
 *   TOXIC    >= 40% of ATR (level being steamrolled)
 *
 * On 15m (ATR ~0.12%): TOXIC threshold ≈ 0.048% — converges toward original value.
 * On 1H  (ATR ~0.40%): TOXIC threshold ≈ 0.160% — correctly scaled up.
 *
 * @param {number} penetration  - (limitPrice - candle.low) / limitPrice  (LONG)
 * @param {number} atr14        - ATR14 value at the fill candle
 * @param {number} limitPrice   - entry limit price
 * @param {number} fillRate     - base fill probability
 * @returns {{ fill: boolean, quality: string, extraStopSlippage: number }}
 */
function classifyFill(penetration, atr14, limitPrice, fillRate) {
  if (penetration <= 0) return { fill: false, quality: 'MISS', extraStopSlippage: 0 };

  // Fall back to fixed thresholds if ATR unavailable
  if (!atr14 || atr14 <= 0 || !limitPrice || limitPrice <= 0) {
    if (penetration < 0.0002) return { fill: Math.random() < fillRate,        quality: 'CLEAN',    extraStopSlippage: 0     };
    if (penetration < 0.001)  return { fill: Math.random() < fillRate * 0.85, quality: 'MARGINAL', extraStopSlippage: 0.001 };
    return                           { fill: true,                             quality: 'TOXIC',    extraStopSlippage: 0.003 };
  }

  const atrPct         = atr14 / limitPrice;
  const cleanThreshold    = atrPct * 0.05;
  const marginalThreshold = atrPct * 0.20;
  const toxicThreshold    = atrPct * 0.40;

  if (penetration < cleanThreshold)    return { fill: Math.random() < fillRate,        quality: 'CLEAN',    extraStopSlippage: 0     };
  if (penetration < marginalThreshold) return { fill: Math.random() < fillRate,        quality: 'CLEAN',    extraStopSlippage: 0     };
  if (penetration < toxicThreshold)    return { fill: Math.random() < fillRate * 0.85, quality: 'MARGINAL', extraStopSlippage: 0.001 };
  return                                      { fill: true,                             quality: 'TOXIC',    extraStopSlippage: 0.003 };
}

/**
 * Simulate limit order fill with ATR-relative penetration-depth adverse selection.
 * Returns fill quality: MISS | EXACT_TOUCH | CLEAN | MARGINAL | TOXIC
 *
 * @param {object} candle    - { high, low, close }
 * @param {object} order     - { side: 'LONG'|'SHORT', limitPrice }
 * @param {string} strategy  - strategy name for fill_rate lookup
 * @param {string} symbol    - symbol for tick size lookup
 * @param {number} [atr14]   - ATR14 at this candle (enables ATR-relative thresholds)
 * @returns {{ fill: boolean, quality: string, extraStopSlippage: number }}
 */
function simulateLimitFill(candle, order, strategy, symbol, atr14) {
  const tickSize = TICK_SIZES[symbol] || 0.1;
  const fillRate = COSTS.fill_rate[strategy] || 0.70;

  if (order.side === 'LONG') {
    const penetration = (order.limitPrice - candle.low) / order.limitPrice;

    if (penetration < 0)
      return { fill: false, quality: 'MISS', extraStopSlippage: 0 };

    if (candle.low >= order.limitPrice - tickSize)
      return { fill: false, quality: 'EXACT_TOUCH', extraStopSlippage: 0 };

    return classifyFill(penetration, atr14, order.limitPrice, fillRate);
  }

  if (order.side === 'SHORT') {
    const penetration = (candle.high - order.limitPrice) / order.limitPrice;

    if (penetration < 0)
      return { fill: false, quality: 'MISS', extraStopSlippage: 0 };

    if (candle.high <= order.limitPrice + tickSize)
      return { fill: false, quality: 'EXACT_TOUCH', extraStopSlippage: 0 };

    return classifyFill(penetration, atr14, order.limitPrice, fillRate);
  }

  return { fill: false, quality: 'MISS', extraStopSlippage: 0 };
}

/**
 * Simulate partial position fill on high-RVOL candles.
 * Fast candles thin the book — you get less than intended size.
 */
function simulatePositionFill(intendedSize, rvol) {
  if (rvol > 3.0) return intendedSize * 0.70;
  if (rvol > 2.0) return intendedSize * 0.82;
  return intendedSize;
}

// ─────────────────────────────────────────────────────────────────────────────
// COST APPLICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate total entry cost for a trade.
 * Includes fee, slippage, and signal delay cost.
 *
 * @param {string}  symbol      - trading symbol
 * @param {string}  interval    - candle interval ('15m', '1h', etc.)
 * @param {boolean} inKillzone  - whether signal fired in killzone
 * @param {boolean} inCrisis    - whether regime is CRISIS
 * @param {boolean} inNewsWindow - whether in macro event blackout window (D5)
 * @returns {number} total cost as fraction of position value
 */
function calcEntryCost(symbol, interval, inKillzone, inCrisis, inNewsWindow = false) {
  const params = EXECUTION_PARAMS[symbol] || EXECUTION_PARAMS.BTCUSDT;

  let slippage;
  if (inCrisis)        slippage = params.crisisSlippage;
  else if (inKillzone) slippage = params.killzoneSlippage;
  else                 slippage = params.baseSlippage;

  // News window: double slippage (spreads widen dramatically during CPI/FOMC/NFP)
  // D5 macro tagger will set this flag — engine applies it automatically
  if (inNewsWindow) slippage *= 2;

  const latency = COSTS.signal_delay_cost[interval] || COSTS.signal_delay_cost['1h'];

  return COSTS.fee_round_trip + slippage + latency;
}

/**
 * Apply funding cost to an open trade.
 * Called on every 8H funding timestamp while trade is open.
 *
 * @param {object} trade            - open trade object
 * @param {number} currentTimestamp - current candle timestamp
 * @param {Map}    fundingMap       - symbol → Map<timestamp, rate>
 */
function applyFundingCost(trade, currentTimestamp, fundingMap) {
  const symbolMap = fundingMap.get(trade.symbol);
  if (!symbolMap) return;

  const rate = symbolMap.get(currentTimestamp);
  if (rate === undefined) return;

  const notional    = trade.size * trade.entryPrice;
  const costSign    = (trade.side === 'LONG') ? -1 : +1;
  const fundingPnl  = notional * rate * costSign;

  trade.cumulativeFundingCost = (trade.cumulativeFundingCost || 0) + Math.abs(notional * rate);
  trade.unrealizedPnl         = (trade.unrealizedPnl || 0) + fundingPnl;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIT CONDITIONS
// Source: backtestplan.md lines 1469-1606 (Step 6.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check time-based exit.
 * Prevents trades from sitting as dead weight.
 *
 * @param {object} trade   - open trade
 * @param {number} elapsed - candles elapsed since entry
 * @param {string} regime  - current regime
 * @returns {{ action: string, fraction: number }|null}
 */
function checkTimeExit(trade, elapsed, regime) {
  const maxDuration = TRADE.maxDurationCandles[regime] || TRADE.maxDurationCandles.RANGING;
  if (elapsed < maxDuration) return null;

  const profitFraction = trade.unrealizedPnl / (trade.riskAmount || 1);

  if (profitFraction >= 0.7) {
    return { action: 'PARTIAL_EXIT', fraction: 0.25, reason: 'time_exit_profit' };
  }
  return { action: 'FULL_EXIT', fraction: 1.0, reason: 'time_exit_flat' };
}

/**
 * Check momentum-based early exit.
 * Fires when momentum deteriorates while trade is in profit.
 *
 * @param {object} trade      - open trade
 * @param {object} candle     - current candle
 * @param {object} prevCandle - previous candle
 * @returns {{ action: string, fraction: number }|null}
 */
function checkMomentumExit(trade, candle, prevCandle) {
  if (!trade.pastTP1) return null;

  const profitFraction = trade.unrealizedPnl / (trade.riskAmount || 1);
  if (profitFraction < 0.5) return null; // only exit if in profit > 0.5R

  const rvolDropped    = candle.rvol < 0.8 && prevCandle.rvol > 1.5;
  const cvdFlattened   = Math.abs(candle.cvdDelta || 0) < 0.1 * Math.abs(prevCandle.cvdDelta || 1);
  const candleRange    = candle.high - candle.low;
  const upperWick      = candle.high - Math.max(candle.open, candle.close);
  const rejectionNearTP = candleRange > 0 &&
    (upperWick / candleRange > 0.6) &&
    (candle.high >= (trade.tp1 || 0) * 0.95);

  if (rvolDropped || cvdFlattened || rejectionNearTP) {
    return { action: 'PARTIAL_EXIT', fraction: 0.5, reason: 'momentum_deterioration' };
  }
  return null;
}

/**
 * Check Z-score blow-off exit.
 * Captures extreme moves before retracement.
 * Uses 30-day historical vol as denominator (not rolling std).
 *
 * @param {object} trade           - open trade
 * @param {object} candle          - current candle
 * @param {object} prevCandle      - previous candle
 * @param {number} historicalVolPer15m - 30-day annualized vol / sqrt(365*96)
 * @returns {{ action: string }|null}
 */
function checkZScoreExit(trade, candle, prevCandle, historicalVolPer15m) {
  if (!trade.pastTP1) return null;
  if (historicalVolPer15m <= 0) return null;

  const currentReturn = (candle.close - prevCandle.close) / prevCandle.close;
  const zScore        = currentReturn / historicalVolPer15m;

  const pctToTP2 = trade.tp2Distance > 0
    ? Math.min(trade.unrealizedPnl / trade.tp2Distance, 1.0)
    : 0;

  const inFavor = (trade.side === 'LONG' && zScore > 0) ||
                  (trade.side === 'SHORT' && zScore < 0);
  if (!inFavor) return null;

  if (Math.abs(zScore) > 3.5 && pctToTP2 > 0.80)
    return { action: 'FULL_EXIT', reason: 'zscore_blowoff', zScore, pctToTP2 };

  if (Math.abs(zScore) > 2.5 && pctToTP2 > 0.90)
    return { action: 'FULL_EXIT', reason: 'zscore_nearTP2', zScore, pctToTP2 };

  return null;
}

/**
 * Check CVD exhaustion exit.
 * Fires 1-3 candles before momentum indicators turn.
 *
 * @param {object}   trade          - open trade
 * @param {number[]} cvdDeltaHistory - recent CVD deltas (last 3)
 * @returns {{ action: string }|null}
 */
function checkCVDExhaustionExit(trade, cvdDeltaHistory) {
  if (!trade.pastTP1) return null;
  if (!cvdDeltaHistory || cvdDeltaHistory.length < 3) return null;

  const recent      = cvdDeltaHistory.slice(-3);
  const peakReached = recent[0] > recent[1] && recent[1] > recent[2];
  const twoNegative = recent[1] < 0 && recent[2] < 0;

  if (peakReached && twoNegative) {
    return { action: 'PARTIAL_EXIT', fraction: 0.75, reason: 'cvd_exhaustion' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK CONTROLS
// Source: backtestplan.md Gate 5, SIZING config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a new trade is allowed given current portfolio state.
 *
 * @param {object[]} openTrades  - currently open trades
 * @param {string}   symbol      - proposed new trade symbol
 * @param {number}   riskAmount  - proposed risk in $ terms
 * @param {number}   capital     - total capital
 * @returns {{ allowed: boolean, reason: string }}
 */
function checkPortfolioRisk(openTrades, symbol, riskAmount, capital) {
  // Max concurrent trades
  if (openTrades.length >= SIZING.maxConcurrentTrades) {
    return { allowed: false, reason: 'max_concurrent_trades' };
  }

  // Correlation cluster: max 1 from [BTC/ETH/SOL/BNB]
  const clusterA = SIZING.correlationClusters.A;
  if (clusterA.includes(symbol)) {
    const clusterAOpen = openTrades.filter(t => clusterA.includes(t.symbol));
    if (clusterAOpen.length >= 1) {
      return { allowed: false, reason: 'correlation_cluster_A_full' };
    }
  }

  // Portfolio heat: max 3% total risk
  const currentRisk = openTrades.reduce((sum, t) => sum + (t.riskAmount || 0), 0);
  if ((currentRisk + riskAmount) / capital > SIZING.maxPortfolioRisk) {
    return { allowed: false, reason: 'portfolio_heat_exceeded' };
  }

  return { allowed: true, reason: '' };
}

/**
 * Check daily loss limit.
 *
 * @param {number} dailyPnl  - today's realized P&L (negative = loss)
 * @param {number} capital   - total capital
 * @returns {boolean} true if trading should pause
 */
function isDailyLossBreached(dailyPnl, capital) {
  return dailyPnl / capital <= -TRADE.dailyLossLimit;
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new trade object.
 *
 * @param {object} params - trade parameters
 * @returns {object} trade
 */
function createTrade(params) {
  return {
    id:                   params.id || `trade_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    symbol:               params.symbol,
    side:                 params.side,           // 'LONG' | 'SHORT'
    strategy:             params.strategy,
    regime:               params.regime,
    entryPrice:           params.entryPrice,
    stopPrice:            params.stopPrice,
    tp1:                  params.tp1,
    tp2:                  params.tp2,
    size:                 params.size,           // position size in base currency
    riskAmount:           params.riskAmount,     // $ at risk
    tp1Distance:          Math.abs(params.tp1 - params.entryPrice),
    tp2Distance:          Math.abs(params.tp2 - params.entryPrice),
    fillQuality:          params.fillQuality,    // CLEAN | MARGINAL | TOXIC
    extraStopSlippage:    params.extraStopSlippage || 0,
    entryTimestamp:       params.entryTimestamp,
    entryCandle:          params.entryCandle,
    unrealizedPnl:        0,
    cumulativeFundingCost: 0,
    pastTP1:              false,
    status:               'OPEN',               // OPEN | PARTIAL_CLOSE | CLOSED
    exitPrice:            null,
    exitTimestamp:        null,
    exitReason:           null,
    realizedPnl:          null,
    candlesHeld:          0,
    cvdDeltaHistory:      [],
  };
}

/**
 * Update unrealized P&L for an open trade.
 *
 * @param {object} trade       - open trade
 * @param {number} currentPrice - current candle close
 */
function updateUnrealizedPnl(trade, currentPrice) {
  const priceDiff = trade.side === 'LONG'
    ? currentPrice - trade.entryPrice
    : trade.entryPrice - currentPrice;

  trade.unrealizedPnl = priceDiff * trade.size;
}

/**
 * Close a trade (full or partial).
 * Applies crisis slippage if closing during a blackout window.
 *
 * @param {object}  trade       - trade to close
 * @param {number}  exitPrice   - exit price
 * @param {string}  reason      - exit reason
 * @param {number}  fraction    - fraction to close (1.0 = full)
 * @param {number}  timestamp   - exit timestamp
 * @param {boolean} inBlackout  - whether exit occurs during macro blackout
 * @returns {object} closed trade record
 */
function closeTrade(trade, exitPrice, reason, fraction = 1.0, timestamp = 0, inBlackout = false) {
  const priceDiff = trade.side === 'LONG'
    ? exitPrice - trade.entryPrice
    : trade.entryPrice - exitPrice;

  const closedSize = trade.size * fraction;
  const grossPnl   = priceDiff * closedSize;

  // Apply exit costs (fee + slippage on exit side)
  // During blackout: apply crisis slippage (book is thin, spreads wide)
  const exitSlippage = inBlackout ? COSTS.crisis_stop_slippage : 0;
  const exitCost = closedSize * exitPrice * (COSTS.fee_round_trip / 2 + exitSlippage);
  const netPnl   = grossPnl - exitCost - (trade.cumulativeFundingCost * fraction);

  if (fraction >= 1.0) {
    trade.status        = 'CLOSED';
    trade.exitPrice     = exitPrice;
    trade.exitTimestamp = timestamp;
    trade.exitReason    = reason;
    trade.realizedPnl   = netPnl;
  } else {
    // Partial close
    trade.status      = 'PARTIAL_CLOSE';
    trade.size       *= (1 - fraction);
    trade.riskAmount *= (1 - fraction);
    trade.cumulativeFundingCost *= (1 - fraction);
    if (reason === 'tp1') {
      trade.pastTP1  = true;
      trade.stopPrice = trade.entryPrice; // move stop to breakeven
    }
  }

  return {
    ...trade,
    closedSize,
    exitPrice,
    exitReason: reason,
    realizedPnl: netPnl,
    exitTimestamp: timestamp,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUITY CURVE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an equity tracker.
 *
 * @param {number} initialCapital
 * @returns {object} equity tracker
 */
function createEquityTracker(initialCapital) {
  return {
    capital:      initialCapital,
    peak:         initialCapital,
    maxDrawdown:  0,
    dailyPnl:     0,
    currentDay:   null,
    paused:       false,
    pauseUntil:   null,
    forceClose:   false,  // set true by macro event tagger or crisis handler
    curve:        [{ timestamp: 0, capital: initialCapital }],
  };
}

/**
 * Force close all positions (called by macro event handler or crisis exit).
 * Sets forceClose flag — runner checks this on each candle.
 *
 * @param {object} tracker - equity tracker
 * @param {string} reason  - reason for force close
 */
function triggerForceClose(tracker, reason) {
  tracker.forceClose = true;
  tracker.forceCloseReason = reason;
}

/**
 * Update equity tracker after a trade closes.
 *
 * @param {object} tracker    - equity tracker
 * @param {number} pnl        - realized P&L
 * @param {number} timestamp  - candle timestamp
 */
function updateEquity(tracker, pnl, timestamp) {
  tracker.capital += pnl;
  tracker.dailyPnl += pnl;

  // Update peak and drawdown
  if (tracker.capital > tracker.peak) {
    tracker.peak = tracker.capital;
  }
  const dd = (tracker.peak - tracker.capital) / tracker.peak;
  if (dd > tracker.maxDrawdown) tracker.maxDrawdown = dd;

  // Daily reset
  const day = new Date(timestamp).toISOString().slice(0, 10);
  if (day !== tracker.currentDay) {
    tracker.dailyPnl  = pnl; // start fresh for new day
    tracker.currentDay = day;
    tracker.paused     = false;
  }

  // Check daily loss limit
  if (isDailyLossBreached(tracker.dailyPnl, tracker.capital)) {
    tracker.paused    = true;
    tracker.pauseUntil = timestamp + 24 * 60 * 60 * 1000; // pause 24H
  }

  tracker.curve.push({ timestamp, capital: tracker.capital });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Fill simulation
  simulateLimitFill,
  simulatePositionFill,

  // Cost application
  calcEntryCost,
  applyFundingCost,

  // Exit conditions
  checkTimeExit,
  checkMomentumExit,
  checkZScoreExit,
  checkCVDExhaustionExit,

  // Risk controls
  checkPortfolioRisk,
  isDailyLossBreached,

  // Position state machine
  createTrade,
  updateUnrealizedPnl,
  closeTrade,

  // Equity tracking
  createEquityTracker,
  updateEquity,
  triggerForceClose,
};
