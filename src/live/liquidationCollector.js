'use strict';
require('dotenv').config();
/**
 * BulletBrain v3.0 — Liquidation & Order Book Collector
 *
 * PURPOSE: 4-week data collection + paper trading for the liquidation cascade strategy.
 *
 * WHAT IT COLLECTS:
 *   1. Real-time liquidation events (forced position closes on Binance)
 *      → Stored with: timestamp, side, qty, price, notional
 *   2. Order book snapshots at key moments (depth 5 or 10)
 *      → Snapshot taken at liquidation cluster detection + every 5 min
 *   3. 1-minute OHLCV for price context
 *   4. Funding rate every 8h
 *
 * PAPER TRADING:
 *   Detects liquidation cascade conditions and logs hypothetical trades:
 *   1. Liquidation spike > $500k in 3-minute window
 *   2. Price deviation > 2σ from 15m VWAP
 *   3. Order book imbalance flips to bid side (institutional absorption)
 *   Entry: limit at bid, exit: VWAP mean-reversion or 0.5% stop
 *
 * STORAGE:
 *   - data/liquidations/{SYMBOL}_liq.ndjson  — one event per line
 *   - data/orderbook/{SYMBOL}_ob.ndjson      — snapshots
 *   - logs/liq_paper_trades.log              — paper trade results
 *
 * RUN ON SERVER:
 *   node src/live/liquidationCollector.js
 *
 * AFTER 4 WEEKS:
 *   Run backtest_liquidation.js to analyze the collected data
 *   and validate the paper trade results.
 */

const WebSocket = require('ws');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');

const SYMBOL       = (process.env.BB_SYMBOL || 'ethusdt').toLowerCase();
const SYMBOL_UPPER = SYMBOL.toUpperCase();
const BASE_URL     = 'https://fapi.binance.com';

// ── Storage paths ─────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, '../../data');
const LIQ_DIR   = path.join(DATA_DIR, 'liquidations');
const OB_DIR    = path.join(DATA_DIR, 'orderbook');
const LOGS_DIR  = path.join(__dirname, '../../logs');

[LIQ_DIR, OB_DIR, LOGS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); });

const LIQ_FILE   = path.join(LIQ_DIR, `${SYMBOL_UPPER}_liq.ndjson`);
const OB_FILE    = path.join(OB_DIR,  `${SYMBOL_UPPER}_ob.ndjson`);
const PAPER_FILE = path.join(LOGS_DIR, 'liq_paper_trades.log');
const STATS_FILE = path.join(LOGS_DIR, 'liq_collector_stats.json');

// ── Paper trade configuration ─────────────────────────────────────────────
const PAPER_CONFIG = {
  liqSpikeMinUSD:     500000,   // $500k liquidation in 3 min = spike
  liqWindowMs:        3 * 60000, // 3-minute window
  priceDevSigma:      2.0,       // 2σ from 15m VWAP
  obImbalanceThresh:  2.0,       // bid volume / ask volume > 2× = heavy bid
  stopPct:            0.005,     // 0.5% hard stop
  tpVwap:             true,      // TP at VWAP reversion
  riskPct:            0.01,      // 1% risk per paper trade
  equity:             100,       // paper equity
};

// ── State ─────────────────────────────────────────────────────────────────
const liqWindow    = [];   // recent liquidations for spike detection
const candles1m    = [];   // 1m candles for VWAP + sigma
let currentOB      = null; // latest order book snapshot
let openPaperTrade = null;
let paperEquity    = PAPER_CONFIG.equity;
let paperTrades    = 0;
let paperWins      = 0;
let totalLiqsCollected  = 0;
let totalOBsCollected   = 0;
let startTime      = Date.now();

// ── Append to NDJSON file ─────────────────────────────────────────────────
function appendNDJSON(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function appendLog(file, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(file, line);
  console.log(msg);
}

// ── Indicators ────────────────────────────────────────────────────────────
function calcVWAP(candles) {
  let pv = 0, vol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume; vol += c.volume;
  }
  return vol > 0 ? pv / vol : 0;
}

