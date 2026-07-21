'use strict';
require('dotenv').config();
/**
 * BulletBrain v3.0 — Live Runner (LONG + SHORT)
 * BULL → LONG  |  BEAR → SHORT  |  RANGING → FLAT
 * Usage: BB_SYMBOL=ethusdt BB_LIVE=false node src/live/liveRunner.js
 */

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

const SYMBOL = (process.env.BB_SYMBOL || 'ethusdt').toLowerCase();
const LIVE_MODE = process.env.BB_LIVE === 'true';
const API_KEY = process.env.BINANCE_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const BASE_URL = 'https://fapi.binance.com';
const INITIAL_CAPITAL = parseFloat(process.env.BB_CAPITAL || '100');

const SWEEP_RVOL_MIN = 0.6, STOP_ATR_MULT = 0.5, TP_R_MULT = 2.0;
const MAX_CONCURRENT = 1, RISK_PCT = 0.02, SKIP_RANGING = true;

const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { cvd: cvdFn } = require('../indicators/cvd');

// Simple 20-candle rolling SMA RVOL (not time-normalized)
// Time-normalized RVOL inflates baseline with crash day volume
function simpleRvol(candles, period = 20) {
  const result = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += candles[j].volume;
    const avg = sum / period;
    result[i] = avg > 0 ? candles[i].volume / avg : 1.0;
  }
  return result;
}

const candles = [];
let isScanning = false;  // true during warmup scan — skip real orders
let atr14 = [], rvolVals = [], cvdVals = { delta: [], cumulative: [] };
let lastRegime = 'RANGING';
let equity = INITIAL_CAPITAL, maxEquity = equity;
let openTrade = null;
let pendingOrder = null;
let trades = 0, wins = 0, losses = 0;
let longTrades = 0, shortTrades = 0;
let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0;

function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  return params;
}

