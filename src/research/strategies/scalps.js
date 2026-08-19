'use strict';

/**
 * Scalp hypothesis family — 1m/3m trend-pullback continuation.
 *
 * Separate from strategies/registry.js ON PURPOSE: these need a 1m base store
 * (data/historical/{SYM}_1m.ndjson) and are evaluated by run_scalps.js only.
 * The autonomous claude-runner registry must never see them — its 15m store
 * cannot resample down.
 *
 * DESIGN CONSTRAINTS (from live measurements, Jul 2026 — see AUDIT trail):
 *  - Round-trip cost floor is ~19 bps (taker+slip both sides, maker target).
 *    Any scalp TP must clear ~25-35 bps or fees consume the trade.
 *  - The deprecated live runner's sub-0.2% targets died to exactly this.
 *  - Mean reversion at 1h and below is REJECTED with |t| up to 26 — every
 *    entry here is WITH the higher-timeframe trend, after a pullback.
 *  - Holds are capped at 45-60 min: the user's scalping brief, and it bounds
 *    the time a loser can occupy margin.
 *
 * External evidence base (Aug 2026 web survey): no public 1m scalp demonstrates
 * net-of-fee survival; the defensible published corridor is 3m/5m entries,
 * targets >= 0.5%, hard time-stops ~55 min (Hummingbot directional examples),
 * HTF trend gate + LTF pullback trigger (dominant open-source pattern).
 */

const { swingStop, atrStop, rTarget } = require('./registry');

// ── shared pieces ───────────────────────────────────────────────────────────

/** EMA-stack trend: +1 up / -1 down / 0 no trade. ~2.5h vs ~10h on 3m. */
function trendDir(ctx, i) {
  const e50 = ctx.ema50[i], e200 = ctx.ema200[i];
  if (!(e50 > 0) || !(e200 > 0)) return 0;
  if (e50 > e200 && ctx.close[i] > e200) return 1;
  if (e50 < e200 && ctx.close[i] < e200) return -1;
  return 0;
}

/**
 * Pullback-continuation trigger against `level` (ema20 or vwap):
 * the bar's wick dips through the level but the close is back on the trend
 * side — someone sold into value and got absorbed.
 */
function pullbackBar(ctx, i, dir, level) {
  if (!(level > 0)) return false;
  return dir > 0
    ? ctx.low[i] <= level && ctx.close[i] > level
    : ctx.high[i] >= level && ctx.close[i] < level;
}

/**
 * Structural stop with a volatility FLOOR: the farther of (swing beyond pad) and
 * (k x ATR). Micro swing stops at 3m are 3-6 bps; a 2.5R target on a 5bp stop is
 * 12bps — under the 19bp cost floor, a guaranteed loser before price moves.
 */
function flooredSwingStop(pad = 0.25, atrK = 1.2) {
  const swing = swingStop(pad);
  return (ctx, i, sig, entry) => {
    const structural = swing(ctx, i, sig, entry);
    const a = ctx.atr14[i];
    if (!(a > 0)) return structural;
    const vol = entry - sig.dir * a * atrK;
    if (!Number.isFinite(structural)) return vol;
    // farther from entry = lower for longs, higher for shorts
    return sig.dir > 0 ? Math.min(structural, vol) : Math.max(structural, vol);
  };
}

// ── hypotheses ──────────────────────────────────────────────────────────────

