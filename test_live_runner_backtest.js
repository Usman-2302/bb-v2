'use strict';

/**
 * Local Backtest - Exact replica of liveRunner.js logic
 * Tests last 15 days of ETHUSDT 15m data
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createReadStream } = require('fs');
const { ema } = require('./src/indicators/ema');
const { atr } = require('./src/indicators/atr');
const { cvd: cvdFn } = require('./src/indicators/cvd');

const DATA_PATH = './data/historical';
const SYMBOL = 'ETHUSDT';
const TIMEFRAME = '15m';

const SWEEP_RVOL_MIN = 0.5;
const STOP_ATR_MULT = 0.5;
const TP_R_MULT = 2.0;
const MAX_CONCURRENT = 1;
const RISK_PCT = 0.02;
const SKIP_RANGING = true;

let equity = 100;
let maxEquity = equity;
let openTrade = null;
let trades = 0, wins = 0, losses = 0;
let longTrades = 0, shortTrades = 0;
let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0, noPoolSweep = 0;

async function loadNDJSON(filePath) {
  const candles = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) candles.push(JSON.parse(line));
  }
  return candles;
}

function simpleRvol(candles, period = 20) {
  const result = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += candles[j].volume;
    const avg = sum / period;
    result[i] = avg > 0 ? candles[i].volume / avg : 1.0;
  }
  return result;
}

function detectRegime(candle, i, candles, atr14) {
  if (i < 200) return 'RANGING';
  const closes = candles.map(c => c.close);
  const e200 = ema(closes, 200);
  const priceAbove = candle.close > e200[i];
  const slope10 = (e200[i] - e200[Math.max(0, i - 10)]) / e200[Math.max(0, i - 10)];
  const atrPct = atr14[i] / candle.close * 100;
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.0007 && priceAbove) return 'BULL';
  if (slope10 < -0.0007 && !priceAbove) return 'BEAR';
  return 'RANGING';
}

function detectPools(type, candles, currentIndex) {
  const pools = [], sw = [];
  for (let j = 1; j < currentIndex - 1; j++) {
    if (type === 'LONG' && candles[j].low < candles[j-1].low && candles[j].low < candles[j+1].low) sw.push(j);
    if (type === 'SHORT' && candles[j].high > candles[j-1].high && candles[j].high > candles[j+1].high) sw.push(j);
  }
  for (let a = 0; a < sw.length; a++) {
    for (let b = a + 1; b < sw.length; b++) {
      const si = sw[a], sj = sw[b];
      if (sj - si > 80) break; if (sj - si < 2) continue;
      const v1 = type === 'LONG' ? candles[si].low : candles[si].high;
      const v2 = type === 'LONG' ? candles[sj].low : candles[sj].high;
      if (Math.abs(v1 - v2) / v1 >= 0.005) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) {
        const cv = type === 'LONG' ? candles[k].low : candles[k].high;
        if (type === 'LONG' ? cv < Math.min(v1, v2) : cv > Math.max(v1, v2)) { swept = true; break; }
      }
      if (swept) continue;
      pools.push({ level: Math.floor((v1 + v2) / 2), formed: sj, expires: sj + 500 });
    }
  }
  return pools;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Local Backtest - liveRunner.js Logic (Last 15 Days)');
  console.log('═══════════════════════════════════════════════\n');

  const filePath = path.join(DATA_PATH, `${SYMBOL}_${TIMEFRAME}_tagged.ndjson`);
  console.log('Loading data...');
  const allCandles = await loadNDJSON(filePath);
  console.log(`  Loaded ${allCandles.length} total candles`);

  const endTime = allCandles[allCandles.length - 1].openTime;
  const fifteenDaysAgo = endTime - 15 * 24 * 60 * 60 * 1000;
  const candles = allCandles.filter(c => c.openTime >= fifteenDaysAgo);
  console.log(`  Last 15 days of data: ${candles.length} candles (${new Date(candles[0].openTime).toISOString()} → ${new Date(candles[candles.length-1].openTime).toISOString()})`);

  console.log('\nComputing indicators...');
  const atr14 = atr(candles, 14);
  const rvolVals = simpleRvol(candles, 20);
  const cvdVals = cvdFn(candles);

  console.log('Running backtest...\n');

  for (let i = 200; i < candles.length; i++) {
    const candle = candles[i];
    const regime = detectRegime(candle, i, candles, atr14);

    if (openTrade) {
      const t = openTrade; let closed = false, pnl = 0, outcome = '';
      if (t.side === 'LONG') {
        if (candle.low <= t.stop) { outcome = 'LOSS'; pnl = -t.risk; closed = true; }
        else if (candle.high >= t.tp) { outcome = 'WIN'; pnl = t.risk * TP_R_MULT; closed = true; }
      } else {
        if (candle.high >= t.stop) { outcome = 'LOSS'; pnl = -t.risk; closed = true; }
        else if (candle.low <= t.tp) { outcome = 'WIN'; pnl = t.risk * TP_R_MULT; closed = true; }
      }
      if (i - t.idx > 50) { outcome = 'TIME'; pnl = t.risk * 0.3; closed = true; }
      if (closed) {
        equity += pnl; if (equity > maxEquity) maxEquity = equity;
        trades++; if (outcome === 'WIN') wins++; else if (outcome === 'LOSS') losses++;
        if (t.side === 'LONG') longTrades++; else shortTrades++;
        openTrade = null;
      }
    }

    if (openTrade) continue;

    if (SKIP_RANGING && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) { rangingSkipped++; continue; }

    const rv = rvolVals[i] || 0, cv = cvdVals.delta[i] || 0, pv = cvdVals.delta[i-1] || 0, av = atr14[i] || 0;
    if (rv < SWEEP_RVOL_MIN) {
      if (rv > 0 && regime !== 'RANGING') rvolBlocked++;
      continue;
    }

    if (regime === 'BULL') {
      const pools = detectPools('LONG', candles, i);
      let found = false;
      for (const pool of pools) {
        if (pool.formed > i || pool.expires < i) continue;
        if (candle.low >= pool.level || candle.close <= pool.level) continue;
        found = true;
        sweepsDetected++;
        if ((cv - pv) <= 0) { ghostsBlocked++; continue; }
        const entry = pool.level, stopDist = av * STOP_ATR_MULT;
        const stop = entry - stopDist, tp = entry + stopDist * TP_R_MULT;
        if (stopDist <= 0 || entry <= stop) { continue; }
        const riskAmt = equity * RISK_PCT;
        openTrade = { side: 'LONG', entry, stop, tp, risk: riskAmt, idx: i, regime };
        break;
      }
      if (!found && pools.length > 0) noPoolSweep++;
    } else if (regime === 'BEAR') {
      const pools = detectPools('SHORT', candles, i);
      for (const pool of pools) {
        if (pool.formed > i || pool.expires < i) continue;
        if (candle.high <= pool.level || candle.close >= pool.level) continue;
        sweepsDetected++;
        if ((cv - pv) >= 0) { ghostsBlocked++; continue; }
        const entry = pool.level, stopDist = av * STOP_ATR_MULT;
        const stop = entry + stopDist, tp = entry - stopDist * TP_R_MULT;
        if (stopDist <= 0 || entry >= stop) { continue; }
        const riskAmt = equity * RISK_PCT;
        openTrade = { side: 'SHORT', entry, stop, tp, risk: riskAmt, idx: i, regime };
        break;
      }
    }
  }

  if (openTrade) {
    const lastCandle = candles[candles.length - 1];
    const t = openTrade;
    let pnl = 0;
    if (t.side === 'LONG') pnl = (lastCandle.close - t.entry) / (t.entry - t.stop) * t.risk;
    else pnl = (t.entry - lastCandle.close) / (t.stop - t.entry) * t.risk;
    equity += pnl;
  }

  const dd = maxEquity > equity ? ((maxEquity - equity) / maxEquity * 100) : 0;
  const wr = trades > 0 ? (wins / trades * 100) : 0;
  const pnl = equity - 100;

  console.log('═══════════════════════════════════════════════');
  console.log('  BACKTEST RESULTS - Last 15 Days');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Equity: $${equity.toFixed(2)} | PnL: $${pnl.toFixed(2)} | Max DD: ${dd.toFixed(2)}%`);
  console.log(`  Trades: ${trades} (L:${longTrades} S:${shortTrades}) | Wins: ${wins} | Losses: ${losses} | WR: ${wr.toFixed(1)}%`);
  console.log(`  Sweeps Detected: ${sweepsDetected}`);
  console.log(`  Ghosts Blocked (CVD): ${ghostsBlocked}`);
  console.log(`  RVOL Blocked (<${SWEEP_RVOL_MIN}): ${rvolBlocked}`);
  console.log(`  Ranging Skipped: ${rangingSkipped}`);
  console.log(`  No Pool Sweep: ${noPoolSweep}`);
  console.log('═══════════════════════════════════════════════\n');

  if (trades > 0) {
    const avgWin = wins > 0 ? (equity - 100 + losses * 100 * RISK_PCT * TP_R_MULT) / wins : 0;
    console.log(`  Avg Win: $${(100 * RISK_PCT * TP_R_MULT).toFixed(2)} | Avg Loss: $${(100 * RISK_PCT).toFixed(2)}`);
  }

  return { equity, trades, wins, losses, wr, dd, sweepsDetected, ghostsBlocked, rvolBlocked, rangingSkipped, noPoolSweep };
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });