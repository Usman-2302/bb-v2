'use strict';

/**
 * Dataset Manager — the data layer's single entry point.
 *
 * Responsibilities:
 *  - keep the 15m base store current (incremental, resumable)
 *  - maintain funding-rate datasets
 *  - version every dataset by content so a result can always be traced to the
 *    exact bytes that produced it
 *
 * Why versioning matters: an experiment archived six months from now is
 * worthless if you cannot tell whether a changed result came from changed code
 * or changed data. Every experiment record stores a dataset fingerprint.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { downloadKlines } = require('../../data/downloader');
const { loadBase } = require('./candles');

const HIST_DIR = () => path.join(process.cwd(), 'data', 'historical');
const FUND_DIR = () => path.join(process.cwd(), 'data', 'funding');
const META_FILE = () => path.join(process.cwd(), 'data', 'dataset-meta.json');

function readMeta() {
  const p = META_FILE();
  if (!fs.existsSync(p)) return { datasets: {} };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { datasets: {} }; }
}

function writeMeta(m) {
  fs.mkdirSync(path.dirname(META_FILE()), { recursive: true });
  fs.writeFileSync(META_FILE(), JSON.stringify(m, null, 2));
}

/**
 * Fingerprint a dataset cheaply but unambiguously: row count plus first/last
 * timestamps plus a hash of the final 64KB. Hashing 28MB per symbol on every
 * cycle would dominate runtime; this catches any append, truncation or rewrite.
 */
function fingerprint(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const tailLen = Math.min(65536, stat.size);
  const buf = Buffer.alloc(tailLen);
  fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen);
  fs.closeSync(fd);
  return {
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    tailSha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
  };
}

/** Bring one symbol's 15m base store up to the present. */
async function updateSymbol(symbol, { startDate = '2021-01-01' } = {}) {
  const start = Date.parse(startDate + 'T00:00:00Z');
  const end = Date.now();
  const before = fingerprint(path.join(HIST_DIR(), `${symbol}_15m.ndjson`));
  await downloadKlines(symbol, '15m', start, end);   // resumes from last row
  const after = fingerprint(path.join(HIST_DIR(), `${symbol}_15m.ndjson`));
  return {
    symbol,
    changed: !before || !after || before.tailSha256 !== after.tailSha256,
    before, after,
  };
}

/** Update every configured symbol and record versions. */
async function updateAll(symbols, opts = {}) {
  const meta = readMeta();
  const results = [];
  for (const s of symbols) {
    let r;
    try {
      r = await updateSymbol(s, opts);
    } catch (e) {
      r = { symbol: s, changed: false, error: e.message };
    }
    results.push(r);
    if (r.after) {
      meta.datasets[`${s}_15m`] = {
        ...r.after,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  meta.lastUpdate = new Date().toISOString();
  writeMeta(meta);
  return results;
}

/** Describe what is currently on disk, including coverage gaps. */
function inventory(symbols) {
  const out = [];
  for (const s of symbols) {
    const p = path.join(HIST_DIR(), `${s}_15m.ndjson`);
    if (!fs.existsSync(p)) { out.push({ symbol: s, present: false }); continue; }
    let candles;
    try { candles = loadBase(s); } catch (e) { out.push({ symbol: s, present: false, error: e.message }); continue; }
    const n = candles.length;
    const first = candles[0].openTime, last = candles[n - 1].openTime;
    const expected = Math.floor((last - first) / (15 * 60 * 1000)) + 1;
    out.push({
      symbol: s, present: true, candles: n,
      from: new Date(first).toISOString().slice(0, 16),
      to: new Date(last).toISOString().slice(0, 16),
      completeness: expected > 0 ? n / expected : NaN,
      missingBars: Math.max(0, expected - n),
      staleHours: (Date.now() - last) / 3600000,
      fingerprint: fingerprint(p),
    });
  }
  return out;
}

/** A single string identifying the whole data state, for experiment records. */
function datasetVersion(symbols) {
  const inv = inventory(symbols).filter(i => i.present);
  const h = crypto.createHash('sha256');
  for (const i of inv) h.update(i.symbol + ':' + i.candles + ':' + (i.fingerprint?.tailSha256 || ''));
  return {
    hash: h.digest('hex').slice(0, 16),
    symbols: inv.map(i => ({ symbol: i.symbol, candles: i.candles, to: i.to })),
  };
}

module.exports = {
  updateSymbol, updateAll, inventory, datasetVersion, fingerprint, readMeta, writeMeta,
  HIST_DIR, FUND_DIR,
};
