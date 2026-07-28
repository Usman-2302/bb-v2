'use strict';
require('dotenv').config();
/**
 * BulletBrain v3.0 — Live Runner (LONG + SHORT)
 * BULL → LONG  |  BEAR → SHORT  |  RANGING → FLAT
 * Entry: MARKET order. SL: STOP_MARKET closePosition. TP: LIMIT reduceOnly.
 *
 * Safety invariants (hardened 2026-07-27 — do not weaken):
 *  1. A live position ALWAYS has SL+TP on the exchange, or it is immediately
 *     market-closed. There is no code path that leaves a filled entry unprotected.
 *  2. SL/TP placement is verified from the Binance response and retried once;
 *     on double failure the position is emergency-closed and the candle is aborted.
 *  3. Position state is only trusted when the API confirms it. An API failure
 *     (null response) means "unknown → keep monitoring", NEVER "flat → cancel orders".
 *  4. On startup the real balance is synced and any pre-existing position is
 *     adopted: stale orders are cancelled and fresh SL/TP are attached.
 *  5. Candle processing is claimed (lastProcessed) BEFORE any await, so the
 *     WS feed and the REST fallback can never double-process a candle.
 */

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

const SYMBOL = (process.env.BB_SYMBOL || 'ethusdt').toLowerCase();
const SYMBOL_UPPER = SYMBOL.toUpperCase();
const LIVE_MODE = process.env.BB_LIVE === 'true';
const API_KEY = process.env.BINANCE_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';
const BASE_URL = 'https://fapi.binance.com';
const INITIAL_CAPITAL = parseFloat(process.env.BB_CAPITAL || '100');

const { TICK_SIZES } = require('../../config');

// Grid-optimized strategy parameters (deliberate exception to config.js rule)
const SWEEP_RVOL_MIN = 0.3;
const STOP_ATR_MULT = 0.3;
const TP_R_MULT = 2.5;
const RISK_PCT = 0.02;
const SKIP_RANGING = true;
const FEE_RATE = 0.0004;
const TIME_EXIT_CANDLES = 50;
const LEVERAGE = 20;

const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { cvd: cvdFn } = require('../indicators/cvd');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
let atr14 = [], rvolVals = [], cvdVals = { delta: [], cumulative: [] }, ema200Vals = [];
let lastRegime = 'RANGING';
let equity = INITIAL_CAPITAL, maxEquity = equity;
let openTrade = null;
let trades = 0, wins = 0, losses = 0;
let longTrades = 0, shortTrades = 0;
let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0;

let positionSideMode = 'ONEWAY'; // 'ONEWAY' or 'HEDGE'
let tickSize = TICK_SIZES[SYMBOL_UPPER] || 0.01;
let stepSize = 0.001;
let minQty = 0, minNotional = 0;
let lastBinanceError = null;
let lastProcessed = 0;
let monitorApiFails = 0;

// ── Sign & API ─────────────────────────────────────────────
function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  params._qs = qs + '&signature=' + params.signature;
  return params;
}

async function binanceRequest(method, path, params = {}, signed = false) {
  lastBinanceError = null;
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
  } catch (e) {
    lastBinanceError = e.response?.data
      ? { code: e.response.data.code, msg: e.response.data.msg }
      : { code: 0, msg: e.message };
    console.error('[BINANCE]', e.response?.data || e.message);
    return null;
  }
}

function formatPrice(price) {
  const precision = tickSize >= 1 ? 0 : tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4;
  return parseFloat(price.toFixed(precision));
}

function formatQty(qty) {
  const precision = stepSize >= 1 ? 0 : stepSize >= 0.1 ? 1 : stepSize >= 0.01 ? 2 : stepSize >= 0.001 ? 3 : 4;
  return parseFloat(qty.toFixed(precision));
}

