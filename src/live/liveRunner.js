'use strict';
require('dotenv').config();
/**
 * BulletBrain v3.0 — Live Runner (LONG + SHORT)
 * BULL → LONG  |  BEAR → SHORT  |  RANGING → FLAT
 * Entry: MARKET order. SL: STOP_MARKET closePosition. TP: bot-managed MARKET exit.
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

const SWEEP_RVOL_MIN = 0.5, STOP_ATR_MULT = 0.5, TP_R_MULT = 2.0;
const RISK_PCT = 0.02, SKIP_RANGING = true;
const FEE_RATE = 0.0004; // 0.04% taker fee per side

const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { cvd: cvdFn } = require('../indicators/cvd');

function simpleRvol(candles, period = 20) {
  const result = new Array(candles.length).fill(1.0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += candles[j].volume;
    result[i] = sum / period > 0 ? candles[i].volume / (sum / period) : 1.0;
  }
  return result;
}

const candles = [];
let isScanning = false;
let atr14 = [], rvolVals = [], cvdVals = { delta: [], cumulative: [] };
let lastRegime = 'RANGING';
let equity = INITIAL_CAPITAL, maxEquity = equity;
let openTrade = null;
let trades = 0, wins = 0, losses = 0;
let longTrades = 0, shortTrades = 0;
let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0;

// ── Sign & API ─────────────────────────────────────────────
function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  params._qs = qs + '&signature=' + params.signature;
  return params;
}

async function binanceRequest(method, path, params = {}, signed = false) {
  if (signed) params = sign({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  try {
    const url = signed ? BASE_URL + path + '?' + params._qs : BASE_URL + path;
    const resp = await axios({ method, url, params: signed ? undefined : params,
      headers: signed ? { 'X-MBX-APIKEY': API_KEY } : {}, timeout: 10000,
      transformResponse: [data => JSON.parse(data, (key, value) =>
        typeof value === 'number' && (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) ? String(value) : value
      )]
    });
    return resp.data;
  } catch (e) { console.error('[BINANCE]', e.response?.data || e.message); return null; }
}

// ── Regime & Pool Detection ─────────────────────────────────
function detectRegime(candle, i) {
  if (i < 200) return 'RANGING';
  const e200 = ema(candles.map(c => c.close), 200);
  const priceAbove = candle.close > e200[i];
  const slope10 = (e200[i] - e200[Math.max(0, i - 10)]) / e200[Math.max(0, i - 10)];
  const atrPct = (atr14[i] || 0) / candle.close * 100;
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

// ═════════════════════════════════════════════════════════════
// CANDLE PROCESSING
// ═════════════════════════════════════════════════════════════
async function processCandle(candle, i) {
  try {
  const regime = detectRegime(candle, i);
  if (regime !== lastRegime) { console.log('[REGIME] ' + lastRegime + ' → ' + regime + ' @ ' + new Date(candle.openTime).toISOString().slice(5,16)); lastRegime = regime; }

  if (!isScanning) {
    const rv = rvolVals[i] || 0;
    console.log('[CANDLE] ' + new Date(candle.openTime).toISOString().slice(5,16) + ' i=' + i + ' O=' + candle.open.toFixed(0) + ' H=' + candle.high.toFixed(0) + ' L=' + candle.low.toFixed(0) + ' C=' + candle.close.toFixed(0) + ' V=' + candle.volume.toFixed(0) + ' rv=' + rv.toFixed(3) + ' rg=' + regime);
  }

  // ═══ ACTIVE TRADE MANAGEMENT ═══
  // SL and TP are placed as Binance orders (STOP_MARKET + LIMIT reduceOnly TP)
  // They auto-execute at exact price — the bot just monitors if position still open
  if (openTrade) {
    const t = openTrade;
    // Check if position still exists on Binance
    let positionClosed = true;
    if (LIVE_MODE && !isScanning) {
      try {
        const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL.toUpperCase() }, true);
        const pos = Array.isArray(positions) ? positions.find(p => p.symbol === SYMBOL.toUpperCase()) : null;
        if (pos && Math.abs(+pos.positionAmt) > 0) {
          positionClosed = false; // Still open
        }
      } catch (e) { /* keep monitoring */ }
    }
    
    if (positionClosed || i - t.idx > 50) {
      // Position closed by SL or TP → read actual PnL from Binance balance
      let outcome = 'CLOSED', pnl = 0;
      if (LIVE_MODE && !isScanning) {
        try {
          const acc = await binanceRequest('GET', '/fapi/v2/account', {}, true);
          if (acc) {
            const newBalance = +acc.totalWalletBalance;
            pnl = newBalance - t.balanceBefore;
            outcome = pnl >= 0 ? 'WIN' : 'LOSS';
            equity = newBalance; // Use real Binance balance
          }
        } catch (e) { pnl = -t.risk; outcome = 'LOSS'; }
      } else {
        // Paper mode: simulated
        const candleReachedTP = t.side === 'LONG' ? candle.high >= t.tp : candle.low <= t.tp;
        const candleHitSL = t.side === 'LONG' ? candle.low <= t.stop : candle.high >= t.stop;
        if (candleReachedTP) { outcome = 'WIN'; pnl = t.risk * 1.8; }
        else if (candleHitSL) { outcome = 'LOSS'; pnl = -t.risk; }
        else { outcome = 'TIME'; pnl = t.risk * 0.3; }
        equity += pnl;
      }
      if (equity > maxEquity) maxEquity = equity;
      trades++; if (outcome === 'WIN') wins++; else if (outcome === 'LOSS') losses++;
      if (t.side === 'LONG') longTrades++; else shortTrades++;
      console.log('[TRADE] ' + t.side + ' ' + outcome + ' | PnL: $' + pnl.toFixed(2) + ' | Balance: $' + equity.toFixed(2) + ' | WR: ' + (trades>0?(wins/trades*100).toFixed(0):'0') + '%');
      openTrade = null;
    }
  }
  if (openTrade) return;

  // ═══ NEW SIGNAL CHECK ═══
  if (SKIP_RANGING && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE')) { rangingSkipped++; return; }

  const rv = rvolVals[i] || 0, cv = cvdVals.delta[i] || 0, pv = cvdVals.delta[i-1] || 0, av = atr14[i] || 0;
  if (rv < SWEEP_RVOL_MIN) {
    if (regime !== 'RANGING' && i > 20) { let s=0; for(let j=i-20;j<i;j++) s+=candles[j].volume; console.log('[RVOL_DBG] i='+i+' vol='+candle.volume.toFixed(0)+' sma20='+(s/20).toFixed(0)+' rv='+rv.toFixed(3)); }
    if (rv > 0 && regime !== 'RANGING') console.log('[FILTER] RVOL= rv='+rv.toFixed(2)+' < '+SWEEP_RVOL_MIN+' regime='+regime+' candle='+new Date(candle.openTime).toISOString().slice(5,16));
    return;
  }

  console.log('[CHECK-PASS] regime='+regime+' rv='+rv.toFixed(2)+' pools='+detectPools(regime==='BULL'?'LONG':'SHORT').length+' candle='+new Date(candle.openTime).toISOString().slice(5,16));

  let found = false;
  if (regime === 'BULL') {
    const pools = detectPools('LONG');
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.low >= pool.level || candle.close <= pool.level) continue;
      found = true; sweepsDetected++;
      if ((cv - pv) <= 0) { ghostsBlocked++; if(!isScanning) console.log('[CVD] Ghost blocked LONG pool=$' + pool.level); continue; }
      const stopDist = av * STOP_ATR_MULT;
      const stop = pool.level - stopDist, tp = pool.level + stopDist * TP_R_MULT;
      if (stopDist <= 0 || pool.level <= stop) { rvolBlocked++; continue; }
      const riskAmt = equity * RISK_PCT, fee = riskAmt * FEE_RATE;
      if (!LIVE_MODE || isScanning) {
        openTrade = { side:'LONG', entry:pool.level, stop, tp, risk:riskAmt+fee, qty:riskAmt/stopDist, idx:i, regime };
        console.log('[🔥 ENTRY] ' + (isScanning?'SCAN':'PAPER') + ' LONG @ $' + pool.level.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2));
      } else {
        const maxQty = equity * 0.8 * 20 / candle.close;
        const qty = Math.min(riskAmt / stopDist, maxQty);
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'MARKET', quantity: qty.toFixed(3) }, true);
        if (!order) { console.error('[ORDER] FAILED LONG MARKET entry'); continue; }
        console.log('[ORDER] MARKET BUY ' + qty.toFixed(3) + ' ETH');
        // Place BOTH SL and TP on Binance — they auto-execute at exact price
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'STOP_MARKET', stopPrice: stop.toFixed(2), closePosition: 'true' }, true);
        console.log('[SL] STOP_MARKET @ $' + stop.toFixed(0));
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'LIMIT', price: tp.toFixed(2), timeInForce: 'GTC', reduceOnly: 'true' }, true);
        console.log('[TP] LIMIT TP @ $' + tp.toFixed(0));
        // Get actual Binance balance for PnL tracking
        const balBefore = await binanceRequest('GET', '/fapi/v2/account', {}, true);
        const balanceBefore = balBefore ? +balBefore.totalWalletBalance : equity;
        openTrade = { side:'LONG', entry:pool.level, stop, tp, risk:riskAmt+fee, qty, idx:i, regime, balanceBefore };
        console.log('[🔥 ENTRY] LIVE LONG | qty=' + qty.toFixed(3) + ' | SL=$' + stop.toFixed(0) + ' | TP=$' + tp.toFixed(0));
      }
      break;
    }
    if (!found && pools.length > 0 && !isScanning) console.log('[BLOCK] No pool sweep LONG candle H='+candle.high.toFixed(0)+' L='+candle.low.toFixed(0)+' C='+candle.close.toFixed(0)+' pools='+pools.length+' active='+pools.filter(p=>p.formed<=i&&p.expires>=i).length);
  } else if (regime === 'BEAR') {
    const pools = detectPools('SHORT');
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.high <= pool.level || candle.close >= pool.level) continue;
      found = true; sweepsDetected++;
      if ((cv - pv) >= 0) { ghostsBlocked++; if(!isScanning) console.log('[CVD] Ghost blocked SHORT pool=$' + pool.level); continue; }
      const stopDist = av * STOP_ATR_MULT;
      const stop = pool.level + stopDist, tp = pool.level - stopDist * TP_R_MULT;
      if (stopDist <= 0 || pool.level >= stop) { rvolBlocked++; continue; }
      const riskAmt = equity * RISK_PCT, fee = riskAmt * FEE_RATE;
      if (!LIVE_MODE || isScanning) {
        openTrade = { side:'SHORT', entry:pool.level, stop, tp, risk:riskAmt+fee, qty:riskAmt/stopDist, idx:i, regime };
        console.log('[🔥 ENTRY] ' + (isScanning?'SCAN':'PAPER') + ' SHORT @ $' + pool.level.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2));
      } else {
        const maxQty = equity * 0.8 * 20 / candle.close;
        const qty = Math.min(riskAmt / stopDist, maxQty);
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'MARKET', quantity: qty.toFixed(3) }, true);
        if (!order) { console.error('[ORDER] FAILED SHORT MARKET entry'); continue; }
        console.log('[ORDER] MARKET SELL ' + qty.toFixed(3) + ' ETH');
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'STOP_MARKET', stopPrice: stop.toFixed(2), closePosition: 'true' }, true);
        console.log('[SL] STOP_MARKET @ $' + stop.toFixed(0));
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'LIMIT', price: tp.toFixed(2), timeInForce: 'GTC', reduceOnly: 'true' }, true);
        console.log('[TP] LIMIT TP @ $' + tp.toFixed(0));
        const balBefore = await binanceRequest('GET', '/fapi/v2/account', {}, true);
        const balanceBefore = balBefore ? +balBefore.totalWalletBalance : equity;
        openTrade = { side:'SHORT', entry:pool.level, stop, tp, risk:riskAmt+fee, qty, idx:i, regime, balanceBefore };
        console.log('[🔥 ENTRY] LIVE SHORT | qty=' + qty.toFixed(3) + ' | SL=$' + stop.toFixed(0) + ' | TP=$' + tp.toFixed(0));
      }
      break;
    }
    if (!found && !isScanning) console.log('[BLOCK] No pool sweep SHORT candle H='+candle.high.toFixed(0)+' L='+candle.low.toFixed(0)+' C='+candle.close.toFixed(0)+' pools='+pools.length+' active='+pools.filter(p=>p.formed<=i&&p.expires>=i).length);
  }
  } catch (e) { console.error('[PROCESS_CANDLE] Error:', e.message, '| i=' + i); }
}

