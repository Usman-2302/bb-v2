'use strict';
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
  const { atr } = require('../src/indicators/atr');
  const { rvol } = require('../src/indicators/rvol');
  const { cvd } = require('../src/indicators/cvd');
  const { rollingVolumeProfile } = require('../src/indicators/volumeProfile');
  const { isBearishSweep, buildBearishLSOSignal, checkCVDVelocityGate } = require('../src/strategies/lso');
  const { runBacktest } = require('../src/backtest/runner');
  const { DATA: { paths }, LSO: LSO_CONFIG } = require('../config');
  
  const SYMBOL = 'BTCUSDT';
  const allCandles = await loadNDJSON(path.join(paths.historical, SYMBOL + '_15m_tagged.ndjson'));
  const cfg = LSO_CONFIG;
  
  // Counts
  let swingHighs = 0, swingLows = 0;
  for (let i = 1; i < allCandles.length - 1; i++) {
    if (allCandles[i].high > allCandles[i-1].high && allCandles[i].high > allCandles[i+1].high) swingHighs++;
    if (allCandles[i].low < allCandles[i-1].low && allCandles[i].low < allCandles[i+1].low) swingLows++;
  }
  console.log('Swing highs:', swingHighs, ' Swing lows:', swingLows);
  
  // Pool counts
  const shIndices = [];
  for (let i = 1; i < allCandles.length - 1; i++) {
    if (allCandles[i].high > allCandles[i-1].high && allCandles[i].high > allCandles[i+1].high) shIndices.push(i);
  }
  const pools = [];
  const seen = new Set();
  for (let a = 0; a < shIndices.length; a++) {
    for (let b = a + 1; b < shIndices.length; b++) {
      const si = shIndices[a], sj = shIndices[b];
      if (sj - si > cfg.equalLookback) break;
      if (sj - si < cfg.equalMinGap) continue;
      if (Math.abs(allCandles[si].high - allCandles[sj].high) / allCandles[si].high >= cfg.equalTolerance) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) if (allCandles[k].high > Math.max(allCandles[si].high, allCandles[sj].high)) { swept = true; break; }
      if (swept) continue;
      const lk = Math.floor((allCandles[si].high + allCandles[sj].high) / 2);
      if (seen.has(lk)) continue; seen.add(lk);
      pools.push({ si, sj, level: (allCandles[si].high + allCandles[sj].high) / 2, formed_at: sj });
    }
  }
  
  // Equal lows for comparison
  const slIndices = [];
  for (let i = 1; i < allCandles.length - 1; i++) {
    if (allCandles[i].low < allCandles[i-1].low && allCandles[i].low < allCandles[i+1].low) slIndices.push(i);
  }
  const lpools = [];
  const lseen = new Set();
  for (let a = 0; a < slIndices.length; a++) {
    for (let b = a + 1; b < slIndices.length; b++) {
      const si = slIndices[a], sj = slIndices[b];
      if (sj - si > cfg.equalLookback) break;
      if (sj - si < cfg.equalMinGap) continue;
      if (Math.abs(allCandles[si].low - allCandles[sj].low) / allCandles[si].low >= cfg.equalTolerance) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) if (allCandles[k].low < Math.min(allCandles[si].low, allCandles[sj].low)) { swept = true; break; }
      if (swept) continue;
      const lk = Math.floor((allCandles[si].low + allCandles[sj].low) / 2);
      if (lseen.has(lk)) continue; lseen.add(lk);
      lpools.push({ si, sj });
    }
  }
  console.log('Equal highs pools:', pools.length, ' Equal lows pools:', lpools.length);
  
  // Count sweeps in BEAR regime
  let sweepsInBear = 0;
  for (const pool of pools) {
    for (let i = pool.formed_at; i <= Math.min(pool.formed_at + cfg.equalLookback, allCandles.length - 1); i++) {
      if (allCandles[i].regime === 'BEAR' && isBearishSweep(allCandles[i], pool)) { sweepsInBear++; break; }
    }
  }
  console.log('Bearish sweeps in BEAR regime (raw, no gates):', sweepsInBear);

  // 2022 baseline with NO gates except CVD_ZSCORE
  const yearStart = new Date('2022-01-01T00:00:00Z').getTime();
  const yearEnd   = new Date('2022-12-31T23:59:59Z').getTime();
  const candles2022 = allCandles.filter(c => c.openTime >= yearStart && c.openTime <= yearEnd);
  const atr14 = atr(candles2022, 14);
  const rvolVals = rvol(candles2022, '15m', 20);
  const cvdVals = cvd(candles2022);
  const vp = rollingVolumeProfile(candles2022, '15m', 24, 50);
  
  let sw = 0, flt = 0;
  const strategy = {
    name: 'SHORT_BASELINE', config: LSO_CONFIG,
    detectZones(candles, atr14, rvolVals, cfg, ctx) {
      const sh = [];
      for (let i = 1; i < candles.length - 1; i++) if (candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high) sh.push(i);
      const ap = []; const sn = new Set();
      for (let a = 0; a < sh.length; a++) {
        for (let b = a + 1; b < sh.length; b++) {
          const si = sh[a], sj = sh[b];
          if (sj - si > cfg.equalLookback) break; if (sj - si < cfg.equalMinGap) continue;
          if (Math.abs(candles[si].high - candles[sj].high) / candles[si].high >= cfg.equalTolerance) continue;
          let swp = false;
          for (let k = si + 1; k < sj; k++) if (candles[k].high > Math.max(candles[si].high, candles[sj].high)) { swp = true; break; }
          if (swp) continue;
          const lk = Math.floor((candles[si].high + candles[sj].high) / 2);
          if (sn.has(lk)) continue; sn.add(lk);
          ap.push({ id:'eqh_'+si+'_'+sj, type:'EQUAL_HIGHS', level:(candles[si].high+candles[sj].high)/2, formed_at:sj, expires_at:sj+cfg.equalLookback });
        }
      }
      ap.sort((a,b)=>a.formed_at-b.formed_at);
      ctx.extra.allPools = ap; ctx.extra.poolActivationPtr = 0; return [];
    },
    updateZones() {}, isZoneActive: () => true,
    onCandleStart(ctx) {
      const { i, activeZones, extra: ex } = ctx;
      while (ex.poolActivationPtr < ex.allPools.length && ex.allPools[ex.poolActivationPtr].formed_at <= i) activeZones.push(ex.allPools[ex.poolActivationPtr++]);
      for (let p = activeZones.length - 1; p >= 0; p--) if (activeZones[p].expires_at < i) activeZones.splice(p, 1);
      if (activeZones.length > 20) activeZones.splice(0, activeZones.length - 20);
    },
    isRegimeAllowed(r) { return r === 'BEAR'; },
    checkEntry(pool, candle, ctx) { if (isBearishSweep(candle, pool)) { sw++; return buildBearishLSOSignal(candle, pool, 0); } return null; },
    gate7(candle, cvdVals, i, ctx) {
      const zr = checkCVDVelocityGate(i, cvdVals, LSO_CONFIG.cvdVelocityZscoreThreshold||2.5, LSO_CONFIG.cvdVelocityLookback||96);
      if (zr.pass) { ctx.extra._cvdTier = 1; return { pass: true }; }
      if (zr.zscore >= 1.5 && ctx.rvolVals[i] > 3.0) { ctx.extra._cvdTier = 2; return { pass: true }; }
      flt++; return { pass: false, reason: 'cvd' };
    },
    validateSignal() { return { accept: true }; },
    getSizeMultiplier() { return 1.0; },
    onTradeOpened(s, pool, az) { const idx = az.indexOf(pool); if (idx >= 0) az.splice(idx, 1); },
    sensitivityParams: {},
    reportMeta() { return { sweepsDetected: sw, cvdFiltered: flt }; },
  };
  
  const report = runBacktest(strategy, {
    candles: candles2022, atr14, rvolVals, cvdVals, fundingMap: new Map(), macroEvents: [], volumeProfiles: vp,
    gates: { regime: true, oi: false, killzone: false, macro: false },
    initialCapital: 10000, symbol: SYMBOL, timeframe: '15m', extra: {}
  });
  console.log('\n2022 Baseline (BEAR only, CVD_ZSCORE, NO VP/4H/squeeze):');
  console.log('  Trades:', report.trades, 'WR:', (report.wr?.point*100).toFixed(1)+'%', 'PF:', report.pf?.toFixed(3));
  console.log('  Sweeps detected:', sw, 'CVD filtered:', flt);
}

main().catch(e => { console.error(e); process.exit(1); });
