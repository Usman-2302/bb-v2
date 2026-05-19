'use strict';

/**
 * BulletBrain v3.0 — LSO Runner (compatibility wrapper)
 *
 * Thin adapter that translates the old LSO-specific API to the new unified
 * runner. All actual logic lives in runner.js + tradeManager.js.
 *
 * Kept for backward compatibility with run_lso_slippage_stress.js.
 * New code should use runBacktest(strategy, options) directly from runner.js.
 */

const { runBacktest, runSensitivityTest, runRegimeSplit, LSO_GATES } = require('./runner');
const { isBullishSweep, buildBullishLSOSignal, checkOBConfluence,
        checkLSOTimeBreakeven, checkOIVelocityGate, checkCVDVelocityGate,
        checkOIFlush, findSessionPools,
        checkVolumeProfileGate, check4HTrendBullish } = require('../strategies/lso');
const { detectBullishOBs, updateOBStatus }       = require('../strategies/ob');
const { isSweepCandle }                          = require('../indicators/cvd');
const { LSO: LSO_CONFIG }                        = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// Strategy descriptor factory (shared by runLSOBacktest and the adapter)
// ─────────────────────────────────────────────────────────────────────────────

function createLSOStrategy(extra) {
  const { oiDataStore } = extra;
  let sweepsDetected = 0, oiFiltered = 0, cvdFiltered = 0, obConfluenceHits = 0;

  return {
    name: 'LSO',
    config: LSO_CONFIG,

    detectZones(candles, atr14, rvolVals, cfg, ctx) {
      const swingLb = cfg.swingLookback || 1;
      const swingLowIndices = [];
      for (let i = swingLb; i < candles.length - swingLb; i++) {
        const low = candles[i].low;
        let isSwing = true;
        for (let d = 1; d <= swingLb; d++) {
          if (low >= candles[i - d].low || low >= candles[i + d].low) { isSwing = false; break; }
        }
        if (isSwing) swingLowIndices.push(i);
      }

      const allPools = [];
      const seen = new Set();
      for (let a = 0; a < swingLowIndices.length; a++) {
        for (let b = a + 1; b < swingLowIndices.length; b++) {
          const si = swingLowIndices[a], sj = swingLowIndices[b];
          if (sj - si > cfg.equalLookback) break;
          if (sj - si < cfg.equalMinGap) continue;
          const lowI = candles[si].low, lowJ = candles[sj].low;
          if (Math.abs(lowI - lowJ) / lowI >= cfg.equalTolerance) continue;
          let swept = false;
          for (let k = si + 1; k < sj; k++) {
            if (candles[k].low < Math.min(lowI, lowJ)) { swept = true; break; }
          }
          if (swept) continue;
          const lk = Math.floor((lowI + lowJ) / 2);
          if (seen.has(lk)) continue;
          seen.add(lk);
          allPools.push({ id: `eql_${candles[si].openTime}_${candles[sj].openTime}`, type: 'EQUAL_LOWS',
            level: (lowI + lowJ) / 2, formed_at: sj, expires_at: sj + cfg.equalLookback, index_i: si, index_j: sj });
        }
      }
      allPools.sort((a, b) => a.formed_at - b.formed_at);
      ctx.extra.allPools = allPools;
      ctx.extra.poolActivationPtr = 0;

      if (extra.obConfluenceEnabled !== false) {
        ctx.extra.allOBs = detectBullishOBs(candles, atr14, rvolVals);
        ctx.extra.activeOBs = [...ctx.extra.allOBs];
      }
      return [];
    },

    updateZones() {},
    isZoneActive: () => true,

    onCandleStart(ctx) {
      const { i, candle, activeZones, extra: ex, cfg } = ctx;
      while (ex.poolActivationPtr < ex.allPools.length && ex.allPools[ex.poolActivationPtr].formed_at <= i) {
        activeZones.push(ex.allPools[ex.poolActivationPtr++]);
      }
      for (let p = activeZones.length - 1; p >= 0; p--) {
        if (activeZones[p].expires_at < i) activeZones.splice(p, 1);
      }
      if (activeZones.length > 20) activeZones.splice(0, activeZones.length - 20);

      if (cfg.useSessionPools) {
        for (let p = activeZones.length - 1; p >= 0; p--) {
          if (activeZones[p].source) {
            const pd = new Date(activeZones[p].formed_time || 0); pd.setUTCHours(0,0,0,0);
            const cd = new Date(candle.openTime); cd.setUTCHours(0,0,0,0);
            if (pd.getTime() < cd.getTime() - 86400000) activeZones.splice(p, 1);
          }
        }
        const tk = new Date(candle.openTime).toISOString().slice(0,10);
        if (!activeZones.some(p => p.source && p.id?.includes(tk.replace(/-/g,'')))) {
          activeZones.push(...findSessionPools(ctx.candles, i));
        }
      }
      if (ex.activeOBs) {
        for (const ob of ex.activeOBs) { if (i > ob.formed_at) updateOBStatus(ob, candle, i); }
        ex.activeOBs = ex.activeOBs.filter(ob => ob.status === 'ACTIVE');
      }
    },

    checkEntry(pool, candle, ctx) {
      // ctx is passed by runner.js as the 3rd argument when available
      // We need atr14[i] for the stop price — get it from ctx if available
      const atr14Val = ctx && ctx.atr14 && ctx.i !== undefined ? ctx.atr14[ctx.i] : 0;
      if (isBullishSweep(candle, pool)) {
        sweepsDetected++;
        return buildBullishLSOSignal(candle, pool, atr14Val);
      }
      return null;
    },

    isRegimeAllowed() { return true; },

    gate7(candle, cvdVals, i, ctx) {
      const variant = ctx.extra.cvdGateVariant || 'CVD';
      if (variant === 'NONE') { ctx.extra._cvdTier = 1; return { pass: true }; }
      if (variant === 'CVD') {
        if (!cvdVals || !cvdVals.delta) return { pass: false, reason: 'cvd_no_data' };
        const cd = cvdVals.delta[i] || 0;
        if (isSweepCandle(candle) && i >= 1) { if (cd <= (cvdVals.delta[i-1]||0)) { cvdFiltered++; return { pass: false, reason: 'cvd_ghost_sweep' }; } }
        if (i >= 20) {
          const rec = cvdVals.delta.slice(Math.max(0,i-20),i).map(d=>Math.abs(d));
          const avg = rec.reduce((a,b)=>a+b,0)/rec.length;
          if (avg > 0 && cd < -1.5*avg) { cvdFiltered++; return { pass: false, reason: 'cvd_negative' }; }
        }
        ctx.extra._cvdTier = 1;
        return { pass: true };
      }
      if (variant === 'OI_VELOCITY') {
        if (!oiDataStore) return { pass: false, reason: 'no_oi' };
        const vr = checkOIVelocityGate(ctx.symbol, candle.openTime, oiDataStore);
        if (!vr.pass) { cvdFiltered++; return { pass: false, reason: `oi_vel_${vr.reason}` }; }
        ctx.extra._cvdTier = 1;
        return { pass: true };
      }
      if (variant === 'CVD_ZSCORE') {
        const zr = checkCVDVelocityGate(i, cvdVals, ctx.cfg.cvdVelocityZscoreThreshold||2.5, ctx.cfg.cvdVelocityLookback||96);
        // Store z-score for conviction score computation (feat/conviction-correlation)
        ctx.extra._cvdZscore = zr.zscore || 0;
        // Phase D9/D13 — Tiered CVD Velocity Gate
        // Tier 1: z ≥ 2.5 → pass at 1.0x size
        // Tier 2: 1.5 ≤ z < 2.5 AND RVOL > threshold → pass at 0.7x size
        //   RVOL threshold is regime-specific: 3.0× in trending, 2.2× in RANGING
        //   Ranging markets have lower "breakout" volume — 2.2× is still significant vs noise
        if (zr.pass) {
          ctx.extra._cvdTier = 1;
          return { pass: true, tier: 1, zscore: zr.zscore };
        }
        if (zr.zscore != null && zr.zscore >= 1.5) {
          const regime = ctx.candles[i].regime || 'RANGING';
          const rvolThreshold = (regime === 'RANGING' || regime === 'RANGING_ZOMBIE') ? 2.2 : 3.0;
          const rvol = ctx.rvolVals[i];
          if (rvol > rvolThreshold) {
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

    validateSignal(signal, candle, i, ctx) {
      const { gates, extra: ex, cfg } = ctx;
      if (cfg.sweepRvolMin > 0 && ctx.rvolVals[i] < cfg.sweepRvolMin) { cvdFiltered++; return { accept: false, reason: 'sweep_rvol' }; }
      if (gates.oi && oiDataStore && ex.oiThresholdFn) {
        const regime = candle.regime || 'RANGING';
        if (!checkOIFlush(ctx.symbol, candle.openTime, oiDataStore, ex.oiThresholdFn(regime))) {
          oiFiltered++; return { accept: false, reason: 'oi_no_flush' };
        }
      }
      // Phase D9 — Gate VP: Volume Profile structural confirmation (HARD gate)
      ctx.extra._vpResult = { pass: true }; // default
      if (ex.gateVP && ex.volumeProfiles) {
        const vpResult = checkVolumeProfileGate(candle, candle.low, candle.close, ex.volumeProfiles, i);
        ctx.extra._vpResult = vpResult; // store for conviction score (feat/conviction-correlation)
        if (!vpResult.pass) { cvdFiltered++; return { accept: false, reason: vpResult.reason }; }
      }
      // Phase D9 — 4H Trend: stored as size multiplier, NOT a hard gate
      // Bullish → 1.0x, Bearish → BLOCK (multiplier=0), Neutral → 0.5x
      ctx.extra._4hMultiplier = 1.0;
      ctx.extra._trend4hState = 'UNKNOWN'; // default
      if (ex.gate4HTrend) {
        const trendResult = check4HTrendBullish(ctx.candles, i);
        ctx.extra._4hMultiplier = trendResult.multiplier;
        ctx.extra._trend4hState = trendResult.state; // store for conviction score
        if (trendResult.multiplier === 0) {
          cvdFiltered++;
          return { accept: false, reason: `4h_${trendResult.state}` };
        }
      }
      return { accept: true };
    },

    getSizeMultiplier(signal, candle, ctx) {
      let mult = 1.0;
      // OB confluence: 1.3× when sweep inside active OB zone
      ctx.extra._insideOB = false; // default for conviction score
      if (ctx.extra.obConfluenceEnabled !== false) {
        const obs = ctx.extra.activeOBs;
        if (obs && obs.length) {
          const oc = checkOBConfluence(candle, obs);
          if (oc.insideOB) {
            obConfluenceHits++;
            mult *= 1.3;
            ctx.extra._insideOB = true; // store for conviction score (feat/conviction-correlation)
          }
        }
      }
      // 4H Trend multiplier (from validateSignal)
      if (ctx.extra._4hMultiplier != null) {
        mult *= ctx.extra._4hMultiplier;
      }
      // CVD tier multiplier (from gate7): Tier 2 → 0.7×
      if (ctx.extra._cvdTier === 2) {
        mult *= 0.7;
      }
      return mult;
    },

    extraTradeFields(signal, pool, i, ctx) {
      let oid = null;
      if (ctx.extra.obConfluenceEnabled !== false && ctx.extra.activeOBs) {
        const oc = checkOBConfluence(ctx.candles[i], ctx.extra.activeOBs);
        if (oc.insideOB) oid = oc.obId;
      }
      const fields = { poolId: pool.id, poolLevel: pool.level, pool_source: pool.source || 'EQUAL_LOW', ob_confluence: oid !== null, ob_confluence_id: oid };

      // Phase D13 — Regime-Specific TP2 for RANGING
      // In ranging markets, target the opposite Value Area boundary instead of DOL
      const regime = ctx.candles[i].regime || 'RANGING';
      if ((regime === 'RANGING' || regime === 'RANGING_ZOMBIE') && ctx.extra.volumeProfiles) {
        const vp = ctx.extra.volumeProfiles[i];
        if (vp && vp.buckets && vp.buckets.length > 0) {
          const { computeValueArea } = require('../indicators/volumeProfile');
          const { vah, val } = computeValueArea(vp);
          if (vah > 0 && val > 0) {
            // For LONG: target VAH (upper boundary). For SHORT: target VAL (lower boundary)
            fields.tp2 = signal.side === 'SHORT' ? val : vah;
            fields.tp2_source = 'VALUE_AREA';
            ctx.extra._tp2Overridden = true;
          }
        }
      }

      return fields;
    },

    onTradeOpened(signal, pool, activeZones) {
      const idx = activeZones.indexOf(pool);
      if (idx >= 0) activeZones.splice(idx, 1);
    },

    sensitivityParams: {
      equalTolerance: [0.0024, 0.003, 0.0036], equalLookback: [40, 50, 60],
      maxBodyWickRatio: [0.32, 0.40, 0.48], stopBuffer: [0.08, 0.10, 0.12],
    },

    reportMeta(ctx) {
      return {
        sweepsDetected, oiFiltered, cvdFiltered,
        dolNotFound: ctx.missedTrades.filter(m => m.reason === 'no_dol').length,
        obConfluenceHits, timeBreakevenExits: ctx.timeBreakevenExitsTotal || 0,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Old API adapter for run_lso_slippage_stress.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a single LSO backtest pass using the old API.
 * Translates old options to the unified runner call.
 */
function runLSOBacktest(options) {
  const {
    candles, atr14, rvolVals, cvdVals, oiDataStore, fundingMap, macroEvents,
    gates, initialCapital = 10000, lsoConfig = {},
    symbol = 'BTCUSDT', timeframe = '15m',
    cvdGateVariant = 'CVD',
    obConfluenceEnabled = true,
    timeBreakevenEnabled = true,
  } = options;

  const oiThresholdFn = (regime) => {
    return (LSO_CONFIG.oiFlushThreshold[regime] || LSO_CONFIG.oiFlushThreshold.RANGING);
  };

  const extra = {
    oiDataStore, oiThresholdFn, cvdGateVariant, obConfluenceEnabled,
    timeBreakeven: timeBreakevenEnabled ? { enabled: true, checkFn: checkLSOTimeBreakeven } : { enabled: false },
  };

  const strategy = createLSOStrategy(extra);

  return runBacktest(strategy, {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents,
    gates, initialCapital, configOverrides: lsoConfig, symbol, timeframe, extra,
  });
}

/**
 * Run LSO sensitivity test using the old API.
 */
function runLSOSensitivityTest(options) {
  const { candles, atr14, rvolVals, cvdVals, oiDataStore, fundingMap, macroEvents,
    gates, initialCapital = 10000, lsoConfig = {},
    symbol = 'BTCUSDT', timeframe = '15m',
    cvdGateVariant = 'CVD',
    obConfluenceEnabled = true,
    timeBreakevenEnabled = true,
  } = options;

  const oiThresholdFn = (regime) => {
    return (LSO_CONFIG.oiFlushThreshold[regime] || LSO_CONFIG.oiFlushThreshold.RANGING);
  };

  const extra = {
    oiDataStore, oiThresholdFn, cvdGateVariant, obConfluenceEnabled,
    timeBreakeven: timeBreakevenEnabled ? { enabled: true, checkFn: checkLSOTimeBreakeven } : { enabled: false },
  };

  const strategy = createLSOStrategy(extra);

  return runSensitivityTest(strategy, {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents,
    gates, initialCapital, configOverrides: lsoConfig, symbol, timeframe, extra,
  });
}

/**
 * Run LSO regime split using the old API.
 */
function runLSORegimeSplit(options) {
  const { candles, atr14, rvolVals, cvdVals, oiDataStore, fundingMap, macroEvents,
    initialCapital = 10000, symbol = 'BTCUSDT', timeframe = '15m',
  } = options;

  const extra = { oiDataStore, obConfluenceEnabled: false };

  const strategy = createLSOStrategy(extra);

  return runRegimeSplit(strategy, {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents,
    initialCapital, symbol, timeframe, extra,
  });
}

module.exports = { runLSOBacktest, runLSOSensitivityTest, runLSORegimeSplit, createLSOStrategy, LSO_GATES };
