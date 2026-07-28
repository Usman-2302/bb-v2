'use strict';

/**
 * Batch research runner.
 *
 * Evaluates every registered strategy across every configured symbol, applies
 * the acceptance gate with multiple-testing correction, and emits console, JSON,
 * CSV and Markdown reports.
 *
 * USAGE
 *   node src/research/run_research.js                       # everything
 *   node src/research/run_research.js --strategy lowvol_trend_4h
 *   node src/research/run_research.js --scenario harsh      # cost sensitivity
 *   node src/research/run_research.js --quiet                # summary only
 */

const fs = require('fs');
const path = require('path');

const cfg = require('../../config.research');
const { loadBase, resample } = require('./core/candles');
const features = require('./core/features');
const { CostModel } = require('./core/costs');
const { evaluate, acceptanceVerdict } = require('./core/validation');
const { bonferroniThreshold } = require('./core/stats');
const { summarise } = require('./core/metrics');
const registry = require('./strategies/registry');
const reporter = require('./reports/reporter');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ONLY = arg('strategy', null);
const SCENARIO = arg('scenario', 'measured');
const QUIET = process.argv.includes('--quiet');

function main() {
  const strategies = ONLY ? [registry.get(ONLY)] : registry.STRATEGIES;
  const scenarioOverrides = cfg.costScenarios[SCENARIO];
  if (!scenarioOverrides) throw new Error('unknown cost scenario: ' + SCENARIO);
  const cost = new CostModel({ ...cfg.costs, ...scenarioOverrides });

  // One test per (strategy, symbol) — the family over which we correct.
  const nTests = strategies.length * cfg.symbols.length;
  const tBar = bonferroniThreshold(nTests, cfg.acceptance.familyAlpha);

  console.log('='.repeat(100));
  console.log('BULLETBRAIN RESEARCH PIPELINE');
  console.log('='.repeat(100));
  console.log('strategies   : ' + strategies.length + '  (' + strategies.map(s => s.name).join(', ') + ')');
  console.log('symbols      : ' + cfg.symbols.join(', '));
  console.log('cost scenario: ' + SCENARIO + ' — ' + cost.describe());
  console.log('splits       : ' + Object.entries(cfg.splits).map(([k, v]) => k + ' ' + v[0] + '..' + v[1]).join(' | '));
  console.log('family       : ' + nTests + ' tests -> Bonferroni |t| bar = ' + tBar.toFixed(2));
  console.log('sizing       : ' + (cfg.sizing.riskPct * 100) + '% risk/trade, fee-inclusive');

  // Cache resampled candles + features per (symbol, timeframe).
  const cache = new Map();
  function contextFor(symbol, tf) {
    const key = symbol + '|' + tf;
    if (cache.has(key)) return cache.get(key);
    const base = loadBase(symbol);
    const candles = resample(base, tf);
    const ctx = features.build(candles);
    ctx.symbol = symbol;
    ctx.timeframe = tf;
    cache.set(key, ctx);
    return ctx;
  }

  const opts = {
    costModel: cost,
    equity: cfg.sizing.equity,
    riskPct: cfg.sizing.riskPct,
    warmup: cfg.engine.warmup,
    minEdgeMult: cfg.engine.minEdgeMult,
  };

  const results = [];
  const verdicts = {};
  const tradeRows = [];

  for (const strat of strategies) {
    const perSymbol = {};
    const pooledTrades = [];
    for (const sym of cfg.symbols) {
      const ctx = contextFor(sym, strat.timeframe);
      const ev = evaluate(strat, ctx, opts, cfg.splits);
      perSymbol[sym] = ev;
      if (!QUIET) reporter.printEvaluation(ev);
      // collect trades for pooling + CSV
      const { runBacktest } = require('./core/engine');
      const raw = runBacktest(strat, ctx, opts);
      pooledTrades.push(...raw.trades);
      for (const t of raw.trades) {
        tradeRows.push({
          strategy: strat.name, symbol: sym, timeframe: strat.timeframe,
          dir: t.dir, reason: t.reason,
          entryTime: new Date(t.entryTime).toISOString(),
          exitTime: new Date(t.exitTime).toISOString(),
          holdBars: t.holdBars,
          rMultiple: Number.isFinite(t.rMultiple) ? t.rMultiple.toFixed(6) : '',
          mfeR: Number.isFinite(t.mfeR) ? t.mfeR.toFixed(4) : '',
          maeR: Number.isFinite(t.maeR) ? t.maeR.toFixed(4) : '',
          pnl: t.pnl.toFixed(4), fees: t.fees.toFixed(4),
          session: t.session, regime: t.regime,
        });
      }
    }
    const pooled = summarise(pooledTrades);
    const verdict = acceptanceVerdict(perSymbol, {
      tBar, minTrades: cfg.acceptance.minTrades,
    });
    verdicts[strat.name] = verdict;
    results.push({
      name: strat.name, timeframe: strat.timeframe, rationale: strat.rationale,
      perSymbol, pooled,
    });
  }

  results.sort((a, b) => (b.pooled.avgR || -Infinity) - (a.pooled.avgR || -Infinity));

  // ── summary ──
  console.log('\n' + '='.repeat(100));
  console.log('RANKING — pooled across symbols, sorted by expectancy (R/trade)');
  console.log('='.repeat(100));
  console.log(reporter.summaryHeader(28));
  for (const r of results) {
    console.log(reporter.summaryRow(r.name + ' [' + r.timeframe + ']', r.pooled, 28) +
      '  ' + (verdicts[r.name].accepted ? 'ACCEPT' : 'reject'));
  }

  const accepted = results.filter(r => verdicts[r.name].accepted).map(r => r.name);

  console.log('\n' + '='.repeat(100));
  console.log('ACCEPTANCE');
  console.log('='.repeat(100));
  if (accepted.length) {
    console.log('  ACCEPTED: ' + accepted.join(', '));
  } else {
    console.log('  NONE ACCEPTED.');
    console.log('  Primary rejection reasons per strategy:');
    for (const r of results) {
      const rs = verdicts[r.name].reasons;
      console.log('    ' + reporter.f(0, 0).slice(0, 0) + r.name.padEnd(26) + (rs[0] || 'n/a'));
    }
  }

  // ── outputs ──
  const outDir = path.join(process.cwd(), cfg.reporting.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = 'scenario-' + SCENARIO;

  if (cfg.reporting.writeJSON) {
    fs.writeFileSync(path.join(outDir, `research_${stamp}.json`),
      JSON.stringify({ config: cfg, scenario: SCENARIO, tBar, nTests, results, verdicts }, null, 2));
  }
  if (cfg.reporting.writeCSV) {
    reporter.writeCSV(outDir, `trades_${stamp}.csv`, tradeRows);
    reporter.writeCSV(outDir, `summary_${stamp}.csv`, results.map(r => ({
      strategy: r.name, timeframe: r.timeframe,
      trades: r.pooled.trades, winRate: r.pooled.winRate,
      avgR: r.pooled.avgR, profitFactor: r.pooled.profitFactor,
      tStat: r.pooled.tStat, sharpe: r.pooled.sharpe, sortino: r.pooled.sortino,
      maxDDR: r.pooled.maxDDR, mar: r.pooled.mar,
      accepted: verdicts[r.name].accepted,
      firstReason: verdicts[r.name].reasons[0] || '',
    })));
  }
  if (cfg.reporting.writeMarkdown) {
    fs.writeFileSync(path.join(outDir, `REPORT_${stamp}.md`),
      reporter.buildMarkdown({
        results, verdicts, config: cfg, tBar,
        costDesc: cost.describe(), accepted,
        generatedAt: new Date().toISOString(),
      }));
  }
  console.log('\nreports written to ' + path.relative(process.cwd(), outDir) + '/');
}

main();
