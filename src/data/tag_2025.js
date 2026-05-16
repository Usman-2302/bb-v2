'use strict';

/**
 * Phase D13: 2025 Forward Test — Tag 2025 data with regime labels
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createReadStream } = require('fs');

async function loadNDJSON(filePath) {
  const candles = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) candles.push(JSON.parse(line)); }
  return candles;
}

async function main() {
  const { ema } = require('../indicators/ema');
  const { atr } = require('../indicators/atr');
  const { DATA: { paths: dp } } = require('../../config');

  const SYMBOL = 'BTCUSDT';
  const rawFile = path.join(dp.historical, `${SYMBOL}_15m_2025_raw.ndjson`);
  
  if (!fs.existsSync(rawFile)) {
    console.error('Raw 2025 data not found. Download first.');
    process.exit(1);
  }

  console.log('Loading 2025 candles...');
  const candles = await loadNDJSON(rawFile);
  console.log(`  Loaded ${candles.length} candles`);
  console.log(`  First: ${new Date(candles[0].openTime).toISOString()}`);
  console.log(`  Last:  ${new Date(candles[candles.length-1].openTime).toISOString()}`);

  // Tag with simple regime model
  console.log('Tagging with regime labels...');
  const closes = candles.map(c => c.close);
  const ema200 = ema(closes, 200);
  const atr14 = atr(candles, 14);

  const regimeCounts = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let regime = 'RANGING';
    if (i >= 200 && ema200[i]) {
      const priceAbove = c.close > ema200[i];
      const emaSlope = i >= 210 ? (ema200[i] - ema200[i-10]) / ema200[i-10] : 0;
      const atrPct = atr14[i] ? (atr14[i] / c.close * 100) : 0;

      if (atrPct > 5) regime = 'CRISIS';
      else if (emaSlope > 0.001 && priceAbove) regime = 'BULL';
      else if (emaSlope < -0.001 && !priceAbove) regime = 'BEAR';
      else regime = 'RANGING';
    }
    c.regime = regime;
    regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;
  }

  // Save tagged
  const taggedFile = path.join(dp.historical, `${SYMBOL}_15m_2025_tagged.ndjson`);
  const ws = fs.createWriteStream(taggedFile);
  for (const c of candles) ws.write(JSON.stringify(c) + '\n');
  ws.end();
  console.log(`  Saved: ${taggedFile}`);
  console.log('  Regime distribution:', JSON.stringify(regimeCounts));
  
  const total = candles.length;
  for (const [r, c] of Object.entries(regimeCounts)) {
    console.log(`    ${r}: ${c} (${(c/total*100).toFixed(1)}%)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