function calcSigma(candles, n = 20) {
  if (candles.length < n) return 0;
  const slice = candles.slice(-n);
  const closes = slice.map(c => c.close);
  const mean = closes.reduce((a,b)=>a+b,0)/closes.length;
  const sd = Math.sqrt(closes.reduce((a,c)=>a+(c-mean)**2,0)/closes.length);
  return sd;
}

// ── Paper trade logic ─────────────────────────────────────────────────────
function detectLiqSpike() {
  const now = Date.now();
  const recent = liqWindow.filter(l => now - l.ts < PAPER_CONFIG.liqWindowMs);
  const totalUSD = recent.reduce((a,l) => a + l.usd, 0);
  return { totalUSD, count: recent.length, recent };
}

function checkOrderBookImbalance() {
  if (!currentOB) return 0;
  const bidVol = currentOB.bids.slice(0,5).reduce((a,b) => a+parseFloat(b[1]), 0);
  const askVol = currentOB.asks.slice(0,5).reduce((a,b) => a+parseFloat(b[1]), 0);
  if (askVol <= 0) return 0;
  return bidVol / askVol; // > 2 = heavy bid = absorption
}

function tryPaperEntry(price, side, reason) {
  if (openPaperTrade) return;
  const dir      = side === 'LONG' ? 1 : -1;
  const stopDist = price * PAPER_CONFIG.stopPct;
  const stop     = price - dir * stopDist;
  const qty      = (paperEquity * PAPER_CONFIG.riskPct) / stopDist;
  const vwap     = calcVWAP(candles1m.slice(-15));

  openPaperTrade = { side, dir, entry: price, stop, vwap, qty, ts: Date.now(), reason };
  const msg = `PAPER ENTRY ${side} ${qty.toFixed(4)} @ ${price.toFixed(2)} stop=${stop.toFixed(2)} vwap=${vwap.toFixed(2)} reason=${reason}`;
  appendLog(PAPER_FILE, msg);
  paperTrades++;
}

function updatePaperTrade(price) {
  if (!openPaperTrade) return;
  const t = openPaperTrade;
  const vwap = calcVWAP(candles1m.slice(-5)); // current short-term VWAP

  // Exit conditions
  const hitStop = t.dir > 0 ? price <= t.stop : price >= t.stop;
  const hitTP   = t.dir > 0 ? price >= vwap   : price <= vwap;
  const timedOut = (Date.now() - t.ts) > 30 * 60000; // 30 min max

  let exitReason = null, exitPrice = null;
  if (hitStop)   { exitPrice = t.stop;  exitReason = 'STOP'; }
  else if (hitTP){ exitPrice = vwap;    exitReason = 'VWAP_TP'; }
  else if (timedOut){ exitPrice = price; exitReason = 'TIMEOUT'; }

  if (exitReason) {
    const pnl = (exitPrice - t.entry) * t.dir * t.qty;
    paperEquity += pnl;
    if (pnl > 0) paperWins++;
    const wr = (paperWins/paperTrades*100).toFixed(1);
    const msg = `PAPER EXIT ${t.side} @ ${exitPrice.toFixed(2)} reason=${exitReason} pnl=${pnl>=0?'+':''}${pnl.toFixed(2)} eq=$${paperEquity.toFixed(2)} WR=${wr}% (${paperWins}/${paperTrades})`;
    appendLog(PAPER_FILE, msg);
    openPaperTrade = null;
  }
}

// ── WebSocket handlers ────────────────────────────────────────────────────
let wsLiq = null, wsOB = null, ws1m = null;

