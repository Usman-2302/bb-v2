'use strict';

/**
 * BulletBrain v3.0 — Open Interest Downloader
 * Phase D1 — Step 0.2 (REVISED)
 *
 * Downloads OI history from Binance Futures REST API.
 * Source: backtestplan.md lines 105-112
 *
 * IMPORTANT LIMITATION:
 * Binance's /futures/data/openInterestHist endpoint only provides
 * the last 30 days of data. Historical OI beyond 30 days is not
 * publicly available via Binance APIs.
 *
 * STRATEGY:
 * 1. Download available OI via REST API (last 30 days, max 500 per request)
 * 2. For backtesting 2021-2024: OI data will be sparse/unavailable
 *    The LSO strategy will use the OI gate where data exists,
 *    and fall back to CVD-only confirmation where OI is unavailable.
 *    This is logged per trade as trade.oi_data_available = false.
 *
 * Output: data/oi/{symbol}_1h.ndjson
 */

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const logger = require('../utils/logger');
const { DATA } = require('../../config');

const BASE_URL    = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BATCH_LIMIT = 500;   // max per request for openInterestHist

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

function getOIFilePath(symbol) {
  const cfg = require('../../config');
  return resolvePath(cfg.DATA.paths.oi, `${symbol}_1h.ndjson`);
}

function getLastOITimestamp(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return null;
  const lines = content.split('\n').filter(l => l.trim());
  if (!lines.length) return null;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return last.timestamp;
  } catch { return null; }
}

function appendOINDJSON(filePath, records) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
}

/**
 * Download OI via REST API.
 * NOTE: Only last ~30 days available from Binance.
 * For historical backtesting, OI gate will be skipped where data is absent.
 */
async function downloadOI(symbol) {
  const filePath = getOIFilePath(symbol);
  const lastTs   = getLastOITimestamp(filePath);

  // Start from 30 days ago or last downloaded timestamp
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  let cursor = lastTs ? lastTs + 1 : thirtyDaysAgo;

  logger.info(`OI download: ${symbol} from ${new Date(cursor).toISOString()} (REST API, last 30 days only)`);

  let totalRecords = 0;

  while (true) {
    try {
      const response = await axios.get(`${BASE_URL}/futures/data/openInterestHist`, {
        params: { symbol, period: '1h', limit: BATCH_LIMIT, startTime: cursor },
        timeout: 15000,
      });

      const raw = response.data;
      if (!raw || raw.length === 0) break;

      const records = raw.map(r => ({
        timestamp: r.timestamp,
        oi:        parseFloat(r.sumOpenInterest),
        symbol:    r.symbol,
      }));

      appendOINDJSON(filePath, records);
      totalRecords += records.length;
      cursor = records[records.length - 1].timestamp + 1;

      if (raw.length < BATCH_LIMIT) break;
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      logger.error(`OI fetch error for ${symbol}`, { message: err.message });
      break;
    }
  }

  logger.info(`OI done: ${symbol} — ${totalRecords} records (last 30 days)`);
  if (totalRecords === 0) {
    logger.warn(`OI: No data available for ${symbol}. LSO will use CVD-only confirmation for historical backtest.`);
  }
  return totalRecords;
}

