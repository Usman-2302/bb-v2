'use strict';

/**
 * BulletBrain v3.0 — Data Validator
 * Phase D1 — Step 0.2
 *
 * Validates downloaded NDJSON data files.
 * Source: backtestplan.md lines 120-128
 *
 * Checks:
 * 1. Gaps > 2 consecutive candles (exchange downtime is normal, > 10 = re-download)
 * 2. Candle count matches expected for the period
 * 3. Zero-volume candles (data artifacts — filter these)
 * 4. OI and funding file existence and record counts
 *
 * Output: results/data_validation.json
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');
const { DATA } = require('../../config');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}
const EXPECTED_CANDLES = {
  '15m': 1461 * 24 * 4,   // 140,256
  '1h':  1461 * 24,        // 35,064
  '4h':  1461 * 6,         // 8,766
  '1d':  1461,             // 1,461
};

// Interval in milliseconds
const INTERVAL_MS = {
  '15m': 15 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '4h':  4  * 60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
};

/**
 * Read all records from an NDJSON file.
 * Returns array of parsed objects.
 */
function readNDJSON(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];

  return content.split('\n')
    .filter(l => l.trim())
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Validate a single OHLCV NDJSON file.
 * Returns a validation result object.
 */
function validateKlines(symbol, interval) {
  // Read path dynamically so tests can patch config.DATA.paths
  const config  = require('../../config');
  const filePath = resolvePath(config.DATA.paths.historical, `${symbol}_${interval}.ndjson`);
  const result = {
    symbol,
    interval,
    filePath,
    exists:         false,
    candles:        0,
    expectedCandles: EXPECTED_CANDLES[interval] || 0,
    countOk:        false,
    gaps:           [],
    maxGap:         0,
    zeroVolume:     0,
    status:         'UNKNOWN',
    issues:         [],
  };

  if (!fs.existsSync(filePath)) {
    result.status = 'MISSING';
    result.issues.push('File does not exist');
    return result;
  }

  result.exists = true;
  const candles = readNDJSON(filePath);
  result.candles = candles.length;

  if (candles.length === 0) {
    result.status = 'EMPTY';
    result.issues.push('File is empty');
    return result;
  }

  // Check candle count (allow 2% tolerance for exchange downtime)
  const tolerance = result.expectedCandles * 0.02;
  result.countOk = Math.abs(candles.length - result.expectedCandles) <= tolerance;
  if (!result.countOk) {
    result.issues.push(
      `Candle count ${candles.length} vs expected ${result.expectedCandles} (${((candles.length / result.expectedCandles) * 100).toFixed(1)}%)`
    );
  }

  // Check for gaps
  const intervalMs = INTERVAL_MS[interval];
  let maxGap = 0;
  const gaps = [];

  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].openTime - candles[i - 1].openTime;
    const missedCandles = Math.round(diff / intervalMs) - 1;

    if (missedCandles > 0) {
      gaps.push({
        at:      new Date(candles[i - 1].openTime).toISOString(),
        missed:  missedCandles,
      });
      if (missedCandles > maxGap) maxGap = missedCandles;
    }
  }

  result.gaps   = gaps.filter(g => g.missed > 2);  // only report gaps > 2 candles
  result.maxGap = maxGap;

  if (maxGap > 10) {
    result.issues.push(`Large gap detected: ${maxGap} consecutive missing candles`);
  }

  // Check for zero-volume candles
  const zeroVol = candles.filter(c => c.volume === 0 || c.volume === null);
  result.zeroVolume = zeroVol.length;
  if (zeroVol.length > 0) {
    result.issues.push(`${zeroVol.length} zero-volume candles (data artifacts)`);
  }

  // Final status
  if (result.issues.length === 0) {
    result.status = 'OK';
  } else if (maxGap > 10 || !result.countOk) {
    result.status = 'CRITICAL';
  } else {
    result.status = 'WARNING';
  }

  return result;
}

/**
 * Validate OI data file for a symbol.
 */