async function initExchangeInfo() {
  const info = await binanceRequest('GET', '/fapi/v1/exchangeInfo');
  if (!info || !Array.isArray(info.symbols)) throw new Error('exchangeInfo unavailable');
  const sym = info.symbols.find(s => s.symbol === SYMBOL_UPPER);
  if (!sym) throw new Error(SYMBOL_UPPER + ' not found on Binance futures');
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const notionalFilter = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL');
  if (priceFilter) tickSize = parseFloat(priceFilter.tickSize);
  if (lotFilter) { stepSize = parseFloat(lotFilter.stepSize); minQty = parseFloat(lotFilter.minQty); }
  if (notionalFilter) minNotional = parseFloat(notionalFilter.notional);
  console.log('[INIT] tickSize=' + tickSize + ' stepSize=' + stepSize + ' minQty=' + minQty + ' minNotional=' + minNotional);

  if (!LIVE_MODE) return; // paper mode: public info only, no signed calls

  const posSide = await binanceRequest('GET', '/fapi/v1/positionSide/dual', {}, true);
  if (!posSide) throw new Error('cannot read position mode');
  positionSideMode = (posSide.dualSidePosition === true || posSide.dualSidePosition === 'true') ? 'HEDGE' : 'ONEWAY';
  console.log('[INIT] Position mode: ' + positionSideMode);

  const lev = await binanceRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL_UPPER, leverage: LEVERAGE }, true);
  if (!lev) throw new Error('failed to set ' + LEVERAGE + 'x leverage');
  console.log('[INIT] Leverage: ' + (lev.leverage || LEVERAGE) + 'x');

  const mt = await binanceRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL_UPPER, marginType: 'ISOLATED' }, true);
  if (mt) console.log('[INIT] Margin type: ISOLATED');
  else if (lastBinanceError && lastBinanceError.code === -4046) console.log('[INIT] Margin type already ISOLATED');
  else console.error('[INIT] WARN: marginType unchanged (open position or API error) — continuing with current setting');
}

// positionSide always comes from the TRADE side, never from the order side:
// closing a LONG is side=SELL with positionSide=LONG in Hedge Mode.
function buildOrderParams(baseParams, tradeSide) {
  if (positionSideMode === 'HEDGE') baseParams.positionSide = tradeSide;
  return baseParams;
}

async function cancelAllOpenOrders() {
  await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL_UPPER }, true);
  await binanceRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol: SYMBOL_UPPER }, true);
  console.log('[CANCEL] All open orders cancelled (standard + algo)');
}

// Returns the position entry, a synthetic flat entry, or null when the API
// failed (null MUST be treated as "unknown", never as "flat").
async function getPosition(tradeSide) {
  const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL_UPPER }, true);
  if (!Array.isArray(positions)) return null;
  const matches = positions.filter(p => p.symbol === SYMBOL_UPPER);
  if (matches.length === 0) return null;
  if (positionSideMode === 'HEDGE' && tradeSide) {
    return matches.find(p => p.positionSide === tradeSide) || { positionAmt: '0' };
  }
  return matches[0];
}

// Places SL + TP for an open position. Returns order ids, or null if either
// leg could not be placed after one retry — caller MUST emergency-close then.
async function attachProtection(side, qty, stop, tp) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

  // SL via ALGO endpoint (required for STOP_MARKET conditional orders)
  const slParams = buildOrderParams({
    symbol: SYMBOL_UPPER,
    side: closeSide,
    algoType: 'CONDITIONAL',
    type: 'STOP_MARKET',
    triggerPrice: formatPrice(stop),
    closePosition: 'true'
  }, side);
  let slResult = await binanceRequest('POST', '/fapi/v1/algoOrder', slParams, true);
  if (!slResult) { await sleep(500); slResult = await binanceRequest('POST', '/fapi/v1/algoOrder', slParams, true); }
  if (!slResult) { console.error('[SL] FAILED twice @ $' + formatPrice(stop)); return null; }
  console.log('[SL] STOP_MARKET (algo) @ $' + formatPrice(stop) + ' (id ' + slResult.orderId + ')');

  // TP via standard ORDER endpoint (LIMIT is a standard order type)
  const tpParams = buildOrderParams({
    symbol: SYMBOL_UPPER,
    side: closeSide,
    type: 'LIMIT',
    price: formatPrice(tp),
    quantity: formatQty(qty),
    timeInForce: 'GTC',
    reduceOnly: 'true'
  }, side);
  let tpResult = await binanceRequest('POST', '/fapi/v1/order', tpParams, true);
  if (!tpResult) { await sleep(500); tpResult = await binanceRequest('POST', '/fapi/v1/order', tpParams, true); }
  if (!tpResult) { console.error('[TP] FAILED twice @ $' + formatPrice(tp)); return null; }
  console.log('[TP] LIMIT @ $' + formatPrice(tp) + ' qty=' + formatQty(qty) + ' (id ' + tpResult.orderId + ')');

  return { slOrderId: slResult.orderId, tpOrderId: tpResult.orderId };
}

