'use strict';
const fs = require('fs');

// Load ALL log files for consolidation
const logFiles = [
  'logsd6v2.txt', 'logsd6v3.text', 'logsd6v4.text', 'losgd6.txt',
];

console.log('=== SWEEP CANDIDATE QUALITY ANALYSIS ===');
console.log('Analyzing all log file sweeps + latest data sweeps');
console.log('');

// ── Step 1: Extract sweep data from live logs ──
const sweepLogs = [];

for (const file of logFiles) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      // Match: SWEEP @ $63107 pool=$62988 → BLOCKED: ... | regime=BULL rvol=0.50
      const m = line.match(/SWEEP @ \$(\d+)\s+pool=\$(\d+).*?regime=(\w+)\s+rvol=([\d.]+)/);
      if (m) {
        sweepLogs.push({
          sweep: parseFloat(m[1]),
          pool: parseFloat(m[2]),
          regime: m[3],
          rvol: parseFloat(m[4]),
        });
      }
    }
  } catch (e) { /* file not found */ }
}
console.log('Live log sweeps found:', sweepLogs.length);

// ── Step 2: Download fresh data and analyze sweeps with actual price outcomes ──
const lines = fs.readFileSync('data/historical/BTCUSDT_15m_3month.ndjson', 'utf8').trim().split('\n').filter(Boolean);
const candles = lines.map(JSON.parse);

// Tag regimes
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const atr14 = atr(candles, 14);
const closes = candles.map(c => c.close);
const ema200_vals = ema(closes, 200);

for (let i = 0; i < candles.length; i++) {
  if (i < 200) { candles[i].regime = 'RANGING'; continue; }
  const pa = candles[i].close > ema200_vals[i];
  const s10 = (ema200_vals[i] - ema200_vals[Math.max(0, i - 10)]) / ema200_vals[Math.max(0, i - 10)];
  const ap = atr14[i] / candles[i].close * 100;
  if (ap > 5) candles[i].regime = 'CRISIS';
  else if (s10 > 0.001 && pa) candles[i].regime = 'BULL';
  else if (s10 < -0.001 && !pa) candles[i].regime = 'BEAR';
  else candles[i].regime = 'RANGING';
}

const { rvol } = require('../indicators/rvol');
const rvolVals = rvol(candles, '15m', 20);
const { cvd: cvdFn } = require('../indicators/cvd');
const cvdData = cvdFn(candles);

// Find all sweep candidates: wick-dominated candles that sweep below a nearby equal-low pool
const { findEqualLows, isBullishSweep } = require('../strategies/lso');
const { LSO: LSO_CONFIG } = require('../../config');

// Build pools
const swingLowIndices = [];
for (let i = 1; i < candles.length - 1; i++) {
  const low = candles[i].low;
  let isSw = true;
  for (let d = 1; d <= 1; d++) {
    if (low >= candles[i-d].low || low >= candles[i+d].low) { isSw = false; break; }
  }
  if (isSw) swingLowIndices.push(i);
}

const allPools = [];
for (let a = 0; a < swingLowIndices.length; a++) {
  for (let b = a + 1; b < swingLowIndices.length; b++) {
    const si = swingLowIndices[a], sj = swingLowIndices[b];
    if (sj - si > 50) break;
    if (sj - si < 2) continue;
    const lowI = candles[si].low, lowJ = candles[sj].low;
    if (Math.abs(lowI - lowJ) / lowI >= 0.005) continue;
    let swept = false;
    for (let k = si + 1; k < sj; k++) {
      if (candles[k].low < Math.min(lowI, lowJ)) { swept = true; break; }
    }
    if (swept) continue;
    allPools.push({ level: Math.floor((lowI + lowJ) / 2), formed_at: sj, expires_at: sj + 50 });
  }
}
allPools.sort((a, b) => a.formed_at - b.formed_at);
console.log('Total pools:', allPools.length);

// ── Step 3: For each sweep candidate, compute actual forward P&L ──
// Simplified: if price reaches TP1 (0.5% up from entry) before hitting stop (0.3% down), it's a win.
// Entry = pool.level (limit order fills at pool retest)
const sweepCandidates = [];
const activePools = [];
let poolPtr = 0;