const STRATEGIES = [
  {
    name: 'scalp_pb_3m',
    timeframe: '3m',
    rationale:
      'Trend-pullback continuation at 3m: EMA50/200 stack defines the trend, ' +
      'a wick through EMA20 that closes back on the trend side is the entry. ' +
      'Structural stop beyond the pullback swing, 2.5R target, 60-min time cap. ' +
      'This is the user scalping brief encoded with the fee floor respected: ' +
      'at 3m ATR ~8bps a 2.5R target is ~30-50bps — 2x the cost floor.',
    maxHoldBars: 20,   // 60 min
    signal: (ctx, i) => {
      const dir = trendDir(ctx, i);
      if (!dir) return null;
      if (!pullbackBar(ctx, i, dir, ctx.ema20[i])) return null;
      if (!(ctx.rvol[i] >= 1.2)) return null;      // participation required
      return { dir };
    },
    stop: flooredSwingStop(0.25, 1.2),
    target: rTarget(2.5),
  },

  {
    name: 'scalp_vwap_3m',
    timeframe: '3m',
    rationale:
      'VWAP variant of the pullback hypothesis: same trend gate, but the ' +
      'pullback level is the session VWAP — the execution benchmark large ' +
      'flow defends. ATR stop (VWAP touches cluster tighter than swings), ' +
      '2R target, 60-min cap.',
    maxHoldBars: 20,
    signal: (ctx, i) => {
      const dir = trendDir(ctx, i);
      if (!dir) return null;
      if (!pullbackBar(ctx, i, dir, ctx.vwap[i])) return null;
      if (!(ctx.rvol[i] >= 1.0)) return null;
      return { dir };
    },
    stop: atrStop(1.5),
    target: rTarget(2),
  },

  {
    name: 'scalp_pb_1m',
    timeframe: '1m',
    rationale:
      'Timeframe-scaling control: the scalp_pb signal at 1m with a 45-min cap. ' +
      'Public microstructure evidence (negative lag-1 autocorrelation at minute ' +
      'scale) says this should be WORSE than 3m — if it is not, the cost floor ' +
      'story is wrong, not the signal. Same role trend_pullback_1h played at 4h.',
    maxHoldBars: 45,   // 45 min
    signal: (ctx, i) => {
      const dir = trendDir(ctx, i);
      if (!dir) return null;
      if (!pullbackBar(ctx, i, dir, ctx.ema20[i])) return null;
      if (!(ctx.rvol[i] >= 1.2)) return null;
      return { dir };
    },
    stop: flooredSwingStop(0.25, 1.2),
    target: rTarget(2.5),
  },

  // ── fade variants ─────────────────────────────────────────────────────────
  // The continuation family above loses with t= -18 .. -99 across every
  // geometry tried (see scalp grid results): after a 3m/1m pullback bar, price
  // more often CONTINUES against the trend than resumes it. That is a strong,
  // consistent anti-signal — so the mirror image is a hypothesis in its own
  // right: fade the pullback bar, i.e. short-term counter-trend. This is the
  // microstructure reversal the academic literature reports at minute scale.
  // Geometry follows the grid frontier: wider ATR stop, closer target.

  {
    name: 'scalp_fade_3m',
    timeframe: '3m',
    rationale:
      'Mirror of scalp_pb_3m (REJECTED, t=-48): the pullback bar that closes ' +
      'back with the trend is faded — at minute scale the "trend resumption" ' +
      'bar is more often the exhaustion bar. 2xATR stop, 1.5R target, 60-min cap.',
    maxHoldBars: 20,
    signal: (ctx, i) => {
      const dir = trendDir(ctx, i);
      if (!dir) return null;
      if (!pullbackBar(ctx, i, dir, ctx.ema20[i])) return null;
      if (!(ctx.rvol[i] >= 1.2)) return null;
      return { dir: -dir };                          // flipped
    },
    stop: atrStop(2),
    target: rTarget(1.5),
  },

  {
    name: 'scalp_fade_1m',
    timeframe: '1m',
    rationale:
      'Mirror of scalp_pb_1m (REJECTED, t=-99) at 1m with a 45-min cap. The ' +
      'strongest anti-signal in the family; if reversal alpha exists at minute ' +
      'scale on ETH/BTC perps, this is where it must show up.',
    maxHoldBars: 45,
    signal: (ctx, i) => {
      const dir = trendDir(ctx, i);
      if (!dir) return null;
      if (!pullbackBar(ctx, i, dir, ctx.ema20[i])) return null;
      if (!(ctx.rvol[i] >= 1.2)) return null;
      return { dir: -dir };                          // flipped
    },
    stop: atrStop(2),
    target: rTarget(1.5),
  },
];

/**
 * Exit-geometry variants of a base strategy, for the --grid explorer.
 * In-sample exploration only — the chosen config must still pass the full
 * acceptance battery (walk-forward + bootstrap + Bonferroni) before paper.
 */
function withExits(base, { rMult, slAtrK, maxHoldBars }) {
  return {
    ...base,
    name: `${base.name}__sl${slAtrK}atr_r${rMult}_h${maxHoldBars}`,
    stop: atrStop(slAtrK),
    target: rTarget(rMult),
    maxHoldBars: maxHoldBars ?? base.maxHoldBars,
  };
}

function get(name) {
  const s = STRATEGIES.find(x => x.name === name);
  if (!s) throw new Error('unknown scalp strategy: ' + name);
  return s;
}

function list() { return STRATEGIES.map(s => s.name); }

module.exports = { STRATEGIES, get, list, withExits };
