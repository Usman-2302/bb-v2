'use strict';
/**
 * BulletBrain — Multi-Timeframe Scalper Backtest
 *
 * STRATEGY:
 *   Direction / Trend → 60m EMA crossover (WFO-validated, Sharpe 6.5 OOS)
 *   Entry trigger     → 15m pullback to EMA in trend direction
 *   Fill realism      → 1m candles used to check intrabar SL/TP hits
 *                       (solves the "15m candle hides SL breach" problem)
 *
 * HOW IT WORKS:
 *   1. Compute 60m EMA fast/slow. When fast > slow = BULL, fast < slow = BEAR.
 *   2. On each 15m candle, check the 60m trend.
 *   3. In BULL: enter LONG when 15m close crosses back above 15m EMA20 (pullback entry)
 *      In BEAR: enter SHORT when 15m close crosses back below 15m EMA20
 *   4. Stop: 2× 15m ATR below/above entry
 *   5. Target: 2.5R from entry (scales with stop, gives time to develop)
 *   6. INTRABAR CHECK: for every open position, scan the 1m candles inside
 *      each 15m bar to find the actual sequence — did SL hit before TP?
 *      This is the key improvement over naive OHLCV backtests.
 *
 * COMPOUNDING: $100 starting equity, 1% risk per trade.
 *
 * Usage:
 *   node backtest_mtf_scalper.js                          # Jun 1 – Aug 1 2026
 *   node backtest_mtf_scalper.js --from 2026-06-01 --to 2026-08-01
 *   node backtest_mtf_scalper.js --fast 10 --slow 50      # EMA params
 *   node backtest_mtf_scalper.js --stop 1.5 --tp 3.0      # stop/TP ATR multiples
 */

const fs   = require('fs');
const path = require('path');

// ── CLI ───────────────────────────────────────────────────────────────────
function arg(n, d) { const i = process.argv.indexOf('--'+n); return i>=0&&process.argv[i+1]?process.argv[i+1]:d; }
const FROM      = arg('from',   '2026-06-01');
const TO        = arg('to',     '2026-08-01');
const EMA_FAST  = parseInt(arg('fast',  '10'),  10);
const EMA_SLOW  = parseInt(arg('slow',  '50'),  10);
const STOP_MULT = parseFloat(arg('stop', '2.0'));
const TP_MULT   = parseFloat(arg('tp',   '2.5'));
const EQUITY_0  = parseFloat(arg('equity','100'));
const RISK_PCT  = parseFloat(arg('risk', '0.01'));  // 1% per trade

// ── Fees (real Binance rates) ─────────────────────────────────────────────
const TAKER = 0.0005;
const MAKER = 0.0002;
const SLIP  = 0.0006;
// Entry: market order (taker + slip). TP: limit (maker). SL: stop_market (taker + slip).
const LOSS_COST = TAKER + TAKER + 2*SLIP;  // round-trip loss
const WIN_COST  = TAKER + MAKER;           // round-trip win (slip already in exit fill for TP)

// ── Indicators ────────────────────────────────────────────────────────────
function ema(prices, n) {
  const k = 2/(n+1); const out = Array(prices.length).fill(NaN); let v = NaN;
  for (let i=0;i<prices.length;i++){v=!isFinite(v)?prices[i]:prices[i]*k+v*(1-k);out[i]=v;}
  return out;
}
function atrArr(c, n=14) {
  const out=Array(c.length).fill(NaN);let prev=c[0].close,s=NaN;
  for(let i=1;i<c.length;i++){
    const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-prev),Math.abs(c[i].low-prev));
    s=!isFinite(s)?tr:s*(n-1)/n+tr/n;out[i]=s;prev=c[i].close;
  }return out;
}
function rvolArr(c,n=20){
  const v=c.map(x=>x.volume);const out=Array(c.length).fill(1);let s=0;
  for(let i=0;i<c.length;i++){s+=v[i];if(i>=n)s-=v[i-n];if(i>=n-1)out[i]=(s/n)>0?v[i]/(s/n):1;}
  return out;
}

// ── Data loading ──────────────────────────────────────────────────────────
function loadNDJSON(file) {
  const out=[];
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;try{out.push(JSON.parse(line));}catch(e){}
  }
  out.sort((a,b)=>a.openTime-b.openTime);
  const d=[];for(const c of out){if(!d.length||d[d.length-1].openTime!==c.openTime)d.push(c);}
  return d;
}

function resample(base, tfMs) {
  const baseMs=base[1].openTime-base[0].openTime;
  if(tfMs===baseMs)return base.slice();
  const exp=tfMs/baseMs;const out=[];let cur=null,cnt=0;
  for(const c of base){
    const bkt=Math.floor(c.openTime/tfMs)*tfMs;
    if(!cur||cur.openTime!==bkt){
      if(cur&&cnt===exp)out.push(cur);
      cur={openTime:bkt,closeTime:bkt+tfMs-1,open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume};
      cnt=0;
    }else{if(c.high>cur.high)cur.high=c.high;if(c.low<cur.low)cur.low=c.low;cur.close=c.close;cur.volume+=c.volume;}
    cnt++;
  }if(cur&&cnt===exp)out.push(cur);return out;
}

function sliceDate(c,from,to){
  const a=Date.parse(from+'T00:00:00Z'),b=Date.parse(to+'T23:59:59Z');
  return c.filter(x=>x.openTime>=a&&x.openTime<=b);
}