// Last-resort flatten: cancel whatever got placed, then market reduceOnly close.
async function emergencyClose(side, qty) {
  await cancelAllOpenOrders();
  const closeParams = buildOrderParams({ symbol: SYMBOL_UPPER, side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: formatQty(qty), reduceOnly: 'true' }, side);
  let res = await binanceRequest('POST', '/fapi/v1/order', closeParams, true);
  if (!res) { await sleep(500); res = await binanceRequest('POST', '/fapi/v1/order', closeParams, true); }
  if (res) console.log('[EMERGENCY] Position closed at market');
  else console.error('[EMERGENCY] CLOSE FAILED — NAKED POSITION — MANUAL ACTION REQUIRED ON BINANCE');
}

// Full live entry pipeline. Returns 'OPENED' | 'SKIP' (try next pool) | 'ABORT' (stop this candle).
async function placeLiveTrade(side, stop, tp, stopDist, riskAmt, fee, i, regime, candle) {
  const isLong = side === 'LONG';
  const maxQty = equity * 0.8 * LEVERAGE / candle.close;
  const qty = Math.min(riskAmt / stopDist, maxQty);
  const fmtQty = formatQty(qty);
  if (!(fmtQty > 0) || fmtQty < minQty || fmtQty * candle.close < minNotional) {
    console.error('[ORDER] Size too small: qty=' + fmtQty + ' notional=$' + (fmtQty * candle.close).toFixed(2) + ' — skip');
    return 'SKIP';
  }

  // Balance BEFORE entry — the PnL baseline for this trade
  const balBefore = await binanceRequest('GET', '/fapi/v2/account', {}, true);
  if (!balBefore) { console.error('[ORDER] Cannot read balance before entry — skip'); return 'SKIP'; }
  const balanceBefore = +balBefore.totalWalletBalance;

  const entryParams = buildOrderParams({ symbol: SYMBOL_UPPER, side: isLong ? 'BUY' : 'SELL', type: 'MARKET', quantity: fmtQty }, side);
  const order = await binanceRequest('POST', '/fapi/v1/order', entryParams, true);
  if (!order) { console.error('[ORDER] FAILED ' + side + ' MARKET entry'); return 'SKIP'; }
  const fillQty = formatQty(parseFloat(order.executedQty || '0') || fmtQty);
  const fillPrice = parseFloat(order.avgPrice || '0') || candle.close;
  console.log('[ORDER] MARKET ' + (isLong ? 'BUY' : 'SELL') + ' ' + fillQty + ' @ $' + fillPrice);

  const prot = await attachProtection(side, fillQty, stop, tp);
  if (!prot) {
    console.error('[SAFETY] Protection incomplete — EMERGENCY CLOSE');
    await emergencyClose(side, fillQty);
    return 'ABORT';
  }

  openTrade = { side, entry: fillPrice, stop, tp, risk: riskAmt + fee, qty: fillQty, idx: i, regime, balanceBefore, slOrderId: prot.slOrderId, tpOrderId: prot.tpOrderId };
  console.log('[🔥 ENTRY] LIVE ' + side + ' | qty=' + fillQty + ' | SL=$' + formatPrice(stop) + ' | TP=$' + formatPrice(tp));
  return 'OPENED';
}