function connectLiquidationStream() {
  // Binance all liquidations stream
  wsLiq = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
  wsLiq.on('open',  () => console.log('[LIQ WS] Connected: all liquidations'));
  wsLiq.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (!msg.o) return;
      const o = msg.o;
      if (o.s !== SYMBOL_UPPER) return; // only our symbol
      const usd = parseFloat(o.q) * parseFloat(o.p); // qty × price
      const event = {
        ts: o.T, symbol: o.s, side: o.S,
        price: parseFloat(o.p), qty: parseFloat(o.q), usd,
        status: o.X,
      };
      appendNDJSON(LIQ_FILE, event);
      totalLiqsCollected++;
      // Add to spike detection window
      liqWindow.push({ts: o.T, usd, side: o.S});
      // Keep only last 10 min
      const cutoff = Date.now() - 10 * 60000;
      while (liqWindow.length > 0 && liqWindow[0].ts < cutoff) liqWindow.shift();
      // Check for paper trade opportunity
      checkSignalConditions(parseFloat(o.p));
    } catch(e) {}
  });
  wsLiq.on('close', () => { console.log('[LIQ WS] Disconnected, reconnecting...'); setTimeout(connectLiquidationStream, 5000); });
  wsLiq.on('error', e => console.error('[LIQ WS]', e.message));
}

function connectOrderBookStream() {
  // Level 2 order book depth (top 10 levels, 500ms)
  wsOB = new WebSocket(`wss://fstream.binance.com/ws/${SYMBOL}@depth10@500ms`);
  wsOB.on('open',  () => console.log('[OB WS] Connected: depth10'));
  wsOB.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      currentOB = { ts: Date.now(), bids: msg.b, asks: msg.a };
      // Save snapshot every 5 minutes or on liquidation spike
      const now = Date.now();
      if (!currentOB._lastSaved || now - currentOB._lastSaved > 5 * 60000) {
        appendNDJSON(OB_FILE, currentOB);
        currentOB._lastSaved = now;
        totalOBsCollected++;
      }
    } catch(e) {}
  });
  wsOB.on('close', () => { setTimeout(connectOrderBookStream, 5000); });
  wsOB.on('error', e => console.error('[OB WS]', e.message));
}

function connect1mStream() {
  // 1m klines for price context and VWAP
  ws1m = new WebSocket(`wss://fstream.binance.com/ws/${SYMBOL}@kline_1m`);
  ws1m.on('open',  () => console.log('[1m WS] Connected'));
  ws1m.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.e !== 'kline') return;
      const k = msg.k;
      const candle = {
        openTime: k.t, closeTime: k.T,
        open: parseFloat(k.o), high: parseFloat(k.h),
        low:  parseFloat(k.l), close: parseFloat(k.c),
        volume: parseFloat(k.v),
      };
      if (k.x) { // closed candle
        candles1m.push(candle);
        if (candles1m.length > 100) candles1m.shift();
        if (openPaperTrade) updatePaperTrade(candle.close);
      }
    } catch(e) {}
  });
  ws1m.on('close', () => { setTimeout(connect1mStream, 5000); });
  ws1m.on('error', e => console.error('[1m WS]', e.message));
}

// ── Signal detection ───────────────────────────────────────────────────────
function checkSignalConditions(currentPrice) {
  if (openPaperTrade) return; // already in a trade
  if (candles1m.length < 20) return; // not enough data

  const spike = detectLiqSpike();
  if (spike.totalUSD < PAPER_CONFIG.liqSpikeMinUSD) return;

  // Check which side is getting liquidated (forced sellers = price falling)
  const longLiqs  = spike.recent.filter(l=>l.side==='SELL').reduce((a,l)=>a+l.usd,0); // long liquidations = forced sell
  const shortLiqs = spike.recent.filter(l=>l.side==='BUY').reduce((a,l)=>a+l.usd,0);  // short liquidations = forced buy

  const vwap  = calcVWAP(candles1m.slice(-15));
  const sigma = calcSigma(candles1m, 20);
  const obRatio = checkOrderBookImbalance();

  // LONG setup: massive long liquidations pushed price far below VWAP
  // → forced selling exhausted, order book shows buyers absorbing
  if (longLiqs > PAPER_CONFIG.liqSpikeMinUSD * 0.7) {
    const deviation = (vwap - currentPrice) / sigma; // positive = below VWAP
    if (deviation > PAPER_CONFIG.priceDevSigma && obRatio > PAPER_CONFIG.obImbalanceThresh) {
      const reason = `liq_cascade_long | usd=$${(spike.totalUSD/1000).toFixed(0)}k dev=${deviation.toFixed(2)}σ ob=${obRatio.toFixed(2)}`;
      appendLog(PAPER_FILE, `[SIGNAL] ${reason}`);
      // Save OB snapshot at signal
      if (currentOB) appendNDJSON(OB_FILE, {...currentOB, _signal: 'LONG', _price: currentPrice, ts: Date.now()});
      tryPaperEntry(currentPrice, 'LONG', reason);
    }
  }

  // SHORT setup: massive short liquidations pushed price far above VWAP
  if (shortLiqs > PAPER_CONFIG.liqSpikeMinUSD * 0.7) {
    const deviation = (currentPrice - vwap) / sigma;
    if (deviation > PAPER_CONFIG.priceDevSigma && (1/obRatio) > PAPER_CONFIG.obImbalanceThresh) {
      const reason = `liq_cascade_short | usd=$${(spike.totalUSD/1000).toFixed(0)}k dev=${deviation.toFixed(2)}σ ob=${(1/obRatio).toFixed(2)}`;
      appendLog(PAPER_FILE, `[SIGNAL] ${reason}`);
      if (currentOB) appendNDJSON(OB_FILE, {...currentOB, _signal: 'SHORT', _price: currentPrice, ts: Date.now()});
      tryPaperEntry(currentPrice, 'SHORT', reason);
    }
  }
}

