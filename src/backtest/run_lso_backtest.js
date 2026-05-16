'use strict';

/**
 * BulletBrain v3.0 — LSO Backtest Execution
 * Phase D8 — Steps 3.4 through 3.6
 *
 * Uses the unified runner with the LSO strategy descriptor from lso_runner.js.
 *
 * Usage: node src/backtest/run_lso_backtest.js
 */

const fs   = require('fs');
const path = require('path');
const { createReadStream } = require('fs');
const readline = require('readline');

const { checkLSOTimeBreakeven, checkVolumeProfileGate, check4HTrendBullish } = require('../strategies/lso');
const { cvd }  = require('../indicators/cvd');
const { atr }  = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { rollingVolumeProfile } = require('../indicators/volumeProfile');
const { createLSOStrategy, LSO_GATES } = require('./lso_runner');
const { runBacktest, runSensitivityTest, runRegimeSplit, runYearlyBreakdown } = require('./runner');
const { DATA, LSO: LSO_CONFIG } = require('../../config');

// ─────────────────────────────────────────────────────────────────────────────
// DATA LOADING
// ─────────────────────────────────────────────────────────────────────────────

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

async function loadFundingData(symbol) {
  const filePath = path.join(DATA.paths.funding, `${symbol}_8h.ndjson`);
  if (!fs.existsSync(filePath)) return new Map();
  const eightHours = 8 * 3600000;
  const innerMap = new Map();
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) {
      const r = JSON.parse(line);
      const rawTs = r.fundingTime || r.timestamp;
      const rate  = r.fundingRate || r.rate;
      if (rawTs !== undefined && rate !== undefined) {
        innerMap.set(Math.floor(rawTs / eightHours) * eightHours, rate);
      }
    }
  }
  const outerMap = new Map();
  outerMap.set(symbol, innerMap);
  return outerMap;
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
  console.log(`  Saved: ${path.basename(filePath)}`);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT PRINTER
// ─────────────────────────────────────────────────────────────────────────────

