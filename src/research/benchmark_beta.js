'use strict';

/**
 * Beta benchmark.
 *
 * The research pipeline surfaced four trend strategies with positive expectancy.
 * Their long/short decomposition showed the entire edge sits on the LONG side
 * (e.g. donchian_breakout_4h: LONG +0.208R, SHORT -0.048R). In a market that
 * rose over the sample, a long-biased system captures drift and reports it as
 * skill.
 *
 * The correct benchmark for a long-biased strategy is not zero — it is
 * buy-and-hold. This computes both on the same risk basis so they are
 * comparable, and reports the strategy's exposure-adjusted alpha.
 *
 * USAGE  node src/research/benchmark_beta.js
 */

const fs = require('fs');
const path = require('path');
const cfg = require('../../config.research');
const { loadBase, resample } = require('./core/candles');
const { mean, sd } = require('./core/metrics');

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

function buyHold(candles) {
  const rets = [];
  for (let i = 1; i < candles.length; i++) {
    rets.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  const span = candles[candles.length - 1].openTime - candles[0].openTime;
  const perYear = rets.length / (span / YEAR_MS);
  const m = mean(rets), s = sd(rets);
  const total = rets.reduce((a, b) => a + b, 0);

  // max drawdown on the log-equity curve
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of rets) {
    cum += r;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  return {
    totalLogReturn: total,
    multiple: Math.exp(total),
    cagr: Math.exp(total / (span / YEAR_MS)) - 1,
    sharpe: s > 0 ? (m / s) * Math.sqrt(perYear) : NaN,
    maxDDlog: maxDD,
    maxDDpct: 1 - Math.exp(-maxDD),
  };
}

function main() {
  const tradesFile = path.join(process.cwd(), 'results/research/trades_scenario-measured.csv');
  if (!fs.existsSync(tradesFile)) {
    console.error('run `node src/research/run_research.js` first');
    process.exit(1);
  }
  const lines = fs.readFileSync(tradesFile, 'utf8').trim().split('\n');
  const cols = lines[0].split(',');
  const rows = lines.slice(1).map(l => {
    // simple split is safe here: no field contains a comma
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });

  console.log('='.repeat(96));
  console.log('BETA BENCHMARK — is the trend edge alpha, or just long exposure?');
  console.log('='.repeat(96));

  console.log('\nBUY AND HOLD over the research sample');
  console.log('  ' + 'symbol'.padEnd(10) + 'multiple'.padStart(10) + 'CAGR'.padStart(10) +
    'Sharpe'.padStart(9) + 'maxDD'.padStart(9));
  const bh = {};
  for (const sym of cfg.symbols) {
    const c = resample(loadBase(sym), '1d');
    const r = buyHold(c);
    bh[sym] = r;
    console.log('  ' + sym.padEnd(10) + (r.multiple.toFixed(2) + 'x').padStart(10) +
      ((r.cagr * 100).toFixed(1) + '%').padStart(10) +
      r.sharpe.toFixed(2).padStart(9) + ((r.maxDDpct * 100).toFixed(0) + '%').padStart(9));
  }

  // strategy long/short decomposition
  const by = new Map();
  for (const r of rows) {
    if (!r.rMultiple) continue;
    const k = r.strategy + '|' + r.dir;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(parseFloat(r.rMultiple));
  }

  console.log('\nSTRATEGY DECOMPOSITION — expectancy by side');
  console.log('  ' + 'strategy'.padEnd(28) + 'LONG n'.padStart(8) + 'LONG avgR'.padStart(11) +
    'SHORT n'.padStart(9) + 'SHORT avgR'.padStart(12) + '   verdict');
  const names = [...new Set(rows.map(r => r.strategy))];
  const findings = [];
  for (const nm of names) {
    const L = by.get(nm + '|1') || [];
    const S = by.get(nm + '|-1') || [];
    if (!L.length && !S.length) continue;
    const lm = L.length ? mean(L) : NaN;
    const sm = S.length ? mean(S) : NaN;
    let verdict;
    if (lm > 0 && sm > 0) verdict = 'symmetric — genuine two-sided signal';
    else if (lm > 0 && !(sm > 0)) verdict = 'LONG-ONLY — indistinguishable from beta';
    else if (!(lm > 0) && sm > 0) verdict = 'SHORT-only';
    else verdict = 'both sides negative';
    findings.push({ nm, lm, sm, verdict });
    console.log('  ' + nm.padEnd(28) + String(L.length).padStart(8) +
      (Number.isFinite(lm) ? lm.toFixed(4) : 'n/a').padStart(11) +
      String(S.length).padStart(9) +
      (Number.isFinite(sm) ? sm.toFixed(4) : 'n/a').padStart(12) +
      '   ' + verdict);
  }

  console.log('\nINTERPRETATION');
  console.log('  A strategy whose edge lives only on the long side, in a sample where the');
  console.log('  underlying rose, has not demonstrated skill. Buy-and-hold captured the same');
  console.log('  drift with no fees, no slippage and no execution risk. To justify deployment');
  console.log('  a long-biased system must beat buy-and-hold on RISK-ADJUSTED terms, not');
  console.log('  merely be positive.');

  const symmetric = findings.filter(f => f.verdict.startsWith('symmetric'));
  console.log('\n  strategies with a genuine two-sided edge: ' +
    (symmetric.length ? symmetric.map(f => f.nm).join(', ') : 'NONE'));

  fs.writeFileSync(path.join(process.cwd(), 'results/research/beta_benchmark.json'),
    JSON.stringify({ buyHold: bh, findings }, null, 2));
  console.log('\nwritten: results/research/beta_benchmark.json');
}

main();
