'use strict';

/**
 * BulletBrain v3.0 — OHLCV Klines Downloader
 * Phase D1 — Step 0.2
 *
 * Downloads historical klines from Binance Futures REST API.
 * Source: backtestplan.md lines 91-128
 *
 * - Paginates in batches of 1500 (Binance max per request)
 * - Appends to NDJSON (one candle per line — streaming-safe)
 * - Resumes from last downloaded candle if interrupted
 * - Respects rate limits (100ms sleep between requests)
 */

const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const logger  = require('../utils/logger');
const { DATA } = require('../../config');

const BASE_URL    = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BATCH_LIMIT = 1500;   // Binance max candles per request
const SLEEP_MS    = 100;    // ms between requests — stays well under rate limit

// Binance interval string mapping
const INTERVAL_MAP = {
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
};

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the output file path for a symbol/interval pair
 */
function getFilePath(symbol, interval) {
  return path.join(process.cwd(), DATA.paths.historical, `${symbol}_${interval}.ndjson`);
}

/**
 * Read the last candle's openTime from an existing NDJSON file.
 * Returns null if file doesn't exist or is empty.
 * Used to resume interrupted downloads.
 */
function getLastTimestamp(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return null;

  const lines = content.split('\n').filter(l => l.trim());
  if (!lines.length) return null;

  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return last.openTime;
  } catch {
    return null;
  }
}

/**
 * Append an array of candle objects to an NDJSON file.
 * Each candle is written as one JSON line.
 */
function appendNDJSON(filePath, candles) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = candles.map(c => JSON.stringify(c)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
}

/**
 * Parse a raw Binance kline array into a candle object.
 * Binance kline format:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume,
 *  trades, takerBuyBase, takerBuyQuote, ignore]
 */
function parseKline(raw) {
  return {
    openTime:  raw[0],
    open:      parseFloat(raw[1]),
    high:      parseFloat(raw[2]),
    low:       parseFloat(raw[3]),
    close:     parseFloat(raw[4]),
    volume:    parseFloat(raw[5]),
    closeTime: raw[6],
    trades:    raw[8],
  };
}

/**
 * Fetch one batch of klines from Binance Futures API.
 */
async function fetchKlines(symbol, interval, startTime) {
  const url = `${BASE_URL}/fapi/v1/klines`;
  const params = {
    symbol,
    interval: INTERVAL_MAP[interval] || interval,
    startTime,
    limit: BATCH_LIMIT,
  };

  const response = await axios.get(url, { params, timeout: 15000 });
  return response.data;
}

/**
 * Download all klines for a symbol/interval between startDate and endDate.
 * Resumes from last downloaded candle if file already exists.
 *
 * @param {string} symbol   - e.g. 'BTCUSDT'
 * @param {string} interval - e.g. '15m', '1h', '4h', '1d'
 * @param {number} startMs  - start timestamp in milliseconds
 * @param {number} endMs    - end timestamp in milliseconds
 */
async function downloadKlines(symbol, interval, startMs, endMs) {
  const filePath = getFilePath(symbol, interval);

  // Resume from last downloaded candle
  const lastTs = getLastTimestamp(filePath);
  let cursor   = lastTs ? lastTs + 1 : startMs;

  if (lastTs) {
    logger.info(`Resuming ${symbol} ${interval} from ${new Date(cursor).toISOString()}`);
  } else {
    logger.info(`Starting ${symbol} ${interval} from ${new Date(cursor).toISOString()}`);
  }

  let totalCandles = 0;
  let batchCount   = 0;

  while (cursor < endMs) {
    try {
      const raw = await fetchKlines(symbol, interval, cursor);

      if (!raw || raw.length === 0) {
        logger.info(`No more data for ${symbol} ${interval} at ${new Date(cursor).toISOString()}`);
        break;
      }

      const candles = raw.map(parseKline);

      // Filter candles beyond endMs
      const filtered = candles.filter(c => c.openTime <= endMs);
      if (filtered.length === 0) break;

      appendNDJSON(filePath, filtered);

      totalCandles += filtered.length;
      batchCount++;
      cursor = filtered[filtered.length - 1].openTime + 1;

      if (batchCount % 10 === 0) {
        logger.info(`${symbol} ${interval}: ${totalCandles} candles, up to ${new Date(cursor).toISOString()}`);
      }

      // Stop if we got fewer than BATCH_LIMIT (means we've reached the end)
      if (raw.length < BATCH_LIMIT) break;

      await sleep(SLEEP_MS);

    } catch (err) {
      logger.error(`Error downloading ${symbol} ${interval}`, {
        message: err.message,
        cursor:  new Date(cursor).toISOString(),
      });

      // Retry after longer sleep on error
      await sleep(2000);
    }
  }

  logger.info(`Done: ${symbol} ${interval} — ${totalCandles} candles total`);
  return totalCandles;
}

/**
 * Download all coins and timeframes defined in config.
 * Runs sequentially to respect rate limits.
 */
async function downloadAll() {
  const startMs = new Date(DATA.startDate + 'T00:00:00Z').getTime();
  const endMs   = new Date(DATA.endDate   + 'T23:59:59Z').getTime();

  logger.phase('D1', 'download', `Starting full download: ${DATA.startDate} → ${DATA.endDate}`);
  logger.phase('D1', 'download', `Coins: ${DATA.coins.join(', ')}`);
  logger.phase('D1', 'download', `Timeframes: ${DATA.timeframes.join(', ')}`);

  const results = [];

  for (const symbol of DATA.coins) {
    for (const interval of DATA.timeframes) {
      const count = await downloadKlines(symbol, interval, startMs, endMs);
      results.push({ symbol, interval, candles: count });
    }
  }

  logger.phase('D1', 'download', 'All downloads complete');
  return results;
}

module.exports = { downloadKlines, downloadAll, getFilePath, getLastTimestamp };