async function binanceRequest(method, path, params = {}, signed = false) {
  if (signed) params = sign({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  try {
    const resp = await axios({ method, url: BASE_URL + path, params, headers: signed ? { 'X-MBX-APIKEY': API_KEY } : {}, timeout: 10000 });
    return resp.data;
  } catch (e) { console.error('[BINANCE]', e.response?.data || e.message); return null; }
}

function detectRegime(candle, i) {
  if (i < 200) return 'RANGING';
  const closes = candles.map(c => c.close);
  const e200 = ema(closes, 200);
  const atrArr = atr(candles, 14);
  const priceAbove = candle.close > e200[i];
  const slope10 = (e200[i] - e200[Math.max(0, i - 10)]) / e200[Math.max(0, i - 10)];
  const atrPct = atrArr[i] / candle.close * 100;
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.0007 && priceAbove) return 'BULL';
  if (slope10 < -0.0007 && !priceAbove) return 'BEAR';
  return 'RANGING';
}

function detectPools(type) {
  const pools = [], sw = [];
  for (let j = 1; j < candles.length - 1; j++) {
    if (type === 'LONG' && candles[j].low < candles[j-1].low && candles[j].low < candles[j+1].low) sw.push(j);
    if (type === 'SHORT' && candles[j].high > candles[j-1].high && candles[j].high > candles[j+1].high) sw.push(j);
  }
  for (let a = 0; a < sw.length; a++) {
    for (let b = a + 1; b < sw.length; b++) {
      const si = sw[a], sj = sw[b];
      if (sj - si > 80) break; if (sj - si < 2) continue;
      const v1 = type === 'LONG' ? candles[si].low : candles[si].high;
      const v2 = type === 'LONG' ? candles[sj].low : candles[sj].high;
      if (Math.abs(v1 - v2) / v1 >= 0.005) continue;
      let swept = false;
      for (let k = si + 1; k < sj; k++) {
        const cv = type === 'LONG' ? candles[k].low : candles[k].high;
        if (type === 'LONG' ? cv < Math.min(v1, v2) : cv > Math.max(v1, v2)) { swept = true; break; }
      }
      if (swept) continue;
      pools.push({ level: Math.floor((v1 + v2) / 2), formed: sj, expires: sj + 500 });
    }
  }
  return pools;
}

async function processCandle(candle, i) {
  try {
  const regime = detectRegime(candle, i);
  if (regime !== lastRegime) { console.log('[REGIME] ' + lastRegime + ' → ' + regime); lastRegime = regime; }

  if (openTrade) {
    const t = openTrade; let closed = false, pnl = 0, outcome = '';
    if (t.side === 'LONG') {
      if (candle.low <= t.stop) { outcome = 'LOSS'; pnl = -t.risk; closed = true; }
      else if (candle.high >= t.tp) { outcome = 'WIN'; pnl = t.risk * TP_R_MULT; closed = true; }
    } else {
      if (candle.high >= t.stop) { outcome = 'LOSS'; pnl = -t.risk; closed = true; }
      else if (candle.low <= t.tp) { outcome = 'WIN'; pnl = t.risk * TP_R_MULT; closed = true; }
    }
    if (i - t.idx > 50) { outcome = 'TIME'; pnl = t.risk * 0.3; closed = true; }
    if (closed) {
      equity += pnl; if (equity > maxEquity) maxEquity = equity;
      trades++; if (outcome === 'WIN') wins++; else if (outcome === 'LOSS') losses++;
      if (t.side === 'LONG') longTrades++; else shortTrades++;
      console.log('[TRADE] ' + t.side + ' ' + outcome + ' | PnL: $' + pnl.toFixed(2) + ' | Equity: $' + equity.toFixed(2) + ' | WR: ' + (trades > 0 ? (wins/trades*100).toFixed(0) : '0') + '%');
      openTrade = null;
    }
  }
  if (openTrade || pendingOrder) return;

  if (SKIP_RANGING && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) { rangingSkipped++; return; }

  const rv = rvolVals[i] || 0, cv = cvdVals.delta[i] || 0, pv = cvdVals.delta[i-1] || 0, av = atr14[i] || 0;
  if (rv < SWEEP_RVOL_MIN) {
    if (regime !== 'RANGING' && candles.length > 0 && i > 20) { let s=0; for(let j=i-20;j<i;j++) s+=candles[j].volume; console.log('[RVOL_DBG] i='+i+' vol='+candle.volume.toFixed(0)+' sma20='+(s/20).toFixed(0)+' rv='+rv.toFixed(3)); }
    if (rv > 0 && regime !== 'RANGING') console.log('[FILTER] RVOL= rv='+rv.toFixed(2)+' < '+SWEEP_RVOL_MIN+' regime='+regime+' candle='+new Date(candle.openTime).toISOString().slice(5,16));
    return;
  }

  // Debug: we made it past RVOL check
  if (Math.random() < 0.05) console.log('[CHECK] regime='+regime+' rv='+rv.toFixed(2)+' pools='+detectPools(regime==='BULL'?'LONG':'SHORT').length+' candle='+new Date(candle.openTime).toISOString().slice(5,16));

  if (regime === 'BULL') {
    const pools = detectPools('LONG');
    let found = false;
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.low >= pool.level || candle.close <= pool.level) continue;
      found = true;
      sweepsDetected++;
      if ((cv - pv) <= 0) { ghostsBlocked++; continue; }
      const entry = pool.level, stopDist = av * STOP_ATR_MULT;
      const stop = entry - stopDist, tp = entry + stopDist * TP_R_MULT;
      if (stopDist <= 0 || entry <= stop) { rvolBlocked++; console.log('[BLOCK] LONG entry failed: entry='+entry.toFixed(0)+' stop='+stop.toFixed(0)+' av='+av.toFixed(2)+' stopDist='+stopDist.toFixed(2)); continue; }
      const riskAmt = equity * RISK_PCT;
      if (LIVE_MODE && !isScanning) {
        const qty = riskAmt / stopDist;
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'LIMIT', price: entry.toFixed(2), quantity: qty.toFixed(4), timeInForce: 'GTC' }, true);
        if (order) {
          pendingOrder = { side: 'LONG', entry, stop, tp, risk: riskAmt, stopDist, idx: i, regime, orderId: order.orderId };
          console.log('[ORDER] Placed LONG limit @ $' + entry.toFixed(0) + ' | Order #' + order.orderId);
        }
      } else {
        openTrade = { side: 'LONG', entry, stop, tp, risk: riskAmt, idx: i, regime };
        console.log('[🔥 ENTRY] ' + (isScanning ? 'SCAN' : 'PAPER') + ' LONG @ $' + entry.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2) + ' | ' + regime);
      }
      break;
    }
    if (!found && pools.length > 0) {
      console.log('[BLOCK] No pool sweep regime='+regime+' candle H='+candle.high.toFixed(0)+' L='+candle.low.toFixed(0)+' C='+candle.close.toFixed(0)+' pools='+pools.length+' nearest='+(pools[0]?.level||'none')+' expired='+pools.filter(p=>p.expires<i).length+' future='+pools.filter(p=>p.formed>i).length);
    }
  } else if (regime === 'BEAR') {
    const pools = detectPools('SHORT');
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.high <= pool.level || candle.close >= pool.level) continue;
      sweepsDetected++;
      if ((cv - pv) >= 0) { ghostsBlocked++; continue; }
      const entry = pool.level, stopDist = av * STOP_ATR_MULT;
      const stop = entry + stopDist, tp = entry - stopDist * TP_R_MULT;
      if (stopDist <= 0 || entry >= stop) { rvolBlocked++; console.log('[BLOCK] SHORT entry failed: entry='+entry.toFixed(0)+' stop='+stop.toFixed(0)+' av='+av.toFixed(2)); continue; }
      const riskAmt = equity * RISK_PCT;
      if (LIVE_MODE && !isScanning) {
        const qty = riskAmt / stopDist;
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'LIMIT', price: entry.toFixed(2), quantity: qty.toFixed(4), timeInForce: 'GTC' }, true);
        if (order) {
          pendingOrder = { side: 'SHORT', entry, stop, tp, risk: riskAmt, stopDist, idx: i, regime, orderId: order.orderId };
          console.log('[ORDER] Placed SHORT limit @ $' + entry.toFixed(0) + ' | Order #' + order.orderId);
        }
      } else {
        openTrade = { side: 'SHORT', entry, stop, tp, risk: riskAmt, idx: i, regime };
        console.log('[🔥 ENTRY] ' + (isScanning ? 'SCAN' : 'PAPER') + ' SHORT @ $' + entry.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2) + ' | ' + regime);
      }
      break;
    }
  }
  } catch (e) { console.error('[PROCESS_CANDLE] Error:', e.message, '| i=' + i); }
}

