'use strict';

/**
 * Download last 10 days of live ETHUSDT 15m data from Binance and backtest
 */

const axios = require('axios');
const { ema } = require('./src/indicators/ema');
const { atr } = require('./src/indicators/atr');
const { cvd: cvdFn } = require('./src/indicators/cvd');

const SYMBOL = 'ETHUSDT';
const INTERVAL = '15m';
const DAYS = 10;
const LIMIT = 1500; // Max per request

async function downloadData() {
  console.log(`Downloading last ${DAYS} days of ${SYMBOL} ${INTERVAL} from Binance...`);
  const endTime = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  
  const allCandles = [];
  let currentEnd = endTime;
  
  while (currentEnd > startTime) {
    const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: {
        symbol: SYMBOL,
        interval: INTERVAL,
        startTime,
        endTime: currentEnd,
        limit: LIMIT
      },
      timeout: 15000
    });
    
    const candles = resp.data.map(k => ({
      openTime: k[0],
      closeTime: k[6],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5]
    }));
    
    if (candles.length === 0) break;
    
    allCandles.unshift(...candles);
    currentEnd = candles[0].openTime - 1;
    
    console.log(`  Got ${candles.length} candles, earliest: ${new Date(candles[0].openTime).toISOString()}`);
    
    if (candles.length < LIMIT) break;
    await new Promise(r => setTimeout(r, 100)); // Rate limit
  }
  
  // Deduplicate and sort
  const unique = allCandles.filter((c, i, arr) => i === 0 || c.openTime !== arr[i-1].openTime);
  unique.sort((a, b) => a.openTime - b.openTime);
  
  console.log(`Total: ${unique.length} candles (${new Date(unique[0].openTime).toISOString()} → ${new Date(unique[unique.length-1].openTime).toISOString()})`);
  return unique;
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
  for (let j = 1; j < candles.length - 1; j++) {
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
  const candles = await downloadData();
  
  console.log('\nComputing indicators...');
  const atr14 = atr(candles, 14);
  const rvolVals = simpleRvol(candles, 20);
  const cvdVals = cvdFn(candles);
  
  // Simulate the live runner's warmup trim (keep last 500)
  const KEEP_CANDLES = 500;
  let testCandles = candles;
  let testAtr14 = atr14;
  let testRvol = rvolVals;
  let testCvd = cvdVals;
  
  if (testCandles.length > KEEP_CANDLES) {
    const removed = testCandles.length - KEEP_CANDLES;
    testCandles = testCandles.slice(-KEEP_CANDLES);
    testAtr14 = testAtr14.slice(-KEEP_CANDLES);
    testRvol = testRvol.slice(-KEEP_CANDLES);
    testCvd = { delta: testCvd.delta.slice(-KEEP_CANDLES), cumulative: testCvd.cumulative.slice(-KEEP_CANDLES) };
    console.log(`Trimmed ${removed} warmup candles, keeping last ${KEEP_CANDLES}`);
  }
  
  console.log(`Backtesting ${testCandles.length} candles...\n`);
  
  const SWEEP_RVOL_MIN = 0.5, STOP_ATR_MULT = 0.5, TP_R_MULT = 2.0, RISK_PCT = 0.02, SKIP_RANGING = true;
  
  let equity = 100, maxEquity = 100;
  let openTrade = null;
  let trades = 0, wins = 0, losses = 0, longTrades = 0, shortTrades = 0;
  let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0, noPoolSweep = 0;
  
  for (let i = 200; i < testCandles.length; i++) {
    const candle = testCandles[i];
    const regime = detectRegime(candle, i, testCandles, testAtr14);
    
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
    
    const rv = testRvol[i] || 0, cv = testCvd.delta[i] || 0, pv = testCvd.delta[i-1] || 0, av = testAtr14[i] || 0;
    if (rv < SWEEP_RVOL_MIN) { if (rv > 0 && regime !== 'RANGING') rvolBlocked++; continue; }
    
    if (regime === 'BULL') {
      const pools = detectPools('LONG', testCandles, i);
      let found = false;
      for (const pool of pools) {
        if (pool.formed > i || pool.expires < i) continue;
        if (candle.low >= pool.level || candle.close <= pool.level) continue;
        found = true; sweepsDetected++;
        if ((cv - pv) <= 0) { ghostsBlocked++; continue; }
        const entry = pool.level, stopDist = av * STOP_ATR_MULT;
        const stop = entry - stopDist, tp = entry + stopDist * TP_R_MULT;
        if (stopDist <= 0 || entry <= stop) continue;
        const riskAmt = equity * RISK_PCT;
        openTrade = { side: 'LONG', entry, stop, tp, risk: riskAmt, idx: i, regime };
        break;
      }
      if (!found && pools.length > 0) noPoolSweep++;
    } else if (regime === 'BEAR') {
      const pools = detectPools('SHORT', testCandles, i);
      for (const pool of pools) {
        if (pool.formed > i || pool.expires < i) continue;
        if (candle.high <= pool.level || candle.close >= pool.level) continue;
        sweepsDetected++;
        if ((cv - pv) >= 0) { ghostsBlocked++; continue; }
        const entry = pool.level, stopDist = av * STOP_ATR_MULT;
        const stop = entry + stopDist, tp = entry - stopDist * TP_R_MULT;
        if (stopDist <= 0 || entry >= stop) continue;
        const riskAmt = equity * RISK_PCT;
        openTrade = { side: 'SHORT', entry, stop, tp, risk: riskAmt, idx: i, regime };
        break;
      }
    }
  }
  
  if (openTrade) {
    const lastCandle = testCandles[testCandles.length - 1];
    const t = openTrade;
    let pnl = 0;
    if (t.side === 'LONG') pnl = (lastCandle.close - t.entry) / (t.entry - t.stop) * t.risk;
    else pnl = (t.entry - lastCandle.close) / (t.stop - t.entry) * t.risk;
    equity += pnl;
  }
  
  const dd = maxEquity > equity ? ((maxEquity - equity) / maxEquity * 100) : 0;
  const wr = trades > 0 ? (wins / trades * 100) : 0;
  
  console.log('═══════════════════════════════════════════════');
  console.log(`  LIVE DATA BACKTEST - Last ${DAYS} Days (${new Date(testCandles[0].openTime).toISOString().slice(0,10)} → ${new Date(testCandles[testCandles.length-1].openTime).toISOString().slice(0,10)})`);
  console.log('═══════════════════════════════════════════════');
  console.log(`  Equity: $${equity.toFixed(2)} | PnL: $${(equity-100).toFixed(2)} (${((equity-100)/100*100).toFixed(1)}%) | Max DD: ${dd.toFixed(2)}%`);
  console.log(`  Trades: ${trades} (L:${longTrades} S:${shortTrades}) | Wins: ${wins} | Losses: ${losses} | WR: ${wr.toFixed(1)}%`);
  console.log(`  Trades/Day: ${(trades/DAYS).toFixed(1)}`);
  console.log(`  Sweeps: ${sweepsDetected} | Ghosts: ${ghostsBlocked} | RVOL block: ${rvolBlocked} | Range skip: ${rangingSkipped} | No pool: ${noPoolSweep}`);
  console.log('═══════════════════════════════════════════════\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });