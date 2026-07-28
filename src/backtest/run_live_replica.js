'use strict';

/**
 * BulletBrain v3.0 — Live-Runner Replica Backtest
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/live/liveRunner.js` does NOT trade the strategy that phases D6-D13
 * validated. It is a separate, grid-searched strategy (see upstream commit
 * d530a48 "optimize: grid-search best config — RVOL 0.3, STOP 0.3ATR, RR 2.5")
 * that was never backtested with realistic execution costs. The only "backtest"
 * it has is the warmup scan inside liveRunner.js itself, which books a fixed
 * `risk * 1.8` on any candle that touches TP — it cannot lose money to fees,
 * cannot lose money to slippage, and resolves TP before SL within the same
 * candle. That is not a backtest, it is a lower bound on optimism.
 *
 * This file replicates liveRunner.js's ENTRY/EXIT LOGIC EXACTLY, then prices
 * it honestly.
 *
 * FAITHFUL TO LIVE (verbatim logic)
 *   - detectRegime: EMA200 10-candle slope +/-0.0005 + price-vs-EMA200, ATR%>5 = CRISIS
 *   - detectPools:  1-bar swings, 0.5% equality, <=80 candle pairing, unswept, expire+500
 *   - simpleRvol:   plain 20-candle volume SMA ratio (NOT time-normalised)
 *   - CVD gate:     sign of (delta[i] - delta[i-1])
 *   - stop = pool.level -/+ 0.3*ATR14 ; tp = pool.level +/- 2.5*stopDist
 *   - sizing = min(riskAmt/stopDist, equity*0.8*LEVERAGE/price)  <- incl. leverage cap
 *   - SKIP_RANGING, TIME_EXIT_CANDLES=50
 *
 * HONEST WHERE LIVE IS FANTASY
 *   1. ENTRY PRICE. liveRunner's paper path books `entry: pool.level`, but the
 *      live path sends a MARKET order and fills at ~the signal candle's close.
 *      For a long sweep, candle.low < pool.level < candle.close, so the live
 *      fill is always WORSE than the paper fill. We model the market fill.
 *      Consequence: real risk = (fill - stop) > stopDist, so realised R < 2.5
 *      before a single cent of fees.
 *   2. FEES. Confirmed from the user's own /fapi/v1/userTrades data:
 *      entry 0.05000% TAKER, TP 0.02000% MAKER. A STOP_MARKET stop can never
 *      be maker, so it pays TAKER. Wins cost taker+maker, losses taker+taker.
 *   3. INTRABAR SEQUENCE. The stop sits ~0.09% from entry and the TP ~0.23%;
 *      at 15m granularity a single candle very often contains both. OHLC data
 *      cannot say which came first. We report BOTH bounds (see --optimistic).
 *   4. FUNDING. 0.01% per 8h of notional while the position is held.
 *
 * DELIBERATE DEVIATIONS (each one FAVOURS the strategy — they cannot manufacture
 * a negative result):
 *   - EMA200/ATR are computed once over the full series instead of over the
 *     live bot's drifting 500..15000-candle buffer. This is strictly more
 *     accurate than what the bot actually does.
 *   - Pool detection uses a rolling 600-candle window. Pools only pair swings
 *     <=80 candles apart and expire 500 candles after formation, so a 600-candle
 *     window is semantically identical to the live full-buffer scan while being
 *     O(1) amortised instead of O(n^2) per candle.
 *
 * USAGE
 *   node src/backtest/run_live_replica.js [--symbol ETHUSDT] [--slippage 0.0006]
 *                                        [--optimistic] [--capital 95.69]
 */

const fs = require('fs');
const path = require('path');

const { atr } = require('../indicators/atr');
const { ema } = require('../indicators/ema');
const { cvd: cvdFn } = require('../indicators/cvd');
const { TICK_SIZES, EXECUTION_PARAMS } = require('../../config');

// ── Live parameters — copied verbatim from src/live/liveRunner.js ────────────
const SWEEP_RVOL_MIN = 0.3;
const STOP_ATR_MULT = 0.3;
const TP_R_MULT = 2.5;
const RISK_PCT = 0.02;
const SKIP_RANGING = true;
const TIME_EXIT_CANDLES = 50;
const LEVERAGE = 20;