function umpireReport() {
  const dd = maxEquity > equity ? ((maxEquity - equity) / maxEquity * 100) : 0;
  const wr = trades > 0 ? (wins / trades * 100) : 0;
  console.log('');
  console.log('════ ════ UMPIRE @ ' + new Date().toISOString() + ' ════ ═════');
  console.log('  Coin: ' + SYMBOL.toUpperCase() + ' | Regime: ' + lastRegime + ' | Mode: ' + (LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'));
  console.log('  Equity: $' + equity.toFixed(2) + ' | Trades: ' + trades + ' (L:' + longTrades + '/S:' + shortTrades + ') | WR: ' + wr.toFixed(0) + '% | PnL: $' + (equity - INITIAL_CAPITAL).toFixed(2));
  console.log('  Sweeps: ' + sweepsDetected + ' | Ghosts: ' + ghostsBlocked + ' | RVOL skip: ' + rvolBlocked + ' | Range skip: ' + rangingSkipped);
  console.log('═══════════════════════════════════════════════════');
}

function computeIndicators() {
  if (candles.length < 200) return;
  atr14 = atr(candles, 14);
  rvolVals = simpleRvol(candles, 20);
  cvdVals = cvdFn(candles);
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  BulletBrain v3.0 — Live Runner (LONG+SHORT)');
  console.log('  Coin: ' + SYMBOL.toUpperCase() + ' | Mode: ' + (LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'));
  console.log('  BULL→LONG | BEAR→SHORT | RANGING→FLAT');
  console.log('  RVOL≥' + SWEEP_RVOL_MIN + ' | ' + TP_R_MULT + 'R Target | ' + STOP_ATR_MULT + ' ATR');
  console.log('═══════════════════════════════════════════════');

  console.log('Backfilling 1500 candles...');
  const endTime = Date.now(), startTime = endTime - 1500 * 15 * 60 * 1000;
  try {
    const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: SYMBOL.toUpperCase(), interval: '15m', startTime, endTime, limit: 1500 }, timeout: 15000,
    });
    for (const k of resp.data) candles.push({ openTime: k[0], closeTime: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    console.log('  Backfilled ' + candles.length + ' candles');
  } catch (e) { console.error('Backfill failed:', e.message); process.exit(1); }
  computeIndicators();
  console.log('  Warmup ready. Scanning for diagnostic trades...');

  isScanning = true;
  const scanStart = 300;
  for (let si = scanStart; si < candles.length; si++) {
    await processCandle(candles[si], si);
  }
  isScanning = false;
  console.log('  Scan found: ' + trades + ' trades (diagnostic only)');

  // Reset to real capital — warmup scan was diagnostic
  equity = INITIAL_CAPITAL;
  maxEquity = equity;
  trades = 0; wins = 0; losses = 0;
  longTrades = 0; shortTrades = 0;
  sweepsDetected = 0; ghostsBlocked = 0; rvolBlocked = 0; rangingSkipped = 0;
  openTrade = null;
  pendingOrder = null;
  console.log('  State reset. Starting LIVE with $' + equity.toFixed(2));

  let lastProcessed = candles[candles.length - 1]?.openTime || 0;
  setInterval(async () => {
    try {
      const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: SYMBOL.toUpperCase(), interval: '15m', limit: 2 }, timeout: 10000,
      });
      for (const k of resp.data) {
        if (k[0] <= lastProcessed) continue;
        if (k[6] > Date.now()) continue; // Skip unclosed candle (partial volume)
        const candle = { openTime: k[0], closeTime: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
        candles.push(candle); if (candles.length > 15000) candles.shift();
        computeIndicators();
        await processCandle(candle, candles.length - 1);
        lastProcessed = k[0];
        if (candles.length % 24 === 0) umpireReport();
      }
    } catch (e) { console.error('[REST_POLL] Error:', e.message); }
  }, 30000);

  const wsUrl = 'wss://fstream.binance.com/ws/' + SYMBOL + '@kline_15m';
  function connectWS() {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => console.log('[WS] Connected'));
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.e !== 'kline' || !msg.k.x) return;
        const k = msg.k, openTime = k.t;
        if (openTime <= lastProcessed) return;
        const candle = { openTime, closeTime: k.T, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        candles.push(candle); if (candles.length > 15000) candles.shift();
        computeIndicators();
        await processCandle(candle, candles.length - 1);
        lastProcessed = openTime;
        if (candles.length % 24 === 0) umpireReport();
      } catch (e) {}
    });
    ws.on('close', () => { console.log('[WS] Disconnected'); setTimeout(connectWS, 10000); });
    ws.on('error', () => {});
  }
  connectWS();
  console.log('[REST] Polling every 30s...');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
