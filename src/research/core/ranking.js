'use strict';

/**
 * Ranking engine and strategy lifecycle.
 *
 * Design principle: HARD GATES first, score second. A composite score is a
 * convenient way to order candidates, but it must never let a strategy that
 * fails a fundamental requirement rank above one that passes. Weighted scores
 * that can be "made up elsewhere" are how weak models get promoted.
 *
 * The beta gate is deliberately fundamental rather than a scored component:
 * Phase 3 found three strategies with PF > 1.1 whose entire edge was long-side
 * drift in a rising market. A long-only "edge" is beta, and beta is free.
 */

const STATUS = {
  RESEARCH: 'RESEARCH',                       // tested, insufficient evidence either way
  REJECTED: 'REJECTED',                       // failed a hard gate
  CANDIDATE: 'CANDIDATE',                     // passes gates, needs more evidence
  PAPER_TRADING: 'PAPER_TRADING',             // worth running forward without money
  PRODUCTION_CANDIDATE: 'PRODUCTION_CANDIDATE', // would justify capital
  NO_SIGNALS: 'NO_SIGNALS',                     // entry conditions never fired — spec result, not perf
  ARCHIVED: 'ARCHIVED',
};

/**
 * Hard gates. Each returns {pass, reason}. Order matters only for reporting.
 */
function hardGates(ev, { tBar, minTrades }) {
  const s = ev.pooled;
  const gates = [];
  const add = (name, pass, detail) => gates.push({ name, pass, detail });

  add('sample_size', s.trades >= minTrades,
    `${s.trades} trades (need >= ${minTrades})`);
  add('positive_expectancy', s.avgR > 0,
    `expectancy ${fmt(s.avgR)}R`);
  add('profit_factor', s.profitFactor > 1,
    `PF ${fmt(s.profitFactor, 2)}`);
  add('statistical_significance', Math.abs(s.tStat) > tBar && s.tStat > 0,
    `t=${fmt(s.tStat, 2)} (bar ${tBar.toFixed(2)})`);

  const beta = ev.analytics?.beta;
  add('two_sided_edge', !!(beta && beta.twoSided),
    beta ? beta.verdict : 'no analytics');

  const conc = ev.analytics?.concentration;
  add('edge_distributed', !conc || conc.verdict !== 'FRAGILE — expectancy depends on <=5 trades',
    conc ? conc.verdict : 'n/a');

  add('cross_symbol', ev.perSymbolPositive === ev.perSymbolCount,
    `${ev.perSymbolPositive}/${ev.perSymbolCount} symbols positive`);

  const boot = ev.bootstrapWorst;
  add('bootstrap_ci', !boot || boot > 0,
    boot === null || boot === undefined ? 'n/a' : `95% CI lower ${fmt(boot)}R`);

  add('walk_forward', ev.wfPositiveShare >= 0.6,
    `${fmt(ev.wfPositiveShare * 100, 0)}% of folds positive`);

  add('cost_resilient', ev.costResilience ? ev.costResilience.survivesHarsh : true,
    ev.costResilience ? ev.costResilience.verdict : 'n/a');

  return gates;
}

/**
 * Composite score 0-100, computed ONLY for strategies that pass every hard gate.
 * Components are capped so no single dimension can dominate.
 */
function score(ev) {
  const s = ev.pooled;
  const c = [];
  const push = (name, value, weight) => c.push({ name, value: clamp01(value), weight });

  // significance, saturating at t=5
  push('significance', Math.abs(s.tStat) / 5, 25);
  // effect size, saturating at 0.3R/trade
  push('expectancy', s.avgR / 0.3, 20);
  // risk-adjusted return, saturating at Sharpe 2
  push('sharpe', s.sharpe / 2, 15);
  // robustness across walk-forward folds
  push('walk_forward', ev.wfPositiveShare, 15);
  // symmetry: fully balanced long/short scores 1
  push('two_sidedness', ev.analytics?.beta ? 1 - (ev.analytics.beta.asymmetry ?? 1) : 0, 15);
  // cost resilience: how little expectancy is lost across cost scenarios
  const deg = ev.costResilience?.degradation;
  push('cost_resilience', Number.isFinite(deg) && s.avgR > 0
    ? 1 - Math.min(1, deg / Math.max(1e-9, s.avgR)) : 0, 10);

  const total = c.reduce((a, x) => a + x.value * x.weight, 0);
  return { total: Math.round(total), components: c };
}

