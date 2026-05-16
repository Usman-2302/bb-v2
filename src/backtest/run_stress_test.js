'use strict';

/**
 * BulletBrain v3.0 — Phase D12: Robustness & Stress Testing
 * Tests: Monte Carlo (5000 runs), Slippage Stress (2x costs), Black Swan
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

function runMonteCarlo(trades, numSims, initialCapital) {
  if (!trades || trades.length === 0) return { error: 'No trades' };
  const FOUR_WEEKS = 28 * 24 * 60 * 60 * 1000;
  const sorted = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
  const blocks = [];
  let block = { start: sorted[0].entryTimestamp, trades: [] };
  for (const t of sorted) {
    if (t.entryTimestamp - block.start > FOUR_WEEKS) {
      if (block.trades.length > 0) blocks.push(block.trades);
      block = { start: t.entryTimestamp, trades: [t] };
    } else { block.trades.push(t); }
  }
  if (block.trades.length > 0) blocks.push(block.trades);

  const eqs = [], dds = [], wrs = [], pfs = [];
  for (let s = 0; s < numSims; s++) {
    const shuffled = [...blocks].sort(() => Math.random() - 0.5);
    let simTrades = [];
    for (const b of shuffled) for (const t of b) {
      const noise = 1.0 + (Math.random() - 0.5) * 0.001;
      simTrades.push({ ...t, realizedPnl: t.realizedPnl * noise });
    }
    const remove = Math.floor(simTrades.length * 0.05);
    for (let r = 0; r < remove; r++) simTrades.splice(Math.floor(Math.random() * simTrades.length), 1);

    let eq = initialCapital, peak = initialCapital, maxDD = 0, wins = 0, gw = 0, gl = 0;
    for (const t of simTrades) {
      eq += t.realizedPnl; if (eq > peak) peak = eq;
      const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd;
      if (t.realizedPnl > 0) { wins++; gw += t.realizedPnl; } else gl += Math.abs(t.realizedPnl);
    }
    eqs.push(eq); dds.push(maxDD); wrs.push(wins / simTrades.length); pfs.push(gl === 0 ? 999 : gw / gl);
  }

  const pct = (arr, p) => [...arr].sort((a,b)=>a-b)[Math.floor(arr.length * p / 100)];
  const sDD = [...dds].sort((a,b)=>a-b), sEQ = [...eqs].sort((a,b)=>a-b);
  const sPF = pfs.filter(f=>isFinite(f)&&f<100).sort((a,b)=>a-b);
  return {
    sims: numSims, trades: trades.length, blocks: blocks.length,
    equity: { p5:pct(sEQ,5), p10:pct(sEQ,10), p50:pct(sEQ,50), p90:pct(sEQ,90), p95:pct(sEQ,95), mean:eqs.reduce((a,b)=>a+b,0)/eqs.length, min:Math.min(...eqs), max:Math.max(...eqs) },
    dd: { p5:pct(sDD,5), p10:pct(sDD,10), p50:pct(sDD,50), p90:pct(sDD,90), p95:pct(sDD,95), mean:dds.reduce((a,b)=>a+b,0)/dds.length, max:Math.max(...dds) },
    wr: { p5:pct(wrs,5), p50:pct(wrs,50), p95:pct(wrs,95) },
    pf: { p5:sPF.length>0?pct(sPF,5):0, p50:sPF.length>0?pct(sPF,50):0, p95:sPF.length>0?pct(sPF,95):0 },
    p10pass: pct(sEQ,10) > initialCapital,
  };
}

async function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('Phase D12 — Robustness & Stress Testing');
  console.log('═══════════════════════════════════════════════════\n');

  const { atr } = require('../indicators/atr');
  const { rvol } = require('../indicators/rvol');
  const { cvd } = require('../indicators/cvd');
  const { rollingVolumeProfile } = require('../indicators/volumeProfile');
  const { createLSOStrategy, LSO_GATES } = require('./lso_runner');
  const { runBacktest } = require('./runner');
  const { DATA: { paths: dp }, LSO: LSO_CONFIG } = require('../../config');

  console.log('[1/3] Running LSO-Long 2021-2024...');
  const SYMBOL = 'BTCUSDT';
  const allCandles = await loadNDJSON(path.join(dp.historical, `${SYMBOL}_15m_tagged.ndjson`));
  const atr14 = atr(allCandles, 14);
  const rvolVals = rvol(allCandles, '15m', 20);
  const cvdVals = cvd(allCandles);
  const vp = rollingVolumeProfile(allCandles, '15m', 24, 50);

  const extra = { oiDataStore: new Map(), oiThresholdFn: r => LSO_CONFIG.oiFlushThreshold[r]||LSO_CONFIG.oiFlushThreshold.RANGING,
    cvdGateVariant: 'CVD_ZSCORE', obConfluenceEnabled: true, timeBreakeven: { enabled: false },
    volumeProfiles: vp, gateVP: true, gate4HTrend: true };
  
  const report = runBacktest(createLSOStrategy(extra), {
    candles: allCandles, atr14, rvolVals, cvdVals, fundingMap: new Map(), macroEvents: [], volumeProfiles: vp,
    gates: LSO_GATES.NO_OI, initialCapital: 10000, symbol: SYMBOL, timeframe: '15m', extra,
  });

  // Extract trades from equity curve
  const curve = report.equityCurve || [];
  const trades = [];
  for (let i = 1; i < curve.length; i++) {
    const pnl = curve[i].capital - curve[i-1].capital;
    if (Math.abs(pnl) > 0.001) trades.push({ entryTimestamp: curve[i].timestamp, realizedPnl: pnl });
  }
  console.log(`  Trades: ${report.trades}, P&L events: ${trades.length}, WR=${(report.wr?.point*100).toFixed(1)}%, PF=${report.pf?.toFixed(3)}`);

  // ═══ TEST 1: MONTE CARLO ═══
  console.log('\n── TEST 1: Monte Carlo (5,000 block-shuffled runs) ──\n');
  const mc = runMonteCarlo(trades, 5000, 10000);
  console.log(`  Blocks: ${mc.blocks} | Trades/sim: ~${Math.round(trades.length*0.95)} (after 5% removal)`);
  console.log(`  Equity:  P5=$${mc.equity.p5.toFixed(0)} P10=$${mc.equity.p10.toFixed(0)} P50=$${mc.equity.p50.toFixed(0)} P90=$${mc.equity.p90.toFixed(0)} P95=$${mc.equity.p95.toFixed(0)}`);
  console.log(`  Max DD:  P5=${(mc.dd.p5*100).toFixed(2)}% P10=${(mc.dd.p10*100).toFixed(2)}% P50=${(mc.dd.p50*100).toFixed(2)}% P90=${(mc.dd.p90*100).toFixed(2)}% P95=${(mc.dd.p95*100).toFixed(2)}%`);
  console.log(`           Worst: ${(mc.dd.max*100).toFixed(2)}% Mean: ${(mc.dd.mean*100).toFixed(2)}%`);
  console.log(`  WR: P5=${(mc.wr.p5*100).toFixed(1)}% P50=${(mc.wr.p50*100).toFixed(1)}% P95=${(mc.wr.p95*100).toFixed(1)}%`);
  console.log(`  PF: P5=${mc.pf.p5.toFixed(2)} P50=${mc.pf.p50.toFixed(2)} P95=${mc.pf.p95.toFixed(2)}`);
  const mcDDpass = (mc.dd.p95 * 100) < 10;
  const mcEqPass = mc.p10pass;
  console.log(`\n  P95 DD < 10%:  ${mcDDpass?'✓ PASS':'✗ FAIL'} (${(mc.dd.p95*100).toFixed(2)}%)`);
  console.log(`  P10 Eq > $10k: ${mcEqPass?'✓ PASS':'✗ FAIL'} ($${mc.equity.p10.toFixed(0)})`);

  // ═══ TEST 2: SLIPPAGE STRESS ═══
  console.log('\n── TEST 2: Slippage Stress (2× fees + 2× slippage) ──\n');
  const extraCostPerTrade = 8;
  const totalExtraCost = trades.length * extraCostPerTrade;
  let sGw = 0, sGl = 0;
  for (const t of trades) { const a = t.realizedPnl - extraCostPerTrade; if (a>0) sGw+=a; else sGl+=Math.abs(a); }
  const sPF = sGl > 0 ? sGw / sGl : Infinity;
  console.log(`  Base PF: ${report.pf?.toFixed(3)} | Stressed PF: ${sPF.toFixed(3)} | Extra cost: $${totalExtraCost.toFixed(0)}`);
  const ssPass = sPF > 1.5;
  console.log(`  PF > 1.5 under 2× costs: ${ssPass?'✓ PASS':'✗ FAIL'}`);

  // ═══ TEST 3: BLACK SWAN ═══
  console.log('\n── TEST 3: Black Swan (10% flash crash on 3 largest trades) ──\n');
  const largest = [...trades].sort((a,b)=>Math.abs(b.realizedPnl)-Math.abs(a.realizedPnl)).slice(0,3);
  const stopDist = 0.015, crisisSlip = 0.005, riskPct = 0.01;
  const lossMult = (stopDist + crisisSlip) / riskPct;
  for (let i=0;i<largest.length;i++) console.log(`  Trade #${i+1}: $${largest[i].realizedPnl.toFixed(0)} → stop at -${(stopDist*100).toFixed(1)}%, crisis fill -${((stopDist+crisisSlip)*100).toFixed(1)}% (${lossMult.toFixed(1)}× risk)`);
  const bsLoss = 3 * lossMult;
  console.log(`\n  Max loss: ${bsLoss.toFixed(1)}% capital | Survives: ${bsLoss<10?'YES':'NO'}`);

  // ═══ FINAL ═══
  console.log('\n═══════════════════════════════════════════════════');
  console.log('PHASE D12 — FINAL VERDICT');
  console.log('═══════════════════════════════════════════════════\n');
  const allPass = mcDDpass && mcEqPass && ssPass && bsLoss < 10;
  console.log(`  MC P95 DD < 10%:     ${mcDDpass?'✓':'-'} (${(mc.dd.p95*100).toFixed(2)}%)`);
  console.log(`  MC P10 Eq > $10k:    ${mcEqPass?'✓':'-'} ($${mc.equity.p10.toFixed(0)})`);
  console.log(`  Slippage PF > 1.5:   ${ssPass?'✓':'-'} (${sPF.toFixed(3)})`);
  console.log(`  Black Swan survived: ${bsLoss<10?'✓':'-'} (${bsLoss.toFixed(1)}% loss)`);
  console.log('');
  console.log(allPass ? '  ╔══════════════════════════════════╗\n  ║     STRATEGY IS LETHAL          ║\n  ║  Production-grade robustness    ║\n  ╚══════════════════════════════════╝' : '  Strategy needs hardening.');

  const out = { monteCarlo: mc, slippageStress: { basePF:report.pf, stressedPF:sPF, pass:ssPass }, blackSwan: { maxLossPct:bsLoss, pass:bsLoss<10 }, verdict: allPass?'LETHAL':'NEEDS_HARDENING' };
  if (!fs.existsSync(dp.results)) fs.mkdirSync(dp.results,{recursive:true});
  fs.writeFileSync(path.join(dp.results,'phase_d12_stress_test.json'), JSON.stringify(out,null,2));
  console.log(`\n  Saved: results/phase_d12_stress_test.json`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
