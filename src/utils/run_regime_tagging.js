'use strict';

/**
 * BulletBrain v3.0 — Regime Tagging Runner
 * Phase D3 — Steps 0.5, 0.7
 *
 * Usage:
 *   node src/utils/run_regime_tagging.js --calibrate   (run calibration only)
 *   node src/utils/run_regime_tagging.js --tag         (tag all candles)
 *   node src/utils/run_regime_tagging.js --all         (calibrate then tag)
 *
 * Output:
 *   results/regime_calibration.json  — calibration results per threshold
 *   data/historical/{symbol}_{tf}_tagged.ndjson — candles with .regime field
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const { loadNDJSON }              = require('../data/loader');
const { calibrateSlopeThreshold, tagRegimes4H, propagateRegime } = require('./regimeDetector');
const logger                      = require('./logger');
const { DATA, REGIME }            = require('../../config');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

/**
 * Run slope threshold calibration on BTC 4H data.
 * Saves results to results/regime_calibration.json.
 */
async function runCalibration() {
  logger.phase('D3', 'calibrate', 'Loading BTC 4H candles for calibration...');

  const filePath  = resolvePath(DATA.paths.historical, 'BTCUSDT_4h.ndjson');
  const candles4H = loadNDJSON(filePath);

  if (candles4H.length === 0) {
    logger.error('No BTC 4H data found. Run Phase D1 first.');
    process.exit(1);
  }

  logger.phase('D3', 'calibrate', `Loaded ${candles4H.length} BTC 4H candles`);
  logger.phase('D3', 'calibrate', 'Testing slope thresholds: [8, 10, 12, 15, 18, 20, 22]°');

  const results = calibrateSlopeThreshold(candles4H);

  // Print table
  console.log('\n┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Thresh°  │ BULL%    │ BEAR%    │ RANGING% │ CRISIS%  │ BULL WR  │ RNG WR   │ WR Delta │');
  console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');
  results.forEach(r => {
    console.log(
      `│ ${String(r.threshold).padEnd(8)} │ ${String(r.bull_pct+'%').padEnd(8)} │ ${String(r.bear_pct+'%').padEnd(8)} │ ${String(r.ranging_pct+'%').padEnd(8)} │ ${String(r.crisis_pct+'%').padEnd(8)} │ ${String(r.bull_wr+'%').padEnd(8)} │ ${String(r.ranging_wr+'%').padEnd(8)} │ ${String(r.wr_delta+'%').padEnd(8)} │`
    );
  });
  console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

  // Find optimal threshold (max WR delta, RANGING < 60%, BULL > 10%)
  const valid = results.filter(r =>
    parseFloat(r.ranging_pct) < 60 &&
    parseFloat(r.bull_pct) > 10
  );
  const optimal = valid.reduce((best, r) =>
    parseFloat(r.wr_delta) > parseFloat(best.wr_delta) ? r : best
  , valid[0] || results[0]);

  console.log(`\n✓ Recommended threshold: ${optimal.threshold}°`);
  console.log(`  WR delta: ${optimal.wr_delta}% (BULL WR ${optimal.bull_wr}% vs RANGING WR ${optimal.ranging_wr}%)`);
  console.log(`  Distribution: BULL ${optimal.bull_pct}% | BEAR ${optimal.bear_pct}% | RANGING ${optimal.ranging_pct}%`);
  console.log(`\n  Current config.js slopeThreshold: ${REGIME.slopeThreshold}°`);

  if (parseInt(optimal.threshold) !== REGIME.slopeThreshold) {
    console.log(`  ⚠ Consider updating config.js REGIME.slopeThreshold to ${optimal.threshold}`);
  } else {
    console.log(`  ✓ Config threshold matches optimal`);
  }

  // Save results
  const resultsDir = resolvePath(DATA.paths.results);
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, 'regime_calibration.json');
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp:          new Date().toISOString(),
    candles_analyzed:   candles4H.length,
    results,
    recommended:        optimal,
    current_config:     REGIME.slopeThreshold,
  }, null, 2));

  logger.phase('D3', 'calibrate', `Calibration saved: ${outPath}`);
  return optimal;
}

/**
 * Tag all historical candles with regime.
 * Reads 4H BTC candles, computes regimes, propagates to all symbols/timeframes.
 */
