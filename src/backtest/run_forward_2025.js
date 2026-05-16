'use strict';

/**
 * Phase D13: 2025 Forward Test
 * LOCKED configuration — no parameter changes allowed.
 * This is the final exam. Data never seen during optimization.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createReadStream } = require('fs');

async function loadNDJSON(filePath) {
  const candles = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) candles.push(JSON.parse(line)); }
  return candles;
}

async function main() {
  const { atr } = require('../indicators/atr');
  const { rvol } = require('../indicators/rvol');
  const { cvd } = require('../indicators/cvd');
  const { rollingVolumeProfile } = require('../indicators/volumeProfile');
  const { createLSOStrategy } = require('./lso_runner');
  const { runBacktest } = require('./runner');
  const { DATA: { paths: dp }, LSO: LSO_CONFIG } = require('../../config');

  const SYMBOL = 'BTCUSDT';
  const TIMEFRAME = '15m';
  const candleFile = path.join(dp.historical, `${SYMBOL}_${TIMEFRAME}_2025_tagged.ndjson`);

  if (!fs.existsSync(candleFile)) {
    console.error('2025 tagged data not found. Run src/data/tag_2025.js first.');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('Phase D13 — 2025 FORWARD TEST (Final Exam)');
  console.log('LOCKED LETHAL Configuration — No Parameter Changes');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('Loading 2025 data...');
  const candles = await loadNDJSON(candleFile);
  console.log(`  Candles: ${candles.length}`);
  console.log(`  Range: ${new Date(candles[0].openTime).toISOString()} → ${new Date(candles[candles.length-1].openTime).toISOString()}`);

  // Regime distribution
  const regimeDist = {};
  for (const c of candles) regimeDist[c.regime] = (regimeDist[c.regime] || 0) + 1;
  console.log('  Regime:', Object.entries(regimeDist).map(([k,v]) => `${k}=${v}(${(v/candles.length*100).toFixed(0)}%)`).join(' '));

  // Compute indicators
  console.log('Computing indicators...');
  const atr14 = atr(candles, 14);
  const rvolVals = rvol(candles, '15m', 20);
  const cvdVals = cvd(candles);
  const volumeProfiles = rollingVolumeProfile(candles, '15m', 24, 50);

  // LOCKED configuration — exact same as Phase D9/D12
  const extra = {
    oiDataStore: new Map(),
    oiThresholdFn: r => LSO_CONFIG.oiFlushThreshold[r] || LSO_CONFIG.oiFlushThreshold.RANGING,
    cvdGateVariant: 'CVD_ZSCORE',
    obConfluenceEnabled: true,
    timeBreakeven: { enabled: true, checkFn: require('../strategies/lso').checkLSORangingTimeExhaustion },
    volumeProfiles,
    gateVP: true,
    gate4HTrend: true,
  };

  const gates = { regime: false, oi: false, killzone: false, macro: false };

  console.log('\n── Running backtest with LOCKED LETHAL config ──\n');
  const strategy = createLSOStrategy(extra);
  const report = runBacktest(strategy, {
    candles, atr14, rvolVals, cvdVals,
    fundingMap: new Map(), macroEvents: [], volumeProfiles,
    gates, initialCapital: 10000,
    symbol: SYMBOL, timeframe: TIMEFRAME, extra,
  });

  const wr = report.wr?.point;
  const pf = report.pf;
  const dd = report.maxDD;
  const trades = report.trades;

  // Wilson CI
  const wilsonCI = (wins, total) => {
    if (total === 0) return { lower: 0, point: 0, upper: 0 };
    const p = wins / total;
    const z = 1.96;
    const n = total;
    const center = p + z*z/(2*n);
    const margin = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n));
    const denom = 1 + z*z/n;
    return { lower: (center-margin)/denom, point: p, upper: (center+margin)/denom };
  };
  const wins = Math.round(wr * trades);
  const wci = wilsonCI(wins, trades);

  console.log('═══════════════════════════════════════════════════════');
  console.log('2025 FORWARD TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`  Trades:       ${trades}`);
  console.log(`  Win Rate:     ${(wr*100).toFixed(1)}%`);
  console.log(`  Wilson CI:    ${(wci.lower*100).toFixed(1)}% – ${(wci.upper*100).toFixed(1)}% (95% confidence${wci.lower>0.3?'':' ⚠ WIDE'})`);
  console.log(`  Profit Factor: ${pf?.toFixed(3)}`);
  console.log(`  Max DD:       ${dd?.toFixed(2)}%`);
  console.log(`  Final Capital: $${(report.finalCapital||0).toFixed(0)}`);

  // Regime breakdown
  console.log('\n  Regime Breakdown:');
  if (report.regimeBreakdown) {
    for (const [regime, rb] of Object.entries(report.regimeBreakdown)) {
      if (rb.trades > 0) {
        const rwr = (rb.wr?.point * 100).toFixed(1);
        console.log(`    ${regime.padEnd(18)} ${String(rb.trades).padStart(3)} trades  WR=${rwr}%  PF=${rb.pf?.toFixed(3)}`);
      }
    }
  }

  // Regime Drift: Compare 2025 vs 2024
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('REGIME DRIFT CHECK: 2025 vs 2024');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log(`  2024 Benchmark:  39 trades, WR=61.5%, PF=3.207, DD=2.19%`);
  console.log(`  2025 Forward:    ${trades} trades, WR=${(wr*100).toFixed(1)}%, PF=${pf?.toFixed(3)}, DD=${dd?.toFixed(2)}%`);

  const wrDelta = Math.abs((wr || 0) - 0.615) * 100;
  const pfDelta = Math.abs((pf || 0) - 3.207);
  const pfDegradation = pf > 0 ? (3.207 - pf) / 3.207 * 100 : 100;

  console.log('');
  console.log(`  WR delta:   ${wrDelta.toFixed(1)}pp ${wrDelta < 10 ? '(within 10pp — normal)' : '(⚠ significant deviation)'}`);
  console.log(`  PF delta:   ${pfDelta.toFixed(3)} (${pfDegradation.toFixed(0)}% degradation)`);

  // Forward Test Acceptance Criteria (from plan)
  const forwardPass = pf >= 1.3 && dd <= 0.20 && wr >= 0.30 && trades >= 30;
  const forwardMarginal = pf >= 1.0 && dd <= 0.25;

  console.log('');
  console.log('Acceptance Criteria:');
  console.log(`  PF > 1.3:        ${pf >= 1.3 ? '✓ PASS' : '✗ FAIL'} (${pf?.toFixed(3)})`);
  console.log(`  DD < 20%:        ${dd <= 0.20 ? '✓ PASS' : '✗ FAIL'} (${dd?.toFixed(2)}%)`);
  console.log(`  WR > 30%:        ${wr >= 0.30 ? '✓ PASS' : '✗ FAIL'} (${(wr*100).toFixed(1)}%)`);
  console.log(`  Trades ≥ 30:     ${trades >= 30 ? '✓ PASS' : '⚠ LOW'} (${trades})`);

  // Regime distribution comparison
  console.log('\n  Market Regime Comparison:');
  console.log('  2021-2024: BULL=45% BEAR=39% RANGING=11% CRISIS=2%');
  console.log('  2025:      ' + Object.entries(regimeDist).map(([k,v]) => `${k}=${(v/candles.length*100).toFixed(0)}%`).join(' '));
  console.log('  ⚠ 2025 is 58% RANGING — very different market structure');

  // Final verdict
  console.log('\n═══════════════════════════════════════════════════════');
  if (forwardPass) {
    console.log('FORWARD TEST VERDICT: PASS ✓');
    console.log('The strategy generalizes to unseen data.');
  } else if (forwardMarginal) {
    console.log('FORWARD TEST VERDICT: MARGINAL ⚠');
    console.log('Strategy survives but performance degraded. Review before live.');
  } else {
    console.log('FORWARD TEST VERDICT: FAIL ✗');
    console.log('Strategy does not generalize. Return to Phase D6 for revision.');
  }
  console.log('═══════════════════════════════════════════════════════');

  // Save
  const result = {
    phase: 'D13', date: new Date().toISOString(),
    symbol: SYMBOL, timeframe: TIMEFRAME,
    candles: candles.length, dateRange: { first: candles[0].openTime, last: candles[candles.length-1].openTime },
    regimeDistribution: regimeDist,
    results: { trades, wr, wci, pf, dd, finalCapital: report.finalCapital },
    regimeBreakdown: report.regimeBreakdown,
    comparison2024: { trades: 39, wr: 0.615, pf: 3.207, dd: 2.19 },
    wrDelta, pfDegradation,
    acceptance: { pfPass: pf >= 1.3, ddPass: dd <= 0.20, wrPass: wr >= 0.30, tradesPass: trades >= 30 },
    verdict: forwardPass ? 'PASS' : forwardMarginal ? 'MARGINAL' : 'FAIL',
  };

  if (!fs.existsSync(dp.results)) fs.mkdirSync(dp.results, { recursive: true });
  fs.writeFileSync(path.join(dp.results, 'forward_2025.json'), JSON.stringify(result, null, 2));
  console.log('\nSaved: results/forward_2025.json');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
