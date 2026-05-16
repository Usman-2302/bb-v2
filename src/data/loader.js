'use strict';

/**
 * BulletBrain v3.0 — NDJSON Data Loader
 * Phase D1
 *
 * Streaming NDJSON loader for the backtest engine.
 * Never loads entire file into memory — streams one candle at a time.
 * Source: backtestplan.md Step 0.1 (NDJSON storage decision)
 */

const fs   = require('fs');
const path = require('path');
const { DATA } = require('../../config');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

/**
 * Stream candles from an NDJSON file.
 * Calls onCandle(candle) for each candle in chronological order.
 * Calls onDone(totalCount) when complete.
 *
 * @param {string}   filePath  - path to NDJSON file
 * @param {Function} onCandle  - callback for each candle
 * @param {Function} [onDone]  - optional callback when done
 */
function streamNDJSON(filePath, onCandle, onDone) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    let buffer = '';
    let count  = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

    stream.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const candle = JSON.parse(trimmed);
          onCandle(candle);
          count++;
        } catch {
          // skip malformed lines
        }
      }
    });

    stream.on('end', () => {
      // Process any remaining buffer content
      if (buffer.trim()) {
        try {
          const candle = JSON.parse(buffer.trim());
          onCandle(candle);
          count++;
        } catch { /* skip */ }
      }
      if (onDone) onDone(count);
      resolve(count);
    });

    stream.on('error', reject);
  });
}

/**
 * Load all candles from an NDJSON file into memory.
 * Use only for small files or testing — prefer streamNDJSON for large datasets.
 *
 * @param {string} filePath
 * @returns {Array} candles
 */
function loadNDJSON(filePath) {
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
 * Get the file path for a klines NDJSON file
 */
function getKlinesPath(symbol, interval) {
  return resolvePath(DATA.paths.historical, `${symbol}_${interval}.ndjson`);
}

/**
 * Get the file path for an OI NDJSON file
 */
function getOIPath(symbol) {
  return resolvePath(DATA.paths.oi, `${symbol}_1h.ndjson`);
}

/**
 * Get the file path for a funding NDJSON file
 */
function getFundingPath(symbol) {
  return resolvePath(DATA.paths.funding, `${symbol}_8h.ndjson`);
}

/**
 * Load OI data into a Map for fast timestamp lookup.
 * Used by the engine's OI interpolation function.
 *
 * @param {string} symbol
 * @returns {Map<number, number>} timestamp → oi value
 */
function loadOIMap(symbol) {
  const cfg      = require('../../config');
  const filePath = resolvePath(cfg.DATA.paths.oi, `${symbol}_1h.ndjson`);
  const records  = loadNDJSON(filePath);
  const map      = new Map();
  records.forEach(r => map.set(r.timestamp, r.oi));
  return map;
}

/**
 * Load funding data into a Map for fast timestamp lookup.
 * Used by applyFundingCost() in the engine.
 *
 * @param {string} symbol
 * @returns {Map<number, number>} timestamp → funding rate
 */
function loadFundingMap(symbol) {
  const cfg      = require('../../config');
  const filePath = resolvePath(cfg.DATA.paths.funding, `${symbol}_8h.ndjson`);
  const records  = loadNDJSON(filePath);
  const map      = new Map();
  records.forEach(r => map.set(r.timestamp, r.rate));
  return map;
}

module.exports = {
  streamNDJSON,
  loadNDJSON,
  getKlinesPath,
  getOIPath,
  getFundingPath,
  loadOIMap,
  loadFundingMap,
};
