'use strict';

/**
 * BulletBrain v3.0 — Unified Backtest Runner
 *
 * Single strategy-agnostic backtest loop. Strategy-specific behavior is
 * injected via a descriptor object with callbacks. Replaces the three
 * duplicate runners (runner.js for FVG, ob_runner.js for OB, lso_runner.js
 * for LSO) that shared ~80% identical code.
 *
 * Strategy descriptor interface:
 *   {
 *     name: string,                         // 'FVG' | 'OB' | 'LSO'
 *     config: object,                       // strategy config from config.js
 *
 *     // Zone / pool lifecycle
 *     detectZones(candles, atr14, rvolVals, cfg) → zones[]
 *     updateZones(activeZones, candle, i) → void    // mutate in place
 *     isZoneActive(zone) → boolean
 *     checkEntry(zone, candle) → signal | null
 *
 *     // Optional: per-candle setup before signal scanning
 *     onCandleStart?(ctx) → void
 *
 *     // Gate 7 (strategy-specific entry filter)
 *     gate7?(candle, cvdVals, i) → { pass: boolean, reason?: string }
 *
 *     // Regime filter: true = allowed, false = skip candle
 *     isRegimeAllowed(regime) → boolean
 *
 *     // Sensitivity parameter matrix
 *     sensitivityParams: { paramName: [values] }
 *
 *     // Optional: extra fields on the trade object
 *     extraTradeFields?(signal, candle, i, ctx) → object
 *
 *     // Optional: extra metadata in the report
 *     reportMeta?(ctx) → object
 *   }
 */

const { findDOL }            = require('../utils/dolFinder');
const { isInBlackout }       = require('../utils/macroTagger');
const { isSweepCandle }      = require('../indicators/cvd');
const {
  simulateLimitFill,
  simulatePositionFill,
  calcEntryCost,
  createTrade,
  createEquityTracker,
  updateEquity,
  closeTrade,
  checkPortfolioRisk,
  isDailyLossBreached,
}                            = require('./engine');
const { processOpenTrades }  = require('./tradeManager');
const { generateReport }     = require('./reporter');
const { TRADE, SIZING }      = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// KILLZONE MULTIPLIER (inherited from D6)
// ─────────────────────────────────────────────────────────────────────────────

const KILLZONE_WINDOWS_UTC = [
  { start: 7,  end: 9  },  // London Open
  { start: 13, end: 15 },  // NY Open
];