for (let i = 300; i < candles.length - 50; i++) {
  const candle = candles[i];
  const regime = candle.regime;

  while (poolPtr < allPools.length && allPools[poolPtr].formed_at <= i) {
    activePools.push(allPools[poolPtr++]);
  }
  for (let p = activePools.length - 1; p >= 0; p--) {
    if (activePools[p].expires_at < i) activePools.splice(p, 1);
  }
  if (activePools.length > 20) activePools.splice(0, activePools.length - 20);

  for (let p = activePools.length - 1; p >= 0; p--) {
    const pool = activePools[p];
    
    // Bullish sweep: candle low < pool level AND candle close > pool level (reclaim)
    if (candle.low >= pool.level + 1) continue; // didn't reach pool
    if (candle.close <= pool.level) continue;   // no reclaim
    
    // Check if it's a sweep - low went below pool
    if (candle.low >= pool.level) continue;
    
    activePools.splice(p, 1);
    
    const sweepRvol = rvolVals[i] || 1.0;
    const entryPrice = pool.level + 1; // limit fill at pool
    const stopPrice = entryPrice - entryPrice * 0.003; // 0.3% stop
    const tp1 = entryPrice + (entryPrice - stopPrice) * 1.5; // 1.5:1 R:R
    const tp2 = entryPrice + (entryPrice - stopPrice) * 3.0; // 3:1 R:R
    
    // Find actual outcome in next 50 candles
    let outcome = 'NEUTRAL';
    let pnlPct = 0;
    let exitCandle = 0;
    
    for (let f = i + 1; f < Math.min(i + 50, candles.length); f++) {
      const fc = candles[f];
      if (fc.low <= stopPrice) {
        outcome = 'LOSS';
        pnlPct = -(entryPrice - stopPrice) / entryPrice * 100;
        exitCandle = f - i;
        break;
      }
      if (fc.high >= tp2) {
        outcome = 'TP2';
        pnlPct = (tp2 - entryPrice) / entryPrice * 100;
        exitCandle = f - i;
        break;
      }
      if (fc.high >= tp1) {
        outcome = 'TP1';
        pnlPct = (tp1 - entryPrice) / entryPrice * 100;
        exitCandle = f - i;
        break;
      }
    }
    if (outcome === 'NEUTRAL') {
      // Close at last candle
      outcome = 'TIME';
      const lastClose = candles[Math.min(i + 50, candles.length - 1)].close;
      pnlPct = (lastClose - entryPrice) / entryPrice * 100;
    }
    
    sweepCandidates.push({
      rvol: sweepRvol,
      regime,
      entryPrice: entryPrice.toFixed(0),
      outcome,
      pnlPct,
      exitCandles: exitCandle,
    });
    break; // one sweep per candle max
  }
}

console.log('Sweep candidates analyzed:', sweepCandidates.length);

// ── Step 4: RVOL bucket analysis ──
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  RVOL BUCKET ANALYSIS — Actual Price Outcomes');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('| RVOL Range     | Count | Wins | WR    | Avg PnL% | Cumulative $ |');
console.log('|---------------|-------|------|-------|----------|-------------|');

const buckets = [
  { min: 0.0, max: 0.5, label: '0.0-0.5' },
  { min: 0.5, max: 0.7, label: '0.5-0.7' },
  { min: 0.7, max: 0.8, label: '0.7-0.8' },
  { min: 0.8, max: 0.9, label: '0.8-0.9' },
  { min: 0.9, max: 1.0, label: '0.9-1.0' },
  { min: 1.0, max: 1.1, label: '1.0-1.1' },
  { min: 1.1, max: 1.2, label: '1.1-1.2' },
  { min: 1.2, max: 1.5, label: '1.2-1.5' },
  { min: 1.5, max: 2.0, label: '1.5-2.0' },
  { min: 2.0, max: 99,  label: '2.0+' },
];

// Sort candidates by RVOL for cumulative analysis
sweepCandidates.sort((a, b) => b.rvol - a.rvol); // descending

let cumulativeTrades = 0;
let cumulativePnl = 0;

for (const bucket of buckets) {
  const trades = sweepCandidates.filter(s => s.rvol >= bucket.min && s.rvol < bucket.max);
  const winners = trades.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2');
  const avgPnl = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  
  // For cumulative: trades ABOVE this bucket's min
  const cumTrades = sweepCandidates.filter(s => s.rvol >= bucket.min);
  const cumPnl = cumTrades.reduce((s, t) => s + t.pnlPct, 0);
  const cumDollar = cumPnl * 10000 / 100; // 1% risk on $10K
  
  console.log(
    '|', bucket.label.padEnd(14),
    '|', String(trades.length).padEnd(6),
    '|', String(winners.length).padEnd(5),
    '|', (trades.length > 0 ? (winners.length/trades.length*100).toFixed(0)+'%' : 'N/A').padEnd(6),
    '|', (trades.length > 0 ? avgPnl.toFixed(2)+'%' : 'N/A').padEnd(9),
    '|', '$'+cumDollar.toFixed(0).padEnd(12),
    '|'
  );
}

// ── Step 5: Find optimal threshold ──
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('  OPTIMAL sweepRvolMin — Cumulative Performance');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('Threshold = only take sweeps with RVOL ≥ this value');
console.log('');

const thresholds = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.1, 1.2, 1.3, 1.5];
let bestThreshold = null;
let bestPnl = -Infinity;

for (const thresh of thresholds) {
  const filtered = sweepCandidates.filter(s => s.rvol >= thresh);
  const wins = filtered.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2');
  const totalPnl = filtered.reduce((s, t) => s + t.pnlPct, 0);
  const dollar = totalPnl * 10000 / 100;
  const avgPerTrade = filtered.length > 0 ? totalPnl / filtered.length : 0;
  
  if (dollar > bestPnl) { bestPnl = dollar; bestThreshold = thresh; }
  
  const mark = thresh === bestThreshold ? ' ← BEST' : '';
  console.log(
    'RVOL ≥', String(thresh).padEnd(5),
    '→', String(filtered.length).padEnd(5), 'trades',
    'WR:', (filtered.length > 0 ? (wins.length/filtered.length*100).toFixed(0)+'%' : 'N/A').padEnd(5),
    `Avg: ${avgPerTrade.toFixed(2)}%`.padEnd(12),
    `PnL: $${dollar.toFixed(0)}`,
    mark
  );
}

console.log('');
console.log('BEST: sweepRvolMin =', bestThreshold, '→ $' + bestPnl.toFixed(0), 'over 3 months');
console.log('Monthly: ~$' + (bestPnl/3).toFixed(0) + ' (' + (bestPnl/3/10000*100).toFixed(1) + '%)');