// ── Main backtest ─────────────────────────────────────────────────────────
function run(candles15m, candles60m, candles1m, equity0) {
  const n15 = candles15m.length;

  // Precompute indicators on 15m
  const close15  = candles15m.map(c=>c.close);
  const e20_15   = ema(close15, 20);
  const atr15    = atrArr(candles15m, 14);
  const rv15     = rvolArr(candles15m, 20);

  // Precompute indicators on 60m
  const close60  = candles60m.map(c=>c.close);
  const eFast60  = ema(close60, EMA_FAST);
  const eSlow60  = ema(close60, EMA_SLOW);

  // Build a lookup: for each 15m bar, what is the most recent closed 60m bar?
  // A 60m bar is "closed" at its closeTime. We use it only when closeTime <= 15m bar openTime.
  const get60mTrend = (barOpenTime) => {
    // Binary search for last 60m bar whose closeTime < barOpenTime
    let lo = 0, hi = candles60m.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo+hi)>>1;
      if (candles60m[mid].closeTime <= barOpenTime) { idx = mid; lo = mid+1; }
      else hi = mid-1;
    }
    if (idx < 1) return 0;  // not enough 60m history
    if (!isFinite(eFast60[idx]) || !isFinite(eSlow60[idx])) return 0;
    return eFast60[idx] > eSlow60[idx] ? 1 : -1;  // +1 BULL, -1 BEAR
  };

  // Build 1m lookup for a given 15m bar
  // Returns array of 1m candles whose openTime is within [barOpen, barClose)
  const get1mCandles = (barOpen, barClose) => {
    return candles1m.filter(c => c.openTime >= barOpen && c.openTime < barClose);
  };

  const trades = [];
  let equity   = equity0;
  let openTrade = null;
  const dailyPnL = {};

  const warmup = Math.max(EMA_SLOW * 2, 60); // enough bars to seed indicators

  for (let i = warmup; i < n15 - 1; i++) {
    const bar     = candles15m[i];
    const nextBar = candles15m[i+1];
    const day     = new Date(bar.openTime).toISOString().slice(0,10);

    // ── MANAGE OPEN TRADE ──────────────────────────────────────────────
    if (openTrade) {
      const t = openTrade;
      const dir = t.dir;

      // Get 1m candles inside this 15m bar for precise fill detection
      const mins = get1mCandles(bar.openTime, bar.closeTime + 1);

      let exitPx = null, isMaker = false, reason = null, exitTime = bar.closeTime;

      if (mins.length > 0) {
        // Walk through 1m candles in order — find FIRST event (SL or TP)
        for (const m of mins) {
          const hitSL = dir > 0 ? m.low  <= t.sl : m.high >= t.sl;
          const hitTP = dir > 0 ? m.high >= t.tp : m.low  <= t.tp;

          if (hitSL && hitTP) {
            // Both on same 1m candle — use the open to decide which filled first
            // If open is already beyond SL: gap fill at open
            const gappedSL = dir > 0 ? m.open <= t.sl : m.open >= t.sl;
            if (gappedSL) {
              exitPx = m.open; reason = 'SL_GAP'; exitTime = m.openTime; break;
            }
            // Otherwise: conservative assumption = SL hit first (downside bias)
            exitPx = t.sl; reason = 'SL'; exitTime = m.openTime; break;
          }
          if (hitSL) {
            const gapped = dir > 0 ? m.open <= t.sl : m.open >= t.sl;
            exitPx = gapped ? m.open : t.sl;
            reason = gapped ? 'SL_GAP' : 'SL';
            exitTime = m.openTime; break;
          }
          if (hitTP) {
            exitPx = t.tp; isMaker = true;
            reason = 'TP'; exitTime = m.openTime; break;
          }
        }

        // No intrabar event — check time exit (max hold = 8 hours = 32 bars at 15m)
        if (!exitPx && (i - t.entryBar) >= 32) {
          exitPx = bar.close; reason = 'TIME'; exitTime = bar.closeTime;
        }
      } else {
        // No 1m data — fall back to OHLCV (conservative: SL before TP)
        const gapped = dir > 0 ? bar.open <= t.sl : bar.open >= t.sl;
        const hitSL  = dir > 0 ? bar.low  <= t.sl : bar.high >= t.sl;
        const hitTP  = dir > 0 ? bar.high >= t.tp : bar.low  <= t.tp;
        const timed  = (i - t.entryBar) >= 32;

        if (gapped)        { exitPx = bar.open;  reason = 'SL_GAP'; exitTime = bar.openTime; }
        else if (hitSL)    { exitPx = t.sl;      reason = 'SL';     exitTime = bar.openTime; }
        else if (hitTP)    { exitPx = t.tp;      reason = 'TP'; isMaker = true; exitTime = bar.closeTime; }
        else if (timed)    { exitPx = bar.close; reason = 'TIME';   exitTime = bar.closeTime; }
      }

      if (exitPx !== null) {
        // Fee calculation: entry already includes slip in t.entry
        const exitFill = isMaker ? exitPx : exitPx * (1 + dir * SLIP);
        const gross    = (exitFill - t.entry) * dir * t.qty;
        const exitFee  = Math.abs(exitPx * t.qty) * (isMaker ? MAKER : TAKER);
        const pnl      = gross - t.entryFee - exitFee;
        equity        += pnl;

        const stopD   = Math.abs(t.entry - t.sl);
        const rMult   = stopD > 0 ? pnl / (stopD * t.qty) : NaN;

        trades.push({
          dir, reason, pnl, equity, rMult,
          fees:     t.entryFee + exitFee,
          holdBars: i - t.entryBar,
          entry:    t.entry, exit: exitFill,
          sl: t.sl, tp: t.tp,
          entryTime: t.entryTime, exitTime,
          trend60m:  t.trend60m,
          used1m:    mins.length > 0,
        });

        if (!dailyPnL[day]) dailyPnL[day] = 0;
        dailyPnL[day] += pnl;
        openTrade = null;
      }
    }
    if (openTrade) continue;

    // ── SIGNAL DETECTION ──────────────────────────────────────────────
    if (!isFinite(e20_15[i]) || !isFinite(atr15[i])) continue;

    // Get 60m trend (use only closed bars — no lookahead)
    const trend = get60mTrend(bar.openTime);
    if (trend === 0) continue;  // no clear trend

    // RVOL filter: require above-average participation
    if (rv15[i] < 0.8) continue;

    // Entry signal: 15m close crosses back to trend side of EMA20
    const longSig  = trend === 1
      && bar.close > e20_15[i]
      && candles15m[i-1].close <= e20_15[i-1]
      && bar.close > bar.open;  // bullish bar confirming the reclaim

    const shortSig = trend === -1
      && bar.close < e20_15[i]
      && candles15m[i-1].close >= e20_15[i-1]
      && bar.close < bar.open;  // bearish bar confirming the break

    if (!longSig && !shortSig) continue;

    const dir    = longSig ? 1 : -1;
    const entry  = nextBar.open * (1 + dir * SLIP);  // market fill at next bar open
    const atrNow = atr15[i];
    if (!atrNow || atrNow <= 0) continue;

    const sl   = entry - dir * atrNow * STOP_MULT;
    const tp   = entry + dir * atrNow * STOP_MULT * TP_MULT;

    const stopD = Math.abs(entry - sl);
    if (stopD <= 0) continue;
    if (dir > 0 && sl >= entry) continue;
    if (dir < 0 && sl <= entry) continue;

    // Cost floor: TP must cover round-trip fees
    const tpMove = Math.abs(tp - entry) / entry;
    if (tpMove < WIN_COST) continue;

    // Risk sizing
    const riskAmt  = equity * RISK_PCT;
    const perUnit  = stopD + entry * LOSS_COST;
    const qty      = riskAmt / perUnit;
    const entryFee = entry * qty * TAKER;  // slip already in entry price

    openTrade = {
      dir, entry, sl, tp, qty, entryFee,
      entryBar:  i + 1,
      entryTime: nextBar.openTime,
      trend60m:  trend,
    };
  }

  return { trades, finalEquity: equity, dailyPnL };
}

