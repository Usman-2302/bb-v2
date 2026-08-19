'use strict';

const fs = require('fs');
const path = require('path');

const cfg = require('./config.research');
const { loadBase, resample, sliceByDate, TF_MS } = require('./src/research/core/candles');
const features = require('./src/research/core/features');
const { CostModel } = require('./src/research/core/costs');
const { runBacktest } = require('./src/research/core/engine');
const { summarise } = require('./src/research/core/metrics');
const registry = require('./src/research/strategies/registry');

const SYMBOLS = ['ETHUSDT', 'BTCUSDT'];
const STRATEGY_NAMES = ['donchian_breakout_4h', 'mtf_structure_align_4h', 'lowvol_trend_4h'];
const START_EQUITY = 100;
const RISK_PCT = 0.01;

const DAYS = 90;
const to = new Date();
const from = new Date(to.getTime() - DAYS * 86400000);
const fromISO = from.toISOString().split('T')[0];
const toISO = to.toISOString().split('T')[0];

console.log(`\n=== Backtest: Top 3 Strategies | Last ${DAYS} days (${fromISO} to ${toISO}) | $${START_EQUITY} compounding ===\n`);

const cost = new CostModel(cfg.costs);
const OPTS_BASE = {
  costModel: cost,
  riskPct: RISK_PCT,
  warmup: cfg.engine.warmup,
  minEdgeMult: cfg.engine.minEdgeMult,
};

function runForSymbol(symbol) {
  console.log(`\n--- ${symbol} ---`);
  
  const baseFile = path.join(process.cwd(), 'data', 'historical', `${symbol}_15m_3mo.ndjson`);
  if (!fs.existsSync(baseFile)) {
    console.log(`  Missing ${baseFile}`);
    return;
  }
  
  const base = loadBase(symbol, null, '15m');
  const sliced = sliceByDate(base, fromISO, toISO);
  console.log(`  15m candles: ${sliced.length} (${sliced[0] ? new Date(sliced[0].openTime).toISOString().split('T')[0] : 'N/A'} to ${sliced[sliced.length-1] ? new Date(sliced[sliced.length-1].openTime).toISOString().split('T')[0] : 'N/A'})`);
  
  if (sliced.length < 500) {
    console.log(`  Insufficient data`);
    return;
  }
  
  const results = [];
  
  for (const name of STRATEGY_NAMES) {
    const strat = registry.get(name);
    const tf = strat.timeframe;
    
    const resampled = resample(sliced, tf);
    console.log(`  ${name} [${tf}]: ${resampled.length} candles`);
    
    if (resampled.length < 300) {
      console.log(`    Insufficient ${tf} candles`);
      continue;
    }
    
    const ctx = features.build(resampled);
    ctx.symbol = symbol;
    ctx.timeframe = tf;
    
    let equity = START_EQUITY;
    const equityCurve = [equity];
    
    const res = runBacktest(strat, ctx, { ...OPTS_BASE, equity });
    
    for (const t of res.trades) {
      equity += t.pnl;
      equityCurve.push(equity);
    }
    
    const sum = summarise(res.trades);
    const totalReturn = ((equity - START_EQUITY) / START_EQUITY * 100).toFixed(2);
    const maxDD = sum.maxDDR;
    
    console.log(`    Trades: ${sum.trades} | Avg R: ${sum.avgR.toFixed(4)} | PF: ${sum.profitFactor.toFixed(2)} | t-stat: ${sum.tStat.toFixed(2)} | Sharpe: ${sum.sharpe.toFixed(2)} | MaxDD: ${maxDD.toFixed(1)}% | Return: ${totalReturn}% | Final: $${equity.toFixed(2)}`);
    
    results.push({ name, tf, sum, equity, totalReturn, maxDD, trades: res.trades });
  }
  
  return results;
}

for (const sym of SYMBOLS) {
  runForSymbol(sym);
}

console.log('\n=== Combined Portfolio (equal weight, independent compounding) ===');
let totalFinal = 0;
for (const sym of SYMBOLS) {
  const baseFile = path.join(process.cwd(), 'data', 'historical', `${sym}_15m_3mo.ndjson`);
  if (!fs.existsSync(baseFile)) continue;
  const base = loadBase(sym, null, '15m');
  const sliced = sliceByDate(base, fromISO, toISO);
  if (sliced.length < 500) continue;
  
  let symTotal = 0;
  for (const name of STRATEGY_NAMES) {
    const strat = registry.get(name);
    const resampled = resample(sliced, strat.timeframe);
    if (resampled.length < 300) continue;
    const ctx = features.build(resampled);
    ctx.symbol = sym;
    ctx.timeframe = strat.timeframe;
    
    let equity = START_EQUITY;
    const res = runBacktest(strat, ctx, { ...OPTS_BASE, equity });
    for (const t of res.trades) equity += t.pnl;
    symTotal += equity;
  }
  totalFinal += symTotal;
  console.log(`  ${sym}: $${symTotal.toFixed(2)} (${((symTotal/(START_EQUITY*STRATEGY_NAMES.length) - 1)*100).toFixed(1)}%)`);
}
console.log(`  TOTAL: $${totalFinal.toFixed(2)} (${((totalFinal/(START_EQUITY*SYMBOLS.length*STRATEGY_NAMES.length) - 1)*100).toFixed(1)}%)`);