// Adopt a position that already exists at startup (crash/restart recovery).
async function adoptExistingPosition() {
  if (!LIVE_MODE) return;
  const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL_UPPER }, true);
  if (!Array.isArray(positions)) throw new Error('cannot verify open positions at startup');
  const open = positions.filter(p => p.symbol === SYMBOL_UPPER && Math.abs(+p.positionAmt) > 0);
  if (open.length === 0) { console.log('[INIT] No existing position — starting flat'); return; }
  if (open.length > 1) console.error('[ADOPT] WARN: multiple position entries: ' + open.map(p => p.positionSide + '=' + p.positionAmt).join(', '));

  const p = open[0];
  const amt = +p.positionAmt;
  const side = amt > 0 ? 'LONG' : 'SHORT';
  const isLong = side === 'LONG';
  const entry = +p.entryPrice;
  const qty = formatQty(Math.abs(amt));
  const lastIdx = candles.length - 1;
  const av = atr14[lastIdx] || 0;
  const cur = candles[lastIdx].close;
  console.log('[ADOPT] Existing ' + side + ' ' + qty + ' @ $' + entry + ' — re-attaching protection');

  await cancelAllOpenOrders(); // clear stale orders from before the restart

  const stopDist = av * STOP_ATR_MULT;
  if (!(stopDist > 0)) { console.error('[ADOPT] ATR unavailable — closing at market'); await emergencyClose(side, qty); return; }
  const stop = isLong ? entry - stopDist : entry + stopDist;
  const tp = isLong ? entry + stopDist * TP_R_MULT : entry - stopDist * TP_R_MULT;

  if ((isLong && cur <= stop) || (!isLong && cur >= stop)) {
    console.error('[ADOPT] Price $' + cur + ' already beyond stop $' + formatPrice(stop) + ' — closing at market');
    await emergencyClose(side, qty);
    return;
  }

  const prot = await attachProtection(side, qty, stop, tp);
  if (!prot) { console.error('[ADOPT] Protection failed — EMERGENCY CLOSE'); await emergencyClose(side, qty); return; }

  openTrade = { side, entry, stop, tp, risk: equity * RISK_PCT, qty, idx: lastIdx, regime: lastRegime, balanceBefore: equity, slOrderId: prot.slOrderId, tpOrderId: prot.tpOrderId, adopted: true };
  console.log('[ADOPT] Protected | SL=$' + formatPrice(stop) + ' | TP=$' + formatPrice(tp) + ' | PnL tracked from $' + equity.toFixed(2));
}

