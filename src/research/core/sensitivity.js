'use strict';

/**
 * Parameter stability, sensitivity and cross-timeframe validation.
 *
 * A strategy whose result collapses when a parameter moves 20% is fitted to
 * noise, not measuring an effect. Phase 3 (`phase_d9_log.md`) already recorded a
 * PF "cliff" from 1.64 to 0.57 across a single z-score step — exactly the shape
 * this module exists to detect automatically.
 */

const { runBacktest } = require('./engine');
const { summarise } = require('./metrics');
const features = require('./features');
const { resample } = require('./candles');

/**
 * Sweep one numeric knob and report the shape of the response surface.
 * `mutate(param)` must return a NEW strategy object; the base strategy is never
 * mutated in place.
 */
function sweep(baseStrategy, ctx, opts, { name, values, mutate }) {
  const points = [];
  for (const v of values) {
    let s;
    try { s = mutate(v); } catch (e) { points.push({ value: v, error: e.message }); continue; }
    const res = runBacktest(s, ctx, opts);
    const sum = summarise(res.trades);
    points.push({ value: v, trades: sum.trades, avgR: sum.avgR, profitFactor: sum.profitFactor, tStat: sum.tStat });
  }
  const valid = points.filter(p => Number.isFinite(p.avgR) && p.trades >= 20);
  const avgs = valid.map(p => p.avgR);
  const positive = avgs.filter(a => a > 0).length;

  // Cliff = the largest single-step drop relative to the neighbouring level.
  let maxDrop = 0;
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1].avgR, b = valid[i].avgR;
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) > 1e-9) {
      const drop = (a - b) / Math.abs(a);
      if (drop > maxDrop) maxDrop = drop;
    }
  }
  const spread = avgs.length ? Math.max(...avgs) - Math.min(...avgs) : NaN;

  return {
    parameter: name,
    points,
    positiveShare: valid.length ? positive / valid.length : NaN,
    spread,
    maxSingleStepDrop: maxDrop,
    verdict: !valid.length ? 'no valid points'
      : positive / valid.length < 0.6 ? 'UNSTABLE — minority of parameter space is positive'
      : maxDrop > 1.5 ? 'CLIFF — result collapses at one parameter step'
      : 'stable',
  };
}

/**
 * Cross-timeframe validation: does the same logic hold on neighbouring
 * timeframes? A real effect degrades smoothly; a fitted one appears at exactly
 * one timeframe and nowhere else.
 */
function crossTimeframe(strategy, base, opts, timeframes) {
  const out = [];
  for (const tf of timeframes) {
    let ctx;
    try {
      const c = resample(base, tf);
      if (c.length < 400) { out.push({ timeframe: tf, skipped: 'insufficient bars' }); continue; }
      ctx = features.build(c);
      ctx.symbol = 'x'; ctx.timeframe = tf;
    } catch (e) { out.push({ timeframe: tf, error: e.message }); continue; }
    const s = { ...strategy, timeframe: tf };
    const res = runBacktest(s, ctx, opts);
    const sum = summarise(res.trades);
    out.push({ timeframe: tf, trades: sum.trades, avgR: sum.avgR, profitFactor: sum.profitFactor, tStat: sum.tStat });
  }
  const valid = out.filter(o => Number.isFinite(o.avgR) && o.trades >= 20);
  const positive = valid.filter(o => o.avgR > 0).length;
  return {
    results: out,
    positiveShare: valid.length ? positive / valid.length : NaN,
    verdict: !valid.length ? 'no valid timeframes'
      : positive === 0 ? 'fails everywhere'
      : positive === 1 && valid.length > 2 ? 'SINGLE-TIMEFRAME — likely fitted'
      : positive / valid.length >= 0.5 ? 'consistent across timeframes'
      : 'weak across timeframes',
  };
}

/**
 * Cost resilience: how fast does expectancy decay as costs rise? This is the
 * measurement that exposed the timeframe thesis — a 1h strategy lost 0.24R to a
 * cost doubling while a 1d strategy lost 0.003R.
 */
function costResilience(strategy, ctx, optsBase, scenarios, CostModel, baseCosts) {
  const out = {};
  for (const [name, override] of Object.entries(scenarios)) {
    const opts = { ...optsBase, costModel: new CostModel({ ...baseCosts, ...override }) };
    const res = runBacktest(strategy, ctx, opts);
    const sum = summarise(res.trades);
    out[name] = { trades: sum.trades, avgR: sum.avgR, profitFactor: sum.profitFactor };
  }
  const names = Object.keys(out);
  const best = out[names[0]]?.avgR, worst = out[names[names.length - 1]]?.avgR;
  const degradation = Number.isFinite(best) && Number.isFinite(worst) ? best - worst : NaN;
  return {
    scenarios: out,
    degradation,
    survivesHarsh: Object.values(out).every(v => v.avgR > 0),
    verdict: !Number.isFinite(degradation) ? 'unknown'
      : Object.values(out).every(v => v.avgR > 0) ? 'cost resilient'
      : 'fails under higher costs',
  };
}

module.exports = { sweep, crossTimeframe, costResilience };
