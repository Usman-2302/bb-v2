'use strict';
/**
 * BulletBrain v3.0 — Live Runner (Phase 2+3)
 * 
 * Clean, single-account trading engine for Binance Futures.
 * Rules: Skip RANGING, RVOL≥1.2, 3R target, 1 ATR stop, max 1 concurrent.
 * 
 * Usage: BB_SYMBOL=ethusdt BB_LIVE=false node src/live/liveRunner.js
 *        BB_LIVE=true → real orders on Binance
 *        BB_LIVE=false → paper trading (default)
 */

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────
const SYMBOL = (process.env.BB_SYMBOL || 'ethusdt').toLowerCase();
const LIVE_MODE = process.env.BB_LIVE === 'true';
const API_KEY = process.env.BINANCE_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const BASE_URL = 'https://fapi.binance.com';
const TIMEFRAME = '15m';
const INITIAL_CAPITAL = 100;

// Strategy params
const SWEEP_RVOL_MIN = 1.2;
const STOP_ATR_MULT = 1.0;
const TP_R_MULT = 3.0;
const MAX_CONCURRENT = 1;
const RISK_PCT = 0.02; // 2% per trade
const SKIP_RANGING = true;

// ── Indicators ──────────────────────────────────────────────────
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd: cvdFn } = require('../indicators/cvd');

// ── State ───────────────────────────────────────────────────────
const candles = [];
let atr14 = [], rvolVals = [], cvdVals = { delta: [], cumulative: [] };
let lastCandleTime = 0;
let lastRegime = 'RANGING';

let equity = INITIAL_CAPITAL;
let maxEquity = equity;
let openTrade = null; // single position
let trades = 0, wins = 0, losses = 0;
let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0;

// ── Binance API helpers ─────────────────────────────────────────
function sign(params) {
  const qs = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  return params;
}

async function binanceRequest(method, path, params = {}, signed = false) {
  if (signed) params = sign({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const url = BASE_URL + path;
  try {
    const resp = await axios({ method, url, params, headers: signed ? { 'X-MBX-APIKEY': API_KEY } : {}, timeout: 10000 });
    return resp.data;
  } catch (e) {
    console.error('[BINANCE] Error:', e.response?.data || e.message);
    return null;
  }
}

// ── Trade Execution ─────────────────────────────────────────────
async function placeLimitBuy(entryPrice, stopPrice, tpPrice, quantity) {
  if (!LIVE_MODE) {
    console.log(`[PAPER] LONG ${SYMBOL} @ $${entryPrice.toFixed(2)} | Stop: $${stopPrice.toFixed(2)} | TP: $${tpPrice.toFixed(2)} | Qty: ${quantity.toFixed(4)}`);
    return { orderId: 'paper_' + Date.now(), price: entryPrice };
  }

  // Place limit buy
  const order = await binanceRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'LIMIT',
    price: entryPrice.toFixed(2), quantity: quantity.toFixed(4),
    timeInForce: 'GTC',
  }, true);
  
  if (order) console.log(`[LIVE] BUY ${SYMBOL} @ $${entryPrice.toFixed(2)} | Order: ${order.orderId}`);
  return order;
}

async function placeStopMarket(stopPrice, quantity, side = 'SELL') {
  if (!LIVE_MODE) return { orderId: 'paper_stop_' + Date.now() };
  
  const order = await binanceRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL.toUpperCase(), side, type: 'STOP_MARKET',
    stopPrice: stopPrice.toFixed(2), closePosition: 'true',
  }, true);
  
  if (order) console.log(`[LIVE] STOP ${SYMBOL} @ $${stopPrice.toFixed(2)} | Order: ${order.orderId}`);
  return order;
}

async function placeTakeProfit(tpPrice, quantity) {
  if (!LIVE_MODE) return { orderId: 'paper_tp_' + Date.now() };
  
  const order = await binanceRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'TAKE_PROFIT_MARKET',
    stopPrice: tpPrice.toFixed(2), closePosition: 'true',
  }, true);
  
  if (order) console.log(`[LIVE] TP ${SYMBOL} @ $${tpPrice.toFixed(2)} | Order: ${order.orderId}`);
  return order;
}

// ── Core Logic ──────────────────────────────────────────────────
function detectRegime(candle, i) {
  if (i < 200) return 'RANGING';
  const closes = candles.map(c => c.close);
  const e200 = ema(closes, 200);
  const atr14Arr = atr(candles, 14);
  const priceAbove = candle.close > e200[i];
  const slope10 = (e200[i] - e200[Math.max(0, i - 10)]) / e200[Math.max(0, i - 10)];
  const atrPct = atr14Arr[i] / candle.close * 100;
  
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.001 && priceAbove) return 'BULL';
  if (slope10 < -0.001 && !priceAbove) return 'BEAR';
  return 'RANGING';
}