// ── Regime & Pool Detection ─────────────────────────────────
function detectRegime(candle, i) {
  if (i < 200) return 'RANGING';
  const e200 = ema200Vals[i], ePrev = ema200Vals[Math.max(0, i - 10)];
  if (!e200 || !ePrev) return 'RANGING';
  const priceAbove = candle.close > e200;
  const slope10 = (e200 - ePrev) / ePrev;
  const atrPct = (atr14[i] || 0) / candle.close * 100;
  if (atrPct > 5) return 'CRISIS';
  if (slope10 > 0.0005 && priceAbove) return 'BULL';
  if (slope10 < -0.0005 && !priceAbove) return 'BEAR';
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

function recordTrade(t, outcome, pnl) {
  if (equity > maxEquity) maxEquity = equity;
  trades++; if (outcome === 'WIN') wins++; else if (outcome === 'LOSS') losses++;
  if (t.side === 'LONG') longTrades++; else shortTrades++;
  console.log('[TRADE] ' + t.side + ' ' + outcome + ' | PnL: $' + pnl.toFixed(2) + ' | Balance: $' + equity.toFixed(2) + ' | WR: ' + (trades>0?(wins/trades*100).toFixed(0):'0') + '%');
}

// ══════════════════════════════════════════════════════════════
// CANDLE PROCESSING
// ══════════════════════════════════════════════════════════════
async function processCandle(candle, i) {
  try {
  const regime = detectRegime(candle, i);
  if (regime !== lastRegime) { console.log('[REGIME] ' + lastRegime + ' → ' + regime + ' @ ' + new Date(candle.openTime).toISOString().slice(5,16)); lastRegime = regime; }

  if (!isScanning) {
    const rv = rvolVals[i] || 0;
    console.log('[CANDLE] ' + new Date(candle.openTime).toISOString().slice(5,16) + ' i=' + i + ' O=' + candle.open.toFixed(0) + ' H=' + candle.high.toFixed(0) + ' L=' + candle.low.toFixed(0) + ' C=' + candle.close.toFixed(0) + ' V=' + candle.volume.toFixed(0) + ' rv=' + rv.toFixed(3) + ' rg=' + regime);
  }

  // ═══ ACTIVE TRADE MANAGEMENT ═══
  if (openTrade) {
    const t = openTrade;
    if (!LIVE_MODE || isScanning) {
      // Paper: simulated SL/TP resolution from candle extremes
      const candleReachedTP = t.side === 'LONG' ? candle.high >= t.tp : candle.low <= t.tp;
      const candleHitSL = t.side === 'LONG' ? candle.low <= t.stop : candle.high >= t.stop;
      if (candleReachedTP || candleHitSL || i - t.idx > TIME_EXIT_CANDLES) {
        let outcome, pnl;
        if (candleReachedTP) { outcome = 'WIN'; pnl = t.risk * 1.8; }
        else if (candleHitSL) { outcome = 'LOSS'; pnl = -t.risk; }
        else { outcome = 'TIME'; pnl = t.risk * 0.3; }
        equity += pnl;
        recordTrade(t, outcome, pnl);
        openTrade = null;
      }
    } else {
      // Live: only the exchange is truth. null = unknown → keep monitoring.
      const pos = await getPosition(t.side);
      if (pos && Math.abs(+pos.positionAmt) > 0) {
        monitorApiFails = 0;
        if (i - t.idx > TIME_EXIT_CANDLES && (i - t.idx) % 10 === 0) {
          console.log('[TIMEOUT] Position open ' + (i - t.idx) + ' candles — SL/TP active on exchange, monitoring');
        }
      } else if (pos) {
        // Confirmed flat → safe to clear orphan SL/TP and book the trade
        monitorApiFails = 0;
        await cancelAllOpenOrders();
        let outcome = 'CLOSED', pnl = 0;
        let acc = await binanceRequest('GET', '/fapi/v2/account', {}, true);
        if (!acc) { await sleep(500); acc = await binanceRequest('GET', '/fapi/v2/account', {}, true); }
        if (acc) {
          const newBalance = +acc.totalWalletBalance;
          pnl = newBalance - t.balanceBefore;
          outcome = pnl >= 0 ? 'WIN' : 'LOSS';
          equity = newBalance;
        } else {
          console.error('[TRADE] Balance unavailable at close — PnL unknown');
        }
        recordTrade(t, outcome, pnl);
        openTrade = null;
      } else {
        monitorApiFails++;
        if (monitorApiFails === 1 || monitorApiFails % 20 === 0) {
          console.error('[MONITOR] Position check failed x' + monitorApiFails + ' — assuming OPEN, keeping SL/TP');
        }
      }
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
        break;
      }
      const r = await placeLiveTrade('LONG', stop, tp, stopDist, riskAmt, fee, i, regime, candle);
      if (r === 'SKIP') continue;
      break; // OPENED or ABORT
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
        break;
      }
      const r = await placeLiveTrade('SHORT', stop, tp, stopDist, riskAmt, fee, i, regime, candle);
      if (r === 'SKIP') continue;
      break; // OPENED or ABORT
    }
    if (!found && !isScanning) console.log('[BLOCK] No pool sweep SHORT candle H='+candle.high.toFixed(0)+' L='+candle.low.toFixed(0)+' C='+candle.close.toFixed(0)+' pools='+pools.length+' active='+pools.filter(p=>p.formed<=i&&p.expires>=i).length);
  }
  } catch (e) { console.error('[PROCESS_CANDLE] Error:', e.message, '| i=' + i); }
}

