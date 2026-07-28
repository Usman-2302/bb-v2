'use strict';

/**
 * Performance metrics computed from a trade list.
 *
 * Everything here is expressed in R-multiples wherever possible. R is
 * capital-independent, so it survives ruin, position-size changes and
 * compounding — all of which corrupt dollar-based metrics (see AUDIT.md, where a
 * compounding run hit zero equity and made every later year read "$-0.00").
 */

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function sd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(a, q) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * @param {Array} trades  each { rMultiple, pnl, entryTime, exitTime, mfeR, maeR, dir, reason }
 * @param {number} riskPerTradePct  fraction of equity risked per trade (for equity curve)
 */
function summarise(trades, riskPerTradePct = 0.01) {
  const n = trades.length;
  const empty = {
    trades: 0, wins: 0, losses: 0, winRate: NaN, avgR: NaN, medianR: NaN,
    totalR: 0, expectancy: NaN, payoff: NaN, profitFactor: NaN,
    sharpe: NaN, sortino: NaN, maxDDR: NaN, mar: NaN, recoveryFactor: NaN,
    avgWinR: NaN, avgLossR: NaN, avgHoldBars: NaN, tradesPerYear: NaN,
    medianMFE: NaN, medianMAE: NaN, tStat: NaN,
  };
  if (!n) return empty;

  const rs = trades.map(t => t.rMultiple).filter(Number.isFinite);
  if (!rs.length) return empty;
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r <= 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));

  // Equity curve in R space (additive) — DD is then in R, not dollars.
  let cum = 0, peak = 0, maxDD = 0;
  const curve = [];
  for (const r of rs) {
    cum += r;
    curve.push(cum);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  const m = mean(rs), s = sd(rs);
  const span = trades.length > 1
    ? (trades[trades.length - 1].exitTime - trades[0].entryTime) : 0;
  const tradesPerYear = span > 0 ? n / (span / YEAR_MS) : NaN;
  const ann = Number.isFinite(tradesPerYear) ? Math.sqrt(tradesPerYear) : NaN;

  const downside = rs.filter(r => r < 0);
  const dsd = downside.length > 1
    ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length) : NaN;

  const totalR = cum;
  const years = span > 0 ? span / YEAR_MS : NaN;
  const cagrR = Number.isFinite(years) && years > 0 ? totalR / years : NaN;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / n * 100,
    avgR: m,
    medianR: median(rs),
    totalR,
    expectancy: m,
    payoff: losses.length && wins.length
      ? (grossWin / wins.length) / (grossLoss / losses.length) : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    sharpe: s > 0 ? (m / s) * ann : NaN,
    sortino: dsd > 0 ? (m / dsd) * ann : NaN,
    maxDDR: maxDD,
    // MAR = annualised return / max drawdown, both in R
    mar: maxDD > 0 && Number.isFinite(cagrR) ? cagrR / maxDD : NaN,
    recoveryFactor: maxDD > 0 ? totalR / maxDD : NaN,
    avgWinR: wins.length ? grossWin / wins.length : NaN,
    avgLossR: losses.length ? -grossLoss / losses.length : NaN,
    avgHoldBars: mean(trades.map(t => t.holdBars).filter(Number.isFinite)),
    tradesPerYear,
    medianMFE: median(trades.map(t => t.mfeR).filter(Number.isFinite)),
    medianMAE: median(trades.map(t => t.maeR).filter(Number.isFinite)),
    // t-stat of mean R against zero: the primary significance measure
    tStat: s > 0 ? m / (s / Math.sqrt(n)) : NaN,
    equityCurveR: curve,
  };
}

/** Split a trade list by a key function and summarise each bucket. */
function summariseBy(trades, keyFn, riskPerTradePct) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = {};
  for (const [k, list] of groups) out[k] = summarise(list, riskPerTradePct);
  return out;
}

module.exports = { summarise, summariseBy, mean, sd, median, quantile };
