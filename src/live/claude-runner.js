'use strict';
require('dotenv').config();

/**
 * BulletBrain v3.0 — claude-runner (RESEARCH RUNNER)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS IS NOT PRODUCTION. IT PLACES NO ORDERS. IT HOLDS NO API KEYS.
 *  There is no code path from this file to a signed Binance request. That is a
 *  deliberate structural guarantee, not a configuration choice — the exchange
 *  client is simply not imported.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURPOSE
 * Rapidly test, compare and validate completely different trading hypotheses
 * against the same market stream, using the SAME engine, cost model and metrics
 * as the offline research pipeline. A strategy that looks good here produces
 * identical numbers in `run_research.js`, because both call `core/engine.js`.
 * That equivalence is the whole point: the deprecated system's downfall was a
 * paper mode that could not lose money to fees (AUDIT.md §4 #9).
 *
 * MODES
 *   --auto                AUTONOMOUS: continuous research cycles, for a VPS
 *   --once                a single full research cycle, then exit
 *   --replay              run the registry over stored history (fast, default)
 *   --live                stream live Binance candles and evaluate in real time
 *   --strategy <name>     restrict to one strategy
 *   --symbol <SYM>        default ETHUSDT
 *   --scenario <name>     cost scenario from config.research.js
 *   --interval <minutes>  --auto cycle period (default 60)
 *   --compare             rank strategies side by side (replay only)
 *
 * ARCHITECTURE — every layer is independently replaceable:
 *   signal -> context -> confirmation -> risk -> entry -> exit -> management -> evaluation
 * Layers live in src/research/core/*; strategies in src/research/strategies/registry.js.
 * Adding a hypothesis means adding one object to the registry — no engine edits.
 */

const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const cfg = require('../../config.research');
const { loadBase, resample, TF_MS } = require('../research/core/candles');
const features = require('../research/core/features');
const { CostModel } = require('../research/core/costs');
const { runBacktest } = require('../research/core/engine');
const { summarise } = require('../research/core/metrics');
const registry = require('../research/strategies/registry');
const reporter = require('../research/reports/reporter');

// ── args ────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : def;
}
const LIVE = process.argv.includes('--live');
const COMPARE = process.argv.includes('--compare') || !process.argv.includes('--strategy');
const SYMBOL = (arg('symbol', 'ETHUSDT')).toUpperCase();
const ONLY = arg('strategy', null);
const SCENARIO = arg('scenario', 'measured');

const cost = new CostModel({ ...cfg.costs, ...(cfg.costScenarios[SCENARIO] || {}) });
const OPTS = {
  costModel: cost,
  equity: cfg.sizing.equity,
  riskPct: cfg.sizing.riskPct,
  warmup: cfg.engine.warmup,
  minEdgeMult: cfg.engine.minEdgeMult,
};

const LOG_DIR = path.join(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'claude-runner.jsonl');

/** Institutional-grade structured logging: one JSON object per event. */
function logEvent(type, payload) {
  const rec = { ts: new Date().toISOString(), type, ...payload };
  fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  return rec;
}

function banner() {
  console.log('═'.repeat(94));
  console.log('  BulletBrain — claude-runner (RESEARCH ONLY — NO ORDERS, NO KEYS)');
  console.log('═'.repeat(94));
  console.log('  mode      : ' + (LIVE ? 'LIVE STREAM (evaluation only)' : 'REPLAY'));
  console.log('  symbol    : ' + SYMBOL);
  console.log('  strategies: ' + (ONLY || registry.list().join(', ')));
  console.log('  costs     : ' + cost.describe());
  console.log('  sizing    : ' + (cfg.sizing.riskPct * 100) + '% risk/trade, fee-inclusive');
  console.log('  log       : ' + path.relative(process.cwd(), LOG_FILE));
  console.log('═'.repeat(94));
}