// ── Real Binance USD-M cost model ───────────────────────────────────────────
// --nofees zeroes every cost. It is a DIAGNOSTIC ONLY: it answers "is the
// strategy's entry/exit geometry itself losing, independent of costs?"
const NOFEES = process.argv.includes('--nofees');
const TAKER = NOFEES ? 0 : 0.0005;          // 0.050% — confirmed from user's userTrades
const MAKER = NOFEES ? 0 : 0.0002;          // 0.020% — confirmed from user's userTrades
const FUNDING_PER_8H = NOFEES ? 0 : 0.0001; // 0.01% of notional per 8h

const POOL_WINDOW = 600;

// ── args ────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const SYMBOL = arg('symbol', 'ETHUSDT');
const OPTIMISTIC = process.argv.includes('--optimistic');
const SLIPPAGE = parseFloat(arg('slippage',
  String((EXECUTION_PARAMS[SYMBOL] || {}).baseSlippage ?? 0.0006)));
const CAPITAL = parseFloat(arg('capital', '95.69'));
const MIN_EDGE = parseFloat(arg('minedge', '0'));
const OLD_SIZING = process.argv.includes('--oldsizing');
const TICK = TICK_SIZES[SYMBOL] || 0.01;

// ── data ────────────────────────────────────────────────────────────────────
function loadCandles(symbol) {
  const p = path.join(process.cwd(), 'data', 'historical', `${symbol}_15m.ndjson`);
  if (!fs.existsSync(p)) throw new Error('missing data file: ' + p);
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    out.push(c);
  }
  // de-dup + sort by openTime (the downloader can overlap batches on resume)
  out.sort((a, b) => a.openTime - b.openTime);
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].openTime === c.openTime) continue;
    dedup.push(c);
  }
  return dedup;
}

// ── liveRunner.js logic, verbatim ───────────────────────────────────────────
function simpleRvol(candles, period = 20) {
  const result = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += candles[j].volume;
    result[i] = sum / period > 0 ? candles[i].volume / (sum / period) : 1.0;
  }
  return result;
}

function detectRegime(candles, atr14, ema200Vals, candle, i) {
  if (i < 200) return 'RANGING';
  const e200 = ema200Vals[i], ePrev = ema200Vals[Math.max(0, i - 10)];
  if (!e200 || !ePrev) return 'RANGING';
  const priceAbove = candle.close > e200;
  const slope10 = (e200 - ePrev) / ePrev;
  const atrPct = (atr14[i] || 0) / candle.close * 100;
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.0005 && priceAbove) return 'BULL';
  if (slope10 < -0.0005 && !priceAbove) return 'BEAR';
  return 'RANGING';
}

/**
 * Verbatim port of liveRunner.detectPools, over a rolling window.
 * `base` is the absolute index of window[0] so pools carry absolute indices.
 *
 * NOTE: `Math.floor` on the pool level is preserved deliberately — it is what
 * the live bot does, and it is one of the bugs this run is meant to expose.
 */
function detectPools(window, base, type) {
  const pools = [], sw = [];
  for (let j = 1; j < window.length - 1; j++) {
    if (type === 'LONG' && window[j].low < window[j - 1].low && window[j].low < window[j + 1].low) sw.push(j);
    if (type === 'SHORT' && window[j].high > window[j - 1].high && window[j].high > window[j + 1].high) sw.push(j);
  }
  for (let a = 0; a < sw.length; a++) {
    for (let b = a + 1; b < sw.length; b++) {
      const si = sw[a], sj = sw[b];
      if (sj - si > 80) break;
      if (sj - si < 2) continue;
      const v1 = type === 'LONG' ? window[si].low : window[si].high;
      const v2 = type === 'LONG' ? window[sj].low : window[sj].high;
      if (Math.abs(v1 - v2) / v1 >= 0.005) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) {
        const cv = type === 'LONG' ? window[k].low : window[k].high;
        if (type === 'LONG' ? cv < Math.min(v1, v2) : cv > Math.max(v1, v2)) { swept = true; break; }
      }
      if (swept) continue;
      pools.push({ level: Math.floor((v1 + v2) / 2), formed: base + sj, expires: base + sj + 500 });
    }
  }
  return pools;
}

