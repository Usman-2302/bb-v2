'use strict';

/**
 * BulletBrain v3.0 — Download Runner
 * Phase D1
 *
 * Run this script to download all historical data.
 * Usage: node src/data/run_download.js [--klines] [--oi] [--funding] [--validate]
 *
 * Flags:
 *   --klines   Download OHLCV klines (default: true)
 *   --oi       Download Open Interest (default: true)
 *   --funding  Download Funding Rates (default: true)
 *   --validate Run validation after download (default: true)
 *   --all      Run everything (default)
 *
 * Example:
 *   node src/data/run_download.js --all
 *   node src/data/run_download.js --validate   (validate only, no download)
 */

require('dotenv').config();

const { downloadAll }        = require('./downloader');
const { downloadAllOI }      = require('./oiDownloader');
const { downloadAllFunding } = require('./fundingDownloader');
const { validateAll }        = require('./validator');
const logger                 = require('../utils/logger');

async function main() {
  const args = process.argv.slice(2);

  const runKlines  = args.includes('--klines')  || args.includes('--all') || args.length === 0;
  const runOI      = args.includes('--oi')       || args.includes('--all') || args.length === 0;
  const runFunding = args.includes('--funding')  || args.includes('--all') || args.length === 0;
  const runValidate = args.includes('--validate') || args.includes('--all') || args.length === 0;

  logger.phase('D1', 'start', 'BulletBrain v3.0 — Phase D1 Data Download');
  logger.phase('D1', 'start', `Tasks: klines=${runKlines} oi=${runOI} funding=${runFunding} validate=${runValidate}`);

  const startTime = Date.now();

  try {
    if (runKlines) {
      logger.phase('D1', 'klines', 'Starting OHLCV download...');
      await downloadAll();
    }

    if (runOI) {
      logger.phase('D1', 'oi', 'Starting OI download...');
      await downloadAllOI();
    }

    if (runFunding) {
      logger.phase('D1', 'funding', 'Starting funding rate download...');
      await downloadAllFunding();
    }

    if (runValidate) {
      logger.phase('D1', 'validate', 'Running validation...');
      const report = validateAll();

      if (report.summary.critical > 0) {
        logger.error(`Validation FAILED: ${report.summary.critical} critical issues`);
        process.exit(1);
      }

      if (report.summary.missing > 0) {
        logger.warn(`${report.summary.missing} files missing — re-run download`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    logger.phase('D1', 'done', `Phase D1 complete in ${elapsed} minutes`);

  } catch (err) {
    logger.error('Phase D1 failed', { message: err.message, stack: err.stack });
    process.exit(1);
  }
}

main();
