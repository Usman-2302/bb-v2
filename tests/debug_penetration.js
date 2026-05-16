'use strict';

/**
 * Penetration depth diagnostic for existing FVG fills.
 * Runs the baseline and logs exact penetration depth for every fill.
 * Shows what fill quality each trade would get under ATR-relative thresholds.
 *
 * Run BEFORE implementing Fix 1 to confirm the fix is needed.
 */

require('dotenv').config();
const { loadNDJSON, loadFundingMap } = require('../src/data/loader');
const { ema }   = require('../src/indicators/ema');
const { atr }   = require('../src/indicators/atr');
const { rvol }  = require('../src/indicators/rvol');
const { cvd }   = require('../src/indicators/cvd');
const { detectBullishFVGs, checkFVGEntry, updateFVGStatus, isTradeable } = require('../src/strategies/fvg');
const { findDOL } = require('../src/utils/dolFinder');
const { DATA, FVG: FVG_CONFIG, SIZING } = require('../config');
const path = require('path');

function r(...p) {
  const j = path.join(...p);
  return path.isAbsolute(j) ? j : path.join(process.cwd(), j);
}

function isKillzone(openTime) {
  const h = new Date(openTime).getUTCHours();
  return (h >= 7 && h < 9) || (h >= 13 && h < 15);
}

// Load data
const candles  = loadNDJSON(r(DATA.paths.historical, 'BTCUSDT_1h_tagged.ndjson'));
const atr14    = atr(candles, 14);
const rvolVals = rvol(candles, '1h', 20);
const cvdVals  = cvd(candles);
const allFVGs  = detectBullishFVGs(candles, atr14, rvolVals);

console.log(`Loaded ${candles.length} candles, ${allFVGs.length} FVGs detected\n`);

// Simulate fills and log penetration details
const fills = [];
const activeFVGs = [...allFVGs];

for (let i = 0; i < candles.length; i++) {
  const candle = candles[i];

  activeFVGs.forEach(fvg => {
    if (i > fvg.formed_at) updateFVGStatus(fvg, candle, i);
  });

  for (const fvg of activeFVGs) {
    if (!isTradeable(fvg)) continue;
    const signal = checkFVGEntry(fvg, candle);
    if (!signal) continue;

    const entryPrice = signal.limitPrice;
    const stopPrice  = signal.stopPrice;

    // Check if price actually reached the entry level
    if (candle.low > entryPrice) continue;

    // Calculate penetration
    const penetration    = (entryPrice - candle.low) / entryPrice;
    const atrPct         = atr14[i] / entryPrice;
    const atrFraction    = atrPct > 0 ? penetration / atrPct : 0;

    // Current classification (fixed 0.10% threshold)
    const currentClass =
      penetration <= 0       ? 'MISS' :
      candle.low >= entryPrice - 0.1/100 * entryPrice ? 'EXACT_TOUCH' :
      penetration < 0.0002   ? 'CLEAN' :
      penetration < 0.001    ? 'MARGINAL' :
                               'TOXIC';

    // New classification (ATR-relative thresholds)
    const cleanThresh    = atrPct * 0.05;
    const marginalThresh = atrPct * 0.20;
    const toxicThresh    = atrPct * 0.40;
    const newClass =
      penetration <= 0            ? 'MISS' :
      penetration < cleanThresh   ? 'EXACT_TOUCH' :
      penetration < marginalThresh ? 'CLEAN' :
      penetration < toxicThresh   ? 'MARGINAL' :
                                    'TOXIC';

    fills.push({
      date:         new Date(candle.openTime).toISOString().slice(0, 16),
      entryPrice:   entryPrice.toFixed(2),
      candleLow:    candle.low.toFixed(2),
      penetrationPct: (penetration * 100).toFixed(4) + '%',
      atr14Pct:     (atrPct * 100).toFixed(4) + '%',
      atrFraction:  atrFraction.toFixed(3) + 'x',
      currentClass,
      newClass,
      reclassified: currentClass !== newClass,
    });

    break; // one fill per candle
  }
}

console.log('=== PENETRATION DEPTH DIAGNOSTIC ===\n');
console.log('Date             | Entry    | Low      | Pen%    | ATR%    | ATR-frac | Current  | New      | Changed');
console.log('-----------------|----------|----------|---------|---------|----------|----------|----------|--------');

fills.forEach(f => {
  const changed = f.reclassified ? '  YES ←' : '';
  console.log(
    `${f.date} | ${f.entryPrice.padStart(8)} | ${f.candleLow.padStart(8)} | ${f.penetrationPct.padStart(7)} | ${f.atr14Pct.padStart(7)} | ${f.atrFraction.padStart(8)} | ${f.currentClass.padEnd(8)} | ${f.newClass.padEnd(8)} |${changed}`
  );
});

console.log(`\nTotal fills analyzed: ${fills.length}`);
const reclassified = fills.filter(f => f.reclassified).length;
console.log(`Reclassified under ATR-relative threshold: ${reclassified}/${fills.length}`);

// Summary
const currentDist = {};
const newDist = {};
fills.forEach(f => {
  currentDist[f.currentClass] = (currentDist[f.currentClass] || 0) + 1;
  newDist[f.newClass]         = (newDist[f.newClass]         || 0) + 1;
});

console.log('\nCurrent distribution:', JSON.stringify(currentDist));
console.log('New distribution:    ', JSON.stringify(newDist));

const currentToxicPct = ((currentDist.TOXIC || 0) / fills.length * 100).toFixed(1);
const newToxicPct     = ((newDist.TOXIC     || 0) / fills.length * 100).toFixed(1);
console.log(`\nToxic fill rate: ${currentToxicPct}% → ${newToxicPct}% (after ATR-relative threshold)`);

if (parseFloat(newToxicPct) < 60) {
  console.log('\n✓ Fix 1 (ATR-relative threshold) will reduce toxic fills below 60%. Proceed with Fix 1.');
} else {
  console.log('\n⚠ Fix 1 alone insufficient. Toxic rate stays > 60%. Consider 15m migration.');
}
