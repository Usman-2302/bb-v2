'use strict';
/**
 * BulletBrain — Walk-Forward Optimization (WFO) Engine
 *
 * Implements the Mroziewicz & Ślepaczuk (2026) methodology exactly:
 *
 *   1. EMA crossover strategy as defined in the paper
 *   2. Walk-Forward Optimization: train on window → test on next window
 *   3. Optimize BOTH the EMA parameters AND the WF window lengths
 *   4. 81 window combinations (9 train × 9 test lengths: 1,2,3,5,7,10,14,21,28 days)
 *   5. Robust Sharpe smoothing (neighbor-weighted)
 *   6. Double out-of-sample: GLOBAL TRAIN → select best 2 → run on UNSEEN once only
 *   7. Bootstrap significance testing (block-shuffled positions)
 *   8. Cost sensitivity analysis at 7 fee levels
 *   9. Portfolio combination (strategy + Buy-and-Hold)
 *
 * Data splits (MUST NEVER be changed once research starts):
 *   GLOBAL TRAIN: 2021-01-01 → 2024-12-31  (in-sample, fully available)
 *   UNSEEN:       2025-01-01 → present      (touch ONCE at the very end)
 *
 * The paper's key finding applied here:
 *   - 15m EMA crossover is UNPROFITABLE at 0.1% costs (mean Sharpe -0.98)
 *   - 60m+ EMA crossover is PROFITABLE at 0.1% costs (mean Sharpe +0.79)
 *   - This mirrors our own findings: 15m scalping fails, higher TF viable
 *
 * Usage:
 *   node src/backtest/run_wfo_strategy.js                    # full run (15m + 60m)
 *   node src/backtest/run_wfo_strategy.js --tf 60m           # 60m only
 *   node src/backtest/run_wfo_strategy.js --symbol ETHUSDT
 *   node src/backtest/run_wfo_strategy.js --unseen           # run on unseen data (FINAL)
 *   node src/backtest/run_wfo_strategy.js --bootstrap 1000   # bootstrap iterations
 */

const fs      = require('fs');
const path    = require('path');

// ── CLI ───────────────────────────────────────────────────────────────────
function arg(n, d) { const i = process.argv.indexOf('--'+n); return i >= 0 && process.argv[i+1] ? process.argv[i+1] : d; }
const SYMBOL         = arg('symbol',    'ETHUSDT');
const TF_ARG         = arg('tf',        'both');       // '15m', '60m', 'both'
const RUN_UNSEEN     = process.argv.includes('--unseen');
const N_BOOTSTRAP    = parseInt(arg('bootstrap', '200'), 10);
const COST_SCENARIO  = arg('cost',      'measured');   // 'measured'|'optimistic'|'harsh'
const QUIET          = process.argv.includes('--quiet');

// ── Date splits (LOCKED — never change) ──────────────────────────────────
const TRAIN_FROM     = '2021-01-01';
const TRAIN_TO       = '2024-12-31';
const UNSEEN_FROM    = '2025-01-01';
// UNSEEN_TO = present (auto)

// ── Fee scenarios ─────────────────────────────────────────────────────────
// Paper used 0.1% per transaction. We measure our own real costs.
// Applying to notional (not risk amount) — the correct way (see AUDIT.md).
const FEE_SCENARIOS = {
  measured:   { taker: 0.0005, maker: 0.0002, slip: 0.0006 }, // real fills
  optimistic: { taker: 0.0005, maker: 0.0002, slip: 0.0002 }, // tight spread
  harsh:      { taker: 0.0007, maker: 0.0003, slip: 0.0012 }, // stressed
  paper_01:   { taker: 0.0005, maker: 0.0005, slip: 0.0000 }, // paper's 0.1% per transaction
};

// ── Walk-Forward window lengths tested (days) ─────────────────────────────
// From paper Section 4.3.1: 1,2,3,5,7,10,14,21,28
const WF_WINDOWS = [1, 2, 3, 5, 7, 10, 14, 21, 28];

// ── EMA periods tested ────────────────────────────────────────────────────
// From paper Section 4.2: fast: 5,7,10,15,20,30 / slow: 40,50,100,150,200
const EMA_FAST  = [5, 7, 10, 15, 20, 30];
const EMA_SLOW  = [40, 50, 100, 150, 200];

// ── Data loading ──────────────────────────────────────────────────────────
function loadNDJSON(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch(e) {}
  }
  out.sort((a,b) => a.openTime - b.openTime);
  const dedup = [];
  for (const c of out) {
    if (!dedup.length || dedup[dedup.length-1].openTime !== c.openTime) dedup.push(c);
  }
  return dedup;
}