// ── metrics ─────────────────────────────────────────────────────────────────
function summarise(trades, initialCapital, equityCurve) {
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gross = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  let peak = initialCapital, maxDD = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const rets = trades.map(t => t.pnlPct);
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;
  const downside = rets.filter(r => r < 0);
  const dsd = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : 0;
  // per-trade Sharpe/Sortino annualised by observed trade frequency
  const spanMs = n ? (trades[n - 1].exitTime - trades[0].entryTime) : 0;
  const tradesPerYear = spanMs > 0 ? n / (spanMs / (365.25 * 24 * 3600 * 1000)) : 0;
  const ann = Math.sqrt(tradesPerYear || 0);

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n * 100 : 0,
    netProfit: gross,
    netProfitPct: initialCapital > 0 ? gross / initialCapital * 100 : 0,
    profitFactor: pf,
    expectancy: n ? gross / n : 0,
    expectancyPct: n ? mean * 100 : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    sharpe: sd > 0 ? (mean / sd) * ann : 0,
    sortino: dsd > 0 ? (mean / dsd) * ann : 0,
    maxDDpct: maxDD * 100,
    recoveryFactor: maxDD > 0 ? (gross / initialCapital) / maxDD : (gross > 0 ? Infinity : 0),
    totalFees: trades.reduce((s, t) => s + t.fees, 0),
    totalSlippage: trades.reduce((s, t) => s + t.slip, 0),
    totalFunding: trades.reduce((s, t) => s + t.funding, 0),
    grossBeforeCosts: trades.reduce((s, t) => s + t.grossPnl, 0),
  };
}

function fmt(v, d = 2) {
  if (v === Infinity) return 'Inf';
  if (!isFinite(v)) return 'n/a';
  return v.toFixed(d);
}

