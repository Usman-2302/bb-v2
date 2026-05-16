'use strict';

/**
 * BulletBrain v3.0 — FVG Backtest Execution
 * Phase D6 — Steps 1.3 through 1.9
 *
 * Usage: node src/backtest/run_fvg_backtest.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { loadNDJSON, loadFundingMap } = require('../data/loader');
const { loadMacroEvents }            = require('../utils/macroTagger');
const { atr }                        = require('../indicators/atr');
const { rvol }                       = require('../indicators/rvol');
const { cvd }                        = require('../indicators/cvd');
const { isSweepCandle }              = require('../indicators/cvd');
const { detectBullishFVGs, updateFVGStatus, checkFVGEntry } = require('../strategies/fvg');
const { runBacktest, runSensitivityTest, runRegimeSplit, runYearlyBreakdown, GATES } = require('./runner');
const logger                         = require('../utils/logger');
const { DATA, FVG: FVG_CONFIG }      = require('../../config');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

function saveResult(filename, data) {
  const dir = resolvePath(DATA.paths.results);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, filename);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  logger.info(`Saved: ${filename}`);
  return outPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// FVG STRATEGY DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

const FVG_STRATEGY = {
  name: 'FVG',
  config: FVG_CONFIG,

  detectZones(candles, atr14, rvolVals, cfg) {
    return detectBullishFVGs(candles, atr14, rvolVals);
  },

  updateZones(activeZones, candle, i) {
    for (const z of activeZones) {
      if (i > z.formed_at) updateFVGStatus(z, candle, i);
    }
  },

  isZoneActive(z) {
    return z.status === 'ACTIVE' || z.status === 'PARTIALLY_FILLED';
  },

  checkEntry(zone, candle) {
    return checkFVGEntry(zone, candle);
  },

  isRegimeAllowed(regime) {
    return regime !== 'BEAR' && regime !== 'CRISIS';
  },

  gate7(candle, cvdVals, i) {
    if (!cvdVals || !cvdVals.delta || i < 20) return { pass: true };

    const currentDelta = Math.abs(cvdVals.delta[i] || 0);
    const recentDeltas = cvdVals.delta.slice(Math.max(0, i - 20), i).map(d => Math.abs(d));
    const avgDelta = recentDeltas.length > 0
      ? recentDeltas.reduce((a, b) => a + b, 0) / recentDeltas.length
      : 0;

    if (avgDelta > 0 && currentDelta > 1.5 * avgDelta) {
      return { pass: false, reason: 'cvd_momentum' };
    }

    if (isSweepCandle(candle) && i >= 1) {
      const prevDelta = cvdVals.delta[i - 1] || 0;
      const currRaw   = cvdVals.delta[i]     || 0;
      if (currRaw <= prevDelta) {
        return { pass: false, reason: 'cvd_ghost_sweep' };
      }
    }

    return { pass: true };
  },

  sensitivityParams: {
    bodyMultiplier:  [1.0, 1.2, 1.4],
    rvolThreshold:   [1.5, 1.8, 2.0],
    validityCandles: [192, 288, 384],
    stopBuffer:      [0.08, 0.10, 0.12],
    entryOffset:     [0.25, 0.50],
  },

  reportMeta(ctx) {
    return {
      dolNotFound:   ctx.missedTrades.filter(m => m.reason === 'no_dol').length,
      cvdFiltered:   ctx.missedTrades.filter(m => m.reason === 'cvd_momentum').length,
      cvdGhostSweep: ctx.missedTrades.filter(m => m.reason === 'cvd_ghost_sweep').length,
      frontRunMisses: ctx.missedTrades.filter(m => m.reason === 'front_run').length,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  logger.phase('D6', 'start', 'FVG Backtest — Steps 1.3 through 1.9');

  logger.phase('D6', 'load', 'Loading BTC 15m tagged candles...');
  const candles = loadNDJSON(resolvePath(DATA.paths.historical, 'BTCUSDT_15m_tagged.ndjson'));
  logger.phase('D6', 'load', `Loaded ${candles.length} candles`);

  logger.phase('D6', 'indicators', 'Computing indicators...');
  const atr14    = atr(candles, 14);
  const rvolVals = rvol(candles, '15m', 20);
  const cvdVals  = cvd(candles);

  const fundingMap  = loadFundingMap('BTCUSDT');
  const macroEvents = loadMacroEvents();

  const baseOptions = {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents,
    initialCapital: 10000, symbol: 'BTCUSDT', timeframe: '15m',
  };

  // ── Step 1.3: Baseline ──────────────────────────────────────────────────
  logger.phase('D6', '1.3', 'Step 1.3 — Baseline (no filters)');
  const baseline = runBacktest(FVG_STRATEGY, { ...baseOptions, gates: GATES.BASELINE });
  saveResult('fvg_baseline.json', baseline);
  logger.info(`Baseline: trades=${baseline.trades} WR=${(baseline.wr.point*100).toFixed(1)}% PF=${baseline.pf} DD=${baseline.maxDD}%`);

  // ── Step 1.4: Regime filter ─────────────────────────────────────────────
  logger.phase('D6', '1.4', 'Step 1.4 — Add regime filter');
  const withRegime = runBacktest(FVG_STRATEGY, { ...baseOptions, gates: GATES.REGIME });
  saveResult('fvg_regime.json', withRegime);
  logger.info(`Regime: trades=${withRegime.trades} WR=${(withRegime.wr.point*100).toFixed(1)}% PF=${withRegime.pf} DD=${withRegime.maxDD}%`);

  const wrImprovement = ((withRegime.wr.point - baseline.wr.point) * 100).toFixed(1);
  logger.info(`WR improvement from regime filter: ${wrImprovement}pp`);
  if (parseFloat(wrImprovement) < -10) {
    logger.warn('WR dropped > 10pp after regime filter — genuine regression. Investigate.');
  }

  // ── Step 1.5: Killzone filter ───────────────────────────────────────────
  logger.phase('D6', '1.5', 'Step 1.5 — Add killzone filter');
  const withKillzone = runBacktest(FVG_STRATEGY, { ...baseOptions, gates: GATES.KILLZONE });
  saveResult('fvg_regime_killzone.json', withKillzone);
  logger.info(`Killzone: trades=${withKillzone.trades} WR=${(withKillzone.wr.point*100).toFixed(1)}% PF=${withKillzone.pf} DD=${withKillzone.maxDD}%`);

  // ── Step 1.6: Full gates ────────────────────────────────────────────────
  logger.phase('D6', '1.6', 'Step 1.6 — Full gates');
  const fullGates = runBacktest(FVG_STRATEGY, { ...baseOptions, gates: GATES.FULL });
  saveResult('fvg_full_gates.json', fullGates);
  logger.info(`Full gates: trades=${fullGates.trades} WR=${(fullGates.wr.point*100).toFixed(1)}% PF=${fullGates.pf} DD=${fullGates.maxDD}%`);

  // ── Step 1.7: Sensitivity test ──────────────────────────────────────────
  logger.phase('D6', '1.7', 'Step 1.7 — Parameter sensitivity test');
  const sensitivity = runSensitivityTest(FVG_STRATEGY, { ...baseOptions, gates: GATES.FULL });
  saveResult('fvg_sensitivity.json', sensitivity);

  let anyFragile = false;
  for (const [param, results] of Object.entries(sensitivity)) {
    if (results.fragile) {
      logger.warn(`FRAGILE parameter: ${param} — WR range ${results.wrRange}pp > 15pp`);
      anyFragile = true;
    } else {
      logger.info(`ROBUST parameter: ${param} — WR range ${results.wrRange}pp`);
    }
  }

  // ── Step 1.8: Regime split ──────────────────────────────────────────────
  logger.phase('D6', '1.8', 'Step 1.8 — Regime-split analysis');
  const regimeSplit = runRegimeSplit(FVG_STRATEGY, { ...baseOptions });
  saveResult('fvg_regime_split.json', regimeSplit);

  for (const [regime, result] of Object.entries(regimeSplit)) {
    logger.info(`${regime}: ${result.status} trades=${result.trades || 0} PF=${result.pf?.toFixed(2) || 'N/A'}`);
  }

  // ── Step 1.9: Year-by-year breakdown ────────────────────────────────────
  logger.phase('D6', '1.9', 'Step 1.9 — Year-by-year breakdown');
  const yearlyResults = runYearlyBreakdown(FVG_STRATEGY, { ...baseOptions });
  saveResult('fvg_yearly.json', yearlyResults);

  for (const [year, r] of Object.entries(yearlyResults)) {
    logger.info(`${year}: trades=${r.trades} WR=${(r.wr.point*100).toFixed(1)}% PF=${r.pf}`);
  }

  // ── Accept/Reject Decision ──────────────────────────────────────────────
  logger.phase('D6', 'decision', '=== ACCEPT/REJECT DECISION ===');

  const fg = fullGates;
  const positiveRegimes = Object.values(regimeSplit).filter(r => r.status === 'PASS').length;
  const positiveYears   = Object.values(yearlyResults).filter(y => y.pf >= 1.2).length;
  const sensitivityPass = !anyFragile;

  const accept =
    fg.pf > 1.5 && fg.maxDD < 8 && fg.wr.point > 0.42 &&
    positiveRegimes >= 2 && sensitivityPass && positiveYears >= 3;

  const decision = {
    verdict: accept ? 'ACCEPT' : 'REJECT',
    pf: fg.pf, maxDD: fg.maxDD, wr: fg.wr, trades: fg.trades,
    positiveRegimes, positiveYears, sensitivityPass,
    criteria: {
      pf_gt_1_5: fg.pf > 1.5, dd_lt_8: fg.maxDD < 8, wr_gt_42: fg.wr.point > 0.42,
      regimes_ge_2: positiveRegimes >= 2, sensitivity_pass: sensitivityPass, years_ge_3: positiveYears >= 3,
    },
    timestamp: new Date().toISOString(),
  };

  saveResult('fvg_decision.json', decision);
  logger.phase('D6', 'decision', `VERDICT: ${decision.verdict}`);
  logger.phase('D6', 'decision', `PF=${fg.pf} DD=${fg.maxDD}% WR=${(fg.wr.point*100).toFixed(1)}% Trades=${fg.trades}`);
  logger.phase('D6', 'done', 'FVG backtest complete. Check results/ directory.');
}

main().catch(e => {
  logger.error('FVG backtest failed', { message: e.message, stack: e.stack });
  process.exit(1);
});