async function downloadAllOI() {
  logger.phase('D1', 'oi', 'Downloading OI (REST API — last 30 days available)');
  logger.phase('D1', 'oi', 'NOTE: Binance does not provide historical OI beyond 30 days publicly.');
  logger.phase('D1', 'oi', 'For 2021-2024 backtest: LSO OI gate will be skipped where data is absent.');

  const results = [];
  for (const symbol of DATA.coins) {
    const count = await downloadOI(symbol);
    results.push({ symbol, records: count });
  }

  logger.phase('D1', 'oi', 'OI download complete');
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK HISTORICAL OI DOWNLOADER — REVISED (Phase D8 finding)
//
// CRITICAL FINDING: Binance Vision does NOT have historical OI data.
// The URL format https://data.binance.vision/data/futures/um/daily/openInterest/
// returns 404 for all dates. Binance Vision only has klines, aggTrades, trades.
//
// Binance's /futures/data/openInterestHist API: LAST 30 DAYS ONLY.
// Source: https://developers.binance.me/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics
//
// ALTERNATIVE SOURCES for 2021-2024 historical OI:
//   1. Coinglass API (paid) — https://docs.coinglass.com/reference/oi-ohlc-histroy
//      Endpoint: GET https://open-api-v4.coinglass.com/api/futures/open-interest/history
//      Supports: 1h interval, Binance exchange, BTCUSDT pair, full history
//      Requires: API key (paid plan)
//
//   2. Manual export from Coinglass website (free, limited)
//      URL: https://www.coinglass.com/pro/futures/OpenInterest
//      Export: CSV, max 1 year per export, requires account
//
//   3. CryptoQuant, Glassnode (paid data providers)
//
// IMPACT ON LSO STRATEGY:
//   Without 2021-2024 OI data, the OI gate cannot be validated.
//   The baseline (NO_OI, CVD gate) shows PF 2.878 with 18 trades.
//   This is the best available result until OI data is sourced.
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download historical OI from Coinglass API.
 * Requires COINGLASS_API_KEY in .env file.
 *
 * @param {string} symbol    - e.g. 'BTCUSDT'
 * @param {string} startDate - 'YYYY-MM-DD'
 * @param {string} endDate   - 'YYYY-MM-DD'
 * @returns {Promise<number>} total records written
 */
async function downloadOIFromCoinglass(symbol, startDate, endDate) {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) {
    logger.error('COINGLASS_API_KEY not set in .env file');
    logger.error('Get a free/paid API key from: https://coinglass.com/pricing');
    logger.error('Add to .env: COINGLASS_API_KEY=your_key_here');
    return 0;
  }

  const filePath    = getOIFilePath(symbol);
  const COINGLASS_BASE = 'https://open-api-v4.coinglass.com/api/futures/open-interest/history';
  const INTERVAL    = '1h';
  const LIMIT       = 1000;

  let cursor    = new Date(startDate).getTime();
  const endTs   = new Date(endDate).getTime() + 86400000;
  let totalRecords = 0;

  logger.info(`OI Coinglass download: ${symbol} from ${startDate} to ${endDate}`);

  while (cursor < endTs) {
    try {
      const response = await axios.get(COINGLASS_BASE, {
        headers: { 'CG-API-KEY': apiKey },
        params: {
          exchange:  'Binance',
          symbol,
          interval:  INTERVAL,
          limit:     LIMIT,
          startTime: cursor,
          endTime:   Math.min(cursor + LIMIT * 3600000, endTs),
          unit:      'coin',
        },
        timeout: 15000,
      });

      const data = response.data?.data;
      if (!data || data.length === 0) break;

      const records = data.map(r => ({
        timestamp: r.t || r.time,
        oi:        parseFloat(r.c || r.close || r.o),
        symbol,
      })).filter(r => !isNaN(r.oi) && !isNaN(r.timestamp));

      if (records.length > 0) {
        appendOINDJSON(filePath, records);
        totalRecords += records.length;
        cursor = records[records.length - 1].timestamp + 3600000;
      } else {
        break;
      }

      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      if (err.response?.status === 401) {
        logger.error('Coinglass API key invalid or expired');
        break;
      }
      logger.warn(`Coinglass OI fetch error for ${symbol}: ${err.message}`);
      break;
    }
  }

  logger.info(`OI Coinglass done: ${symbol} — ${totalRecords} records`);
  return totalRecords;
}

/**
 * Download historical OI for all coins from Coinglass.
 * Run once after setting COINGLASS_API_KEY in .env.
 */
async function downloadAllOIFromCoinglass() {
  logger.phase('D8', 'oi_coinglass', 'Downloading historical OI from Coinglass API (2021-2024)');
  logger.phase('D8', 'oi_coinglass', 'Requires COINGLASS_API_KEY in .env file');

  const results = [];
  for (const symbol of DATA.coins) {
    const count = await downloadOIFromCoinglass(symbol, DATA.startDate, DATA.endDate);
    results.push({ symbol, records: count });
    logger.info(`${symbol}: ${count} OI records downloaded`);
  }

  logger.phase('D8', 'oi_coinglass', 'Coinglass OI download complete');
  logger.phase('D8', 'oi_coinglass', 'Re-run LSO backtest: node src/backtest/run_lso_backtest.js');
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY: Bulk downloader (kept for reference — URL format was wrong)
// The Binance Vision OI endpoint does not exist. This function returns 0.
// ─────────────────────────────────────────────────────────────────────────────

async function downloadOIBulkHistorical(symbol, startDate, endDate) {
  logger.error('downloadOIBulkHistorical: Binance Vision does NOT have historical OI data.');
  logger.error('Use downloadOIFromCoinglass() instead (requires COINGLASS_API_KEY).');
  logger.error('See src/data/oiDownloader.js for details.');
  return 0;
}

async function downloadAllOIBulkHistorical() {
  logger.error('Binance Vision OI bulk download: URL format was incorrect (404 on all dates).');
  logger.error('Historical OI is not available on Binance Vision.');
  logger.error('Use: node src/data/oiDownloader.js --coinglass (requires API key)');
  return [];
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--coinglass')) {
    require('dotenv').config();
    downloadAllOIFromCoinglass().catch(err => {
      logger.error('Coinglass OI download failed', { message: err.message });
      process.exit(1);
    });
  } else if (args.includes('--bulk')) {
    logger.error('--bulk flag: Binance Vision OI endpoint does not exist (404).');
    logger.error('Use --coinglass flag instead (requires COINGLASS_API_KEY in .env).');
    process.exit(1);
  } else {
    downloadAllOI().catch(err => {
      logger.error('OI download failed', { message: err.message });
      process.exit(1);
    });
  }
}

module.exports = {
  downloadOI,
  downloadAllOI,
  getOIFilePath,
  downloadOIBulkHistorical,
  downloadAllOIBulkHistorical,
  downloadOIFromCoinglass,
  downloadAllOIFromCoinglass,
};