function printReport(label, report) {
  const wr = report.wr ? (report.wr.point * 100).toFixed(1) : 'N/A';
  const pf = report.pf ? report.pf.toFixed(3) : 'N/A';
  const dd = report.maxDD != null ? report.maxDD.toFixed(2) : 'N/A';  // maxDD already in % from reporter
  console.log(`  ${label}: trades=${report.trades}, WR=${wr}%, PF=${pf}, DD=${dd}%`);
  if (report.sweepsDetected !== undefined) {
    console.log(`    Sweeps: ${report.sweepsDetected}, OI filtered: ${report.oiFiltered}, CVD filtered: ${report.cvdFiltered}, DOL not found: ${report.dolNotFound}`);
  }
  if (report.obConfluenceHits !== undefined && report.obConfluenceHits > 0) {
    console.log(`    OB confluence hits: ${report.obConfluenceHits}, Time breakeven exits: ${report.timeBreakevenExits || 0}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const SYMBOL    = 'BTCUSDT';
  const TIMEFRAME = '15m';

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('BulletBrain v3.0 — Phase D8: LSO Backtest');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('Loading data...');

  const candleFile = path.join(DATA.paths.historical, `${SYMBOL}_${TIMEFRAME}_tagged.ndjson`);
  if (!fs.existsSync(candleFile)) {
    console.error(`ERROR: Tagged candle file not found: ${candleFile}`);
    process.exit(1);
  }

  const candles = await loadNDJSON(candleFile);
  console.log(`  Loaded ${candles.length} candles`);

  const atr14    = atr(candles, 14);
  const rvolVals = rvol(candles, '15m', 20);
  const cvdVals  = cvd(candles);

  // Phase D9: Pre-compute rolling 24H volume profiles for Gate VP
  console.log('  Computing volume profiles (24H rolling)...');
  const volumeProfiles = rollingVolumeProfile(candles, '15m', 24, 50);
  console.log(`  Volume profiles: ${volumeProfiles.length}`);

  // Phase D9: Compute volume SMA20 for tiered CVD gate
  const volSMA20 = new Array(candles.length).fill(0);
  for (let vi = 0; vi < candles.length; vi++) {
    const start = Math.max(0, vi - 19);
    let sum = 0;
    for (let j = start; j <= vi; j++) sum += candles[j].volume;
    volSMA20[vi] = sum / (vi - start + 1);
  }
  console.log(`  Volume SMA20: ${volSMA20.length} values`);

  const oiDataStore = await loadOIData(SYMBOL);
  const hasOI = oiDataStore.has(SYMBOL) && oiDataStore.get(SYMBOL).length > 0;
  console.log(`  OI data: ${hasOI ? oiDataStore.get(SYMBOL).length + ' records' : 'NOT FOUND'}`);

  const fundingMap = await loadFundingData(SYMBOL);
  const hasFunding = fundingMap.has(SYMBOL) && fundingMap.get(SYMBOL).size > 0;
  console.log(`  Funding data: ${hasFunding ? fundingMap.get(SYMBOL).size + ' records' : 'NOT FOUND'}`);

  const macroEvents = loadMacroEvents();
  console.log(`  Macro events: ${macroEvents.length} events`);

  const oiThresholdFn = (regime) =>
    LSO_CONFIG.oiFlushThreshold[regime] || LSO_CONFIG.oiFlushThreshold.RANGING;

  const baseOptions = {
    candles, atr14, rvolVals, cvdVals, fundingMap, macroEvents, volumeProfiles,
    initialCapital: 10000, symbol: SYMBOL, timeframe: TIMEFRAME,
  };

  // ── Step 3.4: Baseline (CVD_ZSCORE gate, no OI filter) ─────────────────
  console.log('\n── Step 3.4: Baseline (sweep + CVD_ZSCORE only) ──');
  const baselineExtra = { oiDataStore, oiThresholdFn, cvdGateVariant: 'CVD_ZSCORE', obConfluenceEnabled: true,
    timeBreakeven: { enabled: false }, volumeProfiles, volSMA20,
    gateVP: true, gate4HTrend: true };
  const baselineStrategy = createLSOStrategy(baselineExtra);
  const baselineReport = runBacktest(baselineStrategy, { ...baseOptions, gates: LSO_GATES.NO_OI, extra: baselineExtra });
  saveResult('lso_no_oi.json', baselineReport);
  printReport('NO_OI (CVD_ZSCORE gate)', baselineReport);

  // ── Step 3.4b: Baseline with plain CVD for comparison ───────────────────
  console.log('\n── Step 3.4b: Baseline comparison (plain CVD gate) ──');
  const cvdExtra = { ...baselineExtra, cvdGateVariant: 'CVD' };
  const cvdStrategy = createLSOStrategy(cvdExtra);
  const baselineCVDReport = runBacktest(cvdStrategy, { ...baseOptions, gates: LSO_GATES.NO_OI, extra: cvdExtra });
  saveResult('lso_no_oi_cvd.json', baselineCVDReport);
  printReport('NO_OI (CVD gate)', baselineCVDReport);

  if (baselineReport.wr && baselineCVDReport.wr) {
    const delta = ((baselineReport.wr.point - baselineCVDReport.wr.point) * 100).toFixed(1);
    console.log(`  CVD_ZSCORE vs CVD: WR delta=${delta}pp, trades: ${baselineReport.trades} vs ${baselineCVDReport.trades}`);
  }

  // ── Step 3.5: OI filter ─────────────────────────────────────────────────
  if (hasOI) {
    console.log('\n── Step 3.5: Add OI filter ──');
    const oiExtra = { ...baselineExtra, cvdGateVariant: 'OI_VELOCITY' };
    const oiStrategy = createLSOStrategy(oiExtra);
    const oiReport = runBacktest(oiStrategy, { ...baseOptions, gates: LSO_GATES.WITH_OI, extra: oiExtra });
    saveResult('lso_with_oi.json', oiReport);
    printReport('WITH_OI', oiReport);
  } else {
    console.log('\n── Step 3.5: SKIPPED (no OI data) ──');
  }

  // ── Step 3.6: Full gates ────────────────────────────────────────────────
  console.log('\n── Step 3.6: Full gates (regime + killzone + macro) ──');
  const fullExtra = { ...baselineExtra, cvdGateVariant: 'OI_VELOCITY',
    timeBreakeven: { enabled: true, checkFn: checkLSOTimeBreakeven } };
  const fullStrategy = createLSOStrategy(fullExtra);
  const fullReport = runBacktest(fullStrategy, { ...baseOptions, gates: LSO_GATES.FULL, extra: fullExtra });
  saveResult('lso_full_gates.json', fullReport);
  printReport('FULL', fullReport);

  // ── D7 Deferred Item 3: Time breakeven gate comparison ──────────────────
  console.log('\n── D7 Deferred Item 3: Time breakeven gate comparison ──');
  const noTbExtra = { ...fullExtra, timeBreakeven: { enabled: false } };
  const noTbStrategy = createLSOStrategy(noTbExtra);
  const noBreakevenReport = runBacktest(noTbStrategy, { ...baseOptions, gates: LSO_GATES.FULL, extra: noTbExtra });
  printReport('FULL (no breakeven gate)', noBreakevenReport);
  console.log(`  With breakeven:    PF=${fullReport.pf?.toFixed(3)}, WR=${(fullReport.wr?.point*100).toFixed(1)}%`);
  console.log(`  Without breakeven: PF=${noBreakevenReport.pf?.toFixed(3)}, WR=${(noBreakevenReport.wr?.point*100).toFixed(1)}%`);
  const breakevenDecision = (fullReport.pf || 0) > (noBreakevenReport.pf || 0) ? 'KEEP' : 'REVERT';
  console.log(`  Decision: ${breakevenDecision} breakeven gate`);

  // ── Step 3.7: Sensitivity test ──────────────────────────────────────────
  console.log('\n── Step 3.7: Parameter sensitivity test ──');
  const sensStrategy = createLSOStrategy(fullExtra);
  const sensitivityResults = runSensitivityTest(sensStrategy, { ...baseOptions, gates: LSO_GATES.FULL, extra: fullExtra });
  for (const [param, data] of Object.entries(sensitivityResults)) {
    console.log(`  ${param}: ${data.fragile ? 'FRAGILE' : 'ROBUST'} — WR range ${data.wrRange}pp`);
    data.forEach(r => console.log(`    ${param}=${r.value ?? r.label}: WR=${(r.wr*100).toFixed(1)}%, PF=${r.pf?.toFixed(3)}, trades=${r.trades}`));
    if (data.note) console.log(`    NOTE: ${data.note}`);
  }
  saveResult('lso_sensitivity.json', sensitivityResults);

  console.log('\n── Slippage Stress Test ──');
  console.log('  Run separately: node src/backtest/run_lso_slippage_stress.js');

  // ── Step 3.8: Regime-split analysis ─────────────────────────────────────
  console.log('\n── Step 3.8: Regime-split analysis ──');
  const splitExtra = { ...fullExtra, obConfluenceEnabled: false, timeBreakeven: { enabled: false } };
  const splitStrategy = createLSOStrategy(splitExtra);
  const regimeSplitResults = runRegimeSplit(splitStrategy, { ...baseOptions, extra: splitExtra });
  for (const [regime, data] of Object.entries(regimeSplitResults)) {
    if (data.status === 'INSUFFICIENT_DATA') {
      console.log(`  ${regime}: INSUFFICIENT_DATA (${data.candles ?? data.trades ?? 0} ${data.candles !== undefined ? 'candles' : 'trades'})`);
    } else {
      console.log(`  ${regime}: ${data.status} — trades=${data.trades}, WR=${(data.wr?.point*100).toFixed(1)}%, PF=${data.pf?.toFixed(3)}`);
    }
  }
  saveResult('lso_regime_split.json', regimeSplitResults);

  // ── Step 3.9: Year-by-year breakdown ────────────────────────────────────
  console.log('\n── Step 3.9: Year-by-year breakdown ──');
  const yearStrategy = createLSOStrategy(fullExtra);
  const yearlyResults = runYearlyBreakdown(yearStrategy, { ...baseOptions, extra: fullExtra });
  for (const [year, r] of Object.entries(yearlyResults)) {
    console.log(`  ${year}: trades=${r.trades}, WR=${(r.wr?.point*100).toFixed(1)}%, PF=${r.pf?.toFixed(3)}`);
  }
  saveResult('lso_yearly.json', yearlyResults);

  // ── Accept/Reject Decision ──────────────────────────────────────────────
  console.log('\n── Accept/Reject Decision ──');
  const pf = fullReport.pf || 0, dd = fullReport.maxDD || 1, wr = fullReport.wr?.point || 0;
  const years = Object.values(yearlyResults).filter(y => y.pf >= 1.2).length;
  const pfPass = pf > 1.5, ddPass = dd < 0.08, wrPass = wr > 0.42;
  const yrPass = years >= 3, sensPass = Object.values(sensitivityResults).every(p => !p.fragile);

  console.log(`  PF > 1.5:          ${pfPass ? 'PASS' : 'FAIL'} (${pf.toFixed(3)})`);
  console.log(`  DD < 8%:           ${ddPass ? 'PASS' : 'FAIL'} (${(dd*100).toFixed(2)}%)`);
  console.log(`  WR > 42%:          ${wrPass ? 'PASS' : 'FAIL'} (${(wr*100).toFixed(1)}%)`);
  console.log(`  Years >= 3 PASS:   ${yrPass ? 'PASS' : 'FAIL'} (${years}/4)`);
  console.log(`  Sensitivity PASS:  ${sensPass ? 'PASS' : 'FAIL'}`);

  const verdict = (pfPass && ddPass && wrPass && yrPass && sensPass) ? 'ACCEPT' : 'REJECT';
  console.log(`\n  VERDICT: ${verdict}`);

  saveResult('lso_decision.json', {
    verdict, symbol: SYMBOL, timeframe: TIMEFRAME,
    fullGates: { trades: fullReport.trades, wr: fullReport.wr, pf: fullReport.pf, maxDD: fullReport.maxDD },
    criteria: { pfPass, ddPass, wrPass, yrPass, sensPass },
    yearlyResults, sensitivityResults, regimeSplitResults,
    d7DeferredItems: { obConfluenceEnabled: true, timeBreakevenGate: breakevenDecision },
    timestamp: new Date().toISOString(),
  });

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`Phase D8 complete. Verdict: ${verdict}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