// ── replay mode ─────────────────────────────────────────────────────────────
function replay() {
  const strategies = ONLY ? [registry.get(ONLY)] : registry.STRATEGIES;
  const base = loadBase(SYMBOL);
  const ctxCache = new Map();
  const ctxFor = tf => {
    if (!ctxCache.has(tf)) {
      const c = resample(base, tf);
      const ctx = features.build(c);
      ctx.symbol = SYMBOL;
      ctx.timeframe = tf;
      ctxCache.set(tf, ctx);
    }
    return ctxCache.get(tf);
  };

  console.log('\n' + reporter.summaryHeader(30));
  const rows = [];
  for (const s of strategies) {
    const ctx = ctxFor(s.timeframe);
    const res = runBacktest(s, ctx, OPTS);
    const sum = summarise(res.trades);
    rows.push({ s, sum, res });
    console.log(reporter.summaryRow(s.name + ' [' + s.timeframe + ']', sum, 30));
    logEvent('replay_result', {
      strategy: s.name, timeframe: s.timeframe, symbol: SYMBOL,
      trades: sum.trades, avgR: sum.avgR, pf: sum.profitFactor,
      tStat: sum.tStat, sharpe: sum.sharpe, maxDDR: sum.maxDDR,
      rejects: res.rejects, signalsRaw: res.signalsRaw,
    });
  }

  if (COMPARE) {
    rows.sort((a, b) => (b.sum.avgR || -Infinity) - (a.sum.avgR || -Infinity));
    console.log('\nRANKED BY EXPECTANCY');
    for (const r of rows) {
      const verdict = !(r.sum.avgR > 0) ? 'negative expectancy'
        : Math.abs(r.sum.tStat) < 2 ? 'positive but NOT significant'
        : 'positive and significant (verify vs beta)';
      console.log('  ' + (r.s.name + ' [' + r.s.timeframe + ']').padEnd(32) +
        reporter.f(r.sum.avgR, 4).padStart(9) + 'R  t=' +
        reporter.f(r.sum.tStat, 2).padStart(6) + '   ' + verdict);
    }
    console.log('\n  Rejection breakdown (why signals did not become trades):');
    for (const r of rows) {
      const rj = Object.entries(r.res.rejects);
      if (!rj.length) continue;
      console.log('    ' + r.s.name.padEnd(30) +
        rj.map(([k, v]) => k + '=' + v).join('  '));
    }
  }
  console.log('\nFull statistical validation: node src/research/run_research.js');
}

// ── live mode ───────────────────────────────────────────────────────────────
/**
 * Streams closed candles and re-evaluates each strategy on its own timeframe.
 * Emits signals and their disposition, but never sends an order.
 */
async function live() {
  const strategies = ONLY ? [registry.get(ONLY)] : registry.STRATEGIES;
  const timeframes = [...new Set(strategies.map(s => s.timeframe))];
  console.log('\nBackfilling base 15m candles for: ' + timeframes.join(', '));

  const base = [];
  const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol: SYMBOL, interval: '15m', limit: 1500 }, timeout: 20000,
  });
  for (const k of resp.data) {
    if (k[6] > Date.now()) continue;
    base.push({ openTime: k[0], closeTime: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
  }
  console.log('  backfilled ' + base.length + ' base candles');

  const lastSignalBar = new Map();

  function evaluateAll(reason) {
    for (const tf of timeframes) {
      const c = resample(base, tf);
      if (c.length < 260) continue;
      const ctx = features.build(c);
      ctx.symbol = SYMBOL; ctx.timeframe = tf;
      const i = c.length - 1;
      for (const s of strategies.filter(x => x.timeframe === tf)) {
        let sig = null;
        try { sig = s.signal(ctx, i); } catch (e) {
          logEvent('signal_error', { strategy: s.name, error: e.message });
          continue;
        }
        if (!sig || !sig.dir) continue;
        const key = s.name + '|' + c[i].openTime;
        if (lastSignalBar.get(s.name) === c[i].openTime) continue;
        lastSignalBar.set(s.name, c[i].openTime);

        const confirmed = s.confirm ? s.confirm(ctx, i, sig) : true;
        const entryRef = ctx.close[i];
        const stop = s.stop(ctx, i, sig, entryRef);
        const target = s.target ? s.target(ctx, i, sig, entryRef, stop) : null;
        const stopDist = Math.abs(entryRef - stop);
        const riskDollars = cfg.sizing.equity * cfg.sizing.riskPct;
        const qty = stopDist > 0 ? riskDollars / (stopDist + entryRef * cost.roundTripLoss()) : 0;
        const targetMovePct = target ? Math.abs(target - entryRef) / entryRef : null;
        const clearsCost = targetMovePct === null ? null
          : targetMovePct > cost.roundTripWin();

        const rec = logEvent('signal', {
          strategy: s.name, timeframe: tf, symbol: SYMBOL,
          bar: new Date(c[i].openTime).toISOString(),
          dir: sig.dir > 0 ? 'LONG' : 'SHORT',
          confirmed,
          entryRef, stop, target,
          stopDistPct: entryRef > 0 ? stopDist / entryRef : null,
          targetMovePct, clearsCostFloor: clearsCost,
          qty, riskDollars,
          notional: qty * entryRef,
          regime: ctx.trend[i], session: ctx.session[i],
          atrPct: ctx.atrPct[i], volZ: ctx.volZ[i],
          reason,
        });
        console.log('[SIGNAL] ' + rec.bar + '  ' + s.name.padEnd(26) +
          (sig.dir > 0 ? 'LONG ' : 'SHORT') +
          '  entry~' + entryRef.toFixed(2) +
          '  stop=' + (Number.isFinite(stop) ? stop.toFixed(2) : 'n/a') +
          '  target=' + (target ? target.toFixed(2) : 'trail') +
          (confirmed ? '' : '  [REJECTED: confirm]') +
          (clearsCost === false ? '  [BELOW COST FLOOR]' : ''));
      }
    }
  }

  evaluateAll('backfill');

  const wsUrl = 'wss://fstream.binance.com/ws/' + SYMBOL.toLowerCase() + '@kline_15m';
  let lastProcessed = base.length ? base[base.length - 1].openTime : 0;
  let chain = Promise.resolve();

  function connect() {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => console.log('[WS] connected ' + wsUrl));
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.e !== 'kline' || !msg.k.x) return;
      const k = msg.k;
      if (k.t <= lastProcessed) return;
      lastProcessed = k.t;
      // serialise, for the same reason liveRunner does: two feeds, one state
      chain = chain.then(() => {
        base.push({ openTime: k.t, closeTime: k.T, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
        if (base.length > 20000) base.shift();
        console.log('[CANDLE] ' + new Date(k.t).toISOString().slice(5, 16) +
          ' close=' + (+k.c).toFixed(2));
        evaluateAll('live');
      }).catch(e => logEvent('eval_error', { error: e.message }));
    });
    ws.on('close', () => { console.log('[WS] disconnected — retrying in 10s'); setTimeout(connect, 10000); });
    ws.on('error', e => console.error('[WS] error:', e.message || e));
  }
  connect();
  console.log('\nStreaming. Signals are logged and printed; NO orders are ever sent.\n');
}

