'use strict';

/**
 * BulletBrain v3.0 — Funding Rate Downloader
 * Phase D1 — Step 0.2
 *
 * Downloads 8H funding rate history from Binance Futures REST API.
 * Source: backtestplan.md lines 231-265 (COSTS object funding section)
 *
 * CRITICAL: The flat 0.01% assumption is 5-8× too low in BULL regimes.
 * This data is used by applyFundingCost() in the engine for accurate P&L.
 * Output: data/funding/{symbol}_8h.ndjson
 *
 * Endpoint: GET /fapi/v1/fundingRate
 * Returns: [{ symbol, fundingTime, fundingRate, markPrice }]
 * Max 1000 records per request. Funding occurs every 8H.
 */

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const logger = require('../utils/logger');
const { DATA } = require('../../config');

const BASE_URL    = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BATCH_LIMIT = 1000;

/**
 * Get output file path for funding data
 */
function getFundingFilePath(symbol) {
  return path.join(process.cwd(), DATA.paths.funding, `${symbol}_8h.ndjson`);
}

/**
 * Get last downloaded funding timestamp from NDJSON file
 */
function getLastFundingTimestamp(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return null;

  const lines = content.split('\n').filter(l => l.trim());
  if (!lines.length) return null;

  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return last.timestamp;
  } catch {
    return null;
  }
}

/**
 * Append funding records to NDJSON file
 */
function appendFundingNDJSON(filePath, records) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
}

/**
 * Fetch one batch of funding rates from Binance
 */
async function fetchFundingRates(symbol, startTime) {
  const url = `${BASE_URL}/fapi/v1/fundingRate`;
  const params = { symbol, startTime, limit: BATCH_LIMIT };

  const response = await axios.get(url, { params, timeout: 15000 });
  return response.data;
}

/**
 * Download all funding rates for a symbol between startDate and endDate.
 */
async function downloadFunding(symbol, startDate, endDate) {
  const filePath = getFundingFilePath(symbol);
  const startMs  = new Date(startDate + 'T00:00:00Z').getTime();
  const endMs    = new Date(endDate   + 'T23:59:59Z').getTime();

  // Resume from last downloaded record
  const lastTs = getLastFundingTimestamp(filePath);
  let cursor   = lastTs ? lastTs + 1 : startMs;

  if (lastTs) {
    logger.info(`Resuming funding ${symbol} from ${new Date(cursor).toISOString()}`);
  } else {
    logger.info(`Starting funding ${symbol} from ${new Date(cursor).toISOString()}`);
  }

  let totalRecords = 0;

  while (cursor < endMs) {
    try {
      const raw = await fetchFundingRates(symbol, cursor);

      if (!raw || raw.length === 0) break;

      // Normalize to our schema: { timestamp, rate }
      const records = raw
        .filter(r => r.fundingTime <= endMs)
        .map(r => ({
          timestamp: r.fundingTime,
          rate:      parseFloat(r.fundingRate),
          symbol:    r.symbol,
        }));

      if (records.length === 0) break;

      appendFundingNDJSON(filePath, records);
      totalRecords += records.length;
      cursor = records[records.length - 1].timestamp + 1;

      if (raw.length < BATCH_LIMIT) break;

      await new Promise(r => setTimeout(r, 100));

    } catch (err) {
      logger.error(`Funding fetch error for ${symbol}`, { message: err.message });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  logger.info(`Funding done: ${symbol} — ${totalRecords} records`);
  return totalRecords;
}

/**
 * Download funding rates for all coins
 */
async function downloadAllFunding() {
  logger.phase('D1', 'funding', `Downloading funding rates: ${DATA.startDate} → ${DATA.endDate}`);

  const results = [];
  for (const symbol of DATA.coins) {
    const count = await downloadFunding(symbol, DATA.startDate, DATA.endDate);
    results.push({ symbol, records: count });
  }

  logger.phase('D1', 'funding', 'Funding download complete');
  return results;
}

module.exports = { downloadFunding, downloadAllFunding, getFundingFilePath };
