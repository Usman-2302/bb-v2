'use strict';

/**
 * Scalp research runner — the run_research.js battery on a 1m base store.
 *
 * USAGE
 *   node src/research/run_scalps.js                        # all scalp strategies, full battery
 *   node src/research/run_scalps.js --strategy scalp_pb_3m
 *   node src/research/run_scalps.js --scenario harsh       # cost sensitivity
 *   node src/research/run_scalps.js --grid                 # exit-geometry explorer (in-sample!)
 *
 * Identical gates to the main pipeline: next-bar-open fills, stop-first
 * intrabar rule, taker+slip on stops, Bonferroni over the scalp family,
 * walk-forward + block bootstrap + Monte Carlo via validation.evaluate.
 * Requires data/historical/{SYMBOL}_1m.ndjson (see results/live_logs/download_1m.js).
 */

const fs = require('fs');
const path = require('path');

const cfg = require('../../config.research');
const { loadBase, resample } = require('./core/candles');
const features = require('./core/features');
const { CostModel } = require('./core/costs');
const { runBacktest } = require('./core/engine');
const { evaluate, acceptanceVerdict } = require('./core/validation');
const { bonferroniThreshold } = require('./core/stats');
const { summarise } = require('./core/metrics');
const scalps = require('./strategies/scalps');
const reporter = require('./reports/reporter');

const BASE_TF = '1m';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ONLY = arg('strategy', null);
const SCENARIO = arg('scenario', 'measured');
const GRID = process.argv.includes('--grid');
const MAKER = process.argv.includes('--maker');   // limit entries (maker fee, 1bp penetration rule)
const QUIET = process.argv.includes('--quiet');

/** Clone a strategy with limit (maker) entries. */
const asMaker = s => ({ ...s, name: s.name + '_lim', entryMode: 'limit' });

const cost = new CostModel({ ...cfg.costs, ...(cfg.costScenarios[SCENARIO] || {}) });
const opts = {
  costModel: cost,
  equity: cfg.sizing.equity,
  riskPct: cfg.sizing.riskPct,
  warmup: cfg.engine.warmup,
  // scalp-specific: refuse targets that cannot clear one round-trip cost.
  // At 3m this is THE binding constraint — see flooredSwingStop in scalps.js.
  minEdgeMult: 1,
};

const cache = new Map();
function contextFor(symbol, tf) {
  const key = symbol + '|' + tf;
  if (cache.has(key)) return cache.get(key);
  const base = loadBase(symbol, undefined, BASE_TF);
  const candles = resample(base, tf, BASE_TF);
  const ctx = features.build(candles);
  ctx.symbol = symbol;
  ctx.timeframe = tf;
  cache.set(key, ctx);
  return ctx;
}

// ── exit-geometry explorer ──────────────────────────────────────────────────
function grid() {
  const base0 = scalps.get('scalp_pb_3m');
  const base = MAKER ? asMaker(base0) : base0;
  const slK = [1.5, 2];
  const rMults = [1.5, 2, 2.5, 3];
  console.log('EXIT GEOMETRY GRID — ' + base.name + ' (IN-SAMPLE exploration, ETHUSDT only)');
  console.log('costs: ' + cost.describe());
  console.log('');
  console.log('variant'.padEnd(34) + 'n'.padStart(6) + 'WR'.padStart(7) + 'avgR'.padStart(9) +
    'PF'.padStart(7) + 't'.padStart(7) + 'avgHold(m)'.padStart(11) + 'netPnL'.padStart(10));
  for (const k of slK) {
    for (const r of rMults) {
      const s = scalps.withExits(base, { slAtrK: k, rMult: r });
      const ctx = contextFor('ETHUSDT', s.timeframe);
      const res = runBacktest(s, ctx, opts);
      const sum = summarise(res.trades);
      const holdM = res.trades.length
        ? res.trades.reduce((a, t) => a + t.holdBars, 0) / res.trades.length * 3 : 0;
      const pnl = res.trades.reduce((a, t) => a + t.pnl, 0);
      console.log((s.name.replace('scalp_pb_3m__', '')).padEnd(34) +
        String(sum.trades).padStart(6) +
        ((sum.winRate * 100).toFixed(0) + '%').padStart(7) +
        reporter.f(sum.avgR, 3).padStart(9) +
        reporter.f(sum.profitFactor, 2).padStart(7) +
        reporter.f(sum.tStat, 2).padStart(7) +
        holdM.toFixed(0).padStart(11) +
        ('$' + pnl.toFixed(0)).padStart(10));
    }
  }
  console.log('\nReminder: picking the best cell IS in-sample selection. The winner');
  console.log('must still survive the full battery (--strategy) before it means anything.');
}

// ── full battery ────────────────────────────────────────────────────────────
function battery() {
  let strategies = ONLY ? [scalps.get(ONLY)] : scalps.STRATEGIES;
  if (MAKER) strategies = strategies.map(asMaker);
  const nTests = strategies.length * cfg.symbols.length;
  const tBar = bonferroniThreshold(nTests, cfg.acceptance.familyAlpha);

  console.log('='.repeat(100));
  console.log('SCALP RESEARCH BATTERY (1m base store)');
  console.log('='.repeat(100));
  console.log('strategies   : ' + strategies.map(s => s.name).join(', '));
  console.log('symbols      : ' + cfg.symbols.join(', '));
  console.log('cost scenario: ' + SCENARIO + ' — ' + cost.describe());
  console.log('family       : ' + nTests + ' tests -> Bonferroni |t| bar = ' + tBar.toFixed(2));

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
    verdicts[strat.name] = acceptanceVerdict(perSymbol, {
      tBar, minTrades: cfg.acceptance.minTrades,
    });
    results.push({ name: strat.name, timeframe: strat.timeframe, rationale: strat.rationale, perSymbol, pooled });
  }

  results.sort((a, b) => (b.pooled.avgR || -Infinity) - (a.pooled.avgR || -Infinity));

  console.log('\n' + '='.repeat(100));
  console.log('RANKING — pooled across symbols, sorted by expectancy (R/trade)');
  console.log('='.repeat(100));
  console.log(reporter.summaryHeader(28));
  for (const r of results) {
    console.log(reporter.summaryRow(r.name + ' [' + r.timeframe + ']', r.pooled, 28) +
      '  ' + (verdicts[r.name].accepted ? 'ACCEPT' : 'reject'));
  }
  console.log('\nACCEPTANCE: ' +
    (results.filter(r => verdicts[r.name].accepted).map(r => r.name).join(', ') || 'NONE'));
  for (const r of results) {
    console.log('  ' + r.name.padEnd(26) + (verdicts[r.name].reasons[0] || 'n/a'));
  }

  const outDir = path.join(process.cwd(), cfg.reporting.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = 'scalp_' + (MAKER ? 'maker_' : '') + 'scenario-' + SCENARIO;
  if (cfg.reporting.writeJSON) {
    fs.writeFileSync(path.join(outDir, `${stamp}.json`),
      JSON.stringify({ config: cfg, scenario: SCENARIO, tBar, nTests, results, verdicts }, null, 2));
  }
  if (cfg.reporting.writeCSV) {
    reporter.writeCSV(outDir, `trades_${stamp}.csv`, tradeRows);
  }
  console.log('\nreports written to ' + path.relative(process.cwd(), outDir) + '/' + stamp + '.*');
}

if (GRID) grid(); else battery();