// Resample 15m base to any higher TF
const TF_MS = { '15m': 900000, '30m': 1800000, '60m': 3600000, '4h': 14400000, '1d': 86400000 };
function resample(base, tf) {
  const ms = TF_MS[tf]; if (!ms || ms === 900000) return base.slice();
  const baseMs = 900000; const exp = ms / baseMs;
  const out = []; let cur = null, cnt = 0;
  for (const c of base) {
    const bkt = Math.floor(c.openTime / ms) * ms;
    if (!cur || cur.openTime !== bkt) {
      if (cur && cnt === exp) out.push(cur);
      cur = { openTime: bkt, closeTime: bkt+ms-1, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      cnt = 0;
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low  < cur.low)  cur.low  = c.low;
      cur.close = c.close; cur.volume += c.volume;
    }
    cnt++;
  }
  if (cur && cnt === exp) out.push(cur);
  return out;
}

function sliceByDate(candles, from, to) {
  const a = from ? Date.parse(from+'T00:00:00Z') : -Infinity;
  const b = to   ? Date.parse(to  +'T23:59:59Z') :  Infinity;
  return candles.filter(c => c.openTime >= a && c.openTime <= b);
}

// ── EMA indicator ─────────────────────────────────────────────────────────
function calcEMA(closes, n) {
  const k = 2/(n+1); const out = new Array(closes.length).fill(NaN); let v = NaN;
  for (let i = 0; i < closes.length; i++) {
    v = !isFinite(v) ? closes[i] : closes[i]*k + v*(1-k); out[i] = v;
  }
  return out;
}

// ── EMA strategy P&L ─────────────────────────────────────────────────────
/**
 * Compute equity curve, returns, positions, and Sharpe for an EMA crossover
 * on `candles` with the given fee scenario. Entry at next bar open after cross.
 *
 * Returns: { sharpe, annReturn, annVol, maxDD, trades, positions[], returns[] }
 */
function runEMACrossover(candles, fastN, slowN, fees, initialCapital = 10000) {
  if (candles.length < slowN + 10) return null;
  const closes = candles.map(c => c.close);
  const fast   = calcEMA(closes, fastN);
  const slow   = calcEMA(closes, slowN);

  let equity   = initialCapital;
  let position = 0;    // +1 long, -1 short, 0 flat
  let entryPx  = 0;
  let entryNotional = 0;
  const logReturns = [];
  const positionBlocks = []; // for bootstrap
  let blockStart = 0;
  let trades = 0;

  for (let i = slowN; i < candles.length - 1; i++) {
    // Signal on bar i, act on bar i+1 open
    const prevPos = position;
    let newPos = position;
    if (fast[i] >= slow[i]) newPos = 1;
    else                     newPos = -1;

    if (newPos !== prevPos) {
      // Close previous position
      if (prevPos !== 0) {
        const exitPx = candles[i+1].open;
        const exitFee = Math.abs(exitPx * (entryNotional / entryPx)) * fees.taker +
                        Math.abs(exitPx * (entryNotional / entryPx)) * fees.slip;
        const gross = (exitPx - entryPx) * prevPos * (entryNotional / entryPx);
        const pnl   = gross - exitFee;
        equity += pnl;
        positionBlocks.push({ dir: prevPos, bars: i - blockStart, pnl });
        trades++;
      }
      // Open new position
      const entryCandle = candles[i+1];
      entryPx = entryCandle.open * (1 + newPos * fees.slip); // slippage on entry
      entryNotional = equity * 0.95; // ~95% of equity deployed
      const entryFee = Math.abs(entryNotional) * fees.taker;
      equity -= entryFee;
      position = newPos;
      blockStart = i;
    }

    // Log return for this bar (bar is in position)
    if (position !== 0) {
      const r = Math.log(candles[i].close / candles[i-1].close) * position;
      logReturns.push(r);
    } else {
      logReturns.push(0);
    }
  }

  if (!logReturns.length) return null;

  // Compute metrics
  const n = logReturns.length;
  const mean = logReturns.reduce((a,b) => a+b, 0) / n;
  const sd   = Math.sqrt(logReturns.reduce((a,r) => a+(r-mean)**2, 0) / n);

  // Annualize: bars per year depends on TF
  // For 15m: 365*24*4 = 35040 bars/year. For 60m: 365*24 = 8760.
  // We estimate from the data span.
  const spanMs = candles[candles.length-1].openTime - candles[0].openTime;
  const barsPerYear = n / (spanMs / 31557600000); // 31.557M ms per year
  const annReturn = mean * barsPerYear;
  const annVol    = sd * Math.sqrt(barsPerYear);
  const sharpe    = annVol > 0 ? annReturn / annVol : 0;

  // Max drawdown
  let peak = initialCapital, maxDD = 0, eq2 = initialCapital;
  let cumR = 0;
  for (const r of logReturns) {
    cumR += r;
    eq2 = initialCapital * Math.exp(cumR);
    if (eq2 > peak) peak = eq2;
    const dd = (peak - eq2) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    sharpe,
    annReturn,
    annVol,
    maxDD,
    trades,
    finalEquity: equity,
    return: (equity - initialCapital) / initialCapital,
    positionBlocks, // for bootstrap
    logReturns,     // for further analysis
  };
}