// ── autonomous mode ─────────────────────────────────────────────────────────
/**
 * Continuous research. Each cycle: refresh data, run the battery, validate,
 * rank, report, archive, journal. Errors in a cycle are logged and the loop
 * continues — an unattended daemon that exits on the first transient failure is
 * worse than useless.
 */
async function auto() {
  const { runCycle } = require('../research/orchestrator');
  const intervalMin = parseInt(arg('interval', '60'), 10);
  const once = process.argv.includes('--once');
  const statePath = path.join(LOG_DIR, 'claude-runner-state.json');
  let cycle = 1;
  try {
    if (fs.existsSync(statePath)) cycle = (JSON.parse(fs.readFileSync(statePath, 'utf8')).lastCycle || 0) + 1;
  } catch { /* fresh start */ }

  const shutdown = { requested: false };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[${sig}] finishing current cycle then exiting…`);
      shutdown.requested = true;
      if (once) process.exit(0);
    });
  }

  for (;;) {
    const t0 = Date.now();
    try {
      const board = await runCycle({ cycle, scenario: SCENARIO, updateData: true });
      logEvent('cycle_complete', {
        cycle, scenario: SCENARIO,
        top: board.slice(0, 3).map(r => ({ name: r.name, status: r.status, score: r.score, avgR: r.avgR })),
        promoted: board.filter(r => r.status === 'PAPER_TRADING' || r.status === 'PRODUCTION_CANDIDATE').map(r => r.name),
      });
    } catch (e) {
      console.error('[CYCLE ERROR]', e.message);
      logEvent('cycle_error', { cycle, error: e.message, stack: (e.stack || '').split('\n').slice(0, 4) });
    }
    fs.writeFileSync(statePath, JSON.stringify({ lastCycle: cycle, lastRun: new Date().toISOString() }, null, 2));
    cycle++;
    if (once || shutdown.requested) break;

    const waitMs = Math.max(60000, intervalMin * 60000 - (Date.now() - t0));
    console.log(`\nnext cycle in ${(waitMs / 60000).toFixed(1)} min (Ctrl-C to stop)\n`);
    await new Promise(r => setTimeout(r, waitMs));
    if (shutdown.requested) break;
  }
  console.log('autonomous research stopped.');
}

banner();
if (process.argv.includes('--auto') || process.argv.includes('--once')) {
  auto().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
} else if (LIVE) {
  live().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
} else {
  replay();
}
