'use strict';

/**
 * Strategy registry.
 *
 * Each entry is an independent HYPOTHESIS with a stated economic rationale.
 * None is a variation of the deprecated liquidity-sweep system.
 *
 * TIMEFRAME IS THE PRIMARY DESIGN VARIABLE, not a tuning knob. QUANT-REVIEW.md
 * established that any OHLCV-derived alpha at 15m (1-3 bps) is an order of
 * magnitude below the round-trip cost floor (7-10 bps). Costs are fixed per
 * trade while edge scales with holding-period volatility, so the search is
 * deliberately concentrated on 1h/4h/1d where a real effect can pay for itself.
 *
 * Strategy interface (see core/engine.js):
 *   { name, timeframe, rationale, signal, confirm?, stop, target?, manage?, maxHoldBars? }
 */

// ── shared building blocks ──────────────────────────────────────────────────

/** Structural stop: beyond the last confirmed swing, padded by a little ATR. */
function swingStop(pad = 0.25) {
  return (ctx, i, sig, entry) => {
    const a = ctx.atr14[i];
    if (!(a > 0)) return NaN;
    const s = sig.dir > 0 ? ctx.swingLow[i] : ctx.swingHigh[i];
    if (Number.isFinite(s)) {
      const cand = s - sig.dir * a * pad;
      // only accept a structural stop that is actually on the correct side
      if (sig.dir > 0 ? cand < entry : cand > entry) return cand;
    }
    return entry - sig.dir * a * 1.5;   // fallback
  };
}

/** Volatility stop: k * ATR. */
function atrStop(k = 2) {
  return (ctx, i, sig, entry) => {
    const a = ctx.atr14[i];
    return a > 0 ? entry - sig.dir * a * k : NaN;
  };
}