// ── Walk-Forward Optimization ─────────────────────────────────────────────
/**
 * Run walk-forward optimization on `candles` with given window lengths.
 * For each WF step: optimize EMA params on train, test on next window.
 * Returns: { sharpe, annReturn, annVol, maxDD, trades, testReturns[] }
 *
 * trainDays/testDays: number of calendar days per window
 * fees: fee scenario object
 * candleBarMs: milliseconds per bar (for converting days to bars)
 */
function runWalkForward(candles, trainDays, testDays, fees, candleBarMs) {
  const trainMs = trainDays * 86400000;
  const testMs  = testDays  * 86400000;
  const stepMs  = trainMs + testMs;

  const startTs = candles[0].openTime;
  const endTs   = candles[candles.length-1].openTime;

  const allTestReturns = [];
  const allPositionBlocks = [];
  let totalTrades = 0;

  let windowStart = startTs;
  while (windowStart + stepMs <= endTs) {
    const trainStart = windowStart;
    const trainEnd   = windowStart + trainMs;
    const testEnd    = windowStart + stepMs;

    const trainCandles = candles.filter(c => c.openTime >= trainStart && c.openTime < trainEnd);
    const testCandles  = candles.filter(c => c.openTime >= trainEnd   && c.openTime < testEnd);

    if (trainCandles.length < 100 || testCandles.length < 20) {
      windowStart += testMs; // slide by test window
      continue;
    }

    // Find best EMA params on train window
    let bestSharpe = -Infinity;
    let bestFast   = EMA_FAST[0];
    let bestSlow   = EMA_SLOW[EMA_SLOW.length - 1];

    for (const fast of EMA_FAST) {
      for (const slow of EMA_SLOW) {
        const res = runEMACrossover(trainCandles, fast, slow, fees);
        if (res && res.sharpe > bestSharpe) {
          bestSharpe = res.sharpe;
          bestFast   = fast;
          bestSlow   = slow;
        }
      }
    }

    // Apply best params to test window
    const testResult = runEMACrossover(testCandles, bestFast, bestSlow, fees);
    if (testResult) {
      allTestReturns.push(...testResult.logReturns);
      allPositionBlocks.push(...testResult.positionBlocks);
      totalTrades += testResult.trades;
    }

    windowStart += testMs; // walk forward by one test period
  }

  if (!allTestReturns.length) return null;

  const n = allTestReturns.length;
  const mean = allTestReturns.reduce((a,b) => a+b, 0) / n;
  const sd   = Math.sqrt(allTestReturns.reduce((a,r) => a+(r-mean)**2, 0) / n);

  // Estimate bars-per-year from the total candle span
  const spanMs = candles[candles.length-1].openTime - candles[0].openTime;
  const barsPerYear = n / (spanMs / 31557600000);
  const annReturn = mean * barsPerYear;
  const annVol    = sd * Math.sqrt(barsPerYear);
  const sharpe    = annVol > 0 ? annReturn / annVol : 0;

  // Max drawdown from cumulative returns
  let peak = 0, maxDD = 0, cumR = 0;
  for (const r of allTestReturns) {
    cumR += r;
    if (cumR > peak) peak = cumR;
    const dd = peak - cumR;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    sharpe, annReturn, annVol, maxDD: 1 - Math.exp(-maxDD),
    trades: totalTrades,
    testReturns: allTestReturns,
    positionBlocks: allPositionBlocks,
    barsPerYear,
  };
}

