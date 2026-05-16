'use strict';

/**
 * BulletBrain v3.0 — LSO Slippage Stress Test
 * Gemini D8 Watch-out 2
 *
 * Tests whether the LSO edge (PF ~3.0 at baseline) survives real-world
 * execution latency. A "Level Reclaim" entry at pool.level can be missed
 * by 5-10bps in fast markets when price gaps through the level.
 *
 * Method: increase signal_delay_cost for 15m to simulate late fills.
 * The signal_delay_cost is applied as an entry cost deduction, reducing
 * effective P&L on every trade. This is the correct way to model latency —
 * it reduces the net P&L without changing fill probability.
 *
 * Thresholds:
 *   PF >= 1.5 at 5bps  → PASS (edge is robust)
 *   PF >= 1.3 at 5bps  → WARN (edge survives but is thin)
 *   PF < 1.3 at 5bps   → FAIL (do not go live)
 *
 * Usage: node src/backtest/run_lso_slippage_stress.js
 */

const fs   = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const readline = require('readline');

const { runLSOBacktest, LSO_GATES } = require('./lso_runner');
const { cvd }  = require('../indicators/cvd');
const { atr }  = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { DATA, COSTS } = require('../../config');

async function loadNDJSON(filePath) {
  const candles = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) candles.push(JSON.parse(line));
  }
  return candles;
}

async function loadOIData(symbol) {
  const filePath = path.join(DATA.paths.oi, `${symbol}_1h.ndjson`);
  if (!fs.existsSync(filePath)) return new Map();
  const entries = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) {
      const r = JSON.parse(line);
      const ts = r.openTime || r.timestamp;
      const oi = r.oi || r.openInterest || r.sumOpenInterest;
      if (ts !== undefined && oi !== undefined) entries.push({ timestamp: ts, oi });
    }
  }
  const store = new Map();
  store.set(symbol, entries);
  return store;
}

function loadMacroEvents() {
  const filePath = path.join(DATA.paths.historical, '..', 'macro_events.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveResult(filename, data) {
  const dir = DATA.paths.results;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let filePath = path.join(dir, filename);
  if (fs.existsSync(filePath)) {
    let v = 2;
    const base = filename.replace('.json', '');
    while (fs.existsSync(path.join(dir, `${base}_v${v}.json`))) v++;
    filePath = path.join(dir, `${base}_v${v}.json`);
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  Saved: ${filePath}`);
}

async function main() {
  const SYMBOL = 'BTCUSDT';
  const TIMEFRAME = '15m';

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('BulletBrain v3.0 — LSO Slippage Stress Test');
  console.log('Gemini D8 Watch-out 2: Does PF survive real-world latency?');
  console.log('═══════════════════════════════════════════════════════\n');

  const candles = await loadNDJSON(path.join(DATA.paths.historical, `${SYMBOL}_${TIMEFRAME}_tagged.ndjson`));
  const atr14    = atr(candles, 14);
  const rvolVals = rvol(candles, '15m', 20);
  const cvdVals  = cvd(candles);
  const oiDataStore = await loadOIData(SYMBOL);
  const macroEvents = loadMacroEvents();

  const baseOptions = {
    candles, atr14, rvolVals, cvdVals,
    oiDataStore,
    fundingMap: new Map(),
    macroEvents,
    initialCapital: 10000,
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    cvdGateVariant: 'CVD',
    obConfluenceEnabled: true,
    timeBreakevenEnabled: true,
    gates: LSO_GATES.NO_OI,
  };

  // Baseline signal_delay_cost for 15m
  const baseDelayCost = COSTS.signal_delay_cost['15m']; // 0.0003

  const results = [];

  // Test: 0bps, 5bps, 10bps additional latency cost
  // Each bps = 0.0001 additional cost per trade (applied as entry cost deduction)
  for (const { label, extraCost } of [
    { label: '0bps (baseline)',  extraCost: 0 },
    { label: '5bps late fill',   extraCost: 0.0005 },
    { label: '10bps late fill',  extraCost: 0.0010 },
  ]) {
    // Override signal_delay_cost for this run
    COSTS.signal_delay_cost['15m'] = baseDelayCost + extraCost;

    const report = runLSOBacktest({ ...baseOptions });

    // Restore
    COSTS.signal_delay_cost['15m'] = baseDelayCost;

    const pf     = report.pf || 0;
    const wr     = report.wr?.point || 0;
    const verdict = pf >= 1.5 ? 'PASS' : pf >= 1.3 ? 'WARN' : 'FAIL';

    results.push({ label, extraCost, trades: report.trades, wr, pf, maxDD: report.maxDD, verdict });
    console.log(`  ${label}: trades=${report.trades}, WR=${(wr*100).toFixed(1)}%, PF=${pf.toFixed(3)}, DD=${(report.maxDD*100).toFixed(2)}% [${verdict}]`);
  }

  // Summary
  const pfBaseline = results[0]?.pf || 0;
  const pfAt5bps   = results[1]?.pf || 0;
  const pfAt10bps  = results[2]?.pf || 0;

  console.log('\n── Summary ──');
  if (pfBaseline > 0) {
    console.log(`  PF degradation 0→5bps:  ${((pfBaseline - pfAt5bps) / pfBaseline * 100).toFixed(1)}%`);
    console.log(`  PF degradation 0→10bps: ${((pfBaseline - pfAt10bps) / pfBaseline * 100).toFixed(1)}%`);
  }

  const finalVerdict = pfAt5bps >= 1.5 ? 'ROBUST — safe for live trading' :
                       pfAt5bps >= 1.3 ? 'MARGINAL — monitor slippage closely in live' :
                       'FRAGILE — do not go live until slippage is reduced';
  console.log(`  Verdict: ${finalVerdict}`);

  saveResult('lso_slippage_stress.json', {
    results,
    baselinePF: pfBaseline,
    pfAt5bps,
    pfAt10bps,
    verdict: finalVerdict,
    timestamp: new Date().toISOString(),
  });

  console.log('\n═══════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
