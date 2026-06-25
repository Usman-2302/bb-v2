'use strict';
const fs = require('fs');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');

const COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT'];
const WINDOW = 500;

console.log('══════════════════════════════════════════════════');
console.log('  GRID READINESS DETECTOR — Last 14 Days');
console.log('══════════════════════════════════════════════════');
console.log('');

function detectGridReadiness(sym) {
  const lines = fs.readFileSync('data/historical/'+sym+'_15m_3mo.ndjson','utf8').trim().split('\n').filter(Boolean);
  const allCandles = lines.map(JSON.parse);
  
  // Use last 14 days (1344 candles)
  const recent = allCandles.slice(-1344);
  const closes = recent.map(c=>c.close);
  const highs = recent.map(c=>c.high);
  const lows = recent.map(c=>c.low);
  const ema200v = ema(closes,200);
  const atr14 = atr(recent,14);
  
  // Regime
  for(let j=0;j<recent.length;j++){
    if(j<200){recent[j].regime='RANGING';continue;}
    const pa=recent[j].close>ema200v[j];
    const s10=(ema200v[j]-ema200v[Math.max(0,j-10)])/ema200v[Math.max(0,j-10)];
    const ap=atr14[j]/recent[j].close*100;
    if(ap>5)recent[j].regime='CRISIS';else if(s10>0.001&&pa)recent[j].regime='BULL';else if(s10<-0.001&&!pa)recent[j].regime='BEAR';else recent[j].regime='RANGING';
  }
  
  // Last 192 candles = 48 hours
  const last48h = recent.slice(-192);
  const last48hRegime = {};
  last48h.forEach(c=>{last48hRegime[c.regime]=(last48hRegime[c.regime]||0)+1});
  
  const rangingPct = (last48hRegime.RANGING||0) / 192 * 100;
  const atrPct = atr14[atr14.length-1] / closes[closes.length-1] * 100;
  const rangeHigh = Math.max(...last48h.map(c=>c.high));
  const rangeLow = Math.min(...last48h.map(c=>c.low));
  const rangePct = (rangeHigh - rangeLow) / rangeLow * 100;
  const price = closes[closes.length-1];
  
  // Grid score: 0-100
  let score = 0;
  if (rangingPct > 60) score += 30;       // Mostly ranging
  if (atrPct > 0.3 && atrPct < 1.5) score += 20; // Healthy vol, not crisis
  if (rangePct > 1.5 && rangePct < 8) score += 25;  // Wide enough range
  if (rangePct > 0) {
    const posInRange = (price - rangeLow) / (rangeHigh - rangeLow) * 100;
    if (posInRange > 30 && posInRange < 70) score += 15; // Mid-range
  }
  
  // Grid PnL simulation: if we placed grid every 0.3%, how many hits?
  const gridStep = 0.003;
  let gridBuys = 0, gridSells = 0;
  for (let k = 192; k < recent.length; k++) {
    const c = recent[k];
    // Count how many grid levels got crossed
    for (let lvl = rangeLow; lvl <= rangeHigh; lvl += rangeLow * gridStep) {
      if (c.low <= lvl && c.high >= lvl) gridBuys++;
      if (c.high >= lvl + rangeLow*gridStep && c.low <= lvl + rangeLow*gridStep) gridSells++;
    }
  }
  const gridTrades = Math.min(gridBuys, gridSells);
  const gridEstPnL = gridTrades * rangeLow * gridStep * 0.8; // 80% capture
  
  return { sym, rangingPct, atrPct, rangePct, score, gridTrades, gridEstPnL, price, rangeLow, rangeHigh };
}

const results = [];
for (const sym of COINS) {
  const r = detectGridReadiness(sym);
  results.push(r);
  const ready = r.score >= 50 ? '🟢 READY' : r.score >= 35 ? '🟡 WATCH' : '🔴 WAIT';
  console.log(sym.padEnd(8), '| Score:', String(r.score).padEnd(3), '| Ranging:', r.rangingPct.toFixed(0)+'%'.padEnd(5),
    '| ATR:', r.atrPct.toFixed(2)+'%'.padEnd(7), '| Range:', r.rangePct.toFixed(1)+'%'.padEnd(6),
    '| Grid trades:', String(r.gridTrades).padEnd(5), '| Est PnL: $'+r.gridEstPnL.toFixed(0).padEnd(6), '|', ready);
}

console.log('');
const best = results.reduce((b,r) => r.score > b.score ? r : b, results[0]);
console.log('Best grid candidate: ' + best.sym + ' (score ' + best.score + ', range ' + best.rangePct.toFixed(1) + '%, est \$' + best.gridEstPnL.toFixed(0) + ')');
