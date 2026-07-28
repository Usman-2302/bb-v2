'use strict';

/**
 * Strategy templates and builder.
 *
 * A strategy is a plain object. These factories exist so a new hypothesis is a
 * few lines of configuration rather than a reimplementation of stops, targets
 * and trailing logic — and so the engine NEVER needs modification to accept one.
 *
 * Compose freely:
 *   defineStrategy({
 *     name: 'my_idea_4h', timeframe: '4h', rationale: '...',
 *     entry: entries.crossAbove(ctx => ctx.ema20),
 *     stopModel: stops.atr(2), targetModel: targets.rMultiple(2.5),
 *     manageModel: manage.atrTrail(3, 1), maxHoldBars: 40,
 *   })
 */

// ── stop models ─────────────────────────────────────────────────────────────
const stops = {
  atr: (k = 2) => (ctx, i, sig, entry) => {
    const a = ctx.atr14[i];
    return a > 0 ? entry - sig.dir * a * k : NaN;
  },
  /** Beyond the last confirmed swing, padded with a little ATR. */
  swing: (pad = 0.25) => (ctx, i, sig, entry) => {
    const a = ctx.atr14[i];
    if (!(a > 0)) return NaN;
    const s = sig.dir > 0 ? ctx.swingLow[i] : ctx.swingHigh[i];
    if (Number.isFinite(s)) {
      const cand = s - sig.dir * a * pad;
      if (sig.dir > 0 ? cand < entry : cand > entry) return cand;
    }
    return entry - sig.dir * a * 1.5;
  },
  /** Percentage of price — timeframe-agnostic, useful for cost-floor tests. */
  percent: (pct = 0.01) => (ctx, i, sig, entry) => entry * (1 - sig.dir * pct),
};

// ── target models ───────────────────────────────────────────────────────────
const targets = {
  rMultiple: (m = 2) => (ctx, i, sig, entry, stop) =>
    entry + sig.dir * Math.abs(entry - stop) * m,
  atr: (k = 3) => (ctx, i, sig, entry) => {
    const a = ctx.atr14[i];
    return a > 0 ? entry + sig.dir * a * k : null;
  },
  vwap: () => (ctx, i) => ctx.vwap[i],
  none: () => () => null,
};

// ── management models ───────────────────────────────────────────────────────
const manage = {
  none: () => undefined,
  /** Chandelier trail, armed once the trade is `trigger` R in profit. */
  atrTrail: (k = 3, trigger = 1) => (state, ctx, i) => {
    const a = ctx.atr14[i];
    if (!(a > 0)) return {};
    const risk = Math.abs(state.entry - state.stop);
    if ((ctx.close[i] - state.entry) * state.dir < trigger * risk) return {};
    return { stop: ctx.close[i] - state.dir * a * k };
  },
  /** Move to breakeven after `trigger` R. */
  breakeven: (trigger = 1) => (state, ctx, i) => {
    const risk = Math.abs(state.entry - state.stop);
    if ((ctx.close[i] - state.entry) * state.dir < trigger * risk) return {};
    return { stop: state.entry };
  },
};

// ── entry primitives ────────────────────────────────────────────────────────
const entries = {
  /** Series crosses above/below a reference, direction from a bias function. */
  cross: (seriesFn, refFn, biasFn) => (ctx, i) => {
    if (i < 1) return null;
    const s0 = seriesFn(ctx, i - 1), s1 = seriesFn(ctx, i);
    const r0 = refFn(ctx, i - 1), r1 = refFn(ctx, i);
    if (![s0, s1, r0, r1].every(Number.isFinite)) return null;
    const up = s0 <= r0 && s1 > r1;
    const dn = s0 >= r0 && s1 < r1;
    if (!up && !dn) return null;
    const bias = biasFn ? biasFn(ctx, i) : 0;
    const dir = up ? 1 : -1;
    if (bias && bias !== dir) return null;
    return { dir };
  },
  /** Threshold on a z-scored series; `revert` flips to mean-reversion. */
  threshold: (valueFn, level, { revert = false } = {}) => (ctx, i) => {
    const v = valueFn(ctx, i);
    if (!Number.isFinite(v)) return null;
    if (v > level) return { dir: revert ? -1 : 1, meta: { v } };
    if (v < -level) return { dir: revert ? 1 : -1, meta: { v } };
    return null;
  },
};

// ── filters (confirmation layer) ────────────────────────────────────────────
const filters = {
  all: (...fns) => (ctx, i, sig) => fns.every(f => f(ctx, i, sig)),
  htfAgrees: () => (ctx, i, sig) => ctx.trend[i] === 0 || ctx.trend[i] === sig.dir,
  session: (allowed) => (ctx, i) => allowed.includes(ctx.session[i]),
  minVol: (z) => (ctx, i) => Number.isFinite(ctx.volZ[i]) && ctx.volZ[i] >= z,
  maxVol: (z) => (ctx, i) => Number.isFinite(ctx.volZ[i]) && ctx.volZ[i] <= z,
  minAtrPct: (p) => (ctx, i) => Number.isFinite(ctx.atrPct[i]) && ctx.atrPct[i] >= p,
};

/**
 * Assemble a strategy object the engine understands.
 * Validates the shape up front so a malformed strategy fails at registration
 * rather than silently producing zero trades.
 */
function defineStrategy(spec) {
  const required = ['name', 'timeframe', 'entry', 'stopModel'];
  for (const k of required) {
    if (!spec[k]) throw new Error(`defineStrategy: missing "${k}"`);
  }
  const s = {
    name: spec.name,
    timeframe: spec.timeframe,
    rationale: spec.rationale || '',
    params: spec.params || {},
    maxHoldBars: spec.maxHoldBars || 0,
    signal: spec.entry,
    stop: spec.stopModel,
  };
  if (spec.targetModel) s.target = spec.targetModel;
  if (spec.confirm) s.confirm = spec.confirm;
  if (spec.manageModel) s.manage = spec.manageModel;
  return s;
}

module.exports = { stops, targets, manage, entries, filters, defineStrategy };
