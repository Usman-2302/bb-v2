'use strict';

/**
 * Analytics layer — explains WHERE a result comes from.
 *
 * A single expectancy number cannot distinguish a genuine two-sided edge from
 * long-side market beta, or a broad effect from one lucky month. Phase 3 found
 * three strategies whose entire "edge" was long-only drift in a rising market;
 * that discovery is now a first-class, automated check rather than a manual one.
 */

const { summarise, mean, median } = require('./metrics');

/** Bucket trades and summarise each bucket. */
function attribution(trades, keyFn) {
  const g = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (k === null || k === undefined) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  const out = {};
  for (const [k, list] of g) {
    const s = summarise(list);
    out[k] = { trades: s.trades, winRate: s.winRate, avgR: s.avgR, totalR: s.totalR, profitFactor: s.profitFactor };
  }
  return out;
}

/**
 * Directional decomposition and beta verdict.
 *
 * A long-biased strategy in a rising market is not skilled. This returns the
 * per-side expectancy and a verdict the ranking engine consumes directly.
 */
function betaCheck(trades) {
  const L = trades.filter(t => t.dir > 0).map(t => t.rMultiple).filter(Number.isFinite);
  const S = trades.filter(t => t.dir < 0).map(t => t.rMultiple).filter(Number.isFinite);
  const lm = L.length ? mean(L) : NaN;
  const sm = S.length ? mean(S) : NaN;
  let verdict, twoSided = false;
  if (!L.length || !S.length) verdict = 'single-sided sample';
  else if (lm > 0 && sm > 0) { verdict = 'symmetric — genuine two-sided edge'; twoSided = true; }
  else if (lm > 0) verdict = 'LONG-ONLY — indistinguishable from beta';
  else if (sm > 0) verdict = 'SHORT-ONLY';
  else verdict = 'both sides negative';
  return {
    longN: L.length, longAvgR: lm,
    shortN: S.length, shortAvgR: sm,
    // how lopsided: 0 = perfectly balanced, 1 = entirely one side
    asymmetry: Number.isFinite(lm) && Number.isFinite(sm) && (Math.abs(lm) + Math.abs(sm)) > 0
      ? Math.abs(lm - sm) / (Math.abs(lm) + Math.abs(sm)) : NaN,
    twoSided, verdict,
  };
}

/**
 * Drawdown episodes on the R equity curve.
 * An episode runs from the moment equity leaves a peak until it regains it;
 * an unrecovered tail counts as an open episode.
 */
function drawdownAnalysis(trades) {
  const rs = trades.map(t => t.rMultiple).filter(Number.isFinite);
  const episodes = [];
  let cum = 0, peak = 0, curDepth = 0, curLen = 0, worst = 0, longest = 0;
  let sumSqDepth = 0;

  for (const r of rs) {
    cum += r;
    if (cum >= peak) {
      if (curLen > 0) episodes.push({ depthR: curDepth, lengthTrades: curLen, recovered: true });
      peak = cum; curDepth = 0; curLen = 0;
    } else {
      curDepth = peak - cum;
      curLen++;
      if (curDepth > worst) worst = curDepth;
      if (curLen > longest) longest = curLen;
    }
    sumSqDepth += (peak - cum) ** 2;
  }
  if (curLen > 0) episodes.push({ depthR: curDepth, lengthTrades: curLen, recovered: false });

  return {
    maxDDR: worst,
    longestDDTrades: longest,
    episodes: episodes.length,
    unrecovered: episodes.filter(e => !e.recovered).length,
    // Ulcer index in R: RMS depth, penalising long shallow pain as well as spikes
    ulcerR: rs.length ? Math.sqrt(sumSqDepth / rs.length) : 0,
    worstEpisodes: episodes.sort((a, b) => b.depthR - a.depthR).slice(0, 3),
  };
}

/** Edge concentration: is the result driven by a handful of trades? */
function edgeConcentration(trades) {
  const rs = trades.map(t => t.rMultiple).filter(Number.isFinite);
  if (rs.length < 10) return { topDecileShare: NaN, withoutTop5: NaN, verdict: 'too few trades' };
  const total = rs.reduce((a, b) => a + b, 0);
  const sorted = [...rs].sort((a, b) => b - a);
  const topDecile = sorted.slice(0, Math.max(1, Math.floor(rs.length * 0.1)))
    .reduce((a, b) => a + b, 0);
  const withoutTop5 = sorted.slice(5).reduce((a, b) => a + b, 0) / (rs.length - 5);
  return {
    topDecileShare: total !== 0 ? topDecile / total : NaN,
    withoutTop5,
    // if removing 5 trades flips the sign, the "edge" is 5 trades
    verdict: total > 0 && withoutTop5 <= 0
      ? 'FRAGILE — expectancy depends on <=5 trades'
      : 'distributed',
  };
}

/** Full analytics bundle for one strategy/symbol result. */
function analyse(trades) {
  return {
    beta: betaCheck(trades),
    drawdown: drawdownAnalysis(trades),
    concentration: edgeConcentration(trades),
    bySession: attribution(trades, t => t.session),
    byRegime: attribution(trades, t => (t.regime > 0 ? 'UP' : t.regime < 0 ? 'DOWN' : 'FLAT')),
    byExitReason: attribution(trades, t => t.reason),
    byYear: attribution(trades, t => new Date(t.entryTime).getUTCFullYear()),
    excursion: {
      medianMFE: median(trades.map(t => t.mfeR).filter(Number.isFinite)),
      medianMAE: median(trades.map(t => t.maeR).filter(Number.isFinite)),
    },
  };
}

module.exports = { analyse, betaCheck, attribution, drawdownAnalysis, edgeConcentration };
