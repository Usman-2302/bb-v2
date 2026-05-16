'use strict';

/**
 * BulletBrain v3.0 — Shared Trade Management
 *
 * Extracted from the three duplicate runners (FVG, OB, LSO).
 * Processes open trades for one candle: stop, TP1, TP2, time/momentum/z-score/
 * CVD-exhaustion exits, and optional time-based breakeven.
 *
 * Fixes the partial-close-inflation bug present in runner.js and ob_runner.js:
 * momentum and CVD exhaustion partial closes were being pushed to closedTrades
 * when trade.size > 0 (trade still open). Only full closes go to closedTrades.
 */

const {
  applyFundingCost,
  checkTimeExit,
  checkMomentumExit,
  checkZScoreExit,
  checkCVDExhaustionExit,
  updateUnrealizedPnl,
  closeTrade,
  updateEquity,
} = require('./engine');
const { TRADE } = require('../../config');

/**
 * @param {object} ctx
 * @param {object} ctx.candle           - current candle
 * @param {object} ctx.prevCandle       - previous candle
 * @param {number} ctx.candleIndex      - current candle index
 * @param {number[]} ctx.rvolVals       - RVOL array
 * @param {object} ctx.cvdVals          - { delta[], cumulative[] }
 * @param {Map} ctx.fundingMap          - funding rates
 * @param {number} ctx.volPerCandle     - pre-computed vol per candle
 * @param {boolean} ctx.inBlackout      - macro blackout flag
 * @param {object[]} ctx.openTrades     - mutable open trades array
 * @param {object[]} ctx.closedTrades   - mutable closed trades array
 * @param {object} ctx.equity           - equity tracker
 * @param {object} [ctx.timeBreakeven]  - { enabled: boolean, checkFn, threshold }
 * @returns {{ timeBreakevenExits: number }}
 */
function processOpenTrades(ctx) {
  const {
    candle, prevCandle, candleIndex,
    rvolVals, cvdVals, fundingMap, volPerCandle, inBlackout,
    openTrades, closedTrades, equity,
    timeBreakeven = {},
  } = ctx;

  let timeBreakevenExits = 0;

  // Apply funding cost on 8H boundaries
  const fundingTimestamps = [0, 8, 16].map(h =>
    Math.floor(candle.openTime / (8 * 3600000)) * (8 * 3600000) + h * 3600000
  );
  for (const ts of fundingTimestamps) {
    if (ts === candle.openTime) {
      openTrades.forEach(t => applyFundingCost(t, ts, fundingMap));
    }
  }

  for (let t = openTrades.length - 1; t >= 0; t--) {
    const trade = openTrades[t];
    updateUnrealizedPnl(trade, candle.close);
    trade.candlesHeld++;

    if (cvdVals && cvdVals.delta) {
      trade.cvdDeltaHistory.push(cvdVals.delta[candleIndex] || 0);
      if (trade.cvdDeltaHistory.length > 5) trade.cvdDeltaHistory.shift();
    }

    // ── Stop ──────────────────────────────────────────────────────────────
    const stopHit = trade.side === 'LONG'
      ? candle.low <= trade.stopPrice
      : candle.high >= trade.stopPrice;

    if (stopHit) {
      const actualStop = trade.side === 'LONG'
        ? trade.stopPrice * (1 - trade.extraStopSlippage)
        : trade.stopPrice * (1 + trade.extraStopSlippage);
      const closed = closeTrade(trade, actualStop, 'stop', 1.0, candle.openTime, inBlackout);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
      continue;
    }

    // ── TP1 ───────────────────────────────────────────────────────────────
    const tp1Hit = trade.side === 'LONG'
      ? candle.high >= trade.tp1
      : candle.low <= trade.tp1;

    if (tp1Hit && !trade.pastTP1) {
      closeTrade(trade, trade.tp1, 'tp1', TRADE.tp1CloseFraction, candle.openTime, inBlackout);
      updateEquity(equity, trade.tp1 * TRADE.tp1CloseFraction * trade.size * 0.01, candle.openTime);
    }

    // ── TP2 ───────────────────────────────────────────────────────────────
    const tp2Hit = trade.side === 'LONG'
      ? candle.high >= trade.tp2
      : candle.low <= trade.tp2;

    if (tp2Hit) {
      const closed = closeTrade(trade, trade.tp2, 'tp2', 1.0, candle.openTime, inBlackout);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
      continue;
    }

    // ── Time-based breakeven (optional) ────────────────────────────────────
    if (timeBreakeven.enabled && timeBreakeven.checkFn) {
      const tbResult = timeBreakeven.checkFn(trade, trade.candlesHeld, candle.close);
      if (tbResult && tbResult.exit) {
        const closed = closeTrade(trade, candle.close, tbResult.reason, 1.0, candle.openTime, inBlackout);
        closedTrades.push(closed);
        openTrades.splice(t, 1);
        updateEquity(equity, closed.realizedPnl, candle.openTime);
        timeBreakevenExits++;
        continue;
      }
    }

    // ── Time exit (regime-based) ──────────────────────────────────────────
    const timeExit = checkTimeExit(trade, trade.candlesHeld, candle.regime || 'RANGING');
    if (timeExit && timeExit.action === 'FULL_EXIT') {
      const closed = closeTrade(trade, candle.close, timeExit.reason, 1.0, candle.openTime, inBlackout);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
      continue;
    }

    // ── Momentum exit ─────────────────────────────────────────────────────
    const momentumExit = checkMomentumExit(
      trade,
      { ...candle, rvol: rvolVals[candleIndex], cvdDelta: cvdVals?.delta?.[candleIndex] || 0 },
      { ...prevCandle, rvol: rvolVals[candleIndex - 1] || 1, cvdDelta: cvdVals?.delta?.[candleIndex - 1] || 0 }
    );
    if (momentumExit) {
      const closed = closeTrade(trade, candle.close, momentumExit.reason, momentumExit.fraction, candle.openTime, inBlackout);
      // Only push to closedTrades if FULLY closed (fixes partial-close-inflation bug)
      if (trade.size <= 0) {
        closedTrades.push(closed);
        openTrades.splice(t, 1);
      }
      updateEquity(equity, closed.realizedPnl, candle.openTime);
    }

    // ── Z-score exit ──────────────────────────────────────────────────────
    const zExit = checkZScoreExit(trade, candle, prevCandle, volPerCandle);
    if (zExit) {
      const closed = closeTrade(trade, candle.close, zExit.reason, 1.0, candle.openTime, inBlackout);
      closedTrades.push(closed);
      openTrades.splice(t, 1);
      updateEquity(equity, closed.realizedPnl, candle.openTime);
      continue;
    }

    // ── CVD exhaustion exit ───────────────────────────────────────────────
    const cvdExit = checkCVDExhaustionExit(trade, trade.cvdDeltaHistory);
    if (cvdExit) {
      const closed = closeTrade(trade, candle.close, cvdExit.reason, cvdExit.fraction, candle.openTime, inBlackout);
      // Only push to closedTrades if FULLY closed (fixes partial-close-inflation bug)
      if (trade.size <= 0) {
        closedTrades.push(closed);
        openTrades.splice(t, 1);
      }
      updateEquity(equity, closed.realizedPnl, candle.openTime);
    }
  }

  return { timeBreakevenExits };
}

module.exports = { processOpenTrades };