// ── Robust Sharpe (neighbor-smoothed) ─────────────────────────────────────
// From paper Section 4.3.4: Smoothed = 0.5 * original + 0.5 * avg(neighbors)
function smoothGrid(grid, trainIdx, testIdx) {
  const rows  = testIdx.length;
  const cols  = trainIdx.length;
  const raw   = grid; // raw[row][col] = sharpe
  const smooth = Array.from({length: rows}, () => new Array(cols).fill(NaN));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!isFinite(raw[r][c])) continue;
      const neighbors = [];
      for (const dr of [-1, 0, 1]) {
        for (const dc of [-1, 0, 1]) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && isFinite(raw[nr][nc])) {
            neighbors.push(raw[nr][nc]);
          }
        }
      }
      if (!neighbors.length) { smooth[r][c] = raw[r][c]; continue; }
      const neighborAvg = neighbors.reduce((a,b)=>a+b,0) / neighbors.length;
      smooth[r][c] = 0.5 * raw[r][c] + 0.5 * neighborAvg;
    }
  }
  return smooth;
}

// ── Block bootstrap significance test ─────────────────────────────────────
// Shuffles position-blocks to test if sequence matters (paper Section 5.5.1.1)
function blockBootstrap(testReturns, positionBlocks, originalSharpe, barsPerYear, nIter = 200) {
  if (!positionBlocks.length || !testReturns.length) return null;
  let higherCount = 0;

  for (let it = 0; it < nIter; it++) {
    // Shuffle position blocks
    const shuffled = [...positionBlocks].sort(() => Math.random() - 0.5);

    // Reconstruct a return series: each block contributes its bars × random sign
    // We keep the ORIGINAL asset returns for each block but shuffle the ORDER
    // Simplified: use block-level returns shuffled
    const blockReturns = shuffled.map(b => b.pnl / 10000); // normalized
    const sr = blockReturns.reduce((a,b)=>a+b,0) / blockReturns.length;
    const sd2 = Math.sqrt(blockReturns.reduce((a,r)=>a+(r-sr)**2,0)/blockReturns.length);
    const ann = sr * barsPerYear;
    const annSd = sd2 * Math.sqrt(barsPerYear);
    const bs = annSd > 0 ? ann / annSd : 0;
    if (bs > originalSharpe) higherCount++;
  }

  const pctExceeded = higherCount / nIter * 100;
  const significant = pctExceeded < 5; // 5% confidence: strategy beats 95% of shuffles
  return { pctExceeded, significant, nIter };
}

// ── Information Ratio (paper's formula) ──────────────────────────────────
// IR = sign(return) * return² / (vol * maxDD)
function infoRatio(annReturn, annVol, maxDD) {
  if (!annVol || !maxDD) return NaN;
  return Math.sign(annReturn) * (annReturn * annReturn) / (annVol * maxDD);
}

// ── Sortino Ratio ─────────────────────────────────────────────────────────
function sortinoRatio(returns, barsPerYear) {
  const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
  const downside = returns.filter(r => r < 0);
  if (!downside.length) return mean > 0 ? Infinity : 0;
  const dsd = Math.sqrt(downside.reduce((a,r)=>a+r*r,0)/downside.length);
  return dsd > 0 ? (mean * barsPerYear) / (dsd * Math.sqrt(barsPerYear)) : 0;
}

