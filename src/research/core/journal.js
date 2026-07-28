'use strict';

/**
 * Research journal — institutional memory.
 *
 * The purpose is to stop the platform (and its operators) re-testing ideas that
 * have already failed, and to make edge decay visible across cycles. Every
 * entry answers: what was tested, what improved, what failed, why, what next.
 *
 * Written as append-only Markdown so it is readable without tooling.
 */

const fs = require('fs');
const path = require('path');
const { decayTrend } = require('./experiments');

const JOURNAL = () => path.join(process.cwd(), 'results', 'research', 'RESEARCH-JOURNAL.md');

function f(v, d = 4) { return Number.isFinite(v) ? v.toFixed(d) : 'n/a'; }

/**
 * @param {object} ctx
 *   cycle, scenario, datasetVersion, leaderboard, previousLeaderboard, experimentId
 */
function append(ctx) {
  const { cycle, scenario, datasetVersion, leaderboard, previousLeaderboard = [], experimentId } = ctx;
  const prev = new Map(previousLeaderboard.map(r => [r.name, r]));
  const L = [];

  L.push('');
  L.push('---');
  L.push('');
  L.push(`## Cycle ${cycle} — ${new Date().toISOString()}`);
  L.push('');
  L.push(`- experiment: \`${experimentId}\``);
  L.push(`- cost scenario: ${scenario}`);
  L.push(`- dataset: \`${datasetVersion.hash}\` (` +
    datasetVersion.symbols.map(s => `${s.symbol} ${s.candles} to ${s.to}`).join(', ') + ')');
  L.push('');

  L.push('### What was tested');
  L.push('');
  L.push(`${leaderboard.length} strategies across ${new Set(leaderboard.map(r => r.timeframe)).size} timeframes.`);
  L.push('');

  // improvements / regressions vs previous cycle
  const improved = [], regressed = [], statusChanged = [];
  for (const r of leaderboard) {
    const p = prev.get(r.name);
    if (!p) continue;
    const d = r.avgR - p.avgR;
    if (Number.isFinite(d)) {
      if (d > 0.01) improved.push(`${r.name}: ${f(p.avgR)}R → ${f(r.avgR)}R`);
      if (d < -0.01) regressed.push(`${r.name}: ${f(p.avgR)}R → ${f(r.avgR)}R`);
    }
    if (p.status !== r.status) statusChanged.push(`${r.name}: ${p.status} → ${r.status}`);
  }

  L.push('### What improved');
  L.push('');
  L.push(improved.length ? improved.map(s => '- ' + s).join('\n') : '- nothing materially');
  L.push('');
  L.push('### What regressed');
  L.push('');
  L.push(regressed.length ? regressed.map(s => '- ' + s).join('\n') : '- nothing materially');
  L.push('');
  if (statusChanged.length) {
    L.push('### Status changes');
    L.push('');
    L.push(statusChanged.map(s => '- ' + s).join('\n'));
    L.push('');
  }

  L.push('### What failed, and why');
  L.push('');
  const failing = leaderboard.filter(r => r.status === 'REJECTED' || r.status === 'RESEARCH');
  if (!failing.length) L.push('- nothing failed this cycle');
  for (const r of failing.slice(0, 12)) {
    L.push(`- **${r.name}** (${r.status}) — ${r.failedGates[0] || r.explanation}`);
  }
  L.push('');

  // edge decay across the archive
  L.push('### Edge decay watch');
  L.push('');
  let anyDecay = false;
  for (const r of leaderboard.slice(0, 8)) {
    const t = decayTrend(r.name, 'avgR');
    if (t.n >= 3) {
      anyDecay = true;
      L.push(`- ${r.name}: ${t.verdict} (${f(t.first)}R → ${f(t.last)}R over ${t.n} cycles)`);
    }
  }
  if (!anyDecay) L.push('- insufficient cycle history for trend detection (need >= 3 cycles)');
  L.push('');

  L.push('### What should be tested next');
  L.push('');
  for (const s of nextExperiments(leaderboard)) L.push('- ' + s);
  L.push('');

  fs.mkdirSync(path.dirname(JOURNAL()), { recursive: true });
  if (!fs.existsSync(JOURNAL())) {
    fs.writeFileSync(JOURNAL(),
      '# BulletBrain Research Journal\n\n' +
      'Append-only record of every research cycle. Written automatically by the\n' +
      'orchestrator so failed ideas are never silently re-tested.\n');
  }
  fs.appendFileSync(JOURNAL(), L.join('\n'));
  return JOURNAL();
}

/**
 * Derive the research queue from what the evidence actually says, rather than
 * from a fixed list. Each suggestion names the observation that motivates it.
 */
function nextExperiments(leaderboard) {
  const q = [];
  const betaBlocked = leaderboard.filter(r => /LONG-ONLY|SHORT-ONLY/.test(r.betaVerdict || ''));
  if (betaBlocked.length) {
    q.push(`Regress ${betaBlocked.map(r => r.name).join(', ')} against buy-and-hold and test residual alpha — ` +
      `they show positive expectancy but only on one side, which is beta, not skill.`);
  }
  const underSampled = leaderboard.filter(r => r.trades > 0 && r.trades < 50);
  if (underSampled.length) {
    q.push(`Extend the symbol universe: ${underSampled.map(r => r.name).join(', ')} have <50 trades, ` +
      `so no amount of statistics can separate them from noise.`);
  }
  const nearMiss = leaderboard.filter(r => r.avgR > 0 && Math.abs(r.tStat) > 1 && Math.abs(r.tStat) < 3);
  if (nearMiss.length) {
    q.push(`Run parameter-stability sweeps on ${nearMiss.map(r => r.name).join(', ')} — ` +
      `positive but not significant; stability would distinguish a weak real effect from noise.`);
  }
  const stronglyNegative = leaderboard.filter(r => r.avgR < 0 && r.tStat < -3);
  if (stronglyNegative.length) {
    q.push(`Test the INVERSE of ${stronglyNegative.map(r => r.name).join(', ')} — ` +
      `significantly negative expectancy is exploitable information if it survives costs in reverse.`);
  }
  q.push('Add non-OHLCV features (funding rate, liquidations, order-book imbalance) — ' +
    'the OHLCV hypothesis space is close to exhausted at these timeframes.');
  q.push('Expand to a 20+ symbol universe to enable cross-sectional (market-neutral) strategies, ' +
    'which structurally remove the beta contamination blocking current candidates.');
  return q;
}

module.exports = { append, nextExperiments, JOURNAL };