// ── main ────────────────────────────────────────────────────────────────────
function run() {
  const candles = loadCandles(SYMBOL);
  console.log('='.repeat(78));
  console.log('LIVE-RUNNER REPLICA BACKTEST — ' + SYMBOL + ' 15m');
  console.log('='.repeat(78));
  console.log('candles      : ' + candles.length +
    '  (' + new Date(candles[0].openTime).toISOString().slice(0, 10) +
    ' -> ' + new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10) + ')');
  console.log('params       : RVOL>=' + SWEEP_RVOL_MIN + '  stop=' + STOP_ATR_MULT +
    'xATR  TP=' + TP_R_MULT + 'R  risk=' + (RISK_PCT * 100) + '%  lev=' + LEVERAGE + 'x');
  console.log('costs        : taker ' + (TAKER * 100).toFixed(3) + '%  maker ' +
    (MAKER * 100).toFixed(3) + '%  slippage ' + (SLIPPAGE * 100).toFixed(3) + '%/side  funding ' +
    (FUNDING_PER_8H * 100).toFixed(3) + '%/8h');
  console.log('intrabar     : ' + (OPTIMISTIC
    ? 'OPTIMISTIC (TP wins ties — upper bound)'
    : 'PESSIMISTIC (SL wins ties — lower bound)'));
  console.log('capital      : $' + CAPITAL.toFixed(2));
  console.log('sizing       : ' + (OLD_SIZING
    ? 'ORIGINAL riskAmt/stopDist (ignores fees AND entry-vs-anchor gap)'
    : 'FIXED — riskAmt / (|entry-stop| + fees)'));
  console.log('min-edge     : ' + (MIN_EDGE > 0 ? MIN_EDGE + 'x round-trip cost' : 'off'));

  const atr14 = atr(candles, 14);
  const rvolVals = simpleRvol(candles, 20);
  const cvdVals = cvdFn(candles);
  const ema200Vals = ema(candles.map(c => c.close), 200);

  let equity = CAPITAL;
  let openTrade = null;
  const trades = [];
  const equityCurve = [equity];
  const blocked = { ranging: 0, rvol: 0, ghost: 0, noPool: 0, tooSmall: 0, ambiguous: 0, minEdge: 0 };
  let sweeps = 0;
  let ruinAt = null;

  // Compounding a negative edge hits zero and then every later trade is $0,
  // which silently hides the edge. FIXED_RISK sizes off the STARTING capital so
  // per-trade economics stay comparable across the whole sample.
  const FIXED_RISK = !process.argv.includes('--compound');

  // cache pools per candle index, rebuilt each candle like the live bot does
  for (let i = 200; i < candles.length; i++) {
    const candle = candles[i];
    const regime = detectRegime(candles, atr14, ema200Vals, candle, i);

    // ── manage open trade ──
    if (openTrade) {
      const t = openTrade;
      const isLong = t.side === 'LONG';
      const hitSL = isLong ? candle.low <= t.stop : candle.high >= t.stop;
      const hitTP = isLong ? candle.high >= t.tp : candle.low <= t.tp;
      const timedOut = i - t.idx >= TIME_EXIT_CANDLES;

      let exitPrice = null, exitKind = null, exitMaker = false;
      if (hitSL && hitTP) {
        blocked.ambiguous++;
        if (OPTIMISTIC) { exitPrice = t.tp; exitKind = 'TP'; exitMaker = true; }
        else { exitPrice = t.stop; exitKind = 'SL'; }
      } else if (hitTP) {
        exitPrice = t.tp; exitKind = 'TP'; exitMaker = true;
      } else if (hitSL) {
        exitPrice = t.stop; exitKind = 'SL';
      } else if (timedOut) {
        exitPrice = candle.close; exitKind = 'TIME';
      }

      if (exitPrice !== null) {
        // SL and TIME exits are MARKET -> taker + slippage against us.
        // TP is a resting LIMIT -> maker, no slippage (price came to us).
        let fill = exitPrice, slipCost = 0;
        if (!exitMaker) {
          const adverse = exitPrice * SLIPPAGE;
          fill = isLong ? exitPrice - adverse : exitPrice + adverse;
          slipCost = t.qty * adverse;
        }
        const grossPnl = (isLong ? fill - t.entry : t.entry - fill) * t.qty;
        const exitFee = t.qty * fill * (exitMaker ? MAKER : TAKER);
        const heldMs = candle.closeTime - t.entryTime;
        const funding = t.qty * t.entry * FUNDING_PER_8H * (heldMs / (8 * 3600 * 1000));
        const fees = t.entryFee + exitFee;
        const pnl = grossPnl - fees - funding;

        equity += pnl;
        equityCurve.push(equity);
        if (ruinAt === null && equity <= 0) ruinAt = { trade: trades.length + 1, time: candle.closeTime };
        trades.push({
          side: t.side, regime: t.regime, kind: exitKind,
          entry: t.entry, exit: fill, qty: t.qty, notional: t.qty * t.entry,
          grossPnl: grossPnl + slipCost,   // before slippage, for attribution
          pnl, pnlPct: pnl / (equity - pnl),
          fees, slip: slipCost, funding,
          entryTime: t.entryTime, exitTime: candle.closeTime,
          candlesHeld: i - t.idx,
          plannedR: t.plannedR, realisedR: t.riskAtEntry > 0 ? pnl / t.riskAtEntry : 0,
        });
        openTrade = null;
      }
    }
    if (openTrade) continue;

    // ── new signal ──
    if (SKIP_RANGING && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) { blocked.ranging++; continue; }
    if (regime !== 'BULL' && regime !== 'BEAR') continue;

    const rv = rvolVals[i] || 0;
    const cv = cvdVals.delta[i] || 0, pv = cvdVals.delta[i - 1] || 0;
    const av = atr14[i] || 0;
    if (rv < SWEEP_RVOL_MIN) { blocked.rvol++; continue; }

    const type = regime === 'BULL' ? 'LONG' : 'SHORT';
    const from = Math.max(0, i - POOL_WINDOW);
    const pools = detectPools(candles.slice(from, i + 1), from, type);

    let opened = false, sawPool = false;
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (type === 'LONG') {
        if (candle.low >= pool.level || candle.close <= pool.level) continue;
      } else {
        if (candle.high <= pool.level || candle.close >= pool.level) continue;
      }
      sawPool = true; sweeps++;

      // CVD ghost gate
      if (type === 'LONG' ? (cv - pv) <= 0 : (cv - pv) >= 0) { blocked.ghost++; continue; }

      const stopDist = av * STOP_ATR_MULT;
      if (!(stopDist > 0)) continue;
      const stop = type === 'LONG' ? pool.level - stopDist : pool.level + stopDist;
      const tp = type === 'LONG' ? pool.level + stopDist * TP_R_MULT : pool.level - stopDist * TP_R_MULT;

      // ENTRY = MARKET at signal-candle close (what live actually does),
      // NOT pool.level (what liveRunner's paper path pretends).
      const adverse = candle.close * SLIPPAGE;
      const entry = type === 'LONG' ? candle.close + adverse : candle.close - adverse;

      // --minedge N: require the target to clear round-trip cost by N x.
      const tpDist = Math.abs(tp - entry);
      if (MIN_EDGE > 0 && (tpDist / entry) < MIN_EDGE * (TAKER + MAKER)) {
        blocked.minEdge++; continue;
      }

      // sizing — live formula incl. the 20x leverage cap.
      // --fixedsizing uses the ORIGINAL (buggy) riskAmt/stopDist so the report can
      // show what the sizing fix is worth; default sizes off real entry->stop risk.
      const sizingEquity = FIXED_RISK ? CAPITAL : equity;
      const riskAmt = sizingEquity * RISK_PCT;
      const maxQty = sizingEquity * 0.8 * LEVERAGE / candle.close;
      const perUnitLoss = OLD_SIZING
        ? stopDist
        : Math.abs(entry - stop) + entry * (TAKER + TAKER);
      const qty = Math.min(riskAmt / perUnitLoss, maxQty);
      if (!(qty > 0)) { blocked.tooSmall++; continue; }
      const entryFee = qty * entry * TAKER;

      // if the market fill is already past the stop, the trade is dead on arrival
      if (type === 'LONG' ? entry <= stop : entry >= stop) { blocked.tooSmall++; continue; }

      openTrade = {
        side: type, entry, stop, tp, qty, idx: i, regime,
        entryTime: candle.closeTime, entryFee,
        plannedR: TP_R_MULT,
        riskAtEntry: Math.abs(entry - stop) * qty,
      };
      opened = true;
      break;
    }
    if (!opened && !sawPool) blocked.noPool++;
  }

  // ── report ──
  const all = summarise(trades, CAPITAL, equityCurve);
  console.log('\n' + '-'.repeat(78));
  console.log('OVERALL');
  console.log('-'.repeat(78));
  console.log('  Trade count      : ' + all.trades);
  console.log('  Net profit       : $' + fmt(all.netProfit) + '  (' + fmt(all.netProfitPct) + '% of $' + CAPITAL.toFixed(2) + ')');
  console.log('  Final equity     : $' + fmt(equity));
  console.log('  Profit factor    : ' + fmt(all.profitFactor, 3));
  console.log('  Win rate         : ' + fmt(all.winRate, 1) + '%  (' + all.wins + 'W / ' + all.losses + 'L)');
  console.log('  Expectancy       : $' + fmt(all.expectancy, 4) + ' / trade  (' + fmt(all.expectancyPct, 4) + '% of equity)');
  console.log('  Avg win          : $' + fmt(all.avgWin, 4));
  console.log('  Avg loss         : $' + fmt(all.avgLoss, 4));
  console.log('  Sharpe (ann.)    : ' + fmt(all.sharpe, 2));
  console.log('  Sortino (ann.)   : ' + fmt(all.sortino, 2));
  console.log('  Max drawdown     : ' + fmt(all.maxDDpct, 2) + '%');
  console.log('  Recovery factor  : ' + fmt(all.recoveryFactor, 2));

  console.log('\n  COST ATTRIBUTION');
  console.log('  Gross P&L before all costs : $' + fmt(all.grossBeforeCosts));
  console.log('  - fees                     : $' + fmt(all.totalFees));
  console.log('  - slippage                 : $' + fmt(all.totalSlippage));
  console.log('  - funding                  : $' + fmt(all.totalFunding));
  console.log('  = net                      : $' + fmt(all.netProfit));
  const totalCost = all.totalFees + all.totalSlippage + all.totalFunding;
  console.log('  total cost / |gross|       : ' +
    (Math.abs(all.grossBeforeCosts) > 0 ? fmt(totalCost / Math.abs(all.grossBeforeCosts) * 100, 1) + '%' : 'n/a'));

  const realisedRs = trades.map(t => t.realisedR).filter(isFinite);
  if (realisedRs.length) {
    const winR = trades.filter(t => t.pnl > 0).map(t => t.realisedR);
    const lossR = trades.filter(t => t.pnl <= 0).map(t => t.realisedR);
    const sumR = realisedRs.reduce((a, b) => a + b, 0);
    const avgR = sumR / realisedRs.length;
    console.log('\n  EDGE IN R-MULTIPLES  (capital-independent — immune to the ruin artifact)');
    console.log('  planned R:R                 : ' + TP_R_MULT + ' : 1');
    console.log('  median realised R on a WIN  : ' + fmt(median(winR), 3));
    console.log('  median realised R on a LOSS : ' + fmt(median(lossR), 3));
    console.log('  => realised R:R             : ' +
      fmt(Math.abs(median(winR) / median(lossR)), 3) + ' : 1');
    console.log('  *** EXPECTANCY PER TRADE    : ' + fmt(avgR, 4) + ' R ***');
    console.log('  total R over ' + realisedRs.length + ' trades   : ' + fmt(sumR, 1) + ' R');
    const beWR = Math.abs(median(lossR)) / (median(winR) + Math.abs(median(lossR)));
    console.log('  break-even WR needed        : ' + fmt(beWR * 100, 1) + '%   (actual: ' +
      fmt(all.winRate, 1) + '%)');
  }
  if (ruinAt) {
    console.log('\n  *** ACCOUNT RUIN at trade #' + ruinAt.trade + ' on ' +
      new Date(ruinAt.time).toISOString().slice(0, 10) +
      (FIXED_RISK ? ' (fixed-risk sizing; equity went <= 0 but sizing held constant so' +
        ' later trades remain measurable)' : ' (compounded)') + ' ***');
  }

  // long vs short
  console.log('\n' + '-'.repeat(78));
  console.log('LONG vs SHORT');
  console.log('-'.repeat(78));
  for (const side of ['LONG', 'SHORT']) {
    const sub = trades.filter(t => t.side === side);
    if (!sub.length) { console.log('  ' + side.padEnd(6) + ' no trades'); continue; }
    const s = summarise(sub, CAPITAL, [CAPITAL]);
    console.log('  ' + side.padEnd(6) + ' n=' + String(s.trades).padStart(5) +
      '  WR=' + fmt(s.winRate, 1).padStart(5) + '%  PF=' + fmt(s.profitFactor, 3).padStart(6) +
      '  net=$' + fmt(s.netProfit).padStart(10) + '  exp=$' + fmt(s.expectancy, 4).padStart(9));
  }

  // regime
  console.log('\n' + '-'.repeat(78));
  console.log('BY REGIME');
  console.log('-'.repeat(78));
  for (const rg of ['BULL', 'BEAR', 'CRISIS']) {
    const sub = trades.filter(t => t.regime === rg);
    if (!sub.length) { console.log('  ' + rg.padEnd(8) + ' no trades'); continue; }
    const s = summarise(sub, CAPITAL, [CAPITAL]);
    console.log('  ' + rg.padEnd(8) + ' n=' + String(s.trades).padStart(5) +
      '  WR=' + fmt(s.winRate, 1).padStart(5) + '%  PF=' + fmt(s.profitFactor, 3).padStart(6) +
      '  net=$' + fmt(s.netProfit).padStart(10));
  }

  // exit kind
  console.log('\n' + '-'.repeat(78));
  console.log('BY EXIT TYPE');
  console.log('-'.repeat(78));
  for (const k of ['TP', 'SL', 'TIME']) {
    const sub = trades.filter(t => t.kind === k);
    if (!sub.length) { console.log('  ' + k.padEnd(6) + ' none'); continue; }
    const net = sub.reduce((s, t) => s + t.pnl, 0);
    const profitable = sub.filter(t => t.pnl > 0).length;
    console.log('  ' + k.padEnd(6) + ' n=' + String(sub.length).padStart(5) +
      '  net=$' + fmt(net).padStart(10) +
      '  avg=$' + fmt(net / sub.length, 4).padStart(9) +
      '  actually profitable: ' + profitable + '/' + sub.length);
  }

  // walk-forward by calendar year
  console.log('\n' + '-'.repeat(78));
  console.log('WALK-FORWARD (calendar year, out-of-sample by construction —');
  console.log('the grid search that produced these params ran on 2026 data only)');
  console.log('-'.repeat(78));
  const years = [...new Set(trades.map(t => new Date(t.entryTime).getUTCFullYear()))].sort();
  for (const y of years) {
    const sub = trades.filter(t => new Date(t.entryTime).getUTCFullYear() === y);
    const s = summarise(sub, CAPITAL, [CAPITAL]);
    const rs = sub.map(t => t.realisedR).filter(isFinite);
    const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
    console.log('  ' + y + '  n=' + String(s.trades).padStart(5) +
      '  WR=' + fmt(s.winRate, 1).padStart(5) + '%  PF=' + fmt(s.profitFactor, 3).padStart(6) +
      '  avgR=' + fmt(avgR, 4).padStart(8) + 'R' +
      '  net=$' + fmt(s.netProfit).padStart(9));
  }
  console.log('  (net$ is distorted after ruin — judge these rows on PF and avgR)');

  console.log('\n' + '-'.repeat(78));
  console.log('FILTER / BLOCK COUNTS');
  console.log('-'.repeat(78));
  console.log('  candles skipped RANGING      : ' + blocked.ranging);
  console.log('  candles blocked by RVOL<0.3  : ' + blocked.rvol);
  console.log('  pool sweeps detected         : ' + sweeps);
  console.log('  blocked by CVD ghost gate    : ' + blocked.ghost);
  console.log('  rejected (size/dead-on-fill) : ' + blocked.tooSmall);
  console.log('  blocked by min-edge filter   : ' + blocked.minEdge +
    (MIN_EDGE > 0 ? '  (threshold ' + MIN_EDGE + 'x round-trip cost)' : '  (filter off)'));
  console.log('  AMBIGUOUS candles (SL+TP in same bar, resolved ' +
    (OPTIMISTIC ? 'as TP' : 'as SL') + '): ' + blocked.ambiguous +
    (trades.length ? '  = ' + fmt(blocked.ambiguous / trades.length * 100, 1) + '% of trades' : ''));

  const outDir = path.join(process.cwd(), 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const tag = OPTIMISTIC ? 'optimistic' : 'pessimistic';
  const outFile = path.join(outDir,
    `live_replica_${SYMBOL}_slip${SLIPPAGE}_${tag}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    symbol: SYMBOL, params: { SWEEP_RVOL_MIN, STOP_ATR_MULT, TP_R_MULT, RISK_PCT, LEVERAGE, TIME_EXIT_CANDLES },
    costs: { TAKER, MAKER, SLIPPAGE, FUNDING_PER_8H }, intrabar: tag,
    capital: CAPITAL, summary: all, blocked, sweeps,
    byYear: years.map(y => ({ year: y, ...summarise(trades.filter(t => new Date(t.entryTime).getUTCFullYear() === y), CAPITAL, [CAPITAL]) })),
    trades,
  }, null, 2));
  console.log('\nwritten: ' + path.relative(process.cwd(), outFile));
}

function median(a) {
  if (!a || !a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

run();
