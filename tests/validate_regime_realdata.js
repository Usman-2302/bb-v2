'use strict';

/**
 * Real-data regime validation test — Phase D3
 *
 * Runs against actual downloaded BTC 4H data (not synthetic).
 * Checks that known historical periods are classified correctly.
 * This test catches formula errors that synthetic tests miss.
 *
 * Requires: data/historical/BTCUSDT_4h.ndjson (Phase D1 output)
 */

require('dotenv').config();
const path = require('path');
const { loadNDJSON } = require('../src/data/loader');
const { tagRegimes4H } = require('../src/utils/regimeDetector');
const { DATA } = require('../config');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL  ' + name + ' — ' + e.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Load real data
const filePath = resolvePath(DATA.paths.historical, 'BTCUSDT_4h.ndjson');
const candles  = loadNDJSON(filePath);

if (candles.length === 0) {
  console.error('ERROR: No BTC 4H data found. Run Phase D1 first.');
  process.exit(1);
}

console.log(`Loaded ${candles.length} real BTC 4H candles`);
const regimes = tagRegimes4H(candles);
console.log(`Tagged ${regimes.length} candles\n`);

// Helper: get dominant regime for a date range
function dominantRegime(startDate, endDate) {
  const s = new Date(startDate).getTime();
  const e = new Date(endDate).getTime();
  const counts = {};
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].openTime >= s && candles[i].openTime <= e) {
      counts[regimes[i]] = (counts[regimes[i]] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}

// Helper: count a specific regime in a date range
function countRegime(regime, startDate, endDate) {
  const s = new Date(startDate).getTime();
  const e = new Date(endDate).getTime();
  let count = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].openTime >= s && candles[i].openTime <= e && regimes[i] === regime) {
      count++;
    }
  }
  return count;
}

// ── Known period tests (real BTC history) ────────────────────────────────────

test('2021 Q1 is dominated by BULL (BTC ran from 29k to 58k)', () => {
  const dom = dominantRegime('2021-01-01', '2021-03-31');
  assert(dom === 'BULL', `expected BULL, got ${dom}`);
});

test('2022 full year is dominated by BEAR (BTC fell from 47k to 16k)', () => {
  const dom = dominantRegime('2022-01-01', '2022-12-31');
  assert(dom === 'BEAR', `expected BEAR, got ${dom}`);
});

test('Nov 2022 FTX crash has CRISIS candles', () => {
  const crisisCount = countRegime('CRISIS', '2022-11-01', '2022-11-30');
  assert(crisisCount > 0, `expected CRISIS candles in Nov 2022, got ${crisisCount}`);
});

test('2023 H2 is dominated by BULL (BTC ran from 25k to 44k)', () => {
  const dom = dominantRegime('2023-07-01', '2023-12-31');
  assert(dom === 'BULL', `expected BULL, got ${dom}`);
});

test('2024 Q1 is dominated by BULL (BTC ETF approval rally to 73k)', () => {
  const dom = dominantRegime('2024-01-01', '2024-03-31');
  assert(dom === 'BULL', `expected BULL, got ${dom}`);
});

test('2024 Q4 is dominated by BULL (BTC ATH run to 100k+)', () => {
  const dom = dominantRegime('2024-10-01', '2024-12-31');
  assert(dom === 'BULL', `expected BULL, got ${dom}`);
});

// ── Structural sanity checks ──────────────────────────────────────────────────

test('BULL candles exist (> 10% of total)', () => {
  const bullCount = regimes.filter(r => r === 'BULL').length;
  const pct = bullCount / regimes.length;
  assert(pct > 0.10, `BULL is only ${(pct*100).toFixed(1)}% — threshold may be too strict`);
});

test('BEAR candles exist (> 5% of total)', () => {
  const bearCount = regimes.filter(r => r === 'BEAR').length;
  const pct = bearCount / regimes.length;
  assert(pct > 0.05, `BEAR is only ${(pct*100).toFixed(1)}% — threshold may be too strict`);
});

test('CRISIS candles exist but are rare (< 10% of total)', () => {
  const crisisCount = regimes.filter(r => r === 'CRISIS').length;
  const pct = crisisCount / regimes.length;
  assert(crisisCount > 0, 'No CRISIS candles found');
  assert(pct < 0.10, `CRISIS is ${(pct*100).toFixed(1)}% — too many crisis candles`);
});

test('No undefined or null regimes', () => {
  const invalid = regimes.filter(r => !r || typeof r !== 'string');
  assert(invalid.length === 0, `Found ${invalid.length} invalid regime values`);
});

test('All regime values are valid strings', () => {
  const valid = new Set(['BULL', 'BEAR', 'RANGING', 'RANGING_ZOMBIE', 'RANGING_PREZONE', 'CRISIS']);
  const invalid = regimes.filter(r => !valid.has(r));
  assert(invalid.length === 0, `Found invalid regime: ${invalid[0]}`);
});

test('Regime array length matches candle array length', () => {
  assert(regimes.length === candles.length,
    `regime length ${regimes.length} !== candle length ${candles.length}`);
});

test('Anti-flapping: no single-candle spikes in base regimes (BULL/BEAR/RANGING)', () => {
  // Sub-states (ZOMBIE, PREZONE) are computed per-candle from ER/ATR — they can spike.
  // Only base regimes (BULL, BEAR, RANGING) must respect anti-flapping.
  // CRISIS overrides immediately and can create adjacent single-candle appearances — excluded.
  const baseRegimes = regimes.map(r =>
    r.startsWith('RANGING') ? 'RANGING' : r
  );
  let spikes = 0;
  for (let i = 1; i < baseRegimes.length - 1; i++) {
    if (baseRegimes[i] === 'CRISIS') continue;
    if (baseRegimes[i-1] === 'CRISIS' || baseRegimes[i+1] === 'CRISIS') continue; // CRISIS-adjacent
    if (baseRegimes[i] !== baseRegimes[i-1] && baseRegimes[i] !== baseRegimes[i+1]) {
      spikes++;
    }
  }
  assert(spikes === 0, `Found ${spikes} single-candle base regime spikes (anti-flapping broken)`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed}/${passed+failed} tests passed`);
if (failed > 0) {
  console.log(`${failed} FAILED — regime engine has issues`);
  process.exit(1);
} else {
  console.log('Real-data regime validation: ALL PASS');
}