function detectPools(candles, currentIdx) {
  const sw = [];
  for (let j = 1; j < candles.length - 1; j++) {
    if (candles[j].low < candles[j - 1].low && candles[j].low < candles[j + 1].low) sw.push(j);
  }
  const pools = [];
  for (let a = 0; a < sw.length; a++) {
    for (let b = a + 1; b < sw.length; b++) {
      const si = sw[a], sj = sw[b];
      if (sj - si > 50) break;
      if (sj - si < 2) continue;
      if (Math.abs(candles[si].low - candles[sj].low) / candles[si].low >= 0.005) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) {
        if (candles[k].low < Math.min(candles[si].low, candles[sj].low)) { swept = true; break; }
      }
      if (swept) continue;
      pools.push({ level: Math.floor((candles[si].low + candles[sj].low) / 2), formed: sj, expires: sj + 200 });
    }
  }
  return pools;
}

async function processCandle(candle, i) {
  const regime = detectRegime(candle, i);
  
  // Regime drift logging
  if (regime !== lastRegime) {
    const rv = rvolVals[i] || 0;
    console.log(`[DRIFT] ${lastRegime} → ${regime} | RVOL=${rv?.toFixed(2)}`);
    lastRegime = regime;
  }

  // ── Check open trade ──
  if (openTrade) {
    const t = openTrade;
    let closed = false, pnl = 0, outcome = '';
    
    if (candle.low <= t.stop) { outcome = 'LOSS'; pnl = -t.risk; closed = true; }
    else if (candle.high >= t.tp) { outcome = 'WIN'; pnl = t.risk * TP_R_MULT; closed = true; }
    else if (i - t.entryIdx > 50) { outcome = 'TIME'; pnl = t.risk * 0.3; closed = true; }
    
    if (closed) {
      equity += pnl;
      if (equity > maxEquity) maxEquity = equity;
      trades++;
      if (outcome === 'WIN') wins++; else if (outcome === 'LOSS') losses++;
      
      const symbol = SYMBOL.toUpperCase();
      if (LIVE_MODE) {
        await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
      }
      
      const wrPct = trades > 0 ? (wins/trades*100).toFixed(0) : 'N/A';
      console.log('[TRADE] ' + outcome + ' | PnL: $' + pnl.toFixed(2) + ' | Equity: $' + equity.toFixed(2) + ' | WR: ' + wrPct + '%');
      openTrade = null;
    }
  }
  
  if (openTrade) return; // max 1 concurrent

  // ── Skip RANGING ──
  if (SKIP_RANGING && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) {
    rangingSkipped++;
    return;
  }

  // ── Indicators ──
  const rv = rvolVals[i] || 0;
  const cv = cvdVals.delta[i] || 0;
  const pv = cvdVals.delta[i - 1] || 0;
  const av = atr14[i] || 0;

  if (rv < SWEEP_RVOL_MIN) return;

  // ── Pool sweep detection ──
  const pools = detectPools(candles, i);
  for (const pool of pools) {
    if (pool.formed > i || pool.expires < i) continue;
    if (candle.low >= pool.level || candle.close <= pool.level) continue;
    
    sweepsDetected++;
    
    // CVD ghost check
    if ((cv - pv) <= 0) { ghostsBlocked++; continue; }
    
    const entry = pool.level;
    const stopDist = av * STOP_ATR_MULT;
    const stop = entry - stopDist;
    const tp = entry + stopDist * TP_R_MULT;
    if (stopDist <= 0 || entry <= stop) { rvolBlocked++; continue; }

    // Position sizing
    const riskAmt = equity * RISK_PCT;
    const stopPct = stopDist / entry;
    const quantity = riskAmt / (entry * stopPct); // approximate BTC qty
    
    // Either paper or live entry
    if (LIVE_MODE) {
      const order = await placeLimitBuy(entry, stop, tp, quantity);
      if (!order) continue;
      // Place OCO: stop + take profit
      await placeStopMarket(stop, quantity);
      await placeTakeProfit(tp, quantity);
    }
    
    openTrade = { entry, stop, tp, risk: riskAmt, entryIdx: i, regime };
    
    const mode = LIVE_MODE ? 'LIVE' : 'PAPER';
    console.log(`[${mode}] LONG ${SYMBOL} @ $${entry.toFixed(2)} | Stop: $${stop.toFixed(2)} | TP: $${tp.toFixed(2)} | Risk: $${riskAmt.toFixed(2)} | ${regime}`);
    break;
  }
}