/** Assign lifecycle status from gates + score. */
function classify(ev, cfg) {
  // A strategy that produced no trades is not "bad" — it produced no evidence.
  // Conflating the two hides genuine specification errors (an entry condition
  // that can never fire) inside the reject pile.
  if (!ev.pooled.trades) {
    return {
      status: STATUS.NO_SIGNALS, gates: [], failed: ['no trades generated'], score: null,
      explanation: 'Generated zero trades — the entry conditions never co-occurred. ' +
        'This is a specification result, not a performance result: either the ' +
        'conditions are over-constrained or the regime it needs is absent from the sample.',
    };
  }
  const gates = hardGates(ev, cfg);
  const failed = gates.filter(g => !g.pass);
  if (failed.length) {
    // Distinguish "measurably bad" from "not yet enough evidence".
    const measurablyBad = ev.pooled.avgR <= 0 && Math.abs(ev.pooled.tStat) > 2;
    return {
      status: measurablyBad ? STATUS.REJECTED : STATUS.RESEARCH,
      gates, failed: failed.map(g => `${g.name}: ${g.detail}`),
      score: null,
      explanation: measurablyBad
        ? 'Significantly negative expectancy — this hypothesis is measurably wrong, not merely unproven.'
        : 'Did not clear all hard gates; evidence is insufficient rather than damning.',
    };
  }
  const sc = score(ev);
  let status = STATUS.CANDIDATE;
  if (sc.total >= 85) status = STATUS.PRODUCTION_CANDIDATE;
  else if (sc.total >= 70) status = STATUS.PAPER_TRADING;
  return {
    status, gates, failed: [], score: sc,
    explanation: `Passed all ${gates.length} hard gates with composite score ${sc.total}/100.`,
  };
}

/** Build and persist a leaderboard row set. */
function leaderboard(evaluations, cfg) {
  const rows = evaluations.map(ev => {
    const cl = classify(ev, cfg);
    return {
      name: ev.name,
      timeframe: ev.timeframe,
      status: cl.status,
      score: cl.score ? cl.score.total : 0,
      trades: ev.pooled.trades,
      avgR: ev.pooled.avgR,
      profitFactor: ev.pooled.profitFactor,
      sharpe: ev.pooled.sharpe,
      tStat: ev.pooled.tStat,
      maxDDR: ev.pooled.maxDDR,
      robustness: ev.wfPositiveShare,
      confidence: confidenceLabel(ev),
      betaVerdict: ev.analytics?.beta?.verdict || 'n/a',
      failedGates: cl.failed,
      explanation: cl.explanation,
    };
  });
  const rank = {
    PRODUCTION_CANDIDATE: 0, PAPER_TRADING: 1, CANDIDATE: 2,
    RESEARCH: 3, NO_SIGNALS: 4, REJECTED: 5, ARCHIVED: 6,
  };
  // NaN must never reach the comparator: a strategy with zero trades has
  // avgR = NaN, and NaN comparisons return NaN (treated as 0), which silently
  // scrambles the order of every row it is compared against.
  const key = v => (Number.isFinite(v) ? v : -Infinity);
  rows.sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    (key(b.score) - key(a.score)) ||
    (key(b.avgR) - key(a.avgR)));
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

function confidenceLabel(ev) {
  const t = Math.abs(ev.pooled.tStat), n = ev.pooled.trades;
  if (!Number.isFinite(t)) return 'unknown';
  if (n < 50) return 'very low (sample)';
  if (t < 1) return 'very low';
  if (t < 2) return 'low';
  if (t < 3) return 'moderate';
  return 'high';
}

function clamp01(x) { return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }
function fmt(v, d = 4) { return Number.isFinite(v) ? v.toFixed(d) : 'n/a'; }

module.exports = { STATUS, hardGates, score, classify, leaderboard };
