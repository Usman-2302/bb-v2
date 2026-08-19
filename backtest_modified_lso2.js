'use strict';

const fs = require('fs');
const path = require('path');

const cfg = require('./config.research');
const { loadBase, resample, sliceByDate, TF_MS } = require('./src/research/core/candles');
const features = require('./src/research/core/features');
const { CostModel } = require('./src/research/core/costs');
const { runBacktest } = require('./src/research/core/engine');
const { summarise } = require('./src/research/core/metrics');

function createModifiedStrategy(params) {
  const {
    STOP_ATR_MULT = 2.0,
    TP_R_MULT = 2.5,
    SWEEP_RVOL_MIN = 0.3,
    RISK_PCT = 0.003,
    SKIP_RANGING = true,
    TIME_EXIT_CANDLES = 50,
    MIN_EDGE_COST_MULT = 1.5,
  } = params;

  return {
    name: `mod_lso_atr${STOP_ATR_MULT}_r${TP_R_MULT}_risk${(RISK_PCT*100).toFixed(1)}_edge${MIN_EDGE_COST_MULT}`,
    timeframe: '15m',
    maxHoldBars: TIME_EXIT_CANDLES,
    
    signal: (ctx, i) => {
      if (i < 300) return null;
      
      const regime = ctx.trend[i];
      if (SKIP_RANGING && (regime === 0 || regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) return null;
      
      const rv = ctx.rvol[i];
      if (rv < SWEEP_RVOL_MIN) return null;
      
      const cv = ctx.cvdDelta[i] || 0;
      const pv = ctx.cvdDelta[i-1] || 0;
      const atr = ctx.atr14[i] || 0;
      if (!(atr > 0)) return null;
      
      const lookback = 100;
      const start = Math.max(0, i - lookback);
      
      if (regime === 1) {
        let poolLevel = null;
        for (let a = start; a < i; a++) {
          for (let b = a + 2; b < i; b++) {
            if (b - a > 80) break;
            const v1 = ctx.low[a], v2 = ctx.low[b];
            if (Math.abs(v1 - v2) / v1 < 0.005) {
              let swept = false;
              for (let k = a + 1; k < b; k++) {
                if (ctx.low[k] < Math.min(v1, v2)) { swept = true; break; }
              }
              if (!swept) { poolLevel = (v1 + v2) / 2; break; }
            }
          }
          if (poolLevel) break;
        }
        if (!poolLevel) return null;
        if (ctx.low[i] >= poolLevel || ctx.close[i] <= poolLevel) return null;
        if ((cv - pv) <= 0) return null;
        
        const stopDist = atr * STOP_ATR_MULT;
        const stop = poolLevel - stopDist;
        if (stopDist <= 0 || poolLevel <= stop) return null;
        
        // Cost floor check (approximate, using pool level as entry ref)
        const entryRef = poolLevel;
        const tp = poolLevel + stopDist * TP_R_MULT;
        const tpDist = Math.abs(tp - entryRef);
        const WIN_COST_RATE = 0.0007; // taker + maker
        if (MIN_EDGE_COST_MULT > 0 && (tpDist / entryRef) < MIN_EDGE_COST_MULT * WIN_COST_RATE) return null;
        
        return { dir: 1, meta: { poolLevel, stopDist, stop } };
        
      } else if (regime === -1) {
        let poolLevel = null;
        for (let a = start; a < i; a++) {
          for (let b = a + 2; b < i; b++) {
            if (b - a > 80) break;
            const v1 = ctx.high[a], v2 = ctx.high[b];
            if (Math.abs(v1 - v2) / v1 < 0.005) {
              let swept = false;
              for (let k = a + 1; k < b; k++) {
                if (ctx.high[k] > Math.max(v1, v2)) { swept = true; break; }
              }
              if (!swept) { poolLevel = (v1 + v2) / 2; break; }
            }
          }
          if (poolLevel) break;
        }
        if (!poolLevel) return null;
        if (ctx.high[i] <= poolLevel || ctx.close[i] >= poolLevel) return null;
        if ((cv - pv) >= 0) return null;
        
        const stopDist = atr * STOP_ATR_MULT;
        const stop = poolLevel + stopDist;
        if (stopDist <= 0 || poolLevel >= stop) return null;
        
        const entryRef = poolLevel;
        const tp = poolLevel - stopDist * TP_R_MULT;
        const tpDist = Math.abs(tp - entryRef);
        const WIN_COST_RATE = 0.0007;
        if (MIN_EDGE_COST_MULT > 0 && (tpDist / entryRef) < MIN_EDGE_COST_MULT * WIN_COST_RATE) return null;
        
        return { dir: -1, meta: { poolLevel, stopDist, stop } };
      }
      
      return null;
    },
    
    stop: (ctx, i, sig, entry) => sig.meta.stop,
    
    target: (ctx, i, sig, entry, stop) => {
      const stopDist = Math.abs(entry - stop);
      return entry + sig.dir * stopDist * TP_R_MULT;
    },
  };
}

const SYMBOLS = ['ETHUSDT', 'BTCUSDT'];
const DAYS = 90;
const to = new Date();
const from = new Date(to.getTime() - DAYS * 86400000);
const fromISO = from.toISOString().split('T')[0];
const toISO = to.toISOString().split('T')[0];

const PARAM_SETS = [
  { label: 'CONSERVATIVE (no edge filter)', STOP_ATR_MULT: 2.0, TP_R_MULT: 2.5, RISK_PCT: 0.003, MIN_EDGE_COST_MULT: 0 },
  { label: 'CONSERVATIVE + edge 1.0x', STOP_ATR_MULT: 2.0, TP_R_MULT: 2.5, RISK_PCT: 0.003, MIN_EDGE_COST_MULT: 1.0 },
  { label: 'CONSERVATIVE + edge 1.5x', STOP_ATR_MULT: 2.0, TP_R_MULT: 2.5, RISK_PCT: 0.003, MIN_EDGE_COST_MULT: 1.5 },
  { label: 'CONSERVATIVE + edge 2.0x', STOP_ATR_MULT: 2.0, TP_R_MULT: 2.5, RISK_PCT: 0.003, MIN_EDGE_COST_MULT: 2.0 },
  { label: 'WIDE 2.5x ATR + edge 1.5x', STOP_ATR_MULT: 2.5, TP_R_MULT: 2.5, RISK_PCT: 0.003, MIN_EDGE_COST_MULT: 1.5 },
  { label: 'WIDE 2.0x ATR + 3R + edge 1.5x', STOP_ATR_MULT: 2.0, TP_R_MULT: 3.0, RISK_PCT: 0.003, MIN_EDGE_COST_MULT: 1.5 },
];

const cost = new CostModel(cfg.costs);
const START_EQUITY = 100;

console.log(`\n=== Modified LSO + Cost Floor Backtest | Last ${DAYS} days ===\n`);

for (const symbol of SYMBOLS) {
  console.log(`\n========== ${symbol} ==========`);
  
  const baseFile = path.join(process.cwd(), 'data', 'historical', `${symbol}_15m.ndjson`);
  if (!fs.existsSync(baseFile)) continue;
  
  const base = loadBase(symbol, null, '15m');
  const sliced = sliceByDate(base, fromISO, toISO);
  if (sliced.length < 500) continue;
  
  const ctx = features.build(sliced);
  ctx.symbol = symbol;
  ctx.timeframe = '15m';
  
  for (const ps of PARAM_SETS) {
    const strat = createModifiedStrategy(ps);
    
    let equity = START_EQUITY;
    const res = runBacktest(strat, ctx, { costModel: cost, equity, riskPct: ps.RISK_PCT, warmup: 300, minEdgeMult: 0 });
    
    const sum = summarise(res.trades);
    const totalReturn = ((equity - START_EQUITY) / START_EQUITY * 100).toFixed(2);
    const avgHold = res.trades.length > 0 
      ? (res.trades.reduce((a,t) => a + t.holdBars, 0) / res.trades.length).toFixed(1)
      : 'N/A';
    
    console.log(`  ${ps.label}:`);
    console.log(`    Trades: ${sum.trades} | Avg R: ${sum.avgR.toFixed(4)} | PF: ${sum.profitFactor.toFixed(2)} | t: ${sum.tStat.toFixed(2)}`);
    console.log(`    MaxDD: ${sum.maxDDR.toFixed(1)}% | Hold: ${avgHold}b (${(avgHold*15).toFixed(0)}m) | Rejects: ${JSON.stringify(res.rejects)}`);
  }
}

console.log('\n========== COMBINED PORTFOLIO ==========');
for (const ps of PARAM_SETS) {
  let totalFinal = 0;
  for (const symbol of SYMBOLS) {
    const baseFile = path.join(process.cwd(), 'data', 'historical', `${symbol}_15m.ndjson`);
    if (!fs.existsSync(baseFile)) continue;
    const base = loadBase(symbol, null, '15m');
    const sliced = sliceByDate(base, fromISO, toISO);
    if (sliced.length < 500) continue;
    
    const ctx = features.build(sliced);
    ctx.symbol = symbol;
    ctx.timeframe = '15m';
    
    const strat = createModifiedStrategy(ps);
    let equity = START_EQUITY;
    const res = runBacktest(strat, ctx, { costModel: cost, equity, riskPct: ps.RISK_PCT, warmup: 300, minEdgeMult: 0 });
    for (const t of res.trades) equity += t.pnl;
    totalFinal += equity;
  }
  const totalReturn = ((totalFinal - START_EQUITY * SYMBOLS.length) / (START_EQUITY * SYMBOLS.length) * 100).toFixed(2);
  console.log(`  ${ps.label}: $${totalFinal.toFixed(2)} (${totalReturn}%)`);
}