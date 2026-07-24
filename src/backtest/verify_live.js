'use strict';
// Exact replica of liveRunner.js logic for backtest verification
const axios = require('axios');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { cvd: cvdFn } = require('../indicators/cvd');

// ── EXACT SAME CONFIG AS LIVE ──
const RVOL = 0.5, STOP = 0.5, RR = 2.0, THRESH = 0.0007;

function simpleRvol(candles, period = 20) {
  const result = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += candles[j].volume;
    result[i] = sum / period > 0 ? candles[i].volume / (sum / period) : 1.0;
  }
  return result;
}

function detectPools(candles, type) {
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
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol: 'ETHUSDT', interval: '15m', limit: 1500 }, timeout: 15000
  });
  const raw = resp.data.map(k => ({
    openTime: k[0], closeTime: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));

  const byDay = {};
  raw.forEach(c => { const d = new Date(c.openTime).toISOString().slice(0,10); if (!byDay[d]) byDay[d] = []; byDay[d].push(c); });
  const days = Object.keys(byDay).sort().slice(-10);

  let eq = 100, totalT = 0, totalW = 0, totalL = 0;
  console.log('═══ 10-DAY BACKTEST — EXACT LIVE CONFIG ═══');
  console.log('RVOL≥'+RVOL+' | Threshold: '+ (THRESH*100).toFixed(3)+'% | Stop: '+STOP+'ATR | Target: '+RR+'R');
  console.log('| Day | Trades | W/L | WR | Equity | PnL | Regime |');
  console.log('|-----|--------|-----|-----|--------|------|--------|');

  for (const day of days) {
    const startIdx = raw.findIndex(c => new Date(c.openTime).toISOString().slice(0,10) === day);
    const candles = raw.slice(0, startIdx + byDay[day].length);
    if (candles.length < 300) continue;

    let t = 0, w = 0, l = 0, ot = null, regCount = { BULL:0, BEAR:0, RANGING:0 };
    const dayStart = candles.length - byDay[day].length, dayStartEq = eq;

    // Recompute indicators per candle (matches live runner incremental approach)
    for (let i = dayStart; i < candles.length; i++) {
      const c = candles[i];
      const aArr = atr(candles, 14), rArr = simpleRvol(candles, 20), cvArr = cvdFn(candles);
      const eArr = ema(candles.map(x => x.close), 200);

      let regime = 'RANGING';
      if (i >= 200) {
        const pa = c.close > eArr[i], s10 = (eArr[i] - eArr[Math.max(0,i-10)]) / eArr[Math.max(0,i-10)];
        const ap = (aArr[i] || 0) / c.close * 100;
        if (ap > 5) regime = 'CRISIS';
        else if (s10 > THRESH && pa) regime = 'BULL';
        else if (s10 < -THRESH && !pa) regime = 'BEAR';
      }
      regCount[regime] = (regCount[regime] || 0) + 1;

      // Close open trade
      if (ot) {
        let closed = false;
        if (ot.side === 'LONG') {
          if (c.low <= ot.stop) { eq -= ot.risk; l++; closed = true; }
          else if (c.high >= ot.tp) { eq += ot.risk * RR; w++; closed = true; }
        } else {
          if (c.high >= ot.stop) { eq -= ot.risk; l++; closed = true; }
          else if (c.low <= ot.tp) { eq += ot.risk * RR; w++; closed = true; }
        }
        if (i - ot.idx > 50) closed = true;
        if (closed) { t++; ot = null; }
      }
      if (ot || regime === 'RANGING') continue;

      const rv = rArr[i] || 0, cvD = cvArr.delta[i] || 0, pvD = cvArr.delta[i-1] || 0, av = aArr[i] || 0;
      if (rv < RVOL) continue;

      const pools = detectPools(candles, regime === 'BULL' ? 'LONG' : 'SHORT');
      if (regime === 'BULL') {
        for (const p of pools) {
          if (p.formed > i || p.expires < i) continue;
          if (c.low >= p.level || c.close <= p.level) continue;
          if ((cvD - pvD) <= 0) continue;
          const sd = av * STOP;
          if (sd <= 0 || p.level <= p.level - sd) continue;
          ot = { side:'LONG', entry:p.level, stop:p.level-sd, tp:p.level+sd*RR, risk:eq*0.02, idx:i };
          break;
        }
      } else {
        for (const p of pools) {
          if (p.formed > i || p.expires < i) continue;
          if (c.high <= p.level || c.close >= p.level) continue;
          if ((cvD - pvD) >= 0) continue;
          const sd = av * STOP;
          if (sd <= 0 || p.level >= p.level + sd) continue;
          ot = { side:'SHORT', entry:p.level, stop:p.level+sd, tp:p.level-sd*RR, risk:eq*0.02, idx:i };
          break;
        }
      }
    }
    const wr = t > 0 ? w / t * 100 : 0;
    const dayPnl = eq - dayStartEq;
    const mainRegime = Object.entries(regCount).sort((a,b) => b[1]-a[1])[0][0];
    console.log('| ' + day + ' | ' + t + ' | ' + w + '/' + l + ' | ' + wr.toFixed(0) + '% | $' + eq.toFixed(2) + ' | +$' + dayPnl.toFixed(2) + ' | ' + mainRegime + ' |');
    totalT += t; totalW += w; totalL += l;
  }
  const fwr = totalT > 0 ? totalW / totalT * 100 : 0;
  console.log('| **TOTAL** | **' + totalT + '** | **' + totalW + '/' + totalL + '** | **' + fwr.toFixed(0) + '%** | **$' + eq.toFixed(2) + '** | +$' + (eq-100).toFixed(2) + ' | |');
  console.log('\n$100 → $' + eq.toFixed(2) + ' | ' + totalT + ' trades | ' + fwr.toFixed(1) + '% WR | ' + (totalT/10).toFixed(1) + ' trades/day');
}
main().catch(e => console.error(e.message));
