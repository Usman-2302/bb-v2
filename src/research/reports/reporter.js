'use strict';

/**
 * Report generation: console, JSON, CSV and Markdown.
 * The markdown report is the artefact a human reads to decide deployment.
 */

const fs = require('fs');
const path = require('path');

function f(v, d = 3) {
  if (v === Infinity) return 'Inf';
  if (!Number.isFinite(v)) return 'n/a';
  return v.toFixed(d);
}
function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

function summaryRow(label, s, width = 26) {
  return '  ' + pad(label, width) +
    lpad(s.trades, 6) +
    lpad(f(s.winRate, 1) + '%', 8) +
    lpad(f(s.avgR, 4), 10) +
    lpad(f(s.profitFactor, 2), 8) +
    lpad(f(s.tStat, 2), 8) +
    lpad(f(s.sharpe, 2), 8) +
    lpad(f(s.maxDDR, 1), 8) +
    lpad(f(s.mar, 2), 7);
}

function summaryHeader(width = 26) {
  return '  ' + pad('', width) + lpad('n', 6) + lpad('WR', 8) + lpad('avgR', 10) +
    lpad('PF', 8) + lpad('t', 8) + lpad('Sharpe', 8) + lpad('maxDD', 8) + lpad('MAR', 7);
}

function printEvaluation(ev) {
  console.log('\n' + '-'.repeat(100));
  console.log(ev.strategy + '  [' + ev.timeframe + ']  ' + ev.symbol);
  console.log('-'.repeat(100));
  console.log(summaryHeader());
  console.log(summaryRow('ALL', ev.all));
  for (const [k, s] of Object.entries(ev.bySplit)) console.log(summaryRow('  split:' + k, s));
  for (const fold of ev.walkForward.folds) {
    console.log(summaryRow('  wf:' + fold.from, fold.summary));
  }
  if (ev.bootstrap) {
    console.log('  bootstrap 95% CI on mean R : [' + f(ev.bootstrap.meanCI[0], 4) +
      ', ' + f(ev.bootstrap.meanCI[1], 4) + ']  P(mean>0)=' + f(ev.bootstrap.pPositive, 3));
  }
  if (ev.monteCarlo) {
    console.log('  monte carlo maxDD  P50=' + f(ev.monteCarlo.ddP50, 1) +
      'R  P95=' + f(ev.monteCarlo.ddP95, 1) + 'R  worst=' + f(ev.monteCarlo.ddMax, 1) + 'R');
  }
  console.log('  MFE/MAE median: ' + f(ev.all.medianMFE, 2) + ' / ' + f(ev.all.medianMAE, 2) +
    '   avg hold: ' + f(ev.all.avgHoldBars, 1) + ' bars   trades/yr: ' + f(ev.all.tradesPerYear, 0));
}

function writeCSV(outDir, name, rows) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map(c => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  const p = path.join(outDir, name);
  fs.writeFileSync(p, lines.join('\n'));
  return p;
}

function buildMarkdown({ results, verdicts, config, tBar, costDesc, accepted, generatedAt }) {
  const L = [];
  L.push('# BulletBrain Research Report');
  L.push('');
  L.push('**Generated:** ' + generatedAt);
  L.push('**Cost model:** ' + costDesc);
  L.push('**Multiple-testing bar:** |t| > ' + tBar.toFixed(2) +
    ' (Bonferroni, family alpha ' + config.acceptance.familyAlpha + ')');
  L.push('**Splits:** ' + Object.entries(config.splits)
    .map(([k, v]) => `${k} ${v[0]}..${v[1]}`).join(' | '));
  L.push('');

  L.push('## Verdict');
  L.push('');
  if (accepted.length) {
    L.push('**ACCEPTED:** ' + accepted.join(', '));
  } else {
    L.push('**No strategy met the acceptance criteria.** No deployment is recommended.');
  }
  L.push('');

  L.push('## Ranking (by out-of-sample expectancy, pooled across symbols)');
  L.push('');
  L.push('| strategy | tf | trades | WR | avgR | PF | t | Sharpe | maxDD(R) | verdict |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    L.push('| ' + [
      r.name, r.timeframe, r.pooled.trades,
      f(r.pooled.winRate, 1) + '%', f(r.pooled.avgR, 4), f(r.pooled.profitFactor, 2),
      f(r.pooled.tStat, 2), f(r.pooled.sharpe, 2), f(r.pooled.maxDDR, 1),
      verdicts[r.name].accepted ? 'ACCEPT' : 'reject',
    ].join(' | ') + ' |');
  }
  L.push('');

  L.push('## Rejected hypotheses and why');
  L.push('');
  for (const r of results) {
    const v = verdicts[r.name];
    if (v.accepted) continue;
    L.push('### ' + r.name + ' (' + r.timeframe + ')');
    L.push('');
    L.push('*' + r.rationale + '*');
    L.push('');
    for (const reason of v.reasons.slice(0, 8)) L.push('- ' + reason);
    L.push('');
  }

  L.push('## Per-strategy detail');
  L.push('');
  for (const r of results) {
    L.push('### ' + r.name + ' [' + r.timeframe + ']');
    L.push('');
    L.push('| symbol | window | n | WR | avgR | PF | t |');
    L.push('|---|---|---|---|---|---|---|');
    for (const [sym, ev] of Object.entries(r.perSymbol)) {
      L.push('| ' + [sym, 'ALL', ev.all.trades, f(ev.all.winRate, 1) + '%',
        f(ev.all.avgR, 4), f(ev.all.profitFactor, 2), f(ev.all.tStat, 2)].join(' | ') + ' |');
      for (const [w, s] of Object.entries(ev.bySplit)) {
        L.push('| ' + [sym, w, s.trades, f(s.winRate, 1) + '%',
          f(s.avgR, 4), f(s.profitFactor, 2), f(s.tStat, 2)].join(' | ') + ' |');
      }
    }
    L.push('');
  }
  return L.join('\n');
}

module.exports = { printEvaluation, summaryRow, summaryHeader, writeCSV, buildMarkdown, f };
