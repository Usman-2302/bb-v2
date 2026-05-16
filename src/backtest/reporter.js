'use strict';

/**
 * BulletBrain v3.0 — Backtest Reporter
 * Phase D4 — Step 0.4
 *
 * Generates metrics from a completed backtest run.
 * Source: backtestplan.md lines 371-408 (Report generator output)
 */

/**
 * Calculate Wilson confidence interval for a binomial proportion.
 * Used for WR confidence intervals.
 *
 * @param {number} wins  - number of wins
 * @param {number} total - total trades
 * @returns {{ lower, point, upper, reliable, n }}
 */
function wilsonCI(wins, total) {
  if (total === 0) return { lower: 0, point: 0, upper: 0, reliable: false, n: 0 };

  const p = wins / total;
  const z = 1.96; // 95% CI
  const n = total;

  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  const denom  = 1 + z * z / n;

  return {
    lower:    (center - margin) / denom,
    point:    p,
    upper:    (center + margin) / denom,
    reliable: total >= 100,
    n:        total,
  };
}

/**
 * Calculate Sharpe ratio from equity curve.
 * Uses daily returns, annualized.
 *
 * @param {object[]} curve - [{ timestamp, capital }]
 * @returns {number} annualized Sharpe ratio
 */
function calcSharpe(curve) {
  if (curve.length < 2) return 0;

  // Group by day
  const dailyCapital = {};
  curve.forEach(p => {
    const day = new Date(p.timestamp).toISOString().slice(0, 10);
    dailyCapital[day] = p.capital;
  });

  const days    = Object.keys(dailyCapital).sort();
  const returns = [];
  for (let i = 1; i < days.length; i++) {
    const prev = dailyCapital[days[i - 1]];
    const curr = dailyCapital[days[i]];
    if (prev > 0) returns.push((curr - prev) / prev);
  }

  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Annualize: multiply by sqrt(252) for daily returns
  return (mean / stdDev) * Math.sqrt(252);
}

/**
 * Calculate Profit Factor from trade list.
 * PF = gross wins / gross losses
 *
 * @param {object[]} trades - closed trade records
 * @returns {number} profit factor
 */
function calcProfitFactor(trades) {
  let grossWins   = 0;
  let grossLosses = 0;

  trades.forEach(t => {
    if (t.realizedPnl > 0) grossWins   += t.realizedPnl;
    else                    grossLosses += Math.abs(t.realizedPnl);
  });

  return grossLosses === 0 ? Infinity : grossWins / grossLosses;
}

/**
 * Generate full backtest report from completed trades and equity curve.
 *
 * @param {object[]} trades  - all closed trade records
 * @param {object}   equity  - equity tracker object
 * @param {object}   meta    - { strategy, symbol, startDate, endDate }
 * @returns {object} report
 */