function umpireReport() {
  const wr = trades > 0 ? (wins / trades * 100) : 0;
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
  console.log('  BulletBrain v3.0 — Live Runner');
  console.log('  Coin: ' + SYMBOL.toUpperCase() + ' | Mode: ' + (LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'));
  console.log('  MARKET entry | SL: STOP_MARKET | TP: MARKET exit | Fee: ' + (FEE_RATE*100).toFixed(2) + '%');
  console.log('  RVOL≥' + SWEEP_RVOL_MIN + ' | ' + TP_R_MULT + 'R | ' + STOP_ATR_MULT + ' ATR');
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
  for (let si = 300; si < candles.length; si++) { await processCandle(candles[si], si); }
  isScanning = false;
  console.log('  Scan found: ' + trades + ' trades (diagnostic only)');

  equity = INITIAL_CAPITAL; maxEquity = equity;
  trades = 0; wins = 0; losses = 0;
  longTrades = 0; shortTrades = 0;
  sweepsDetected = 0; ghostsBlocked = 0; rvolBlocked = 0; rangingSkipped = 0;
  openTrade = null;

  const KEEP_CANDLES = 500;
  if (candles.length > KEEP_CANDLES) {
    const removed = candles.splice(0, candles.length - KEEP_CANDLES).length;
    console.log('  RVOL baseline reset: trimmed ' + removed + ' candles, keeping ' + KEEP_CANDLES);
  }
  computeIndicators();
  console.log('  State reset. Starting LIVE with $' + equity.toFixed(2));

  let lastProcessed = candles[candles.length - 1]?.openTime || 0;
  setInterval(async () => {
    try {
      const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: SYMBOL.toUpperCase(), interval: '15m', limit: 2 }, timeout: 10000,
      });
      for (const k of resp.data) {
        const kTime = new Date(k[0]).toISOString().slice(5,16);
        if (k[0] <= lastProcessed) { if (Date.now() % 120000 < 30000) console.log('[REST] Skip old ' + kTime); continue; }
        if (k[6] > Date.now()) { console.log('[REST] Skip unclosed ' + kTime); continue; }
        console.log('[REST] Processing ' + kTime + ' vol=' + (+k[5]).toFixed(0));
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
        console.log('[WS] Candle ' + new Date(openTime).toISOString().slice(5,16) + ' close=' + (+k.c).toFixed(0));
        const candle = { openTime, closeTime: k.T, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        candles.push(candle); if (candles.length > 15000) candles.shift();
        computeIndicators();
        await processCandle(candle, candles.length - 1);
        lastProcessed = openTime;
        if (candles.length % 24 === 0) umpireReport();
      } catch (e) {}
    });
    ws.on('close', () => { console.log('[WS] Disconnected'); setTimeout(connectWS, 10000); });
    ws.on('error', (e) => { console.error('[WS] Error:', e.message || e); });
  }
  connectWS();
  console.log('[REST] Polling every 30s...');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
