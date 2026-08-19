'use strict';

/**
 * Modular research engine.
 *
 * Pipeline, each layer independently replaceable:
 *
 *   signal -> context -> confirmation -> risk -> entry -> exit -> management -> evaluation
 *
 * A strategy supplies only the layers it needs; the engine provides safe
 * defaults for the rest. The engine owns all execution realism (fills, costs,
 * intrabar ambiguity), so a strategy author cannot accidentally get it wrong —
 * that was the root cause of the old paper-mode fantasy (AUDIT.md §4 #9).
 *
 * EXECUTION MODEL (deliberately conservative):
 *  - A signal on bar i is actioned at bar i+1's OPEN, never bar i's close. The
 *    old system decided and filled on the same closed bar, which is unachievable
 *    live and quietly worth several bps.
 *  - Market entries pay slippage + taker.
 *  - Stops are STOP_MARKET: taker + slippage on exit.
 *  - Targets are resting LIMIT: maker, no slippage.
 *  - If one bar contains both stop and target, the STOP is assumed to fill
 *    first. OHLC cannot resolve the order and the optimistic reading is how
 *    backtests lie.
 *  - A gap through the stop fills at the open, not the stop price.
 *
 * LIMIT ENTRIES (strategy.entryMode === 'limit'):
 *  - The order rests at the SIGNAL bar's close and may fill during bar i+1
 *    only: a long fills iff low(i+1) trades through the limit by >= 1bp (the
 *    queue-risk haircut — a mere touch does not guarantee a fill on a real
 *    book). Gap opens fill at the open when it is better than the limit.
 *  - Unfilled orders are cancelled (logged as 'limit_not_filled' rejects).
 *  - Maker entries pay makerFee with no slippage. This exists to test whether
 *    sub-hour strategies can get under the taker fee floor at all; it is NOT a
 *    license to assume fills — the 1bp penetration rule is the conservatism.
 */

const { CostModel } = require('./costs');

const DEFAULT_EXITS = {
  /** Fixed R target with a hard stop. */
  fixedR: ({ rMult = 2 } = {}) => ({
    name: `fixedR(${rMult})`,
    target: (entry, stop, dir) => entry + dir * Math.abs(entry - stop) * rMult,
  }),
  /** No target: exit only on stop, trail, or time. */
  none: () => ({ name: 'none', target: () => null }),
};

/**
 * @param {object} strategy
 *   name, timeframe,
 *   signal(ctx, i) -> {dir:1|-1, meta?} | null      REQUIRED
 *   confirm(ctx, i, sig) -> boolean                 optional
 *   stop(ctx, i, sig, entryPrice) -> price          REQUIRED
 *   target(ctx, i, sig, entryPrice, stopPrice) -> price|null   optional
 *   manage(state, ctx, i) -> {stop?, exit?}         optional (trailing/breakeven)
 *   maxHoldBars                                     optional
 * @param {object} opts { features, costModel, riskPct, maxBars }
 */