// ── Stats ─────────────────────────────────────────────────────────────────
function stats(trades, days) {
  if (!trades.length) return { n:0 };
  const rs   = trades.map(t=>t.rMult).filter(isFinite);
  const wins = rs.filter(r=>r>0);
  if (!rs.length) return { n:trades.length };
  const avgR = rs.reduce((a,b)=>a+b,0)/rs.length;
  const sdR  = Math.sqrt(rs.reduce((a,r)=>a+(r-avgR)**2,0)/rs.length);
  const t    = sdR>0?avgR/(sdR/Math.sqrt(rs.length)):0;
  const pf   = wins.reduce((a,b)=>a+b,0)/Math.abs(rs.filter(r=>r<=0).reduce((a,b)=>a+b,0)||1);
  const wr   = wins.length/rs.length*100;
  const tpd  = trades.length/days;
  const reasons = {};
  for(const t2 of trades) reasons[t2.reason]=(reasons[t2.reason]||0)+1;
  let peak=0,dd=0,eq=0;
  for(const r of rs){eq+=r;if(eq>peak)peak=eq;if(peak-eq>dd)dd=peak-eq;}
  // % of trades where 1m data was used
  const used1m = trades.filter(t=>t.used1m).length;
  return {n:trades.length,wr,avgR,sdR,t,pf,tpd,maxDD:dd,reasons,used1m,
          totalR:rs.reduce((a,b)=>a+b,0)};
}

// ── Main ──────────────────────────────────────────────────────────────────
console.log('\n'+'='.repeat(80));
console.log('MTF SCALPER BACKTEST — ETHUSDT');
console.log(`Period: ${FROM} → ${TO}`);
console.log(`60m trend: EMA${EMA_FAST}/EMA${EMA_SLOW} crossover (WFO-validated Sharpe 6.5+)`);
console.log(`15m entry: EMA20 pullback reclaim in trend direction`);
console.log(`Stop: ${STOP_MULT}×ATR | Target: ${TP_MULT*STOP_MULT}×ATR (${TP_MULT}R)`);
console.log(`Start equity: $${EQUITY_0} | Risk/trade: ${RISK_PCT*100}% | Compounding: ON`);
console.log(`Fill model: 1m intrabar candles used for precise SL/TP ordering`);
console.log(`Fees: taker ${TAKER*1e4}bps + maker ${MAKER*1e4}bps + slip ${SLIP*1e4}bps/side`);
console.log('='.repeat(80));