// ── Umpire Report ────────────────────────────────────────────────
function umpireReport() {
  const regime = lastRegime;
  const dd = maxEquity > equity ? ((maxEquity - equity) / maxEquity * 100) : 0;
  const wr = trades > 0 ? (wins / trades * 100) : 0;
  const pnl = equity - INITIAL_CAPITAL;
  
  console.log('');
  console.log('════ ════ UMPIRE @ ' + new Date().toISOString() + ' ════ ═════');
  console.log(`  Coin: ${SYMBOL.toUpperCase()} | Regime: ${regime} | Mode: ${LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'}`);
  console.log(`  Equity: $${equity.toFixed(2)} | Trades: ${trades} | WR: ${wr.toFixed(0)}% | PnL: $${pnl.toFixed(2)} | DD: ${dd.toFixed(1)}%`);
  console.log(`  Sweeps: ${sweepsDetected} | Ghosts: ${ghostsBlocked} | RVOL skip: ${rvolBlocked} | Range skip: ${rangingSkipped}`);
  console.log('═══════════════════════════════════════════════════');
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  BulletBrain v3.0 — Live Runner`);
  console.log(`  Coin: ${SYMBOL.toUpperCase()} | Mode: ${LIVE_MODE ? '🔴 LIVE TRADING' : '📄 PAPER TRADING'}`);
  console.log(`  Rules: Skip RANGING | RVOL≥${SWEEP_RVOL_MIN} | ${TP_R_MULT}R Target | ${STOP_ATR_MULT} ATR Stop | Max ${MAX_CONCURRENT} concurrent`);
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // Backfill warmup
  console.log('Backfilling 1000 candles...');
  const endTime = Date.now();
  const startTime = endTime - 1000 * 15 * 60 * 1000;
  
  try {
    const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: SYMBOL.toUpperCase(), interval: '15m', startTime, endTime, limit: 1000 },
      timeout: 15000,
    });
    
    for (const k of resp.data) {
      candles.push({
        openTime: k[0], closeTime: k[6],
        open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      });
    }
    console.log(`  Backfilled ${candles.length} candles`);
    console.log(`  Range: ${new Date(candles[0].openTime).toISOString()} → ${new Date(candles[candles.length-1].openTime).toISOString()}`);
  } catch (e) {
    console.error('  Backfill failed:', e.message);
    process.exit(1);
  }

  // Compute initial indicators
  computeIndicators();
  console.log('  Warmup ready. Waiting for live data...');
  console.log('');

  // REST polling fallback
  let lastProcessed = candles[candles.length - 1]?.openTime || 0;
  
  setInterval(async () => {
    try {
      const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: SYMBOL.toUpperCase(), interval: '15m', limit: 2 },
        timeout: 10000,
      });
      
      for (const k of resp.data) {
        const openTime = k[0];
        if (openTime <= lastProcessed) continue;
        
        const candle = {
          openTime, closeTime: k[6],
          open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        };
        
        candles.push(candle);
        if (candles.length > 10000) candles.shift();
        computeIndicators();
        
        const i = candles.length - 1;
        await processCandle(candle, i);
        lastProcessed = openTime;
        
        // Umpire every 24 candles
        if (candles.length % 24 === 0) umpireReport();
      }
    } catch (e) {
      // silent retry
    }
  }, 30000);

  // WebSocket for real-time
  const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL}@kline_${TIMEFRAME}`;
  let ws = null;
  
  function connectWS() {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => console.log('[WS] Connected'));
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.e !== 'kline' || !msg.k.x) return; // only closed candles
        
        const k = msg.k;
        const openTime = k.t;
        if (openTime <= lastProcessed) return;
        
        const candle = {
          openTime, closeTime: k.T,
          open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        };
        
        candles.push(candle);
        if (candles.length > 10000) candles.shift();
        computeIndicators();
        
        const i = candles.length - 1;
        await processCandle(candle, i);
        lastProcessed = openTime;
        
        if (candles.length % 24 === 0) umpireReport();
      } catch (e) {}
    });
    ws.on('close', () => { console.log('[WS] Disconnected. Reconnecting in 10s...'); setTimeout(connectWS, 10000); });
    ws.on('error', () => {});
  }
  
  connectWS();
  
  console.log('[REST] Polling every 30s. Waiting for first live candle...');
}

function computeIndicators() {
  if (candles.length < 200) {
    atr14 = []; rvolVals = []; cvdVals = { delta: [], cumulative: [] };
    return;
  }
  atr14 = atr(candles, 14);
  rvolVals = rvol(candles, '15m', 20);
  cvdVals = cvdFn(candles);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
