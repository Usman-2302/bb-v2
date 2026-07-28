'use strict';

/**
 * Research Orchestrator — one autonomous cycle, end to end.
 *
 *   data update -> features -> strategy battery -> validation -> analytics
 *   -> sensitivity -> ranking -> reports -> archive -> journal
 *
 * Designed for unattended VPS operation: every step is wrapped so a single
 * failing strategy or a transient network error degrades the cycle rather than
 * killing the process. A research daemon that dies at 3am has no value.
 *
 * It NEVER places orders. There is no exchange client in this dependency graph.
 */

const fs = require('fs');
const path = require('path');

const cfg = require('../../config.research');
const dataset = require('./core/dataset');
const { loadBase, resample } = require('./core/candles');
const features = require('./core/features');
const { CostModel } = require('./core/costs');
const { runBacktest } = require('./core/engine');
const { summarise } = require('./core/metrics');
const { evaluate } = require('./core/validation');
const { bonferroniThreshold } = require('./core/stats');
const analytics = require('./core/analytics');
const sensitivity = require('./core/sensitivity');
const ranking = require('./core/ranking');
const experiments = require('./core/experiments');
const journal = require('./core/journal');
const registry = require('./strategies/registry');
const reporter = require('./reports/reporter');

const OUT = () => path.join(process.cwd(), cfg.reporting.outDir);

function log(...a) { console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a); }

