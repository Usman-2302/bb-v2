'use strict';
const fs = require('fs');

console.log('══════════════════════════════════════════════════');
console.log('  GHOST FADE BACKTEST — Rolling Window, No Lookahead');
console.log('══════════════════════════════════════════════════');
console.log('');

const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');

const COINS = ['BTCUSDT','ETHUSDT'];
const WINDOW = 500; // same as live bot warmup

function backtestGhostFade(sym) {
  const lines = fs.readFileSync('data/historical/'+sym+'_15m_3mo.ndjson','utf8').trim().split('\n').filter(Boolean);
  const allCandles = lines.map(JSON.parse);
  
  // Rolling window simulation
  let capital = 10000;
  let trades = [], wins = 0, losses = 0;
  let maxCapital = 10000, maxDD = 0;
  
  // Process candle by candle, maintaining rolling window
  for (let currentIdx = WINDOW; currentIdx < allCandles.length; currentIdx++) {
    // Rolling window: last 500 candles up to currentIdx
    const windowStart = Math.max(0, currentIdx - WINDOW);
    const windowCandles = allCandles.slice(windowStart, currentIdx + 1);
    const i = windowCandles.length - 1; // current candle index in window
    if (i < 200) continue; // need warmup
    
    // Tag regimes on window
    const closes = windowCandles.map(c => c.close);
    const ema200v = ema(closes, 200);
    const atr14 = atr(windowCandles, 14);
    
    for (let j = 0; j < windowCandles.length; j++) {
      if (j < 200) { windowCandles[j].regime = 'RANGING'; continue; }
      const pa = windowCandles[j].close > ema200v[j];
      const s10 = (ema200v[j] - ema200v[Math.max(0,j-10)]) / ema200v[Math.max(0,j-10)];
      const ap = atr14[j] / windowCandles[j].close * 100;
      if (ap > 5) windowCandles[j].regime = 'CRISIS';
      else if (s10 > 0.001 && pa) windowCandles[j].regime = 'BULL';
      else if (s10 < -0.001 && !pa) windowCandles[j].regime = 'BEAR';
      else windowCandles[j].regime = 'RANGING';
    }
    
    const windowRvol = rvol(windowCandles, '15m', 20);
    const windowCvd = cvdFn(windowCandles);
    
    // Detect pools INCREMENTALLY from rolling window (no lookahead)
    const swingLows = [];
    for (let j = 1; j < windowCandles.length - 1; j++) {
      if (windowCandles[j].low < windowCandles[j-1].low && windowCandles[j].low < windowCandles[j+1].low) {
        swingLows.push(j);
      }
    }
    
    const pools = [];
    for (let a = 0; a < swingLows.length; a++) {
      for (let b = a + 1; b < swingLows.length; b++) {
        const si = swingLows[a], sj = swingLows[b];
        if (sj - si > 50) break;
        if (sj - si < 2) continue;
        if (Math.abs(windowCandles[si].low - windowCandles[sj].low) / windowCandles[si].low >= 0.005) continue;
        let swept = false;
        for (let k = si + 1; k < sj; k++) {
          if (windowCandles[k].low < Math.min(windowCandles[si].low, windowCandles[sj].low)) { swept = true; break; }
        }
        if (swept) continue;
        pools.push({ level: Math.floor((windowCandles[si].low + windowCandles[sj].low) / 2), formed: sj, expires: sj + 50 });
      }
    }
    
    // Check for sweeps on current candle
    const candle = windowCandles[i];
    const cv = windowCvd.delta[i] || 0;
    const pv = windowCvd.delta[i-1] || 0;
    const rv = windowRvol[i] || 0;
    const atrVal = atr14[i] || 0;
    
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      
      // Bullish sweep: wick below pool, close above
      if (candle.low >= pool.level || candle.close <= pool.level) continue;
      
      // GHOST FADE: Only trade if CVD is FLAT or NEGATIVE (ghost sweep)
      const cvdChange = cv - pv;
      const isGhost = cvdChange <= 0; // CVD didn't increase = no buyers
      
      if (!isGhost) continue; // skip genuine sweeps
      
      // Entry: Sell stop at sweep low
      const entryPrice = candle.low;
      const stopPrice = entryPrice + (1.5 * atrVal * candle.close); // 1.5 ATR above (out of noise)
      const riskDist = stopPrice - entryPrice;
      if (riskDist <= 0) continue;
      
      // Target: 2R below
      const tpPrice = entryPrice - (riskDist * 2);
      
      // Simple PnL: look ahead max 50 candles
      let outcome = 'OPEN', pnl = 0;
      for (let f = i + 1; f < Math.min(i + 50, windowCandles.length); f++) {
        const fc = windowCandles[f];
        if (fc.high >= stopPrice) { outcome = 'LOSS'; pnl = -riskDist * 0.01 * capital; break; }
        if (fc.low <= tpPrice) { outcome = 'WIN'; pnl = 2 * riskDist * 0.01 * capital; break; }
      }
      if (outcome === 'OPEN') {
        outcome = 'TIME';
        const exitPx = windowCandles[Math.min(i+50, windowCandles.length-1)].close;
        pnl = (entryPrice - exitPx) / entryPrice * 0.01 * capital;
      }
      
      const size = capital * 0.01 / riskDist;
      capital += pnl;
      if (capital > maxCapital) maxCapital = capital;
      const dd = (maxCapital - capital) / maxCapital;
      if (dd > maxDD) maxDD = dd;
      
      trades.push({ entry: entryPrice, stop: stopPrice, tp: tpPrice, outcome, pnl, regime: candle.regime, rvol: rv });
      if (outcome === 'WIN') wins++;
      if (outcome === 'LOSS') losses++;
      break; // one trade per candle
    }
  }
  
  const gw = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
  const gl = Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
  const pf = gl > 0 ? gw/gl : (gw > 0 ? Infinity : 0);
  
  return { sym, trades: trades.length, wins, losses, wr: trades.length>0 ? wins/trades.length : 0, pf, dd: maxDD*100, pnl: capital-10000, capital };
}

const results = [];
for (const sym of COINS) {
  const r = backtestGhostFade(sym);
  results.push(r);
  console.log(sym + ': ' + r.trades + ' trades | WR ' + (r.wr*100).toFixed(1) + '% | PF ' + r.pf.toFixed(3) + ' | DD ' + r.dd.toFixed(2) + '% | PnL $' + r.pnl.toFixed(0));
}

console.log('');
const total = results.reduce((s,r) => s + r.pnl, 0);
console.log('TOTAL PnL: $' + total.toFixed(0) + ' | Monthly: $' + (total/3).toFixed(0));