// ── Status reporting ───────────────────────────────────────────────────────
function saveStats() {
  const uptime = ((Date.now()-startTime)/3600000).toFixed(1);
  const stats = {
    timestamp:   new Date().toISOString(),
    uptime_h:    uptime,
    liqsCollected: totalLiqsCollected,
    obsCollected:  totalOBsCollected,
    paperTrades,
    paperWins,
    paperWR:     paperTrades > 0 ? (paperWins/paperTrades*100).toFixed(1)+'%' : '0%',
    paperEquity: paperEquity.toFixed(2),
    paperReturn: ((paperEquity-PAPER_CONFIG.equity)/PAPER_CONFIG.equity*100).toFixed(2)+'%',
    currentSignal: openPaperTrade ? `${openPaperTrade.side} since ${new Date(openPaperTrade.ts).toISOString().slice(11,19)}` : 'flat',
  };
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  console.log(`[STATS] up:${uptime}h | liqs:${totalLiqsCollected} obs:${totalOBsCollected} | paper:${paperTrades} trades WR:${stats.paperWR} $${stats.paperEquity} (${stats.paperReturn})`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('BulletBrain — Liquidation & Order Book Collector');
  console.log(`Symbol: ${SYMBOL_UPPER}`);
  console.log(`Collecting: liquidations, order book, 1m candles`);
  console.log(`Paper trading: liquidation cascade exhaustion strategy`);
  console.log(`Data → data/liquidations/ + data/orderbook/`);
  console.log(`Logs → logs/liq_paper_trades.log`);
  console.log('='.repeat(60));

  appendLog(PAPER_FILE, `=== Collector started ${new Date().toISOString()} ===`);
  appendLog(PAPER_FILE, `Config: spike>$${PAPER_CONFIG.liqSpikeMinUSD/1000}k in 3min, dev>${PAPER_CONFIG.priceDevSigma}σ, ob>${PAPER_CONFIG.obImbalanceThresh}x`);

  // Backfill 1m candles
  try {
    const klines = await axios.get(`${BASE_URL}/fapi/v1/klines?symbol=${SYMBOL_UPPER}&interval=1m&limit=100`);
    if (klines.data) {
      for (const k of klines.data) {
        candles1m.push({openTime:k[0],closeTime:k[6],open:parseFloat(k[1]),high:parseFloat(k[2]),low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5])});
      }
      console.log(`[INIT] Loaded ${candles1m.length} historical 1m candles`);
    }
  } catch(e) { console.error('[INIT] Backfill failed:', e.message); }

  // Start all streams
  connectLiquidationStream();
  connectOrderBookStream();
  connect1mStream();

  // Status every 30 minutes
  setInterval(saveStats, 30 * 60000);
  // Initial status after 60s
  setTimeout(saveStats, 60000);

  console.log('[INIT] All streams connecting. Data collection active.');
  console.log('[INFO] Run for 4 weeks, then analyze with backtest_liquidation.js');
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
