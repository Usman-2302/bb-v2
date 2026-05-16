'use strict';
const { loadNDJSON } = require('../src/data/loader');
const { ema }        = require('../src/indicators/ema');
const { atr }        = require('../src/indicators/atr');
const { DATA }       = require('../config');
const path           = require('path');

function resolvePath(...parts) {
  const joined = path.join(...parts);
  return path.isAbsolute(joined) ? joined : path.join(process.cwd(), joined);
}

// ATR-normalized slope
function calcEMASlope(ema200, atr14, index, lookback = 20) {
  if (index < lookback) return 0;
  const emaChange   = ema200[index] - ema200[index - lookback];
  const atrBaseline = atr14[index];
  if (atrBaseline === 0) return 0;
  return emaChange / (atrBaseline * lookback);
}

// Price distance from EMA200 in ATR units
function calcPriceVsEMA(price, ema200val, atr14val) {
  if (atr14val === 0) return 0;
  return (price - ema200val) / atr14val;
}

// Composite classifier (two-feature)
function classifyComposite(slope, priceVsEMA, slopeThresh = 0.011, priceThresh = 0.30) {
  if (slope >  slopeThresh && priceVsEMA >  priceThresh) return 'BULL';
  if (slope < -slopeThresh && priceVsEMA < -priceThresh) return 'BEAR';
  return 'RANGING';
}

const candles = loadNDJSON(resolvePath(DATA.paths.historical, 'BTCUSDT_4h.ndjson'));
const closes  = candles.map(c => c.close);
const ema200  = ema(closes, 200);
const atr14   = atr(candles, 14);

// Group by month
const months = {};
for (let i = 20; i < candles.length; i++) {
  const month = new Date(candles[i].openTime).toISOString().slice(0, 7);
  if (!months[month]) months[month] = [];
  months[month].push({
    slope:      calcEMASlope(ema200, atr14, i, 20),
    priceVsEMA: calcPriceVsEMA(candles[i].close, ema200[i], atr14[i]),
  });
}

const knownRegimes = {
  '2021-01': 'BULL', '2021-02': 'BULL', '2021-03': 'BULL',
  '2021-04': 'BULL', '2021-05': 'BEAR', '2021-06': 'RANGING',
  '2021-07': 'BULL', '2021-08': 'BULL', '2021-09': 'BULL',
  '2021-10': 'BULL', '2021-11': 'BULL', '2021-12': 'BEAR',
  '2022-01': 'BEAR', '2022-02': 'BEAR', '2022-03': 'RANGING',
  '2022-04': 'BEAR', '2022-05': 'BEAR', '2022-06': 'BEAR',
  '2022-07': 'RANGING', '2022-08': 'RANGING', '2022-09': 'BEAR',
  '2022-10': 'RANGING', '2022-11': 'CRISIS/BEAR', '2022-12': 'RANGING',
  '2023-01': 'RANGING', '2023-02': 'RANGING', '2023-03': 'BULL',
  '2023-04': 'BULL', '2023-05': 'RANGING', '2023-06': 'RANGING',
  '2023-07': 'BULL', '2023-08': 'RANGING', '2023-09': 'RANGING',
  '2023-10': 'BULL', '2023-11': 'BULL', '2023-12': 'BULL',
  '2024-01': 'BULL', '2024-02': 'BULL', '2024-03': 'BULL',
  '2024-04': 'RANGING', '2024-05': 'BULL', '2024-06': 'RANGING',
  '2024-07': 'RANGING', '2024-08': 'RANGING', '2024-09': 'RANGING',
  '2024-10': 'BULL', '2024-11': 'BULL', '2024-12': 'BULL',
};

console.log('Month    | Avg Slope | Avg PriceVsEMA | Composite | Label      | Match');
console.log('---------|-----------|----------------|-----------|------------|------');

let correct = 0;
let total   = 0;

for (const [month, data] of Object.entries(months).sort()) {
  const avgSlope      = data.reduce((s, d) => s + d.slope, 0)      / data.length;
  const avgPriceVsEMA = data.reduce((s, d) => s + d.priceVsEMA, 0) / data.length;
  const composite     = classifyComposite(avgSlope, avgPriceVsEMA);
  const label         = knownRegimes[month] || '?';

  // Normalize label for comparison (CRISIS/BEAR → BEAR)
  const labelNorm = label.includes('BEAR') ? 'BEAR' : label;
  const match     = composite === labelNorm ? '✓' : '✗';

  if (label !== '?') {
    total++;
    if (composite === labelNorm) correct++;
  }

  console.log(
    `${month}  | ${avgSlope.toFixed(4).padStart(9)} | ${avgPriceVsEMA.toFixed(4).padStart(14)} | ${composite.padEnd(9)} | ${label.padEnd(10)} | ${match}`
  );
}

console.log(`\nAccuracy: ${correct}/${total} (${(correct/total*100).toFixed(1)}%)`);

// Test different price thresholds to find optimal
console.log('\n--- Threshold sensitivity (slope=0.011, varying price threshold) ---');
for (const pt of [0.10, 0.20, 0.30, 0.40, 0.50, 0.60]) {
  let c = 0, t = 0;
  for (const [month, data] of Object.entries(months)) {
    const label = knownRegimes[month];
    if (!label || label === '?') continue;
    const avgSlope      = data.reduce((s, d) => s + d.slope, 0)      / data.length;
    const avgPriceVsEMA = data.reduce((s, d) => s + d.priceVsEMA, 0) / data.length;
    const comp          = classifyComposite(avgSlope, avgPriceVsEMA, 0.011, pt);
    const labelNorm     = label.includes('BEAR') ? 'BEAR' : label;
    t++;
    if (comp === labelNorm) c++;
  }
  console.log(`  priceThresh=${pt.toFixed(2)}: accuracy ${c}/${t} (${(c/t*100).toFixed(1)}%)`);
}