/** Run one complete research cycle. Returns the leaderboard. */
async function runCycle({ cycle = 1, scenario = 'measured', updateData = true, quiet = false } = {}) {
  const started = Date.now();
  log(`cycle ${cycle} starting (scenario=${scenario})`);

  // ── 1. data layer ──
  if (updateData) {
    try {
      const upd = await dataset.updateAll(cfg.symbols);
      for (const u of upd) {
        log(`  data ${u.symbol}: ` + (u.error ? 'ERROR ' + u.error : (u.changed ? 'updated' : 'already current')));
      }
    } catch (e) {
      log('  data update failed (continuing with cached data): ' + e.message);
    }
  }
  const inv = dataset.inventory(cfg.symbols);
  for (const i of inv) {
    if (!i.present) { log(`  MISSING dataset: ${i.symbol}`); continue; }
    log(`  ${i.symbol}: ${i.candles} candles to ${i.to} ` +
      `(complete ${(i.completeness * 100).toFixed(2)}%, stale ${i.staleHours.toFixed(1)}h)`);
  }
  const dsVersion = dataset.datasetVersion(cfg.symbols);

  // ── 2. setup ──
  const costOverride = cfg.costScenarios[scenario] || {};
  const cost = new CostModel({ ...cfg.costs, ...costOverride });
  const opts = {
    costModel: cost,
    equity: cfg.sizing.equity,
    riskPct: cfg.sizing.riskPct,
    warmup: cfg.engine.warmup,
    minEdgeMult: cfg.engine.minEdgeMult,
  };
  const strategies = registry.STRATEGIES;
  const nTests = strategies.length * cfg.symbols.length;
  const tBar = bonferroniThreshold(nTests, cfg.acceptance.familyAlpha);
  log(`  ${strategies.length} strategies x ${cfg.symbols.length} symbols = ${nTests} tests, |t| bar ${tBar.toFixed(2)}`);

  // ── 3. context cache ──
  const baseCache = new Map();
  const ctxCache = new Map();
  const baseFor = sym => {
    if (!baseCache.has(sym)) baseCache.set(sym, loadBase(sym));
    return baseCache.get(sym);
  };
  const ctxFor = (sym, tf) => {
    const k = sym + '|' + tf;
    if (!ctxCache.has(k)) {
      const c = resample(baseFor(sym), tf);
      const ctx = features.build(c);
      ctx.symbol = sym; ctx.timeframe = tf;
      ctxCache.set(k, ctx);
    }
    return ctxCache.get(k);
  };

  // ── 4. battery + validation + analytics ──
  const evaluations = [];
  for (const strat of strategies) {
    try {
      const pooledTrades = [];
      const perSymbol = {};
      let wfPos = 0, wfTot = 0, bootWorst = null, symPositive = 0;

      for (const sym of cfg.symbols) {
        const ctx = ctxFor(sym, strat.timeframe);
        const ev = evaluate(strat, ctx, opts, cfg.splits);
        perSymbol[sym] = ev;
        const raw = runBacktest(strat, ctx, opts);
        pooledTrades.push(...raw.trades);
        if (ev.all.avgR > 0) symPositive++;
        for (const f of ev.walkForward.folds) {
          if (f.summary.trades >= 5) { wfTot++; if (f.summary.avgR > 0) wfPos++; }
        }
        if (ev.bootstrap) {
          const lo = ev.bootstrap.meanCI[0];
          bootWorst = bootWorst === null ? lo : Math.min(bootWorst, lo);
        }
      }

      const pooled = summarise(pooledTrades);
      const anal = analytics.analyse(pooledTrades);

      // cost resilience on the primary symbol only — full matrix is expensive
      let costRes = null;
      try {
        const ctx0 = ctxFor(cfg.symbols[0], strat.timeframe);
        costRes = sensitivity.costResilience(strat, ctx0, opts, cfg.costScenarios, CostModel, cfg.costs);
      } catch (e) { /* non-fatal */ }

      evaluations.push({
        name: strat.name,
        timeframe: strat.timeframe,
        rationale: strat.rationale,
        pooled, perSymbol, analytics: anal,
        wfPositiveShare: wfTot ? wfPos / wfTot : 0,
        bootstrapWorst: bootWorst,
        perSymbolPositive: symPositive,
        perSymbolCount: cfg.symbols.length,
        costResilience: costRes,
      });
      if (!quiet) {
        log(`  ${strat.name.padEnd(28)} n=${String(pooled.trades).padStart(5)} ` +
          `avgR=${reporter.f(pooled.avgR, 4).padStart(8)} t=${reporter.f(pooled.tStat, 2).padStart(6)} ` +
          `| ${anal.beta.verdict}`);
      }
    } catch (e) {
      log(`  ${strat.name}: FAILED — ${e.message}`);
    }
  }

  // ── 5. ranking ──
  const board = ranking.leaderboard(evaluations, { tBar, minTrades: cfg.acceptance.minTrades });

  // ── 6. archive ──
  const prev = experiments.latest(1)[0];
  const expId = experiments.record({
    cycle, scenario,
    datasetVersion: dsVersion,
    config: { splits: cfg.splits, costs: { ...cfg.costs, ...costOverride }, sizing: cfg.sizing },
    tBar, nTests,
    strategies: board.map(r => ({
      name: r.name, status: r.status, score: r.score,
      avgR: r.avgR, profitFactor: r.profitFactor, tStat: r.tStat, trades: r.trades,
    })),
    leaderboard: board,
  });

  // ── 7. reports ──
  writeReports({ board, evaluations, scenario, cost, tBar, dsVersion, expId, cycle });

  // ── 8. journal ──
  journal.append({
    cycle, scenario, datasetVersion: dsVersion,
    leaderboard: board,
    previousLeaderboard: prev ? prev.leaderboard : [],
    experimentId: expId,
  });

  log(`cycle ${cycle} complete in ${((Date.now() - started) / 1000).toFixed(1)}s — experiment ${expId}`);
  const promoted = board.filter(r => r.status === 'PRODUCTION_CANDIDATE' || r.status === 'PAPER_TRADING');
  log(promoted.length
    ? `  PROMOTED: ${promoted.map(r => r.name + '=' + r.status).join(', ')}`
    : '  no strategy promoted beyond CANDIDATE');
  return board;
}