function umpireReport() {
  const wr = trades > 0 ? (wins / trades * 100) : 0;
  console.log('════ ════ UMPIRE @ ' + new Date().toISOString() + ' ════ ═════');
  console.log('  Coin: ' + SYMBOL_UPPER + ' | Regime: ' + lastRegime + ' | Mode: ' + (LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'));
  console.log('  Equity: $' + equity.toFixed(2) + ' | Trades: ' + trades + ' (L:' + longTrades + '/S:' + shortTrades + ') | WR: ' + wr.toFixed(0) + '% | PnL: $' + (equity - INITIAL_CAPITAL).toFixed(2));
  console.log('  Sweeps: ' + sweepsDetected + ' | Ghosts: ' + ghostsBlocked + ' | RVOL skip: ' + rvolBlocked + ' | Range skip: ' + rangingSkipped);
  console.log('═══════════════════════════════════════════════════');
}

function computeIndicators() {
  if (candles.length < 200) return;
  atr14 = atr(candles, 14);
  rvolVals = simpleRvol(candles, 20);
  cvdVals = cvdFn(candles);
  ema200Vals = ema(candles.map(c => c.close), 200);
}

// Single entry point for every new closed candle (WS + REST fallback).
// Claims lastProcessed BEFORE any await → the two feeds can never double-process.
async function onNewCandle(candle) {
  if (candle.openTime <= lastProcessed) return false;
  lastProcessed = candle.openTime;
  if (candles.length > 0 && candles[candles.length - 1].openTime === candle.openTime) candles.pop();
  candles.push(candle);
  if (candles.length > 15000) candles.shift();
  computeIndicators();
  await processCandle(candle, candles.length - 1);
  if (candles.length % 24 === 0) umpireReport();
  return true;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  BulletBrain v3.0 — Live Runner');
  console.log('  Coin: ' + SYMBOL_UPPER + ' | Mode: ' + (LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'));
  console.log('  MARKET entry | SL: STOP_MARKET | TP: LIMIT reduceOnly | Fee: ' + (FEE_RATE*100).toFixed(2) + '%');
  console.log('  RVOL≥' + SWEEP_RVOL_MIN + ' | ' + TP_R_MULT + 'R | ' + STOP_ATR_MULT + ' ATR');
  console.log('═══════════════════════════════════════════════');

  if (LIVE_MODE && (!API_KEY || !SECRET_KEY)) {
    console.error('FATAL: BB_LIVE=true but BINANCE_API_KEY / BINANCE_SECRET_KEY missing');
    process.exit(1);
  }

  await initExchangeInfo();

  console.log('Backfilling 1500 candles...');
  const endTime = Date.now(), startTime = endTime - 1500 * 15 * 60 * 1000;
  try {
    const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: SYMBOL_UPPER, interval: '15m', startTime, endTime, limit: 1500 }, timeout: 15000,
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

  if (LIVE_MODE) {
    const acc = await binanceRequest('GET', '/fapi/v2/account', {}, true);
    if (!acc) { console.error('FATAL: cannot read account balance at startup'); process.exit(1); }
    equity = +acc.totalWalletBalance; maxEquity = equity;
    console.log('[INIT] Balance synced: $' + equity.toFixed(2));
    await adoptExistingPosition();
  }
  console.log('  State reset. Starting ' + (LIVE_MODE ? 'LIVE' : 'PAPER') + ' with $' + equity.toFixed(2));

  lastProcessed = candles[candles.length - 1]?.openTime || 0;

  setInterval(async () => {
    try {
      const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
        params: { symbol: SYMBOL_UPPER, interval: '15m', limit: 2 }, timeout: 10000,
      });
      for (const k of resp.data) {
        if (k[6] > Date.now()) continue; // unclosed candle
        const candle = { openTime: k[0], closeTime: k[6], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
        if (await onNewCandle(candle)) console.log('[REST] Processed ' + new Date(k[0]).toISOString().slice(5,16) + ' (WS fallback)');
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
        const k = msg.k;
        const candle = { openTime: k.t, closeTime: k.T, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        if (await onNewCandle(candle)) console.log('[WS] Candle ' + new Date(candle.openTime).toISOString().slice(5,16) + ' close=' + candle.close.toFixed(0));
      } catch (e) {}
    });
    ws.on('close', () => { console.log('[WS] Disconnected'); setTimeout(connectWS, 10000); });
    ws.on('error', (e) => { console.error('[WS] Error:', e.message || e); });
  }
  connectWS();
  console.log('[REST] Polling every 30s...');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