// Load all data
console.log('\nLoading data...');
const raw15m = loadNDJSON('data/historical/ETHUSDT_15m.ndjson');
const raw1m  = loadNDJSON('data/historical/ETHUSDT_1m.ndjson');

// Build 60m from 15m
const raw60m = resample(raw15m, 60*60*1000);

// ── Need warmup before the window for indicators ──────────────────────────
// Add 500 bars of 15m before FROM for warmup
const fromMs  = Date.parse(FROM+'T00:00:00Z');
const toMs    = Date.parse(TO+'T23:59:59Z');
const warmupFrom = new Date(fromMs - 500 * 15 * 60 * 1000).toISOString().slice(0,10);

const c15m  = raw15m.filter(c=>c.openTime>=Date.parse(warmupFrom+'T00:00:00Z')&&c.openTime<=toMs);
const c60m  = raw60m.filter(c=>c.openTime<=toMs);  // all 60m up to end (for trend lookup)
const c1m   = raw1m.filter(c=>c.openTime>=fromMs&&c.openTime<=toMs);   // only in window (for fills)

// How many 15m bars are in the actual test window (non-warmup)?
const testBars = c15m.filter(c=>c.openTime>=fromMs).length;
const DAYS = Math.ceil((toMs-fromMs)/86400000);

console.log(`15m bars (with warmup): ${c15m.length} | In window: ${testBars}`);
console.log(`60m bars available: ${c60m.length}`);
console.log(`1m bars in window: ${c1m.length} (used for precise fill detection)`);

// Run backtest
const { trades, finalEquity, dailyPnL } = run(c15m, c60m, c1m, EQUITY_0);

// Filter to only trades that opened in the test window
const windowTrades = trades.filter(t => t.entryTime >= fromMs && t.entryTime <= toMs);

const s = stats(windowTrades, DAYS);

// ── Results ───────────────────────────────────────────────────────────────
const P = (v,n) => String(v).padStart(n);
const pct = v => (v>=0?'+':'')+v.toFixed(2)+'%';
const sign = v => (v>=0?'+':'')+v.toFixed(4);

console.log('\n'+'─'.repeat(80));
console.log('RESULTS');
console.log('─'.repeat(80));

if (!s.n) {
  console.log('No trades fired in this window.');
  console.log('Possible reasons: trend filter too strict, no EMA crossovers, warmup too short');
  process.exit(0);
}

const retPct = ((finalEquity - EQUITY_0) / EQUITY_0 * 100);
console.log(`Trades: ${s.n} | T/day: ${s.tpd.toFixed(1)} | WR: ${s.wr.toFixed(1)}%`);
console.log(`avgR: ${sign(s.avgR)} | PF: ${s.pf.toFixed(2)} | t-stat: ${s.t.toFixed(2)} | MaxDD: ${s.maxDD.toFixed(2)}R`);
console.log(`1m data used: ${s.used1m}/${s.n} trades (${(s.used1m/s.n*100).toFixed(0)}%)`);
console.log(`Exit reasons: ${Object.entries(s.reasons).map(([k,v])=>`${k}:${v}`).join(' ')}`);
console.log(`\nStart: $${EQUITY_0.toFixed(2)} → Final: $${finalEquity.toFixed(2)} (${pct(retPct)})`);