// ── Order Management ────────────────────────────────────────────
async function checkOrderFilled(orderId) {
  if (!LIVE_MODE) return true;
  try {
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', SECRET_KEY).update('orderId=' + orderId + '&symbol=' + SYMBOL.toUpperCase() + '&timestamp=' + ts).digest('hex');
    const resp = await axios({ url: BASE_URL + '/fapi/v1/order?orderId=' + orderId + '&symbol=' + SYMBOL.toUpperCase() + '&timestamp=' + ts + '&signature=' + sig, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000 });
    return resp.data.status === 'FILLED';
  } catch (e) { return false; }
}
async function cancelOrder(orderId) {
  if (!LIVE_MODE) return;
  try {
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', SECRET_KEY).update('orderId=' + orderId + '&symbol=' + SYMBOL.toUpperCase() + '&timestamp=' + ts).digest('hex');
    await axios({ method: 'DELETE', url: BASE_URL + '/fapi/v1/order?orderId=' + orderId + '&symbol=' + SYMBOL.toUpperCase() + '&timestamp=' + ts + '&signature=' + sig, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000 });
    console.log('[ORDER] Cancelled unfilled #' + orderId);
  } catch (e) {}
}
async function placeSLTP(side, stop, tp, qty) {
  if (!LIVE_MODE) return;
  const stopSide = side === 'BUY' ? 'SELL' : 'BUY';
  await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: stopSide, type: 'STOP_MARKET', stopPrice: stop.toFixed(2), closePosition: 'true' }, true);
  await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: stopSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(2), closePosition: 'true' }, true);
}