function runBacktest(strategy, ctx, opts = {}) {
  const cost = opts.costModel || new CostModel();
  const maxHold = strategy.maxHoldBars || opts.maxHoldBars || 0;
  const c = ctx.candles;
  const n = c.length;
  const warmup = opts.warmup ?? 250;

  const trades = [];
  const rejects = Object.create(null);
  let open = null;
  let signalsRaw = 0;

  const reject = k => { rejects[k] = (rejects[k] || 0) + 1; };

  for (let i = warmup; i < n - 1; i++) {
    // ── manage an open position on bar i ──
    if (open) {
      const bar = c[i];
      const dir = open.dir;
      const gapThroughStop = dir > 0 ? bar.open <= open.stop : bar.open >= open.stop;
      const hitStop = dir > 0 ? bar.low <= open.stop : bar.high >= open.stop;
      const hitTarget = open.target !== null &&
        (dir > 0 ? bar.high >= open.target : bar.low <= open.target);

      let exitPrice = null, isMaker = false, reason = null;

      if (gapThroughStop) {
        // price opened beyond the stop: the fill is the open, not the stop
        exitPrice = bar.open; reason = 'STOP_GAP';
      } else if (hitStop) {
        exitPrice = open.stop; reason = 'STOP';
      } else if (hitTarget) {
        exitPrice = open.target; isMaker = true; reason = 'TARGET';
      } else if (maxHold && (i - open.entryIdx) >= maxHold) {
        exitPrice = bar.close; reason = 'TIME';
      } else if (strategy.manage) {
        const upd = strategy.manage(open, ctx, i) || {};
        if (upd.stop !== undefined && Number.isFinite(upd.stop)) {
          // only ever tighten
          if (dir > 0 ? upd.stop > open.stop : upd.stop < open.stop) open.stop = upd.stop;
        }
        if (upd.exit) { exitPrice = bar.close; reason = 'MANAGED'; }
      }

      // track excursions
      const mfe = dir > 0 ? (bar.high - open.entry) : (open.entry - bar.low);
      const mae = dir > 0 ? (open.entry - bar.low) : (bar.high - open.entry);
      if (mfe > open.mfe) open.mfe = mfe;
      if (mae > open.mae) open.mae = mae;

      if (exitPrice !== null) {
        const fill = isMaker ? exitPrice : cost.marketFill(exitPrice, -dir);
        const gross = (fill - open.entry) * dir * open.qty;
        const exitFee = cost.fee(Math.abs(fill * open.qty), isMaker);
        const funding = cost.funding(Math.abs(open.entry * open.qty), c[i].closeTime - open.entryTime);
        const pnl = gross - open.entryFee - exitFee - funding;
        const riskDollars = open.riskDollars;
        trades.push({
          strategy: strategy.name,
          symbol: ctx.symbol, timeframe: strategy.timeframe,
          dir, reason,
          entry: open.entry, exit: fill, qty: open.qty,
          entryTime: open.entryTime, exitTime: c[i].closeTime,
          holdBars: i - open.entryIdx,
          pnl,
          rMultiple: riskDollars > 0 ? pnl / riskDollars : NaN,
          mfeR: riskDollars > 0 ? (open.mfe * open.qty) / riskDollars : NaN,
          maeR: riskDollars > 0 ? (open.mae * open.qty) / riskDollars : NaN,
          fees: open.entryFee + exitFee,
          funding,
          regime: ctx.trend ? ctx.trend[open.entryIdx] : 0,
          session: ctx.session ? ctx.session[open.entryIdx] : null,
          meta: open.meta,
        });
        open = null;
      }
    }
    if (open) continue;

    // ── look for a new signal on bar i, act on bar i+1 open ──
    const sig = strategy.signal(ctx, i);
    if (!sig || !sig.dir) continue;
    signalsRaw++;

    if (strategy.confirm && !strategy.confirm(ctx, i, sig)) { reject('confirm'); continue; }

    const nextIdx = i + 1;
    if (nextIdx >= n) break;
    let entry, entryIsMaker = false;
    if (strategy.entryMode === 'limit') {
      // Resting limit at the signal bar's close; fills during bar i+1 only.
      const limit = c[i].close;
      const bar = c[nextIdx];
      const through = 1e-4;   // must trade ~1bp through the limit (queue risk)
      const filled = sig.dir > 0 ? bar.low <= limit * (1 - through)
                                 : bar.high >= limit * (1 + through);
      if (!filled) { reject('limit_not_filled'); continue; }
      entry = sig.dir > 0 ? Math.min(bar.open, limit) : Math.max(bar.open, limit);
      entryIsMaker = true;
    } else {
      entry = cost.marketFill(c[nextIdx].open, sig.dir);
    }

    const stop = strategy.stop(ctx, i, sig, entry);
    if (!Number.isFinite(stop)) { reject('no_stop'); continue; }
    const stopDist = Math.abs(entry - stop);
    if (!(stopDist > 0)) { reject('zero_stop'); continue; }
    // a stop already breached by the entry fill is not a trade
    if (sig.dir > 0 ? stop >= entry : stop <= entry) { reject('stop_wrong_side'); continue; }

    const target = strategy.target
      ? strategy.target(ctx, i, sig, entry, stop)
      : null;

    // Cost floor: the target must clear the round trip by a margin, otherwise the
    // trade cannot pay for itself even when it works.
    if (target !== null && opts.minEdgeMult > 0) {
      const move = Math.abs(target - entry) / entry;
      if (move < opts.minEdgeMult * cost.roundTripWin()) { reject('below_cost_floor'); continue; }
    }

    // Risk-based sizing: riskDollars caps the TOTAL loss including both fee legs.
    const riskDollars = (opts.equity || 10000) * (opts.riskPct || 0.01);
    const perUnitLoss = stopDist + entry * cost.roundTripLoss();
    const qty = riskDollars / perUnitLoss;
    const entryFee = cost.fee(Math.abs(entry * qty), entryIsMaker);

    open = {
      dir: sig.dir, entry, stop, target, qty, entryFee,
      entryIdx: nextIdx, entryTime: c[nextIdx].openTime,
      riskDollars, mfe: 0, mae: 0, meta: sig.meta || null,
    };
  }

  return { trades, rejects, signalsRaw };
}

module.exports = { runBacktest, DEFAULT_EXITS };