function generateReport(trades, equity, meta = {}) {
  if (trades.length === 0) {
    return {
      ...meta,
      trades:       0,
      wr:           wilsonCI(0, 0),
      pf:           0,
      avgRR:        0,
      maxDD:        0,
      sharpe:       0,
      tradesPerMonth: 0,
      totalCostDrag: 0,
      ghostTradeRate: 0,
      toxicFillRate:  0,
      cumulativeFundingCost: 0,
      regimeBreakdown: {},
      yearlyBreakdown: {},
      missedTrades:   0,
    };
  }

  const wins   = trades.filter(t => t.realizedPnl > 0).length;
  const losses = trades.filter(t => t.realizedPnl <= 0).length;
  const total  = trades.length;

  // Average R:R achieved
  const avgWin  = wins  > 0 ? trades.filter(t => t.realizedPnl > 0).reduce((s, t) => s + t.realizedPnl, 0) / wins  : 0;
  const avgLoss = losses > 0 ? Math.abs(trades.filter(t => t.realizedPnl <= 0).reduce((s, t) => s + t.realizedPnl, 0) / losses) : 1;
  const avgRR   = avgLoss > 0 ? avgWin / avgLoss : 0;

  // Trades per month
  const startMs = Math.min(...trades.map(t => t.entryTimestamp));
  const endMs   = Math.max(...trades.map(t => t.exitTimestamp || t.entryTimestamp));
  const months  = (endMs - startMs) / (30 * 24 * 60 * 60 * 1000);
  const tradesPerMonth = months > 0 ? total / months : total;

  // Total cost drag
  const totalCost = trades.reduce((s, t) => s + (t.cumulativeFundingCost || 0), 0);
  const totalPnl  = trades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const costDrag  = equity.capital > 0 ? totalCost / equity.capital : 0;

  // Ghost trade rate (exact touch fills — would be no-fill in reality)
  const exactTouchWins = trades.filter(t => t.fillQuality === 'EXACT_TOUCH' && t.realizedPnl > 0).length;
  const ghostTradeRate = wins > 0 ? exactTouchWins / wins : 0;

  // Toxic fill rate
  const toxicFills = trades.filter(t => t.fillQuality === 'TOXIC').length;
  const toxicFillRate = total > 0 ? toxicFills / total : 0;

  // Cumulative funding cost
  const cumulativeFundingCost = trades.reduce((s, t) => s + (t.cumulativeFundingCost || 0), 0);

  // Regime breakdown
  const regimeBreakdown = {};
  trades.forEach(t => {
    const r = t.regime || 'UNKNOWN';
    if (!regimeBreakdown[r]) regimeBreakdown[r] = { trades: 0, wins: 0, pnl: 0 };
    regimeBreakdown[r].trades++;
    if (t.realizedPnl > 0) regimeBreakdown[r].wins++;
    regimeBreakdown[r].pnl += t.realizedPnl || 0;
  });
  Object.keys(regimeBreakdown).forEach(r => {
    const rb = regimeBreakdown[r];
    rb.wr = wilsonCI(rb.wins, rb.trades);
    rb.pf = calcProfitFactor(trades.filter(t => t.regime === r));
  });

  // Year-by-year breakdown
  const yearlyBreakdown = {};
  trades.forEach(t => {
    const year = new Date(t.entryTimestamp).getFullYear().toString();
    if (!yearlyBreakdown[year]) yearlyBreakdown[year] = { trades: 0, wins: 0, pnl: 0 };
    yearlyBreakdown[year].trades++;
    if (t.realizedPnl > 0) yearlyBreakdown[year].wins++;
    yearlyBreakdown[year].pnl += t.realizedPnl || 0;
  });
  Object.keys(yearlyBreakdown).forEach(y => {
    const yb = yearlyBreakdown[y];
    yb.wr = wilsonCI(yb.wins, yb.trades);
    yb.pf = calcProfitFactor(trades.filter(t => new Date(t.entryTimestamp).getFullYear().toString() === y));
  });

  // Missed trades (cancelled limit orders)
  const missedTrades = trades.filter(t => t.status === 'MISSED').length;

  return {
    ...meta,
    generatedAt:    new Date().toISOString(),
    trades:         total,
    wins,
    losses,
    wr:             wilsonCI(wins, total),
    pf:             calcProfitFactor(trades),
    avgRR:          parseFloat(avgRR.toFixed(3)),
    maxDD:          parseFloat((equity.maxDrawdown * 100).toFixed(2)),
    finalCapital:   parseFloat(equity.capital.toFixed(2)),
    totalPnl:       parseFloat(totalPnl.toFixed(2)),
    sharpe:         parseFloat(calcSharpe(equity.curve).toFixed(3)),
    tradesPerMonth: parseFloat(tradesPerMonth.toFixed(1)),
    totalCostDrag:  parseFloat((costDrag * 100).toFixed(3)),
    ghostTradeRate: parseFloat((ghostTradeRate * 100).toFixed(1)),
    toxicFillRate:  parseFloat((toxicFillRate * 100).toFixed(1)),
    cumulativeFundingCost: parseFloat(cumulativeFundingCost.toFixed(2)),
    regimeBreakdown,
    yearlyBreakdown,
    missedTrades,
    equityCurve:    equity.curve,
  };
}

module.exports = { generateReport, wilsonCI, calcSharpe, calcProfitFactor };