function getKillzoneContext(openTimeMs, killzoneGateActive) {
  const hourUTC    = new Date(openTimeMs).getUTCHours();
  const inKillzone = KILLZONE_WINDOWS_UTC.some(w => hourUTC >= w.start && hourUTC < w.end);
  if (!killzoneGateActive) return { inKillzone, sizeMult: 1.0 };
  return { inKillzone, sizeMult: inKillzone ? 1.20 : 0.80 };
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE FLAGS
// ─────────────────────────────────────────────────────────────────────────────

const GATES = {
  BASELINE:  { regime: false, killzone: false, macro: false },
  REGIME:    { regime: true,  killzone: false, macro: false },
  KILLZONE:  { regime: true,  killzone: true,  macro: false },
  FULL:      { regime: true,  killzone: true,  macro: true  },
};

// LSO-specific gates (extra `oi` field)
const LSO_GATES = {
  NO_OI:    { regime: false, oi: false, killzone: false, macro: false },
  WITH_OI:  { regime: false, oi: true,  killzone: false, macro: false },
  REGIME:   { regime: true,  oi: true,  killzone: false, macro: false },
  KILLZONE: { regime: true,  oi: true,  killzone: true,  macro: false },
  FULL:     { regime: true,  oi: true,  killzone: true,  macro: true  },
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: pre-compute vol per candle for Z-score exit
// ─────────────────────────────────────────────────────────────────────────────

function computeVolPerCandle(closes, timeframe) {
  const dailyRets = [];
  for (let i = 1; i < closes.length; i++) {
    dailyRets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const meanRet  = dailyRets.reduce((a, b) => a + b, 0) / (dailyRets.length || 1);
  const variance = dailyRets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (dailyRets.length || 1);
  const annualVol = Math.sqrt(variance * 252);
  return annualVol / Math.sqrt(365 * (timeframe === '15m' ? 96 : 24));
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE BACKTEST LOOP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a single backtest pass.
 *
 * @param {object} strategy - strategy descriptor (see top of file)
 * @param {object} options
 * @param {object[]} options.candles
 * @param {number[]} options.atr14
 * @param {number[]} options.rvolVals
 * @param {object}   options.cvdVals        - { delta[], cumulative[] }
 * @param {Map}      options.fundingMap      - nested Map<symbol, Map<timestamp, rate>>
 * @param {object[]} options.macroEvents
 * @param {object}   options.gates          - GATES variant
 * @param {number}   options.initialCapital
 * @param {object}   options.configOverrides - strategy config overrides (sensitivity)
 * @param {string}   options.symbol
 * @param {string}   options.timeframe
 * @param {object}   [options.extra]         - strategy-specific extra options
 * @returns {object} report
 */
function runBacktest(strategy, options) {
  const {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents,
    gates, initialCapital = 10000, configOverrides = {},
    symbol = 'BTCUSDT', timeframe = '15m',
    extra = {},
  } = options;

  const cfg  = { ...strategy.config, ...configOverrides };
  const ctx  = { cfg, symbol, timeframe, gates, extra, cvdVals, atr14, rvolVals, candles };

  // Pre-detect all zones (ctx passed so LSO can store pre-computed pools in extra)
  let activeZones = strategy.detectZones(candles, atr14, rvolVals, cfg, ctx);

  const equity       = createEquityTracker(initialCapital);
  const openTrades   = [];
  const closedTrades = [];
  const missedTrades = [];

  // Vol for Z-score exit
  const closes       = candles.map(c => c.close);
  const volPerCandle = computeVolPerCandle(closes, timeframe);

  // Tracking
  let timeBreakevenExitsTotal = 0;
  const tradedCandles = new Set();

  // ── Main candle loop ──────────────────────────────────────────────────────
  for (let i = 0; i < candles.length; i++) {
    const candle     = candles[i];
    const prevC      = candles[i - 1] || candle;
    const regime     = candle.regime || 'RANGING';
    const inBlackout = gates.macro
      ? isInBlackout(candle.openTime, macroEvents).inBlackout
      : false;

    // ── Process open trades (shared trade management) ──────────────────────
    const tbConfig = extra.timeBreakeven || {};
    const { timeBreakevenExits } = processOpenTrades({
      candle, prevCandle: prevC, candleIndex: i,
      rvolVals, cvdVals, fundingMap, volPerCandle, inBlackout,
      openTrades, closedTrades, equity,
      timeBreakeven: tbConfig,
    });
    timeBreakevenExitsTotal += timeBreakevenExits;

    // ── Update zone states ─────────────────────────────────────────────────
    if (strategy.updateZones) {
      strategy.updateZones(activeZones, candle, i);
    }
    activeZones = activeZones.filter(z => strategy.isZoneActive(z));

    // ── Skip if paused or in blackout ──────────────────────────────────────
    if (equity.paused) continue;
    if (inBlackout) continue;

    // ── Regime gate ────────────────────────────────────────────────────────
    if (gates.regime && strategy.isRegimeAllowed) {
      if (!strategy.isRegimeAllowed(regime)) continue;
    }

    // ── Per-candle strategy setup (LSO: pool activation/expiry) ────────────
    if (strategy.onCandleStart) {
      strategy.onCandleStart({ ...ctx, i, candle, activeZones });
    }

    if (activeZones.length === 0) continue;

    // Skip if this candle already produced a trade (one-trade-per-candle guard)
    if (tradedCandles.has(i)) continue;

    // ── Scan for entry signals ─────────────────────────────────────────────
    for (const zone of activeZones) {
      // Pass ctx and i so strategies can access atr14[i] and other per-candle data
      const signal = strategy.checkEntry(zone, candle, { ...ctx, i });
      if (!signal) continue;

      // ── Consume the zone immediately on sweep detection ─────────────────
      // This matches the old runner behavior: pool is removed as soon as a
      // sweep is detected, regardless of whether the trade passes all gates.
      // Prevents the same pool being swept again on the next candle if a gate
      // rejects the trade (e.g., RVOL too low, OI not flushed).
      if (strategy.onTradeOpened) {
        strategy.onTradeOpened(signal, zone, activeZones, ctx);
      }

      // ── Gate 7 (strategy-specific) ──────────────────────────────────────
      if (strategy.gate7) {
        const g7 = strategy.gate7(candle, cvdVals, i, ctx);
        if (!g7.pass) {
          missedTrades.push({ reason: g7.reason || 'gate7', timestamp: candle.openTime, zoneId: zone.id });
          break; // pool already consumed — stop scanning
        }
      }

      // ── Extra signal validation (LSO: sweep RVOL filter, OI flush) ──────
      if (strategy.validateSignal) {
        const validation = strategy.validateSignal(signal, candle, i, ctx);
        if (!validation.accept) {
          missedTrades.push({ reason: validation.reason || 'signal_rejected', timestamp: candle.openTime, zoneId: zone.id });
          break; // pool already consumed — stop scanning
        }
      }

      const entryPrice = signal.limitPrice;
      const stopPrice  = signal.stopPrice;
      const riskDist   = Math.abs(entryPrice - stopPrice);
      if (riskDist <= 0) continue;

      // Find DOL target
      const dolResult = findDOL(candles, i, entryPrice, stopPrice, signal.side || 'LONG', [], atr14);
      if (!dolResult) {
        missedTrades.push({ reason: 'no_dol', timestamp: candle.openTime, zoneId: zone.id });
        continue;
      }

      // Simulate fill
      const fillResult = simulateLimitFill(
        candle, { side: signal.side || 'LONG', limitPrice: entryPrice },
        strategy.name, symbol, atr14[i]
      );
      if (!fillResult.fill) {
        missedTrades.push({ reason: fillResult.quality, timestamp: candle.openTime, zoneId: zone.id });
        continue;
      }

      // ── Position sizing ─────────────────────────────────────────────────
      const kz         = getKillzoneContext(candle.openTime, gates.killzone);
      const inCrisis   = regime === 'CRISIS';
      const entryCost  = calcEntryCost(symbol, timeframe, kz.inKillzone, inCrisis, inBlackout);
      const zombieMult = (gates.regime && regime === 'RANGING_ZOMBIE') ? 0.5 : 1.0;

      // Strategy-specific size multiplier (LSO: OB confluence 1.3×)
      const strategySizeMult = strategy.getSizeMultiplier
        ? strategy.getSizeMultiplier(signal, candle, ctx)
        : 1.0;

      const riskAmount = initialCapital * SIZING.baseRisk * kz.sizeMult * zombieMult * strategySizeMult;
      const rawSize    = riskAmount / riskDist;
      const size       = simulatePositionFill(rawSize, rvolVals[i]);

      // Portfolio risk check
      const riskCheck = checkPortfolioRisk(openTrades, symbol, riskAmount, equity.capital);
      if (!riskCheck.allowed) {
        missedTrades.push({ reason: riskCheck.reason, timestamp: candle.openTime, zoneId: zone.id });
        continue;
      }

      if (isDailyLossBreached(equity.dailyPnl, equity.capital)) continue;

      const tp1 = entryPrice + riskDist * TRADE.tp1RR;
      const tp2 = dolResult.dol;

      const baseTrade = {
        symbol, entryPrice, stopPrice, tp1, tp2, size, riskAmount,
        side:              signal.side || 'LONG',
        strategy:          strategy.name,
        regime,
        fillQuality:       fillResult.quality,
        extraStopSlippage: fillResult.extraStopSlippage,
        entryTimestamp:    candle.openTime,
        entryCandle:       i,
        notionalValue:     size * entryPrice,
        entryCostPct:      entryCost,
        inKillzone:        kz.inKillzone,
        kzSizeMult:        kz.sizeMult,
        dolTier:           dolResult.tier,
        dolType:           dolResult.type,
      };

      // Strategy-specific extra trade fields
      const extraFields = strategy.extraTradeFields
        ? strategy.extraTradeFields(signal, candle, i, ctx)
        : {};

      const trade = createTrade({ ...baseTrade, ...extraFields });

      openTrades.push(trade);
      tradedCandles.add(i);

      break; // one trade per candle
    }
  }

  // Close remaining open trades at last candle
  const lastCandle = candles[candles.length - 1];
  for (const trade of openTrades) {
    const closed = closeTrade(trade, lastCandle.close, 'end_of_data', 1.0, lastCandle.openTime);
    closedTrades.push(closed);
    updateEquity(equity, closed.realizedPnl, lastCandle.openTime);
  }

  // Generate report
  const reportMeta = strategy.reportMeta
    ? strategy.reportMeta({ ...ctx, missedTrades, activeZones, timeBreakevenExitsTotal })
    : {};

  const report = generateReport(closedTrades, equity, {
    strategy:      strategy.name,
    symbol,
    gates,
    config:        cfg,
    missedTrades:  missedTrades.length,
    tradeLog:      closedTrades.map(t => ({
      entryCandle:  t.entryCandle,
      regime:       t.regime,
      fillQuality:  t.fillQuality,
      pool_source:  t.pool_source || 'EQUAL_LOW',
    })),
    ...reportMeta,
  });

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSITIVITY TEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run parameter sensitivity test.
 * Tests ±20% of each parameter defined in strategy.sensitivityParams.
 * PASS if WR variation < 15pp across range.
 */
function runSensitivityTest(strategy, baseOptions) {
  const results = {};

  for (const [param, values] of Object.entries(strategy.sensitivityParams)) {
    results[param] = [];
    for (const val of values) {
      const report = runBacktest(strategy, {
        ...baseOptions,
        configOverrides: { [param]: val },
      });
      results[param].push({
        value: val,
        wr: report.wr.point,
        pf: report.pf,
        trades: report.trades,
      });
    }
    const wrs     = results[param].map(r => r.wr);
    const wrRange = Math.max(...wrs) - Math.min(...wrs);
    results[param].fragile = wrRange > 0.15;
    results[param].wrRange = parseFloat((wrRange * 100).toFixed(1));
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGIME SPLIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run regime-split analysis.
 * Runs backtest separately for each regime period.
 */
function runRegimeSplit(strategy, baseOptions) {
  const regimes = ['BULL', 'BEAR', 'RANGING', 'RANGING_ZOMBIE', 'CRISIS'];
  const results = {};

  for (const targetRegime of regimes) {
    const filteredCandles = baseOptions.candles.filter(c => c.regime === targetRegime);

    if (filteredCandles.length < 50) {
      results[targetRegime] = { status: 'INSUFFICIENT_DATA', candles: filteredCandles.length };
      continue;
    }

    const filteredATR  = baseOptions.atr14.filter((_, i) => baseOptions.candles[i].regime === targetRegime);
    const filteredRVOL = baseOptions.rvolVals.filter((_, i) => baseOptions.candles[i].regime === targetRegime);

    const report = runBacktest(strategy, {
      ...baseOptions,
      candles:  filteredCandles,
      atr14:    filteredATR,
      rvolVals: filteredRVOL,
      gates:    GATES.FULL,
    });

    results[targetRegime] = {
      status: report.trades >= 30 ? (report.pf >= 1.2 ? 'PASS' : 'FAIL') : 'INSUFFICIENT_DATA',
      trades: report.trades,
      wr:     report.wr,
      pf:     report.pf,
      maxDD:  report.maxDD,
    };
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// YEAR-BY-YEAR HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run year-by-year breakdown. Not a separate function in the old runners,
 * but all three run_*_backtest.js files had identical year-filtering logic.
 * Exported so run scripts can call it directly.
 */
function runYearlyBreakdown(strategy, baseOptions, years = ['2021', '2022', '2023', '2024']) {
  const { candles, atr14, rvolVals, cvdVals } = baseOptions;
  const results = {};

  for (const year of years) {
    const yearStart = new Date(`${year}-01-01T00:00:00Z`).getTime();
    const yearEnd   = new Date(`${year}-12-31T23:59:59Z`).getTime();
    const yearCandles = candles.filter(c => c.openTime >= yearStart && c.openTime <= yearEnd);

    if (yearCandles.length === 0) continue;

    const yearATR  = atr14.filter((_, i) => candles[i].openTime >= yearStart && candles[i].openTime <= yearEnd);
    const yearRVOL = rvolVals.filter((_, i) => candles[i].openTime >= yearStart && candles[i].openTime <= yearEnd);
    const yearCVD  = cvdVals ? {
      delta:      cvdVals.delta.filter((_, i) => candles[i].openTime >= yearStart && candles[i].openTime <= yearEnd),
      cumulative: cvdVals.cumulative.filter((_, i) => candles[i].openTime >= yearStart && candles[i].openTime <= yearEnd),
    } : null;

    const yearReport = runBacktest(strategy, {
      ...baseOptions,
      candles:  yearCandles,
      atr14:    yearATR,
      rvolVals: yearRVOL,
      cvdVals:  yearCVD,
      gates:    GATES.FULL,
    });

    results[year] = {
      trades: yearReport.trades,
      wr:     yearReport.wr,
      pf:     yearReport.pf,
      maxDD:  yearReport.maxDD,
    };
  }

  return results;
}

module.exports = {
  runBacktest,
  runSensitivityTest,
  runRegimeSplit,
  runYearlyBreakdown,
  GATES,
  LSO_GATES,
};