function writeReports({ board, evaluations, scenario, cost, tBar, dsVersion, expId, cycle }) {
  const outDir = OUT();
  fs.mkdirSync(outDir, { recursive: true });

  // permanent leaderboard (overwritten — always the current truth)
  const lb = [];
  lb.push('# Strategy Leaderboard');
  lb.push('');
  lb.push(`_Updated ${new Date().toISOString()} — experiment \`${expId}\`, dataset \`${dsVersion.hash}\`, scenario ${scenario}_`);
  lb.push('');
  lb.push('| Rank | Strategy | TF | Score | Status | PF | Expectancy | Sharpe | Robustness | Confidence |');
  lb.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of board) {
    lb.push(`| ${r.rank} | ${r.name} | ${r.timeframe} | ${r.score} | **${r.status}** | ` +
      `${reporter.f(r.profitFactor, 2)} | ${reporter.f(r.avgR, 4)}R | ${reporter.f(r.sharpe, 2)} | ` +
      `${reporter.f(r.robustness * 100, 0)}% | ${r.confidence} |`);
  }
  lb.push('');
  lb.push('## Why each strategy has its status');
  lb.push('');
  for (const r of board) {
    lb.push(`### ${r.name} — ${r.status}`);
    lb.push('');
    lb.push(r.explanation);
    lb.push('');
    lb.push(`Beta check: ${r.betaVerdict}`);
    if (r.failedGates.length) {
      lb.push('');
      lb.push('Failed gates:');
      for (const g of r.failedGates) lb.push('- ' + g);
    }
    lb.push('');
  }
  fs.writeFileSync(path.join(outDir, 'LEADERBOARD.md'), lb.join('\n'));

  // cycle report
  const R = [];
  R.push(`# Research Cycle ${cycle} — ${new Date().toISOString().slice(0, 10)}`);
  R.push('');
  R.push('## Executive Summary');
  R.push('');
  const best = board[0];
  const accepted = board.filter(r => ['PRODUCTION_CANDIDATE', 'PAPER_TRADING', 'CANDIDATE'].includes(r.status));
  R.push(`- ${board.length} strategies evaluated, ${accepted.length} passed all hard gates.`);
  R.push(`- Best ranked: **${best.name}** (${best.status}, score ${best.score}, ${reporter.f(best.avgR, 4)}R, t=${reporter.f(best.tStat, 2)}).`);
  R.push(`- Cost model: ${cost.describe()}`);
  R.push(`- Multiple-testing bar: |t| > ${tBar.toFixed(2)}`);
  R.push(`- Dataset: \`${dsVersion.hash}\``);
  R.push('');
  if (!accepted.length) {
    R.push('**No strategy is deployable.** No promotion is recommended.');
    R.push('');
  }

  R.push('## Best strategies');
  R.push('');
  R.push('| Strategy | TF | n | WR | Expectancy | PF | Sharpe | t | maxDD(R) |');
  R.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of board.slice(0, 5)) {
    const wr = evaluations.find(e => e.name === r.name)?.pooled.winRate;
    R.push(`| ${r.name} | ${r.timeframe} | ${r.trades} | ${reporter.f(wr, 1)}% | ` +
      `${reporter.f(r.avgR, 4)}R | ${reporter.f(r.profitFactor, 2)} | ${reporter.f(r.sharpe, 2)} | ` +
      `${reporter.f(r.tStat, 2)} | ${reporter.f(r.maxDDR, 1)} |`);
  }
  R.push('');
  R.push('## Worst strategies');
  R.push('');
  for (const r of board.slice(-3).reverse()) {
    R.push(`- **${r.name}** (${r.timeframe}): ${reporter.f(r.avgR, 4)}R, t=${reporter.f(r.tStat, 2)} — ${r.failedGates[0] || r.explanation}`);
  }
  R.push('');

  R.push('## Edge analysis');
  R.push('');
  for (const e of evaluations.slice(0, 8)) {
    const b = e.analytics.beta, c = e.analytics.concentration;
    R.push(`### ${e.name}`);
    R.push('');
    R.push(`- direction: LONG ${b.longN} @ ${reporter.f(b.longAvgR, 4)}R, SHORT ${b.shortN} @ ${reporter.f(b.shortAvgR, 4)}R → _${b.verdict}_`);
    R.push(`- edge concentration: ${c.verdict} (top decile holds ${reporter.f(c.topDecileShare * 100, 0)}% of total R)`);
    R.push(`- excursions: median MFE ${reporter.f(e.analytics.excursion.medianMFE, 2)}R, MAE ${reporter.f(e.analytics.excursion.medianMAE, 2)}R`);
    if (e.costResilience) R.push(`- cost resilience: ${e.costResilience.verdict} (degradation ${reporter.f(e.costResilience.degradation, 4)}R)`);
    R.push('');
  }

  R.push('## Failure reasons');
  R.push('');
  for (const r of board.filter(x => x.failedGates.length)) {
    R.push(`- **${r.name}**: ` + r.failedGates.join('; '));
  }
  R.push('');
  R.push('## Recommended next experiments');
  R.push('');
  for (const s of journal.nextExperiments(board)) R.push('- ' + s);
  R.push('');

  fs.writeFileSync(path.join(outDir, `CYCLE_${String(cycle).padStart(4, '0')}.md`), R.join('\n'));
  fs.writeFileSync(path.join(outDir, 'latest_leaderboard.json'),
    JSON.stringify({ experimentId: expId, cycle, scenario, dsVersion, tBar, board }, null, 2));
}

module.exports = { runCycle };