// At $100 equity, 1% risk = $1/trade
const riskPerTrade = EQUITY_0 * RISK_PCT;
const estFees = windowTrades.reduce((a,t)=>a+t.fees,0);
console.log(`Estimated total fees paid: $${estFees.toFixed(2)}`);

// ── Daily P&L table ────────────────────────────────────────────────────────
console.log('\n'+'─'.repeat(60));
console.log('DAILY P&L (compounding from $'+EQUITY_0+')');
console.log('─'.repeat(60));
let running = EQUITY_0;
const sortedDays = Object.keys(dailyPnL).sort();
// Also include days with no trades (running stays same)
let cur = new Date(fromMs);
const end = new Date(toMs);
while (cur <= end) {
  const d = cur.toISOString().slice(0,10);
  const pnl = dailyPnL[d] || 0;
  const dayTrades = windowTrades.filter(t=>t.entryTime>=Date.parse(d+'T00:00:00Z')&&t.entryTime<Date.parse(d+'T00:00:00Z')+86400000);
  if (dayTrades.length > 0 || sortedDays.includes(d)) {
    running += pnl;
    const s2 = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
    console.log(`  ${d}  n=${dayTrades.length}  P&L=${s2.padStart(8)}  running=$${running.toFixed(2)}`);
  }
  cur.setDate(cur.getDate()+1);
}
console.log(`  FINAL: $${finalEquity.toFixed(2)} (${pct(retPct)})`);

// ── Trade list ─────────────────────────────────────────────────────────────
console.log('\n'+'─'.repeat(80));
console.log('TRADE LOG');
console.log('─'.repeat(80));
console.log(P('Date/Time',18) + P('Dir',5) + P('Entry',9) + P('SL',9) + P('TP',9) +
            P('Exit',9) + P('Reason',8) + P('P&L',8) + P('R',7) + P('Eq',9) + P('1m',4));
for (const t of windowTrades) {
  const dt = new Date(t.entryTime).toISOString().slice(5,16);
  const d = t.dir > 0 ? 'L' : 'S';
  const r = isFinite(t.rMult) ? t.rMult.toFixed(2) : '?';
  const used = t.used1m ? 'Y' : 'N';
  const pnlStr = (t.pnl>=0?'+':'')+t.pnl.toFixed(2);
  console.log(P(dt,18)+P(d,5)+P(t.entry.toFixed(1),9)+P(t.sl.toFixed(1),9)+P(t.tp.toFixed(1),9)+
              P(t.exit.toFixed(1),9)+P(t.reason,8)+P(pnlStr,8)+P(r,7)+P('$'+t.equity.toFixed(2),9)+P(used,4));
}

// ── Summary interpretation ─────────────────────────────────────────────────
console.log('\n'+'='.repeat(80));
console.log('INTERPRETATION');
console.log('─'.repeat(80));
if (s.t > 2.0 && s.n >= 20) {
  console.log(`✓ t-stat ${s.t.toFixed(2)} with ${s.n} trades → statistically significant edge`);
} else if (s.t > 1.0) {
  console.log(`~ t-stat ${s.t.toFixed(2)} → promising but not yet statistically significant (need more trades)`);
} else {
  console.log(`✗ t-stat ${s.t.toFixed(2)} → no significant edge in this window`);
}
if (retPct > 20) {
  console.log(`✓ Return ${pct(retPct)} exceeds 20% monthly target`);
} else if (retPct > 0) {
  console.log(`~ Return ${pct(retPct)} — profitable but below 20% monthly target`);
} else {
  console.log(`✗ Return ${pct(retPct)} — loss in this period`);
}
console.log(`  Avg hold: ${(windowTrades.reduce((a,t)=>a+t.holdBars,0)/(windowTrades.length||1)*15).toFixed(0)} min`);
console.log(`  1m intrabar check caught precise fills on ${s.used1m} of ${s.n} trades`);
console.log(`  Without 1m check, those ${s.n-s.used1m} trades would have used OHLCV assumptions`);
console.log('='.repeat(80));
