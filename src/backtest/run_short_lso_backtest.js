'use strict';

/**
 * BulletBrain v3.0 — SHORT-LSO Backtest Execution
 * Phase D10 — Mirror of LSO for downside
 *
 * Usage: node src/backtest/run_short_lso_backtest.js
 */

const fs   = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const readline = require('readline');

// LSO shared functions (mirrored: findEqualHighs, isBearishSweep, buildBearishLSOSignal, checkCVDVelocityGate)
const { findEqualHighs, isBearishSweep, buildBearishLSOSignal,
        checkCVDVelocityGate } = require('../strategies/lso');

// SHORT-LSO specific gates
const { checkVolumeProfileGateBearish, check4HTrendBearish,
        checkShortSqueezeBuffer, isBearRegimeStable } = require('../strategies/shortLso');

const { cvd }  = require('../indicators/cvd');
const { atr }  = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { rollingVolumeProfile } = require('../indicators/volumeProfile');

const { runBacktest, runYearlyBreakdown } = require('./runner');
const { DATA, LSO: LSO_CONFIG } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADING (shared with run_lso_backtest.js)
// ─────────────────────────────────────────────────────────────────────────────

async function loadNDJSON(filePath) {
  const candles = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) candles.push(JSON.parse(line));
  }
  return candles;
}

