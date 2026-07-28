'use strict';

/**
 * Validation protocols.
 *
 * A strategy is only interesting if it survives ALL of these. Any single one in
 * isolation is easy to pass by luck, which is how the deprecated system reached
 * production on a grid-searched configuration.
 */

const { runBacktest } = require('./engine');
const { summarise } = require('./metrics');
const { blockBootstrap, monteCarlo, bonferroniThreshold } = require('./stats');

/** Restrict a context to a date range, keeping feature arrays aligned. */
function windowIndices(ctx, fromISO, toISO) {
  const a = fromISO ? Date.parse(fromISO + 'T00:00:00Z') : -Infinity;
  const b = toISO ? Date.parse(toISO + 'T23:59:59Z') : Infinity;
  let lo = 0, hi = ctx.candles.length - 1;
  while (lo < ctx.candles.length && ctx.candles[lo].openTime < a) lo++;
  while (hi >= 0 && ctx.candles[hi].openTime > b) hi--;
  return [lo, hi];
}

/**
 * Run a strategy over a date window by filtering the resulting trades.
 * Features are always computed on the FULL series so indicator warmup is
 * identical across windows — slicing candles first would give each window a
 * different EMA seed and make windows incomparable.
 */
function runWindow(strategy, ctx, opts, fromISO, toISO) {
  const res = runBacktest(strategy, ctx, opts);
  const a = fromISO ? Date.parse(fromISO + 'T00:00:00Z') : -Infinity;
  const b = toISO ? Date.parse(toISO + 'T23:59:59Z') : Infinity;
  const trades = res.trades.filter(t => t.entryTime >= a && t.entryTime <= b);
  return { ...res, trades, summary: summarise(trades) };
}

/**
 * Rolling walk-forward. Each step trains on `trainBars` and evaluates on the
 * following `testBars`. Since none of these strategies fit parameters in-sample,
 * the train leg is used only as a stability reference; the concatenated TEST
 * legs form the honest out-of-sample record.
 */
function walkForward(strategy, ctx, opts, { folds = 5 } = {}) {
  const c = ctx.candles;
  if (c.length < folds * 200) return { folds: [], combined: summarise([]) };
  const res = runBacktest(strategy, ctx, opts);
  const t0 = c[0].openTime, t1 = c[c.length - 1].openTime;
  const span = (t1 - t0) / folds;
  const out = [];
  for (let k = 0; k < folds; k++) {
    const a = t0 + k * span, b = t0 + (k + 1) * span;
    const tr = res.trades.filter(t => t.entryTime >= a && t.entryTime < b);
    out.push({
      fold: k + 1,
      from: new Date(a).toISOString().slice(0, 10),
      to: new Date(b).toISOString().slice(0, 10),
      summary: summarise(tr),
    });
  }
  return { folds: out, combined: summarise(res.trades) };
}

/**
 * Full evaluation of one strategy on one symbol: splits, walk-forward,
 * bootstrap CI and Monte Carlo.
 */
function evaluate(strategy, ctx, opts, splits) {
  const full = runBacktest(strategy, ctx, opts);
  const all = summarise(full.trades);
  const rs = full.trades.map(t => t.rMultiple).filter(Number.isFinite);

  const bySplit = {};
  for (const [name, [from, to]] of Object.entries(splits)) {
    const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T23:59:59Z');
    bySplit[name] = summarise(full.trades.filter(t => t.entryTime >= a && t.entryTime <= b));
  }

  return {
    strategy: strategy.name,
    symbol: ctx.symbol,
    timeframe: strategy.timeframe,
    all,
    bySplit,
    walkForward: walkForward(strategy, ctx, opts, { folds: 5 }),
    bootstrap: rs.length > 30 ? blockBootstrap(rs) : null,
    monteCarlo: rs.length > 30 ? monteCarlo(rs) : null,
    rejects: full.rejects,
    signalsRaw: full.signalsRaw,
  };
}

/**
 * Acceptance gate. Deliberately strict — the cost of a false accept is real
 * money, the cost of a false reject is another week of research.
 */
function acceptanceVerdict(perSymbol, { tBar, minTrades = 50 }) {
  const reasons = [];
  const syms = Object.keys(perSymbol);

  for (const s of syms) {
    const e = perSymbol[s];
    if (e.all.trades < minTrades) reasons.push(`${s}: only ${e.all.trades} trades (<${minTrades})`);
    if (!(e.all.avgR > 0)) reasons.push(`${s}: expectancy ${fmt(e.all.avgR)}R <= 0`);
    if (!(Math.abs(e.all.tStat) > tBar)) reasons.push(`${s}: |t|=${fmt(e.all.tStat)} <= ${tBar.toFixed(2)} (multiple-testing bar)`);
    if (!(e.all.profitFactor > 1)) reasons.push(`${s}: PF ${fmt(e.all.profitFactor)} <= 1`);
    for (const [w, sum] of Object.entries(e.bySplit)) {
      if (sum.trades >= 10 && !(sum.avgR > 0)) reasons.push(`${s}/${w}: expectancy ${fmt(sum.avgR)}R <= 0`);
    }
    if (e.bootstrap && !(e.bootstrap.meanCI[0] > 0)) {
      reasons.push(`${s}: bootstrap 95% CI lower bound ${fmt(e.bootstrap.meanCI[0])}R <= 0`);
    }
    const wfPositive = e.walkForward.folds.filter(f => f.summary.trades >= 5 && f.summary.avgR > 0).length;
    const wfTotal = e.walkForward.folds.filter(f => f.summary.trades >= 5).length;
    if (wfTotal >= 3 && wfPositive < Math.ceil(wfTotal * 0.6)) {
      reasons.push(`${s}: only ${wfPositive}/${wfTotal} walk-forward folds positive`);
    }
  }
  return { accepted: reasons.length === 0, reasons };
}

function fmt(v) { return Number.isFinite(v) ? v.toFixed(3) : 'n/a'; }

module.exports = { evaluate, walkForward, runWindow, windowIndices, acceptanceVerdict, bonferroniThreshold };