function rTarget(mult) {
  return (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * mult;
}

/** Chandelier-style trail once the trade is in profit by `trigger` R. */
function atrTrail(k = 3, trigger = 1) {
  return (state, ctx, i) => {
    const a = ctx.atr14[i];
    if (!(a > 0)) return {};
    const risk = Math.abs(state.entry - state.stop);
    const prog = (ctx.close[i] - state.entry) * state.dir;
    if (prog < trigger * risk) return {};
    return { stop: ctx.close[i] - state.dir * a * k };
  };
}

const HTF_UP = ctx => (i, htfIdx) => htfIdx >= 0 && ctx.htf.close[htfIdx] > ctx.htf.ema50[htfIdx];

// ── hypotheses ──────────────────────────────────────────────────────────────

const STRATEGIES = [
  {
    name: 'ts_momentum_1d',
    timeframe: '1d',
    rationale:
      'Time-series momentum (Moskowitz, Ooi & Pedersen 2012): an assets own past ' +
      'excess return predicts its future return across essentially every liquid ' +
      'futures market, attributed to under-reaction and risk-transfer demand. The ' +
      'canonical 12-month/1-month lookbacks compress to weeks in crypto. Traded ' +
      'daily so fixed costs are negligible against the move size.',
    maxHoldBars: 20,
    signal: (ctx, i) => {
      if (i < 30) return null;
      const look = 20;
      const r = Math.log(ctx.close[i] / ctx.close[i - look]);
      if (!Number.isFinite(r) || r === 0) return null;
      // require the move to be meaningful relative to realised vol
      const vol = ctx.rv20[i];
      if (!(vol > 0)) return null;
      const z = r / (vol * Math.sqrt(look));
      if (Math.abs(z) < 0.5) return null;
      return { dir: r > 0 ? 1 : -1, meta: { z } };
    },
    stop: atrStop(3),
    target: null,
    manage: atrTrail(4, 1),
  },

  {
    name: 'donchian_breakout_4h',
    timeframe: '4h',
    rationale:
      'Classic trend-following breakout (Donchian / Turtle lineage). Economic ' +
      'basis: sustained order-flow imbalance from slow institutional rebalancing ' +
      'means new extremes cluster. Long-horizon, low trade count, so the fee ' +
      'burden per unit of move is small.',
    maxHoldBars: 60,
    signal: (ctx, i) => {
      if (!Number.isFinite(ctx.donHigh[i])) return null;
      if (ctx.close[i] > ctx.donHigh[i]) return { dir: 1 };
      if (ctx.close[i] < ctx.donLow[i]) return { dir: -1 };
      return null;
    },
    stop: atrStop(2.5),
    target: null,
    manage: atrTrail(3, 1),
  },

  {
    name: 'htf_trend_pullback_4h',
    timeframe: '4h',
    rationale:
      'Buy the pullback inside an established higher-timeframe uptrend. Rationale: ' +
      'trend persistence plus better entry location than breakout chasing, which ' +
      'the 15m study showed is where the old system lost (it bought decisive ' +
      'closes and became exit liquidity).',
    maxHoldBars: 40,
    signal: (ctx, i) => {
      if (!(ctx.ema50[i] && ctx.ema200[i])) return null;
      const up = ctx.ema50[i] > ctx.ema200[i];
      const dn = ctx.ema50[i] < ctx.ema200[i];
      // pullback = close crosses back to the fast EMA against the trend
      if (up && ctx.close[i] <= ctx.ema20[i] && ctx.close[i - 1] > ctx.ema20[i - 1]) return { dir: 1 };
      if (dn && ctx.close[i] >= ctx.ema20[i] && ctx.close[i - 1] < ctx.ema20[i - 1]) return { dir: -1 };
      return null;
    },
    stop: swingStop(0.25),
    target: rTarget(2.5),
  },

  {
    name: 'bos_continuation_4h',
    timeframe: '4h',
    rationale:
      'Break of structure continuation: price closing beyond the last confirmed ' +
      'swing in the direction of the prevailing structure. This is the ' +
      'institutional-flow reading of trend continuation, and unlike the old sweep ' +
      'signal it requires structure to AGREE rather than to be violated.',
    maxHoldBars: 40,
    signal: (ctx, i) => {
      if (!ctx.bos[i] || !ctx.trend[i]) return null;
      if (ctx.bos[i] !== ctx.trend[i]) return null;   // must confirm, not oppose
      return { dir: ctx.bos[i] };
    },
    stop: swingStop(0.25),
    target: rTarget(2),
  },

  {
    name: 'choch_reversal_4h',
    timeframe: '4h',
    rationale:
      'Change of character: the first structural break AGAINST an established ' +
      'trend often marks distribution/accumulation completing. Counterpart ' +
      'hypothesis to bos_continuation — if continuation works, this should fail, ' +
      'and vice versa. Testing both guards against confirmation bias.',
    maxHoldBars: 40,
    signal: (ctx, i) => (ctx.choch[i] ? { dir: ctx.choch[i] } : null),
    stop: swingStop(0.3),
    target: rTarget(2.5),
  },

  {
    name: 'vol_squeeze_breakout_4h',
    timeframe: '4h',
    rationale:
      'Volatility clustering (Engle/ARCH): low-volatility regimes are followed by ' +
      'high-volatility regimes. Enter on the expansion bar in its own direction. ' +
      'The edge is regime timing, not direction prediction.',
    maxHoldBars: 30,
    signal: (ctx, i) => {
      if (!Number.isFinite(ctx.volZ[i]) || !Number.isFinite(ctx.volZ[i - 1])) return null;
      // was compressed, now expanding
      if (!(ctx.volZ[i - 1] < -0.5 && ctx.volZ[i] > 0)) return null;
      if (!ctx.ret1[i]) return null;
      return { dir: ctx.ret1[i] > 0 ? 1 : -1 };
    },
    stop: atrStop(2),
    target: rTarget(3),
  },

  {
    name: 'lowvol_trend_4h',
    timeframe: '4h',
    rationale:
      'The only candidate that showed consistent positive (if insignificant) alpha ' +
      'across both symbols and all windows in the 15m battery: trend-following ' +
      'conditioned on LOW realised volatility. Promoted to 4h, where the same ' +
      'effect has ~4x the move size against identical fixed costs. This is the ' +
      'single most evidence-motivated hypothesis in the registry.',
    maxHoldBars: 40,
    signal: (ctx, i) => {
      if (!Number.isFinite(ctx.volZ[i]) || !ctx.ema200[i]) return null;
      if (ctx.volZ[i] > -0.5) return null;          // quiet regimes only
      return { dir: ctx.close[i] > ctx.ema200[i] ? 1 : -1 };
    },
    stop: atrStop(2.5),
    target: null,
    manage: atrTrail(3, 1),
  },

  {
    name: 'vwap_reversion_1h',
    timeframe: '1h',
    rationale:
      'Intraday mean reversion to session VWAP. Economic basis: VWAP is the ' +
      'execution benchmark for large orders, so systematic flow leans against ' +
      'deviations. Fades stretched moves rather than chasing them.',
    maxHoldBars: 12,
    signal: (ctx, i) => {
      const d = ctx.vwapDev[i];
      if (!Number.isFinite(d)) return null;
      if (d < -2) return { dir: 1 };
      if (d > 2) return { dir: -1 };
      return null;
    },
    stop: atrStop(1.5),
    target: (ctx, i, sig, entry) => ctx.vwap[i],   // revert to the benchmark
  },

  {
    name: 'zscore_reversion_1h',
    timeframe: '1h',
    rationale:
      'Statistical overextension reversion: a single-bar move several sigma beyond ' +
      'recent realised volatility reflects liquidity depletion rather than ' +
      'information, and partially retraces as market makers rebuild inventory.',
    maxHoldBars: 12,
    signal: (ctx, i) => {
      if (!(ctx.rv20[i] > 0)) return null;
      const z = ctx.ret1[i] / ctx.rv20[i];
      if (z < -2.5) return { dir: 1 };
      if (z > 2.5) return { dir: -1 };
      return null;
    },
    stop: atrStop(2),
    target: rTarget(1.5),
  },

  {
    name: 'trend_pullback_1h',
    timeframe: '1h',
    rationale:
      'The 4h pullback hypothesis at 1h. Included as an explicit timeframe-scaling ' +
      'control: if the SAME logic is profitable at 4h and unprofitable at 1h, that ' +
      'isolates the cost floor as the binding constraint rather than the signal.',
    maxHoldBars: 24,
    signal: (ctx, i) => {
      if (!(ctx.ema50[i] && ctx.ema200[i])) return null;
      const up = ctx.ema50[i] > ctx.ema200[i];
      const dn = ctx.ema50[i] < ctx.ema200[i];
      if (up && ctx.close[i] <= ctx.ema20[i] && ctx.close[i - 1] > ctx.ema20[i - 1]) return { dir: 1 };
      if (dn && ctx.close[i] >= ctx.ema20[i] && ctx.close[i - 1] < ctx.ema20[i - 1]) return { dir: -1 };
      return null;
    },
    stop: swingStop(0.25),
    target: rTarget(2.5),
  },
];

// ── strategies built from templates ─────────────────────────────────────────
// These demonstrate the extension contract: a new hypothesis is a configuration
// object, and the engine is never modified to accept one.
const T = require('./templates');

STRATEGIES.push(
  T.defineStrategy({
    name: 'range_fade_4h',
    timeframe: '4h',
    rationale:
      'Range hypothesis: when structure is FLAT (no higher-highs/higher-lows), ' +
      'excursions beyond the 24-bar channel revert rather than extend. Explicitly ' +
      'conditioned on the absence of trend, unlike the deprecated system which ' +
      'faded into trends indiscriminately.',
    maxHoldBars: 20,
    entry: (ctx, i) => {
      if (ctx.trend[i] !== 0) return null;               // range regime only
      if (!Number.isFinite(ctx.donHigh[i])) return null;
      if (ctx.close[i] > ctx.donHigh[i]) return { dir: -1 };
      if (ctx.close[i] < ctx.donLow[i]) return { dir: 1 };
      return null;
    },
    stopModel: T.stops.atr(2),
    targetModel: T.targets.rMultiple(1.5),
  }),

  T.defineStrategy({
    name: 'session_breakout_1h',
    timeframe: '1h',
    rationale:
      'Session hypothesis: the London and New York opens concentrate liquidity ' +
      'and information arrival, so range expansion in those windows carries ' +
      'directional content that Asian-hours expansion does not.',
    maxHoldBars: 12,
    entry: (ctx, i) => {
      if (!Number.isFinite(ctx.donHigh[i])) return null;
      if (ctx.close[i] > ctx.donHigh[i]) return { dir: 1 };
      if (ctx.close[i] < ctx.donLow[i]) return { dir: -1 };
      return null;
    },
    confirm: T.filters.session(['LONDON', 'NY']),
    stopModel: T.stops.atr(2),
    targetModel: T.targets.rMultiple(2),
  }),

  T.defineStrategy({
    name: 'composite_trend_vol_4h',
    timeframe: '4h',
    rationale:
      'Composite hypothesis: combine the two components that were individually ' +
      'least-bad in prior work — trend alignment and low-volatility conditioning — ' +
      'and require BOTH. If the components carry independent information the ' +
      'combination should beat either alone; if they are the same signal wearing ' +
      'two hats, it will not.',
    maxHoldBars: 40,
    entry: (ctx, i) => {
      if (!(ctx.ema50[i] && ctx.ema200[i]) || !Number.isFinite(ctx.volZ[i])) return null;
      if (ctx.volZ[i] > 0) return null;
      const dir = ctx.ema50[i] > ctx.ema200[i] ? 1 : -1;
      if (ctx.trend[i] !== 0 && ctx.trend[i] !== dir) return null;   // structure must agree
      return { dir };
    },
    stopModel: T.stops.atr(2.5),
    targetModel: T.targets.none(),
    manageModel: T.manage.atrTrail(3, 1),
  }),

  T.defineStrategy({
    name: 'mtf_structure_align_4h',
    timeframe: '4h',
    rationale:
      'Multi-timeframe hypothesis: require confirmed market structure and the ' +
      'slow trend filter to agree, entering only on a break of structure in that ' +
      'direction. Strictest of the trend family — tests whether stacking ' +
      'confirmations helps or, as at 15m, monotonically destroys the edge.',
    maxHoldBars: 40,
    entry: (ctx, i) => {
      if (!ctx.bos[i] || !ctx.ema200[i]) return null;
      const macro = ctx.close[i] > ctx.ema200[i] ? 1 : -1;
      if (ctx.bos[i] !== macro) return null;
      if (ctx.trend[i] !== 0 && ctx.trend[i] !== macro) return null;
      return { dir: macro };
    },
    stopModel: T.stops.swing(0.3),
    targetModel: T.targets.rMultiple(2.5),
  }),
);

function get(name) {
  const s = STRATEGIES.find(x => x.name === name);
  if (!s) throw new Error('unknown strategy: ' + name);
  return s;
}

function list() { return STRATEGIES.map(s => s.name); }

module.exports = { STRATEGIES, get, list, swingStop, atrStop, rTarget, atrTrail };
