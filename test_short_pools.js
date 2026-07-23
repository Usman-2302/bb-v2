const { ema } = require('./src/indicators/ema');
const { atr } = require('./src/indicators/atr');
const { cvd: cvdFn } = require('./src/indicators/cvd');
const fs = require('fs');
const readline = require('readline');

async function load() {
  const candles = [];
  const rl = readline.createInterface({ input: fs.createReadStream('./data/historical/ETHUSDT_15m.ndjson'), crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) candles.push(JSON.parse(line)); }
  return candles;
}

async function test() {
  const allCandles = await load();
  const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
  const candles = allCandles.filter(c => c.openTime >= fifteenDaysAgo);
  console.log('Candles:', candles.length);
  
  const atr14 = atr(candles, 14);
  const cvdVals = cvdFn(candles);
  
  // Simulate the trim
  const KEEP = 500;
  if (candles.length > KEEP) candles.splice(0, candles.length - KEEP);
  console.log('After trim:', candles.length);
  
  // Test detectPools for SHORT at the last index
  function detectPools(type, candles, currentIndex) {
    const pools = [], sw = [];
    for (let j = 1; j < candles.length - 1; j++) {
      if (type === 'LONG' && candles[j].low < candles[j-1].low && candles[j].low < candles[j+1].low) sw.push(j);
      if (type === 'SHORT' && candles[j].high > candles[j-1].high && candles[j].high > candles[j+1].high) sw.push(j);
    }
    console.log('Swing highs found:', sw.length);
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
  
  const i = candles.length - 1;
  console.log('Testing SHORT pools at i=', i);
  const shortPools = detectPools('SHORT', candles, i);
  console.log('SHORT pools:', shortPools.length);
  if (shortPools.length > 0) console.log('First:', shortPools[0]);
  
  const longPools = detectPools('LONG', candles, i);
  console.log('LONG pools:', longPools.length);
}
test().catch(console.error);