'use strict';

/**
 * FVG Candle Frequency Analysis — Phase D6 Pre-Step
 *
 * Before writing strategy code, count how many valid FVG candidates
 * exist per regime per month. If signal count is too low (< 8/month),
 * the strategy needs a longer validation period or looser filters.
 *
 * Source: masterplan.md Phase D6 pre-step
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { loadNDJSON } = require('../src/data/loader');
const { ema }        = require('../src/indicators/ema');
const { atr }        = require('../src/indicators/atr');
const { rvol }       = require('../src/indicators/rvol');
const { DATA, FVG, SESSIONS } = require('../config');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

// Load BTC 1H tagged candles
const candles = loadNDJSON(resolvePath(DATA.paths.historical, 'BTCUSDT_1h_tagged.ndjson'));
console.log(`Loaded ${candles.length} BTC 1H tagged candles`);

// Pre-compute indicators
const closes  = candles.map(c => c.close);
const ema200  = ema(closes, 200);
const atr14   = atr(candles, 14);
const rvolVals = rvol(candles, '1h', 20);

// Helper: is candle in Asian session?
function isAsianSession(openTime) {
  const hour = new Date(openTime).getUTCHours();
  return hour >= SESSIONS.asian.start || hour < SESSIONS.asian.end;
}

// Detect bullish FVGs
let fvgCount = 0;
const fvgsByMonth  = {};
const fvgsByRegime = {};

for (let i = 1; i < candles.length - 1; i++) {
  const prev = candles[i - 1];
  const curr = candles[i];
  const next = candles[i + 1];

  // Gap condition: candle[i-1].high < candle[i+1].low
  if (prev.high >= next.low) continue;

  // Gap size filter
  const gapSize = (next.low - prev.high) / curr.close;
  if (gapSize < FVG.minGapSize) continue;

  // Body size filter: candle[i] body > bodyMultiplier × ATR14
  const body = Math.abs(curr.close - curr.open);
  if (body < FVG.bodyMultiplier * atr14[i]) continue;

  // RVOL filter
  if (rvolVals[i] < FVG.rvolThreshold) continue;

  // Asian session gate
  if (isAsianSession(curr.openTime)) continue;

  // Valid FVG found
  fvgCount++;
  const month  = new Date(curr.openTime).toISOString().slice(0, 7);
  const regime = curr.regime || 'UNKNOWN';

  fvgsByMonth[month]   = (fvgsByMonth[month]   || 0) + 1;
  fvgsByRegime[regime] = (fvgsByRegime[regime] || 0) + 1;
}

console.log(`\nTotal valid FVG candidates: ${fvgCount}`);
console.log(`Date range: ${candles[0] ? new Date(candles[0].openTime).toISOString().slice(0,10) : 'N/A'} to ${candles[candles.length-1] ? new Date(candles[candles.length-1].openTime).toISOString().slice(0,10) : 'N/A'}`);

// Monthly breakdown
console.log('\n── Monthly FVG count ──');
const months = Object.keys(fvgsByMonth).sort();
let totalMonths = 0;
let lowMonths   = 0;
months.forEach(m => {
  const count = fvgsByMonth[m];
  const flag  = count < 8 ? ' ⚠ LOW' : '';
  console.log(`  ${m}: ${count}${flag}`);
  totalMonths++;
  if (count < 8) lowMonths++;
});

const avgPerMonth = fvgCount / totalMonths;
console.log(`\nAverage per month: ${avgPerMonth.toFixed(1)}`);
console.log(`Months with < 8 signals: ${lowMonths}/${totalMonths}`);

// Regime breakdown
console.log('\n── FVG count by regime ──');
Object.entries(fvgsByRegime).sort((a,b) => b[1]-a[1]).forEach(([r,n]) => {
  console.log(`  ${r.padEnd(20)}: ${n} (${(n/fvgCount*100).toFixed(1)}%)`);
});

// Assessment
console.log('\n── Assessment ──');
if (avgPerMonth >= 8) {
  console.log(`✓ Average ${avgPerMonth.toFixed(1)} FVGs/month — sufficient for statistical significance`);
  console.log('  At 40% WR: need 100 trades = ~${(100/avgPerMonth).toFixed(0)} months of data');
  console.log('  2021-2024 data (48 months) should provide enough trades');
} else {
  console.log(`⚠ Average ${avgPerMonth.toFixed(1)} FVGs/month — may be too few`);
  console.log('  Consider loosening filters or accepting longer validation period');
}

// Save results
const resultsDir = resolvePath(DATA.paths.results);
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
const outPath = path.join(resultsDir, 'signal_frequency_analysis.json');
fs.writeFileSync(outPath, JSON.stringify({
  timestamp:    new Date().toISOString(),
  strategy:     'FVG',
  symbol:       'BTCUSDT',
  interval:     '1h',
  totalFVGs:    fvgCount,
  avgPerMonth:  parseFloat(avgPerMonth.toFixed(1)),
  byMonth:      fvgsByMonth,
  byRegime:     fvgsByRegime,
  lowMonths,
  totalMonths,
}, null, 2));
console.log(`\nSaved: ${outPath}`);