async function runTagging() {
  logger.phase('D3', 'tag', 'Starting regime tagging for all candles...');

  // Load BTC 4H candles (regime source)
  const btc4HPath  = resolvePath(DATA.paths.historical, 'BTCUSDT_4h.ndjson');
  const candles4H  = loadNDJSON(btc4HPath);

  if (candles4H.length === 0) {
    logger.error('No BTC 4H data. Run Phase D1 first.');
    process.exit(1);
  }

  logger.phase('D3', 'tag', `Computing regimes for ${candles4H.length} BTC 4H candles...`);

  // Tag 4H BTC candles
  const regimes4H = tagRegimes4H(candles4H, REGIME.slopeThreshold);
  const tagged4H  = candles4H.map((c, i) => ({ ...c, regime: regimes4H[i] }));

  // Count regime distribution for validation
  const dist = {};
  regimes4H.forEach(r => { dist[r] = (dist[r] || 0) + 1; });
  logger.phase('D3', 'tag', `Regime distribution: ${JSON.stringify(dist)}`);

  // Save tagged BTC 4H
  const btc4HTaggedPath = resolvePath(DATA.paths.historical, 'BTCUSDT_4h_tagged.ndjson');
  fs.writeFileSync(btc4HTaggedPath,
    tagged4H.map(c => JSON.stringify(c)).join('\n') + '\n');
  logger.phase('D3', 'tag', `Saved: BTCUSDT_4h_tagged.ndjson`);

  // Propagate to all symbols and timeframes
  for (const symbol of DATA.coins) {
    for (const interval of DATA.timeframes) {
      if (symbol === 'BTCUSDT' && interval === '4h') continue; // already done

      const inPath  = resolvePath(DATA.paths.historical, `${symbol}_${interval}.ndjson`);
      const outPath = resolvePath(DATA.paths.historical, `${symbol}_${interval}_tagged.ndjson`);

      if (!fs.existsSync(inPath)) {
        logger.warn(`Skipping ${symbol} ${interval} — file not found`);
        continue;
      }

      const candles  = loadNDJSON(inPath);
      const regimes  = propagateRegime(candles, tagged4H);
      const tagged   = candles.map((c, i) => ({ ...c, regime: regimes[i] }));

      fs.writeFileSync(outPath, tagged.map(c => JSON.stringify(c)).join('\n') + '\n');
      logger.info(`Tagged: ${symbol} ${interval} — ${tagged.length} candles`);
    }
  }

  logger.phase('D3', 'tag', 'All candles tagged with regime');

  // Export regime periods CSV for visual validation
  exportRegimeCSV(tagged4H);
}

/**
 * Export regime periods to CSV for visual validation in Excel/TradingView.
 */
function exportRegimeCSV(tagged4H) {
  const resultsDir = resolvePath(DATA.paths.results);
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const csvPath = path.join(resultsDir, 'regime_periods.csv');
  const lines   = ['date,regime,close,atr_pct'];

  tagged4H.forEach(c => {
    const date = new Date(c.openTime).toISOString().slice(0, 16);
    lines.push(`${date},${c.regime},${c.close}`);
  });

  fs.writeFileSync(csvPath, lines.join('\n'));
  logger.phase('D3', 'tag', `Regime CSV exported: ${csvPath}`);
  logger.phase('D3', 'tag', 'Open regime_periods.csv and verify:');
  logger.phase('D3', 'tag', '  2021 Q1-Q3 = BULL | 2022 = BEAR | Nov 2022 = CRISIS | 2023 Q1-Q2 = RANGING→BULL');
}

async function main() {
  const args       = process.argv.slice(2);
  const doCalib    = args.includes('--calibrate') || args.includes('--all') || args.length === 0;
  const doTag      = args.includes('--tag')       || args.includes('--all') || args.length === 0;

  logger.phase('D3', 'start', 'BulletBrain v3.0 — Phase D3 Regime Engine');

  if (doCalib) await runCalibration();
  if (doTag)   await runTagging();

  logger.phase('D3', 'done', 'Phase D3 complete');
}

main().catch(e => {
  logger.error('Phase D3 failed', { message: e.message });
  process.exit(1);
});