function loadMacroEvents() {
  const filePath = path.join(DATA.paths.historical, '..', 'macro_events.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveResult(filename, data) {
  const dir = DATA.paths.results;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) {
    let v = 2;
    const base = filename.replace('.json', '');
    while (fs.existsSync(path.join(dir, `${base}_v${v}.json`))) v++;
    filePath = path.join(dir, `${base}_v${v}.json`);
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  Saved: ${path.basename(filePath)}`);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORT-LSO STRATEGY DESCRIPTOR
// ─────────────────────────────────────────────────────────────────────────────

function createShortLSOStrategy(extra) {
  let sweepsDetected = 0, cvdFiltered = 0, dolNotFound = 0;

  return {
    name: 'SHORT_LSO',
    config: LSO_CONFIG,

    // ── Pool detection: equal HIGHS (mirror of equal lows) ────────────────
    detectZones(candles, atr14, rvolVals, cfg, ctx) {
      const swingLb = cfg.swingLookback || 1;
      const swingHighIndices = [];
      for (let i = swingLb; i < candles.length - swingLb; i++) {
        const high = candles[i].high;
        let isSwing = true;
        for (let d = 1; d <= swingLb; d++) {
          if (high <= candles[i - d].high || high <= candles[i + d].high) { isSwing = false; break; }
        }
        if (isSwing) swingHighIndices.push(i);
      }

      const allPools = [];
      const seen = new Set();
      for (let a = 0; a < swingHighIndices.length; a++) {
        for (let b = a + 1; b < swingHighIndices.length; b++) {
          const si = swingHighIndices[a], sj = swingHighIndices[b];
          if (sj - si > cfg.equalLookback) break;
          if (sj - si < cfg.equalMinGap) continue;
          const highI = candles[si].high, highJ = candles[sj].high;
          if (Math.abs(highI - highJ) / highI >= cfg.equalTolerance) continue;
          let swept = false;
          for (let k = si + 1; k < sj; k++) {
            if (candles[k].high > Math.max(highI, highJ)) { swept = true; break; }
          }
          if (swept) continue;
          const lk = Math.floor((highI + highJ) / 2);
          if (seen.has(lk)) continue;
          seen.add(lk);
          allPools.push({
            id: `eqh_${candles[si].openTime}_${candles[sj].openTime}`,
            type: 'EQUAL_HIGHS',
            level: (highI + highJ) / 2,
            formed_at: sj, expires_at: sj + cfg.equalLookback,
            index_i: si, index_j: sj,
          });
        }
      }
      allPools.sort((a, b) => a.formed_at - b.formed_at);
      ctx.extra.allPools = allPools;
      ctx.extra.poolActivationPtr = 0;
      return [];
    },

    updateZones() {},
    isZoneActive: () => true,

    onCandleStart(ctx) {
      const { i, activeZones, extra: ex } = ctx;
      while (ex.poolActivationPtr < ex.allPools.length && ex.allPools[ex.poolActivationPtr].formed_at <= i) {
        activeZones.push(ex.allPools[ex.poolActivationPtr++]);
      }
      for (let p = activeZones.length - 1; p >= 0; p--) {
        if (activeZones[p].expires_at < i) activeZones.splice(p, 1);
      }
      if (activeZones.length > 20) activeZones.splice(0, activeZones.length - 20);
    },

    isRegimeAllowed(regime) {
      // SHORT-LSO activates ONLY in BEAR regime
      return regime === 'BEAR';
    },

    checkEntry(pool, candle, ctx) {
      const atr14Val = ctx && ctx.atr14 && ctx.i !== undefined ? ctx.atr14[ctx.i] : 0;
      if (isBearishSweep(candle, pool)) {
        sweepsDetected++;
        return buildBearishLSOSignal(candle, pool, atr14Val);
      }
      return null;
    },

    // ── Gate 7: CVD_ZSCORE (shared with LSO, but CVD should be NEGATIVE for shorts) ──
    gate7(candle, cvdVals, i, ctx) {
      const variant = ctx.extra.cvdGateVariant || 'CVD_ZSCORE';
      if (variant === 'NONE') { ctx.extra._cvdTier = 1; return { pass: true }; }
      if (variant === 'CVD_ZSCORE') {
        const zr = checkCVDVelocityGate(i, cvdVals, ctx.cfg.cvdVelocityZscoreThreshold || 2.5, ctx.cfg.cvdVelocityLookback || 96);
        // For shorts: strong negative CVD delta = institutional selling
        // CVD_ZSCORE works the same way — z-score magnitude indicates absorption
        // Tier 1: z ≥ 2.5 → institutional-quality absorption
        if (zr.pass) {
          ctx.extra._cvdTier = 1;
          return { pass: true, tier: 1, zscore: zr.zscore };
        }
        // Tier 2: 1.5 ≤ z < 2.5 AND RVOL > 3.0×
        if (zr.zscore != null && zr.zscore >= 1.5) {
          const rvolVal = ctx.rvolVals[i];
          if (rvolVal > 3.0) {
            ctx.extra._cvdTier = 2;
            return { pass: true, tier: 2, zscore: zr.zscore };
          }
        }
        cvdFiltered++;
        return { pass: false, reason: `cvd_zs_${zr.reason}` };
      }
      ctx.extra._cvdTier = 1;
      return { pass: true };
    },

    // ── Validate signal: Gate VP bearish, 4H Trend bearish, short-squeeze buffer ──
    validateSignal(signal, candle, i, ctx) {
      const { extra: ex, cfg } = ctx;

      // Sweep RVOL filter
      if (cfg.sweepRvolMin > 0 && ctx.rvolVals[i] < cfg.sweepRvolMin) {
        cvdFiltered++; return { accept: false, reason: 'sweep_rvol' };
      }

      // Gate VP Bearish: sweep high > POC, reclaim close < VAH
      if (ex.gateVP && ex.volumeProfiles) {
        const vpResult = checkVolumeProfileGateBearish(candle, candle.high, candle.close, ex.volumeProfiles, i);
        if (!vpResult.pass) { cvdFiltered++; return { accept: false, reason: vpResult.reason }; }
      }

      // 4H Trend Bearish: stored as size multiplier, hard block if Bullish
      ctx.extra._4hMultiplier = 1.0;
      if (ex.gate4HTrend) {
        const trendResult = check4HTrendBearish(ctx.candles, i);
        ctx.extra._4hMultiplier = trendResult.multiplier;
        if (trendResult.multiplier === 0) {
          cvdFiltered++;
          return { accept: false, reason: `4h_${trendResult.state}` };
        }
      }

      // Short-squeeze volatility buffer: block if sweep candle > 2× avg ATR
      if (ex.gateSqueezeBuffer) {
        const avgATR30 = ex.avgATR30 ? ex.avgATR30[i] : null;
        const sqResult = checkShortSqueezeBuffer(ctx.atr14[i], avgATR30);
        if (!sqResult.pass) { cvdFiltered++; return { accept: false, reason: sqResult.reason }; }
      }

      // BEAR regime stability: must be BEAR for >= 6 hours (24 candles)
      if (ex.gateRegimeStable && !isBearRegimeStable(ctx.candles, i, 24)) {
        cvdFiltered++;
        return { accept: false, reason: 'bear_regime_unstable' };
      }

      return { accept: true };
    },

    // ── Size multiplier: 4H Trend × CVD Tier × Short tight stop ──
    getSizeMultiplier(signal, candle, ctx) {
      let mult = 1.0;
      // 4H Trend multiplier
      if (ctx.extra._4hMultiplier != null) mult *= ctx.extra._4hMultiplier;
      // CVD Tier 2 → 0.7×
      if (ctx.extra._cvdTier === 2) mult *= 0.7;
      return mult;
    },

    extraTradeFields(signal, pool, i, ctx) {
      return {
        poolId: pool.id, poolLevel: pool.level,
        pool_source: pool.source || 'EQUAL_HIGH',
      };
    },

    onTradeOpened(signal, pool, activeZones) {
      const idx = activeZones.indexOf(pool);
      if (idx >= 0) activeZones.splice(idx, 1);
    },

    sensitivityParams: {
      equalTolerance: [0.0024, 0.003, 0.0036],
      equalLookback: [40, 50, 60],
      maxBodyWickRatio: [0.32, 0.40, 0.48],
      stopBuffer: [0.056, 0.07, 0.084],     // ±20% of 0.07
    },

    reportMeta(ctx) {
      return {
        sweepsDetected,
        cvdFiltered,
        dolNotFound: ctx.missedTrades ? ctx.missedTrades.filter(m => m.reason === 'no_dol').length : 0,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const SYMBOL    = 'BTCUSDT';
  const TIMEFRAME = '15m';

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('BulletBrain v3.0 — Phase D10: SHORT-LSO Backtest');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('Loading data...');

  const candleFile = path.join(DATA.paths.historical, `${SYMBOL}_${TIMEFRAME}_tagged.ndjson`);
  if (!fs.existsSync(candleFile)) {
    console.error(`ERROR: Tagged candle file not found: ${candleFile}`);
    process.exit(1);
  }

  const allCandles = await loadNDJSON(candleFile);
  console.log(`  Loaded ${allCandles.length} candles`);

  // Pre-compute indicators
  const atr14    = atr(allCandles, 14);
  const rvolVals = rvol(allCandles, '15m', 20);
  const cvdVals  = cvd(allCandles);

  // Compute average ATR30 for short-squeeze buffer
  const avgATR30 = new Array(allCandles.length).fill(0);
  for (let i = 0; i < allCandles.length; i++) {
    const start = Math.max(0, i - 29);
    let sum = 0, count = 0;
    for (let j = start; j <= i; j++) { sum += atr14[j]; count++; }
    avgATR30[i] = count > 0 ? sum / count : atr14[i];
  }

  console.log('  Computing volume profiles (24H rolling)...');
  const volumeProfiles = rollingVolumeProfile(allCandles, '15m', 24, 50);
  console.log(`  Volume profiles: ${volumeProfiles.length}`);

  const macroEvents = loadMacroEvents();
  console.log(`  Macro events: ${macroEvents.length} events`);

  const baseOptions = {
    candles: allCandles, atr14, rvolVals, cvdVals,
    fundingMap: new Map(), macroEvents, volumeProfiles,
    initialCapital: 10000, symbol: SYMBOL, timeframe: TIMEFRAME,
  };

  const gates = { regime: true, oi: false, killzone: false, macro: false };

  // ── Yearly breakdown 2021-2024 ──────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Phase D10 — SHORT-LSO Yearly Breakdown (2021-2024)');
  console.log('Both gates: VP Bearish + 4H Trend Bearish + Squeeze Buffer');
  console.log('═══════════════════════════════════════════════════════\n');

  const years = ['2021', '2022', '2023', '2024'];
  const allResults = [];

  for (const year of years) {
    const yearStart = new Date(`${year}-01-01T00:00:00Z`).getTime();
    const yearEnd   = new Date(`${year}-12-31T23:59:59Z`).getTime();
    const candles = allCandles.filter(c => c.openTime >= yearStart && c.openTime <= yearEnd);

    if (candles.length === 0) { console.log(`${year}: NO DATA`); continue; }

    const yrAtr14 = [];
    const yrRvol = [];
    const yrCvdDelta = [], yrCvdCum = [];
    const yrVP = [];
    const yrAvgATR30 = [];
    for (let i = 0; i < allCandles.length; i++) {
      if (allCandles[i].openTime >= yearStart && allCandles[i].openTime <= yearEnd) {
        yrAtr14.push(atr14[i]);
        yrRvol.push(rvolVals[i]);
        yrCvdDelta.push(cvdVals.delta[i]);
        yrCvdCum.push(cvdVals.cumulative[i]);
        yrVP.push(volumeProfiles[i]);
        yrAvgATR30.push(avgATR30[i]);
      }
    }

    const extra = {
      cvdGateVariant: 'CVD_ZSCORE', obConfluenceEnabled: false,
      volumeProfiles: yrVP, avgATR30: yrAvgATR30,
      gateVP: true, gate4HTrend: true, gateSqueezeBuffer: true, gateRegimeStable: true,
    };

    const strategy = createShortLSOStrategy(extra);
    const report = runBacktest(strategy, {
      candles, atr14: yrAtr14, rvolVals: yrRvol,
      cvdVals: { delta: yrCvdDelta, cumulative: yrCvdCum },
      fundingMap: new Map(), macroEvents, volumeProfiles: yrVP,
      gates, initialCapital: 10000, symbol: SYMBOL, timeframe: TIMEFRAME, extra,
    });

    const wr = (report.wr?.point * 100).toFixed(1);
    const pf = report.pf?.toFixed(3);
    const dd = report.maxDD?.toFixed(2);

    console.log(`${year}: trades=${String(report.trades).padStart(4)}  WR=${wr}%  PF=${pf}  DD=${dd}%`);

    if (report.regimeBreakdown) {
      for (const [regime, rb] of Object.entries(report.regimeBreakdown)) {
        if (rb.trades > 0) {
          const rwr = (rb.wr?.point * 100).toFixed(1);
          const rpf = rb.pf?.toFixed(3);
          console.log(`    ${regime.padEnd(18)} trades=${String(rb.trades).padStart(3)}  WR=${rwr}%  PF=${rpf}`);
        }
      }
    }

    allResults.push({ year, report });
  }

  // Summary
  console.log('');
  console.log('=== SHORT-LSO CROSS-YEAR VERDICT ===');
  let totalTrades = 0;
  for (const { report } of allResults) totalTrades += report.trades;
  console.log(`Total trades (all years): ${totalTrades}`);

  const allPass = allResults.every(({ report }) => report.trades === 0 || report.pf >= 1.4);
  const anyFail = allResults.filter(({ report }) => report.trades > 0 && report.pf < 1.4);
  console.log(`All years PF >= 1.4 (or 0 trades): ${allPass ? 'YES' : 'NO'}`);
  if (anyFail.length > 0) {
    console.log(`Years with PF < 1.4: ${anyFail.map(a => `${a.year}(PF=${a.report.pf?.toFixed(3)})`).join(', ')}`);
  }

  const verdict = totalTrades >= 30 ? (allPass ? 'ACCEPT' : 'REJECT') : 'INSUFFICIENT_DATA';
  console.log(`\nVERDICT: ${verdict} (min 30 trades required, have ${totalTrades})`);

  saveResult('short_lso_yearly.json', { verdict, totalTrades, yearlyResults: allResults.map(a => ({
    year: a.year, trades: a.report.trades, wr: a.report.wr, pf: a.report.pf, maxDD: a.report.maxDD,
  }))});

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Phase D10 complete. Verdict: ${verdict}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