function validateOI(symbol) {
  const config  = require('../../config');
  const filePath = resolvePath(config.DATA.paths.oi, `${symbol}_1h.ndjson`);
  const result = {
    symbol,
    filePath,
    exists:  false,
    records: 0,
    status:  'UNKNOWN',
    issues:  [],
  };

  if (!fs.existsSync(filePath)) {
    result.status = 'MISSING';
    result.issues.push('OI file does not exist');
    return result;
  }

  result.exists = true;
  const records = readNDJSON(filePath);
  result.records = records.length;

  // 4 years × 365.25 days × 24 hours = ~35,064 hourly records
  const expectedMin = 30000;
  if (records.length < expectedMin) {
    result.status = 'WARNING';
    result.issues.push(`Only ${records.length} OI records (expected >= ${expectedMin})`);
  } else {
    result.status = 'OK';
  }

  return result;
}

/**
 * Validate funding rate data file for a symbol.
 */
function validateFunding(symbol) {
  const config  = require('../../config');
  const filePath = resolvePath(config.DATA.paths.funding, `${symbol}_8h.ndjson`);
  const result = {
    symbol,
    filePath,
    exists:  false,
    records: 0,
    status:  'UNKNOWN',
    issues:  [],
  };

  if (!fs.existsSync(filePath)) {
    result.status = 'MISSING';
    result.issues.push('Funding file does not exist');
    return result;
  }

  result.exists = true;
  const records = readNDJSON(filePath);
  result.records = records.length;

  // 4 years × 365.25 days × 3 funding events/day = ~4,383 records
  const expectedMin = 4000;
  if (records.length < expectedMin) {
    result.status = 'WARNING';
    result.issues.push(`Only ${records.length} funding records (expected >= ${expectedMin})`);
  } else {
    result.status = 'OK';
  }

  return result;
}

/**
 * Run full validation on all downloaded data.
 * Outputs results/data_validation.json
 */
function validateAll() {
  logger.phase('D1', 'validate', 'Starting data validation');

  const report = {
    timestamp:  new Date().toISOString(),
    klines:     [],
    oi:         [],
    funding:    [],
    summary:    { ok: 0, warning: 0, critical: 0, missing: 0 },
  };

  // Validate klines
  for (const symbol of DATA.coins) {
    for (const interval of DATA.timeframes) {
      const result = validateKlines(symbol, interval);
      report.klines.push(result);

      const s = result.status;
      if (s === 'OK')       report.summary.ok++;
      else if (s === 'WARNING')  report.summary.warning++;
      else if (s === 'CRITICAL') report.summary.critical++;
      else                       report.summary.missing++;

      const icon = s === 'OK' ? '✓' : s === 'WARNING' ? '⚠' : '✗';
      logger.info(`${icon} ${symbol} ${interval}: ${result.candles} candles [${s}]${result.issues.length ? ' — ' + result.issues[0] : ''}`);
    }
  }

  // Validate OI
  for (const symbol of DATA.coins) {
    const result = validateOI(symbol);
    report.oi.push(result);
    const icon = result.status === 'OK' ? '✓' : '⚠';
    logger.info(`${icon} OI ${symbol}: ${result.records} records [${result.status}]`);
  }

  // Validate funding
  for (const symbol of DATA.coins) {
    const result = validateFunding(symbol);
    report.funding.push(result);
    const icon = result.status === 'OK' ? '✓' : '⚠';
    logger.info(`${icon} Funding ${symbol}: ${result.records} records [${result.status}]`);
  }

  // Save report
  const resultsDir = resolvePath(DATA.paths.results);
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const reportPath = path.join(resultsDir, 'data_validation.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  logger.phase('D1', 'validate', `Validation complete — OK:${report.summary.ok} WARN:${report.summary.warning} CRITICAL:${report.summary.critical} MISSING:${report.summary.missing}`);
  logger.phase('D1', 'validate', `Report saved: ${reportPath}`);

  return report;
}

module.exports = { validateAll, validateKlines, validateOI, validateFunding, readNDJSON };