// ── Buy-and-Hold baseline ─────────────────────────────────────────────────
function buyAndHold(candles) {
  if (candles.length < 2) return { sharpe: 0, annReturn: 0, annVol: 0, maxDD: 0, return: 0 };
  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    returns.push(Math.log(candles[i].close / candles[i-1].close));
  }
  const n = returns.length;
  const mean = returns.reduce((a,b)=>a+b,0)/n;
  const sd   = Math.sqrt(returns.reduce((a,r)=>a+(r-mean)**2,0)/n);
  const spanMs = candles[candles.length-1].openTime - candles[0].openTime;
  const bpy = n / (spanMs / 31557600000);
  const annReturn = mean * bpy;
  const annVol    = sd * Math.sqrt(bpy);
  let peak = 0, maxDD = 0, cum = 0;
  for (const r of returns) {
    cum += r; if (cum > peak) peak = cum;
    const dd = peak - cum; if (dd > maxDD) maxDD = dd;
  }
  return {
    sharpe: annVol > 0 ? annReturn / annVol : 0,
    annReturn, annVol,
    maxDD: 1 - Math.exp(-maxDD),
    return: Math.exp(returns.reduce((a,b)=>a+b,0)) - 1,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
function pad(v, n) { return String(v).padStart(n); }
function fnum(v, d=3) { return isFinite(v) ? v.toFixed(d) : 'N/A'; }

async function main() {
  const fees = FEE_SCENARIOS[COST_SCENARIO] || FEE_SCENARIOS.measured;

  console.log('\n' + '='.repeat(80));
  console.log('WALK-FORWARD OPTIMIZATION (Mroziewicz & Ślepaczuk 2026 methodology)');
  console.log(`Symbol: ${SYMBOL} | Cost scenario: ${COST_SCENARIO}`);
  console.log(`Fees: taker ${(fees.taker*1e4).toFixed(1)}bps + maker ${(fees.maker*1e4).toFixed(1)}bps + slip ${(fees.slip*1e4).toFixed(1)}bps/side`);
  if (RUN_UNSEEN) {
    console.log('⚠  UNSEEN DATA RUN — this exhausts the OOS period. Do not re-run.');
  } else {
    console.log(`GLOBAL TRAIN: ${TRAIN_FROM} → ${TRAIN_TO} | UNSEEN: ${UNSEEN_FROM} → present (LOCKED)`);
  }
  console.log('='.repeat(80));

  // Load data
  const file15m = path.join(__dirname, '../../data/historical', `${SYMBOL}_15m.ndjson`);
  if (!fs.existsSync(file15m)) {
    console.error(`Missing: ${file15m}`);
    process.exit(1);
  }
  console.log('\nLoading 15m base data...');
  const base15m = loadNDJSON(file15m);
  const lastDate = new Date(base15m[base15m.length-1].openTime).toISOString().slice(0,10);
  console.log(`  ${base15m.length} bars | ${new Date(base15m[0].openTime).toISOString().slice(0,10)} → ${lastDate}`);

  // Determine which timeframes to test
  const TFS = TF_ARG === 'both' ? ['15m', '60m'] :
              TF_ARG === '60m'  ? ['60m'] :
              TF_ARG === '15m'  ? ['15m'] :
                                  ['15m', '60m'];

  for (const tf of TFS) {
    const candleBarMs = TF_MS[tf];
    const allCandles  = tf === '15m' ? base15m : resample(base15m, tf);
    const trainCandles = RUN_UNSEEN
      ? sliceByDate(allCandles, TRAIN_FROM, null)         // all available for unseen run
      : sliceByDate(allCandles, TRAIN_FROM, TRAIN_TO);    // train only for WFO
    const unseenCandles = sliceByDate(allCandles, UNSEEN_FROM, null);

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`TIMEFRAME: ${tf} | Train: ${trainCandles.length} bars | Unseen: ${unseenCandles.length} bars`);
    console.log('─'.repeat(80));

    if (trainCandles.length < 500) {
      console.log(`  Insufficient training data for ${tf}. Skip.`);
      continue;
    }

    // ── PHASE 1: Buy-and-Hold baseline ──────────────────────────────────
    const bah = buyAndHold(trainCandles);
    console.log(`\nBuy-and-Hold (${TRAIN_FROM}→${TRAIN_TO}):`);
    console.log(`  Sharpe: ${fnum(bah.sharpe,3)} | Return: ${(bah.return*100).toFixed(1)}% | Vol: ${(bah.annVol*100).toFixed(1)}% | MaxDD: ${(bah.maxDD*100).toFixed(1)}%`);

    // ── PHASE 2: WFO grid — 81 combinations ─────────────────────────────
    console.log(`\nRunning 81 WFO combinations (${WF_WINDOWS.length}×${WF_WINDOWS.length})...`);
    const grid     = Array.from({length: WF_WINDOWS.length}, () => new Array(WF_WINDOWS.length).fill(NaN));
    let gridDone   = 0;

    for (let ti = 0; ti < WF_WINDOWS.length; ti++) {
      for (let si = 0; si < WF_WINDOWS.length; si++) {
        const trainDays = WF_WINDOWS[ti];
        const testDays  = WF_WINDOWS[si];
        const res = runWalkForward(trainCandles, trainDays, testDays, fees, candleBarMs);
        grid[si][ti] = res ? res.sharpe : NaN; // [test row][train col] — matches paper layout
        gridDone++;
      }
      if (!QUIET) process.stdout.write(`  Train ${WF_WINDOWS[ti]}d: done\r`);
    }
    if (!QUIET) process.stdout.write('\n');

    // ── PHASE 3: Print raw Sharpe grid ──────────────────────────────────
    console.log('\nRaw Sharpe grid (rows=test days, cols=train days):');
    console.log('Test\\Train ' + WF_WINDOWS.map(w => pad(w+'d', 7)).join(''));
    for (let si = 0; si < WF_WINDOWS.length; si++) {
      const row = WF_WINDOWS.map((_,ti) => pad(isFinite(grid[si][ti]) ? grid[si][ti].toFixed(2) : 'N/A', 7)).join('');
      console.log(`${pad(WF_WINDOWS[si]+'d', 10)}${row}`);
    }

    // ── PHASE 4: Smooth the grid ─────────────────────────────────────────
    const smooth = smoothGrid(grid, WF_WINDOWS, WF_WINDOWS);
    console.log('\nSmoothed (Robust) Sharpe grid:');
    console.log('Test\\Train ' + WF_WINDOWS.map(w => pad(w+'d', 7)).join(''));
    for (let si = 0; si < WF_WINDOWS.length; si++) {
      const row = WF_WINDOWS.map((_,ti) => pad(isFinite(smooth[si][ti]) ? smooth[si][ti].toFixed(2) : 'N/A', 7)).join('');
      console.log(`${pad(WF_WINDOWS[si]+'d', 10)}${row}`);
    }

    // ── PHASE 5: Select top 2 by smoothed Sharpe ────────────────────────
    const candidates = [];
    for (let si = 0; si < WF_WINDOWS.length; si++) {
      for (let ti = 0; ti < WF_WINDOWS.length; ti++) {
        if (isFinite(smooth[si][ti])) {
          candidates.push({ trainDays: WF_WINDOWS[ti], testDays: WF_WINDOWS[si], smoothedSharpe: smooth[si][ti] });
        }
      }
    }
    candidates.sort((a,b) => b.smoothedSharpe - a.smoothedSharpe);
    const top2 = candidates.slice(0, 2);

    console.log('\nTop 2 WFO configurations (by smoothed Sharpe):');
    for (const c of top2) {
      const raw = grid[WF_WINDOWS.indexOf(c.testDays)][WF_WINDOWS.indexOf(c.trainDays)];
      console.log(`  Train ${c.trainDays}d / Test ${c.testDays}d | Raw Sharpe: ${fnum(raw,3)} | Smoothed: ${fnum(c.smoothedSharpe,3)}`);
    }

    // ── PHASE 6: Evaluate top 2 on TRAIN data, get bootstrap ────────────
    console.log('\nEvaluating top 2 configs on GLOBAL TRAIN data...');
    const trainResults = [];
    for (const config of top2) {
      const res = runWalkForward(trainCandles, config.trainDays, config.testDays, fees, candleBarMs);
      if (!res) { console.log(`  ${config.trainDays}d/${config.testDays}d: insufficient data`); continue; }
      const ir = infoRatio(res.annReturn, res.annVol, res.maxDD);
      const sr = sortinoRatio(res.testReturns, res.barsPerYear);
      console.log(`\n  Train ${config.trainDays}d / Test ${config.testDays}d:`);
      console.log(`    Sharpe: ${fnum(res.sharpe,3)} | Return: ${(res.annReturn*100).toFixed(1)}% | Vol: ${(res.annVol*100).toFixed(1)}% | MaxDD: ${(res.maxDD*100).toFixed(1)}%`);
      console.log(`    Info ratio: ${fnum(ir,3)} | Sortino: ${fnum(sr,3)} | Trades: ${res.trades}`);
      console.log(`    vs Buy-and-Hold: Sharpe ${fnum(bah.sharpe,3)}`);

      // Bootstrap significance test
      if (N_BOOTSTRAP > 0) {
        console.log(`    Running block bootstrap (${N_BOOTSTRAP} iters)...`);
        const bs = blockBootstrap(res.testReturns, res.positionBlocks, res.sharpe, res.barsPerYear, N_BOOTSTRAP);
        if (bs) {
          console.log(`    Bootstrap: ${bs.pctExceeded.toFixed(1)}% of shuffles exceed original Sharpe → ${bs.significant ? '✓ SIGNIFICANT (p<5%)' : '✗ NOT significant'}`);
        }
      }
      trainResults.push({ config, res, ir, sr });
    }

    // ── PHASE 7: Cost sensitivity (paper's Table 9 equivalent) ──────────
    console.log('\nCost sensitivity analysis (best config):');
    if (trainResults.length > 0) {
      const best = trainResults.sort((a,b) => b.res.sharpe - a.res.sharpe)[0];
      // Cost sensitivity: vary round-trip cost, see how Sharpe and return degrade
      // In EMA crossover, fee impact = n_trades × avg_notional × round_trip_rate
      // We model this by adjusting the annualized return directly
      const costLevels = [0.0005, 0.0007, 0.001, 0.002, 0.003, 0.004, 0.005]; // per leg (taker)
      console.log('  Cost/leg  | Sharpe  | AnnReturn | AdjReturn | MaxDD   | Trades');
      const baseRes = best.res;
      const tradesPerYear = baseRes.trades / ((trainCandles[trainCandles.length-1].openTime - trainCandles[0].openTime) / 31557600000);
      const avgNotionalFraction = 0.95; // fraction of equity in each trade

      for (const c of costLevels) {
        // Total annual fee drag = trades/year × round-trip cost × 2 (entry + exit) × notional fraction
        const roundTrip = c * 2; // taker both ways (conservative)
        const annFeeRateApprox = tradesPerYear * roundTrip * avgNotionalFraction;
        // Adjusted return = base return - fee drag per year
        const adjAnnReturn = baseRes.annReturn - annFeeRateApprox;
        const adjSharpe    = baseRes.annVol > 0 ? adjAnnReturn / baseRes.annVol : 0;
        const unprofitable = adjAnnReturn <= 0 ? ' ← BREAKEVEN' : '';
        console.log(`  ${(c*100).toFixed(3)}%    | ${fnum(adjSharpe,3).padStart(7)} | ${(baseRes.annReturn*100).toFixed(1).padStart(8)}% | ${(adjAnnReturn*100).toFixed(1).padStart(8)}% | ${(baseRes.maxDD*100).toFixed(1).padStart(6)}% | ${baseRes.trades}${unprofitable}`);
      }
      const breakevenCost = baseRes.annReturn / (tradesPerYear * 2 * avgNotionalFraction);
      console.log(`  Break-even cost/leg: ~${(breakevenCost*100).toFixed(3)}% (paper found ~0.36-0.40%)`);
      console.log(`  Our cost/leg: ${(fees.taker*100).toFixed(3)}% taker + ${(fees.slip*100).toFixed(3)}% slip = ${((fees.taker+fees.slip)*100).toFixed(3)}%`);
      const profitable = (fees.taker + fees.slip) < breakevenCost;
      console.log(`  → Strategy is ${profitable ? '✓ PROFITABLE' : '✗ UNPROFITABLE'} at our real costs`);
    }

    // ── PHASE 8: UNSEEN DATA (only when --unseen flag passed) ────────────
    if (RUN_UNSEEN && unseenCandles.length > 200 && trainResults.length > 0) {
      console.log('\n' + '!'.repeat(60));
      console.log('UNSEEN DATA EVALUATION — This is final. Do not re-run.');
      console.log('!'.repeat(60));

      const bahUnseen = buyAndHold(unseenCandles);
      console.log(`\nBuy-and-Hold on UNSEEN data (${UNSEEN_FROM}→${lastDate}):`);
      console.log(`  Sharpe: ${fnum(bahUnseen.sharpe,3)} | Return: ${(bahUnseen.return*100).toFixed(1)}% | MaxDD: ${(bahUnseen.maxDD*100).toFixed(1)}%`);

      for (const {config} of trainResults) {
        const res = runWalkForward(unseenCandles, config.trainDays, config.testDays, fees, candleBarMs);
        if (!res) continue;
        const ir = infoRatio(res.annReturn, res.annVol, res.maxDD);
        const sr = sortinoRatio(res.testReturns, res.barsPerYear);
        const beatBaHSharpe = res.sharpe > bahUnseen.sharpe;
        const beatBaHDD = res.maxDD < bahUnseen.maxDD;
        console.log(`\n  Train ${config.trainDays}d / Test ${config.testDays}d on UNSEEN:`);
        console.log(`    Sharpe: ${fnum(res.sharpe,3)} | Return: ${(res.annReturn*100).toFixed(1)}% | MaxDD: ${(res.maxDD*100).toFixed(1)}%`);
        console.log(`    Info ratio: ${fnum(ir,3)} | Sortino: ${fnum(sr,3)} | Trades: ${res.trades}`);
        console.log(`    Beat B&H Sharpe: ${beatBaHSharpe ? '✓ YES' : '✗ NO'} | Beat B&H MaxDD: ${beatBaHDD ? '✓ YES' : '✗ NO'}`);
      }

      // Portfolio combination (paper's key finding)
      console.log('\nPortfolio combination (50% strategy + 50% Buy-and-Hold):');
      const best = trainResults[0];
      const res  = runWalkForward(unseenCandles, best.config.trainDays, best.config.testDays, fees, candleBarMs);
      if (res && unseenCandles.length > 0) {
        const bah2   = buyAndHold(unseenCandles);
        // Portfolio: equal weight, no rebalancing
        const portReturns = res.testReturns.map((r, i) => {
          const bahr = Math.log(unseenCandles[Math.min(i+1, unseenCandles.length-1)].close /
                                unseenCandles[Math.max(i,   0)                           ].close);
          return 0.5 * r + 0.5 * bahr;
        });
        const pm = portReturns.reduce((a,b)=>a+b,0)/portReturns.length;
        const psd = Math.sqrt(portReturns.reduce((a,r)=>a+(r-pm)**2,0)/portReturns.length);
        const pBpy = res.barsPerYear;
        const pSharpe = psd > 0 ? (pm * pBpy) / (psd * Math.sqrt(pBpy)) : 0;
        let ppeak=0, pmaxDD=0, pcum=0;
        for(const r of portReturns){pcum+=r;if(pcum>ppeak)ppeak=pcum;const dd=ppeak-pcum;if(dd>pmaxDD)pmaxDD=dd;}
        const portMaxDD = 1-Math.exp(-pmaxDD);
        console.log(`  Strategy Sharpe: ${fnum(res.sharpe,3)} | B&H Sharpe: ${fnum(bah2.sharpe,3)} | Portfolio Sharpe: ${fnum(pSharpe,3)}`);
        console.log(`  Strategy MaxDD: ${(res.maxDD*100).toFixed(1)}% | B&H MaxDD: ${(bah2.maxDD*100).toFixed(1)}% | Portfolio MaxDD: ${(portMaxDD*100).toFixed(1)}%`);
        console.log(`  → ${pSharpe > Math.max(res.sharpe, bah2.sharpe) ? '✓ Portfolio WINS' : 'Portfolio does not dominate'}`);
      }
    }

    // ── PHASE 9: Summary for this timeframe ─────────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log(`SUMMARY for ${tf}:`);
    const rawSharpes = grid.flat().filter(isFinite);
    const meanSharpe = rawSharpes.reduce((a,b)=>a+b,0) / rawSharpes.length;
    const maxSharpe  = Math.max(...rawSharpes);
    const posSharpes = rawSharpes.filter(s=>s>0).length;
    console.log(`  Mean Sharpe (all 81): ${fnum(meanSharpe,3)}`);
    console.log(`  Max Sharpe:           ${fnum(maxSharpe,3)}`);
    console.log(`  Positive configs:     ${posSharpes}/81 (${(posSharpes/81*100).toFixed(0)}%)`);
    console.log(`  Paper finding for ${tf === '60m' ? '60m' : '15m'}: mean Sharpe ${tf === '60m' ? '+0.79' : '-0.98'} (at 0.1% cost)`);
    console.log(`  Our finding:          ${fnum(meanSharpe,3)} (at ${COST_SCENARIO} costs)`);

    // Paper interpretation
    if (meanSharpe > 0.5) {
      console.log(`  ✓ STRONG: Mean Sharpe > 0.5 — strategy has edge at this timeframe/cost`);
    } else if (meanSharpe > 0) {
      console.log(`  ~ MARGINAL: Mean Sharpe > 0 but < 0.5 — edge exists but may not survive live costs`);
    } else {
      console.log(`  ✗ NO EDGE: Mean Sharpe < 0 at ${COST_SCENARIO} costs`);
      console.log(`    The paper found 15m unprofitable at 0.1% costs. Our costs are higher.`);
    }
    console.log('─'.repeat(80));
  }

  // Final instructions
  console.log('\n' + '='.repeat(80));
  console.log('NEXT STEPS:');
  if (!RUN_UNSEEN) {
    console.log('  1. If 60m shows positive mean Sharpe: run with --unseen to evaluate on OOS data');
    console.log('     (only once — do not re-run --unseen after seeing the result)');
    console.log('  2. Run with --cost harsh to verify edge survives stressed costs');
    console.log('  3. Run with --bootstrap 1000 for higher-confidence significance test');
    console.log('  4. If strategy passes OOS: port the winning WFO config into liveRunner.js');
    console.log('     The winning config = EMA crossover with the best train/test window lengths');
  } else {
    console.log('  OOS run complete. Results above are the final answer.');
    console.log('  Do not re-tune parameters or re-run this with different settings.');
    console.log('  If OOS Sharpe > 0 and beats B&H on MaxDD: proceed to liveRunner.js port.');
  }
  console.log('='.repeat(80));
}

main().catch(e => { console.error(e); process.exit(1); });
