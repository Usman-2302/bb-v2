'use strict';

/**
 * BulletBrain v3.0 — OB Backtest Execution
 * Phase D7 — Steps 2.1 through 2.9
 *
 * Usage: node src/backtest/run_ob_backtest.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { loadNDJSON, loadFundingMap } = require('../data/loader');
const { loadMacroEvents }            = require('../utils/macroTagger');
const { atr }                        = require('../indicators/atr');
const { rvol }                       = require('../indicators/rvol');
const { cvd, isSweepCandle }         = require('../indicators/cvd');
const { detectBullishOBs, updateOBStatus, checkOBEntry } = require('../strategies/ob');
const { detectBullishFVGs, updateFVGStatus, checkFVGEntry } = require('../strategies/fvg');
const { runBacktest, runSensitivityTest, runRegimeSplit, runYearlyBreakdown, GATES } = require('./runner');
const logger                         = require('../utils/logger');
const { DATA, OB: OB_CONFIG }        = require('../../config');

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
// OB STRATEGY DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

const OB_STRATEGY = {
  name: 'OB',
  config: OB_CONFIG,

  detectZones(candles, atr14, rvolVals, cfg) {
    return detectBullishOBs(candles, atr14, rvolVals);
  },

  updateZones(activeZones, candle, i) {
    for (const z of activeZones) {
      if (i > z.formed_at) updateOBStatus(z, candle, i);
    }
  },

  isZoneActive(z) {
    return z.status === 'ACTIVE';
  },

  checkEntry(zone, candle) {
    return checkOBEntry(zone, candle);
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
    moveMultiplier:  [1.2, 1.5, 1.8],
    rvolThreshold:   [1.6, 2.0, 2.4],
    validityCandles: [38,  48,  58 ],
    stopBuffer:      [0.08, 0.10, 0.12],
  },

  reportMeta(ctx) {
    return {
      dolNotFound:   ctx.missedTrades.filter(m => m.reason === 'no_dol').length,
      cvdFiltered:   ctx.missedTrades.filter(m => m.reason === 'cvd_momentum').length,
      cvdGhostSweep: ctx.missedTrades.filter(m => m.reason === 'cvd_ghost_sweep').length,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  logger.phase('D7', 'start', 'OB Backtest — Steps 2.1 through 2.9');

  logger.phase('D7', 'load', 'Loading BTC 15m tagged candles...');
  const candles = loadNDJSON(resolvePath(DATA.paths.historical, 'BTCUSDT_15m_tagged.ndjson'));
  logger.phase('D7', 'load', `Loaded ${candles.length} candles`);

  logger.phase('D7', 'indicators', 'Computing indicators...');
  const atr14    = atr(candles, 14);
  const rvolVals = rvol(candles, '15m', 20);
  const cvdVals  = cvd(candles);

  const fundingMap  = loadFundingMap('BTCUSDT');
  const macroEvents = loadMacroEvents();

  const baseOptions = {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents,
    initialCapital: 10000, symbol: 'BTCUSDT', timeframe: '15m',
  };

  // ── Step 2.1: Baseline ──────────────────────────────────────────────────
  logger.phase('D7', '2.1', 'Step 2.1 — Baseline (no filters)');
  const baseline = runBacktest(OB_STRATEGY, { ...baseOptions, gates: GATES.BASELINE });
  saveResult('ob_baseline.json', baseline);
  logger.info(`Baseline: trades=${baseline.trades} WR=${(baseline.wr.point*100).toFixed(1)}% PF=${baseline.pf} DD=${baseline.maxDD}%`);

  // ── Step 2.2: Regime filter ─────────────────────────────────────────────
  logger.phase('D7', '2.2', 'Step 2.2 — Add regime filter');
  const withRegime = runBacktest(OB_STRATEGY, { ...baseOptions, gates: GATES.REGIME });
  saveResult('ob_regime.json', withRegime);
  logger.info(`Regime: trades=${withRegime.trades} WR=${(withRegime.wr.point*100).toFixed(1)}% PF=${withRegime.pf} DD=${withRegime.maxDD}%`);

  const wrImprovement = ((withRegime.wr.point - baseline.wr.point) * 100).toFixed(1);
  logger.info(`WR change from regime filter: ${wrImprovement}pp`);
  if (parseFloat(wrImprovement) < -10) {
    logger.warn('WR dropped > 10pp after regime filter — genuine regression. Investigate.');
  }

  // ── Step 2.3: Killzone multiplier ───────────────────────────────────────
  logger.phase('D7', '2.3', 'Step 2.3 — Add killzone multiplier');
  const withKillzone = runBacktest(OB_STRATEGY, { ...baseOptions, gates: GATES.KILLZONE });
  saveResult('ob_regime_killzone.json', withKillzone);
  logger.info(`Killzone: trades=${withKillzone.trades} WR=${(withKillzone.wr.point*100).toFixed(1)}% PF=${withKillzone.pf} DD=${withKillzone.maxDD}%`);

  // ── Step 2.4: Full gates ────────────────────────────────────────────────
  logger.phase('D7', '2.4', 'Step 2.4 — Full gates (regime + killzone + macro)');
  const fullGates = runBacktest(OB_STRATEGY, { ...baseOptions, gates: GATES.FULL });
  saveResult('ob_full_gates.json', fullGates);
  logger.info(`Full gates: trades=${fullGates.trades} WR=${(fullGates.wr.point*100).toFixed(1)}% PF=${fullGates.pf} DD=${fullGates.maxDD}%`);

  // ── Step 2.5: Sensitivity test ──────────────────────────────────────────
  logger.phase('D7', '2.5', 'Step 2.5 — Parameter sensitivity test');
  const sensitivity = runSensitivityTest(OB_STRATEGY, { ...baseOptions, gates: GATES.FULL });
  saveResult('ob_sensitivity.json', sensitivity);

  let anyFragile = false;
  for (const [param, results] of Object.entries(sensitivity)) {
    if (results.fragile) {
      logger.warn(`FRAGILE parameter: ${param} — WR range ${results.wrRange}pp > 15pp`);
      anyFragile = true;
    } else {
      logger.info(`ROBUST parameter: ${param} — WR range ${results.wrRange}pp`);
    }
  }

  // ── Step 2.6: Regime split ──────────────────────────────────────────────
  logger.phase('D7', '2.6', 'Step 2.6 — Regime-split analysis');
  const regimeSplit = runRegimeSplit(OB_STRATEGY, { ...baseOptions });
  saveResult('ob_regime_split.json', regimeSplit);

  for (const [regime, result] of Object.entries(regimeSplit)) {
    logger.info(`${regime}: ${result.status} trades=${result.trades || 0} PF=${result.pf?.toFixed(2) || 'N/A'}`);
  }

  // ── Step 2.7: Year-by-year breakdown ────────────────────────────────────
  logger.phase('D7', '2.7', 'Step 2.7 — Year-by-year breakdown');
  const yearlyResults = runYearlyBreakdown(OB_STRATEGY, { ...baseOptions });
  saveResult('ob_yearly.json', yearlyResults);

  for (const [year, r] of Object.entries(yearlyResults)) {
    logger.info(`${year}: trades=${r.trades} WR=${(r.wr.point*100).toFixed(1)}% PF=${r.pf}`);
  }

  // ── Step 2.8: OB/FVG Correlation Check ──────────────────────────────────
  logger.phase('D7', '2.8', 'Step 2.8 — OB/FVG correlation check');

  // Build FVG signal index using a lightweight FVG strategy descriptor
  const obTrades = fullGates.tradeLog || [];

  // Lightweight FVG pass to get signal candle indices
  const allFVGs    = detectBullishFVGs(candles, atr14, rvolVals);
  let activeFVGs   = [...allFVGs];
  const fvgSignalIdx = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    for (const fvg of activeFVGs) {
      if (i > fvg.formed_at) updateFVGStatus(fvg, candle, i);
    }
    activeFVGs = activeFVGs.filter(f => f.status === 'ACTIVE' || f.status === 'PARTIALLY_FILLED');

    for (const fvg of activeFVGs) {
      if (checkFVGEntry(fvg, candle)) { fvgSignalIdx.push(i); break; }
    }
  }

  let overlapping = 0;
  for (const trade of obTrades) {
    const nearby = fvgSignalIdx.some(idx => Math.abs(idx - trade.entryCandle) <= 2);
    if (nearby) overlapping++;
  }

  const overlapRate = obTrades.length > 0
    ? parseFloat((overlapping / obTrades.length * 100).toFixed(1))
    : 0;

  const correlationResult = {
    obTrades: obTrades.length, overlapping, overlapRate,
    verdict: overlapRate > 40
      ? 'HIGH_OVERLAP — OB takes precedence over FVG when both fire'
      : 'LOW_OVERLAP — OB and FVG can be active simultaneously',
    timestamp: new Date().toISOString(),
  };

  saveResult('ob_fvg_correlation.json', correlationResult);
  logger.info(`OB/FVG overlap: ${overlapping}/${obTrades.length} trades (${overlapRate}%) — ${correlationResult.verdict}`);

  // ── Step 2.9: Accept/Reject Decision ────────────────────────────────────
  logger.phase('D7', '2.9', '=== ACCEPT/REJECT DECISION ===');

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
    obFvgOverlapRate: overlapRate,
    criteria: {
      pf_gt_1_5: fg.pf > 1.5, dd_lt_8: fg.maxDD < 8, wr_gt_42: fg.wr.point > 0.42,
      regimes_ge_2: positiveRegimes >= 2, sensitivity_pass: sensitivityPass, years_ge_3: positiveYears >= 3,
    },
    timestamp: new Date().toISOString(),
  };

  saveResult('ob_decision.json', decision);
  logger.phase('D7', 'decision', `VERDICT: ${decision.verdict}`);
  logger.phase('D7', 'decision', `PF=${fg.pf} DD=${fg.maxDD}% WR=${(fg.wr.point*100).toFixed(1)}% Trades=${fg.trades}`);
  logger.phase('D7', 'done', 'OB backtest complete. Check results/ directory.');
}

main().catch(e => {
  logger.error('OB backtest failed', { message: e.message, stack: e.stack });
  process.exit(1);
});
