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
 *  5. Candle processing is claimed (lastProcessed) BEFORE any await, AND the
 *     body is serialised, so the WS feed and the REST fallback can neither
 *     double-process one candle nor process two candles concurrently.
 *  6. TIME_EXIT_CANDLES is ENFORCED live, not just logged. A position past the
 *     limit is market-closed; the next poll confirms flat and books the PnL.
 *  7. Paper/scan mode prices fills with the same real fee schedule and the same
 *     MARKET entry as live, and resolves SL before TP when one candle spans both.
 *     It must never report a result the live path could not achieve.
 *  8. Prices and quantities are quantised to the exchange increment (a multiple
 *     of tickSize/stepSize), not to a decimal place count.
 *
 * ⚠ STRATEGY STATUS — READ BEFORE ENABLING BB_LIVE=true
 *   These parameters (RVOL 0.3 / 0.3xATR stop / 2.5R) were grid-searched and
 *   never cost-aware backtested. `npm run backtest:replica` reproduces this exact
 *   logic over 195,294 ETH 15m candles (2021-01 -> 2026-07):
 *     zero costs     : +0.013 R/trade, PF 0.86   (no gross edge)
 *     real fees      : -0.336 R/trade, PF 0.38
 *     fees+slippage  : -0.611 R/trade, PF 0.14
 *   Realised R:R is 0.26:1, not the nominal 2.5:1, because stop and target are
 *   anchored to pool.level while entry is a MARKET fill at candle close. BTC
 *   reproduces this independently. The fixes below make an edgeless strategy
 *   execute CORRECTLY — they do not create an edge. See AUDIT.md / QUANT-REVIEW.md.
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
const TIME_EXIT_CANDLES = 50;
const LEVERAGE = 20;

// Real Binance USD-M fee schedule, measured from this account's own
// /fapi/v1/userTrades fills (entry 0.05000% taker, TP 0.02000% maker).
// The previous single FEE_RATE=0.0004 was both the wrong rate AND applied to
// riskAmt instead of notional, understating true cost by ~3 orders of magnitude.
// A STOP_MARKET stop can never rest, so a loss always pays taker on BOTH legs.
const TAKER_FEE = 0.0005;
const MAKER_FEE = 0.0002;
const WIN_COST_RATE = TAKER_FEE + MAKER_FEE;   // MARKET in, LIMIT TP out
const LOSS_COST_RATE = TAKER_FEE + TAKER_FEE;  // MARKET in, STOP_MARKET out

// Refuse setups whose TP cannot clear round-trip cost by this factor.
// 0 disables the filter (default: preserves existing behaviour).
const MIN_EDGE_COST_MULT = parseFloat(process.env.BB_MIN_EDGE || '0');

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
let sweepsDetected = 0, ghostsBlocked = 0, rvolBlocked = 0, rangingSkipped = 0, edgeBlocked = 0;

let positionSideMode = 'ONEWAY'; // 'ONEWAY' or 'HEDGE'
let tickSize = TICK_SIZES[SYMBOL_UPPER] || 0.01;
let stepSize = 0.001;
let minQty = 0, minNotional = 0;
let lastBinanceError = null;
let lastProcessed = 0;
let monitorApiFails = 0;

// Serialises candle processing. `lastProcessed` stops the SAME candle being
// handled twice, but it does NOT stop the WS feed and the REST poll handling two
// DIFFERENT candles concurrently — both would await, both would observe
// openTrade == null, and both would open a position. Candle boundaries are
// precisely when both feeds fire, so this is not a remote possibility.
let candleChain = Promise.resolve();
function serialise(fn) {
  const next = candleChain.then(fn, fn);
  candleChain = next.catch(() => {});   // a rejected link must not kill the chain
  return next;
}

// Quantise to an exchange increment. Deriving a decimal precision from tickSize
// only works when the tick is a power of ten: a 0.5 tick with "1 decimal place"
// happily produces 1877.3, which Binance rejects (-1111 / -4014). Round to a
// MULTIPLE of the increment instead.
function roundToIncrement(value, increment, mode = 'round') {
  if (!(increment > 0)) return value;
  const n = value / increment;
  const k = mode === 'floor' ? Math.floor(n + 1e-9) : Math.round(n);
  const decimals = Math.max(0, Math.min(12, (String(increment).split('.')[1] || '').length));
  return parseFloat((k * increment).toFixed(decimals));
}

// ── Sign & API ─────────────────────────────────────────────
function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  params._qs = qs + '&signature=' + params.signature;
  return params;
}

// Offset between Binance server time and the local clock. A VPS whose clock has
// drifted more than recvWindow gets every signed request rejected with -1021,
// which surfaces as "protection failed" rather than as a clock problem.
let timeOffsetMs = 0;
async function syncServerTime() {
  try {
    const r = await axios.get(BASE_URL + '/fapi/v1/time', { timeout: 10000 });
    if (r.data && r.data.serverTime) {
      timeOffsetMs = r.data.serverTime - Date.now();
      console.log('[INIT] Clock offset vs Binance: ' + timeOffsetMs + 'ms');
      if (Math.abs(timeOffsetMs) > 2000) {
        console.error('[INIT] WARN: clock is off by ' + timeOffsetMs + 'ms — fix NTP on this host');
      }
    }
  } catch (e) { console.error('[INIT] time sync failed:', e.message); }
}

async function binanceRequest(method, path, params = {}, signed = false) {
  lastBinanceError = null;
  if (signed) params = sign({ ...params, timestamp: Date.now() + timeOffsetMs, recvWindow: 5000 });
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
  return roundToIncrement(price, tickSize, 'round');
}

// Quantity floors: rounding UP can exceed available margin or breach reduceOnly.
function formatQty(qty) {
  return roundToIncrement(qty, stepSize, 'floor');
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

// Single sizing path for BOTH paper and live, so the two can never disagree.
//
// riskAmt is now a cap on the TOTAL loss (price move + both fee legs), not just
// the price component, and it measures from the ACTUAL entry rather than from
// pool.level. Previously qty = riskAmt/stopDist ignored fees and used the wrong
// anchor, so a "2% risk" trade lost ~2.8% of equity when the stop hit.
function sizePosition(stop, price) {
  const riskAmt = equity * RISK_PCT;
  const perUnitLoss = Math.abs(price - stop) + price * LOSS_COST_RATE;
  const riskQty = perUnitLoss > 0 ? riskAmt / perUnitLoss : 0;
  const maxQty = equity * 0.8 * LEVERAGE / price;
  const qty = Math.min(riskQty, maxQty);
  return {
    qty, riskAmt,
    feeEst: qty * price * LOSS_COST_RATE,
    cappedBy: maxQty < riskQty ? 'LEVERAGE' : 'RISK_PCT',
  };
}

// Reject setups whose target cannot pay for the round trip.
function clearsCostFloor(entryRef, tpDist) {
  if (!(MIN_EDGE_COST_MULT > 0)) return true;
  return (tpDist / entryRef) >= MIN_EDGE_COST_MULT * WIN_COST_RATE;
}

// positionSide always comes from the TRADE side, never from the order side:
// closing a LONG is side=SELL with positionSide=LONG in Hedge Mode.
function buildOrderParams(baseParams, tradeSide) {
  if (positionSideMode === 'HEDGE') baseParams.positionSide = tradeSide;
  return baseParams;
}

// Reports what actually happened. This previously printed unconditional success
// even when both DELETEs failed, which would hide an orphaned STOP_MARKET sitting
// on the exchange after the bot believed it was flat.
async function cancelAllOpenOrders() {
  const std = await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL_UPPER }, true);
  const algo = await binanceRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol: SYMBOL_UPPER }, true);
  if (std && algo) {
    console.log('[CANCEL] All open orders cancelled (standard + algo)');
  } else {
    console.error('[CANCEL] INCOMPLETE — standard=' + (std ? 'ok' : 'FAILED') +
      ' algo=' + (algo ? 'ok' : 'FAILED') +
      ' — an orphaned protective order may still be live on the exchange');
  }
  return !!(std && algo);
}

// Returns the position entry, a synthetic flat entry, or null when the API
// failed (null MUST be treated as "unknown", never as "flat").
async function getPosition(tradeSide) {
  const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL_UPPER }, true);
  if (!Array.isArray(positions)) return null;   // API failure → unknown
  const matches = positions.filter(p => p.symbol === SYMBOL_UPPER);
  // An empty array is a SUCCESSFUL response meaning "no position on this symbol",
  // i.e. flat. Returning null here made the bot treat flat as "unknown" and hold
  // openTrade forever, so the trade never booked and no new signal could fire.
  // Latent on /fapi/v2/positionRisk; ACTIVE the moment v3 is adopted, which omits
  // flat positions by design.
  if (matches.length === 0) return { positionAmt: '0' };
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
  if (!slResult) { 
    const err = lastBinanceError ? ' code=' + lastBinanceError.code + ' msg=' + lastBinanceError.msg : '';
    console.error('[SL] FAILED twice @ $' + formatPrice(stop) + err); 
    return null; 
  }
  console.log('[SL] STOP_MARKET (algo) @ $' + formatPrice(stop) + ' (id ' + slResult.algoId + ')');

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
  if (!tpResult) { 
    const err = lastBinanceError ? ' code=' + lastBinanceError.code + ' msg=' + lastBinanceError.msg : '';
    console.error('[TP] FAILED twice @ $' + formatPrice(tp) + err); 
    return null; 
  }
  console.log('[TP] LIMIT @ $' + formatPrice(tp) + ' qty=' + formatQty(qty) + ' (id ' + tpResult.orderId + ')');

  return { slOrderId: slResult.algoId, tpOrderId: tpResult.orderId };
}

// Last-resort flatten: cancel whatever got placed, then market reduceOnly close.
async function emergencyClose(side, qty) {
  await cancelAllOpenOrders();
  const closeParams = buildOrderParams({ symbol: SYMBOL_UPPER, side: side === 'LONG' ? 'SELL' : 'BUY', type: 'MARKET', quantity: formatQty(qty), reduceOnly: 'true' }, side);
  let res = await binanceRequest('POST', '/fapi/v1/order', closeParams, true);
  if (!res) { await sleep(500); res = await binanceRequest('POST', '/fapi/v1/order', closeParams, true); }
  if (res) {
    console.log('[EMERGENCY] Position closed at market');
    // Resync equity from the wallet. An emergency close never goes through the
    // openTrade booking path, so without this the in-process equity stays stale
    // and every subsequent position is sized off a balance that no longer exists.
    const acc = await binanceRequest('GET', '/fapi/v2/account', {}, true);
    if (acc) {
      equity = +acc.totalWalletBalance;
      if (equity > maxEquity) maxEquity = equity;
      console.log('[EMERGENCY] Equity resynced: $' + equity.toFixed(2));
    } else {
      console.error('[EMERGENCY] Equity resync FAILED — sizing may use a stale balance');
    }
  } else {
    // A reduceOnly close is REJECTED when the position is already flat (e.g. the
    // stop filled in the meantime). Confirm with the exchange before screaming
    // "naked position" — a false alarm every time trains you to ignore the real one.
    const pos = await getPosition(side);
    if (pos && Math.abs(+pos.positionAmt) === 0) {
      console.log('[EMERGENCY] Close rejected but position is already FLAT — nothing to do');
      const acc = await binanceRequest('GET', '/fapi/v2/account', {}, true);
      if (acc) equity = +acc.totalWalletBalance;
    } else if (pos) {
      console.error('[EMERGENCY] CLOSE FAILED — NAKED POSITION amt=' + pos.positionAmt +
        ' — MANUAL ACTION REQUIRED ON BINANCE');
    } else {
      console.error('[EMERGENCY] CLOSE FAILED and position state UNKNOWN — CHECK BINANCE MANUALLY');
    }
  }
}

// Full live entry pipeline. Returns 'OPENED' | 'SKIP' (try next pool) | 'ABORT' (stop this candle).
async function placeLiveTrade(side, stop, tp, stopDist, riskAmt, fee, i, regime, candle) {
  const isLong = side === 'LONG';
  const sized = sizePosition(stop, candle.close);
  const qty = sized.qty;
  const fmtQty = formatQty(qty);
  // Which constraint actually governs size. At small equity with 20x leverage the
  // cap — not RISK_PCT — is usually binding, so "2% risk" is not what is running.
  console.log('[SIZE] capped-by=' + sized.cappedBy + ' qty=' + fmtQty +
    ' notional=$' + (qty * candle.close).toFixed(2) +
    ' (' + (qty * candle.close / equity).toFixed(1) + 'x equity)');
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
    // An aborted entry still cost a round trip in fees and slippage. It never
    // reached recordTrade, so these losses were invisible to the umpire's win
    // rate — the reported WR was better than reality by exactly the worst cases.
    const after = await binanceRequest('GET', '/fapi/v2/account', {}, true);
    const realised = after ? (+after.totalWalletBalance - balanceBefore) : 0;
    if (after) equity = +after.totalWalletBalance;
    recordTrade({ side, regime }, 'ABORT', realised);
    return 'ABORT';
  }

  // entryOpenTime, not a buffer index: candles.shift() at the 15000 cap slides
  // every index, which silently corrupted the time-exit countdown.
  openTrade = { side, entry: fillPrice, stop, tp, risk: riskAmt + fee, qty: fillQty, entryOpenTime: candle.openTime, regime, balanceBefore, slOrderId: prot.slOrderId, tpOrderId: prot.tpOrderId };
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

  openTrade = { side, entry, stop, tp, risk: equity * RISK_PCT, qty, entryOpenTime: candles[lastIdx].openTime, regime: lastRegime, balanceBefore: equity, slOrderId: prot.slOrderId, tpOrderId: prot.tpOrderId, adopted: true };
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
      // Round to the symbol's tick, not to whole units. Math.floor() here threw
      // away up to ~$1 of level precision on ETH (~0.05%, comparable to the whole
      // fee budget) and collapsed to 0 on any sub-$1 symbol, producing a zero
      // pool level and nonsensical stop/TP.
      const mid = (v1 + v2) / 2;
      pools.push({ level: roundToIncrement(mid, tickSize), formed: sj, expires: sj + 500 });
    }
  }
  return pools;
}

function recordTrade(t, outcome, pnl) {
  if (equity > maxEquity) maxEquity = equity;
  // Count by realised P&L, not by label, so ABORT/TIME exits land in the right
  // bucket instead of vanishing from the win-rate numerator.
  trades++; if (pnl > 0) wins++; else losses++;
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
    const heldCandles = Math.round((candle.openTime - t.entryOpenTime) / (15 * 60 * 1000));
    if (!LIVE_MODE || isScanning) {
      // Paper: resolve from candle extremes and price the fills for real.
      // Previously this booked a flat risk*1.8 on any TP touch, -risk on any SL
      // touch, and resolved TP first when a candle contained both — i.e. it could
      // not lose to fees or intrabar sequence. Those are exactly what decide this
      // strategy, so the old scan output was meaningless.
      const candleReachedTP = t.side === 'LONG' ? candle.high >= t.tp : candle.low <= t.tp;
      const candleHitSL = t.side === 'LONG' ? candle.low <= t.stop : candle.high >= t.stop;
      const timedOut = heldCandles >= TIME_EXIT_CANDLES;
      if (candleReachedTP || candleHitSL || timedOut) {
        const isLong = t.side === 'LONG';
        let outcome, exitPrice, exitMaker;
        // A single 15m candle often spans both levels; OHLC cannot order them.
        // Assume the stop filled first — the conservative reading.
        if (candleHitSL) { outcome = 'LOSS'; exitPrice = t.stop; exitMaker = false; }
        else if (candleReachedTP) { outcome = 'WIN'; exitPrice = t.tp; exitMaker = true; }
        else { outcome = 'TIME'; exitPrice = candle.close; exitMaker = false; }
        const gross = (isLong ? exitPrice - t.entry : t.entry - exitPrice) * t.qty;
        const fees = t.qty * t.entry * TAKER_FEE +
                     t.qty * exitPrice * (exitMaker ? MAKER_FEE : TAKER_FEE);
        const pnl = gross - fees;
        // Reconcile the label with reality: hitting TP but finishing negative
        // after fees is a LOSS, and labelling it WIN is exactly the misleading
        // signal that hid the fee problem in the first place.
        if (pnl > 0 && outcome !== 'WIN') outcome = 'WIN';
        if (pnl <= 0 && outcome === 'WIN') outcome = 'TP_BUT_LOSS';
        equity += pnl;
        recordTrade(t, outcome, pnl);
        openTrade = null;
      }
    } else {
      // Live: only the exchange is truth. null = unknown → keep monitoring.
      const pos = await getPosition(t.side);
      if (pos && Math.abs(+pos.positionAmt) > 0) {
        monitorApiFails = 0;
        // TIME_EXIT_CANDLES was previously only logged, never acted on, so a live
        // position could be held indefinitely while paper/backtest exited at 50.
        if (heldCandles >= TIME_EXIT_CANDLES) {
          console.log('[TIMEOUT] ' + heldCandles + ' candles held — closing at market (time exit)');
          await emergencyClose(t.side, formatQty(Math.abs(+pos.positionAmt)));
          // fall through: the next poll confirms flat and books the PnL
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

  // detectPools is O(n^2) over the whole buffer; it was previously called twice
  // per candle (once just to print a count). Compute once and reuse.
  const poolType = regime === 'BULL' ? 'LONG' : 'SHORT';
  const pools = detectPools(poolType);
  console.log('[CHECK-PASS] regime='+regime+' rv='+rv.toFixed(2)+' pools='+pools.length+' candle='+new Date(candle.openTime).toISOString().slice(5,16));

  let found = false;
  if (regime === 'BULL') {
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.low >= pool.level || candle.close <= pool.level) continue;
      found = true; sweepsDetected++;
      if ((cv - pv) <= 0) { ghostsBlocked++; if(!isScanning) console.log('[CVD] Ghost blocked LONG pool=$' + pool.level); continue; }
      const stopDist = av * STOP_ATR_MULT;
      const stop = pool.level - stopDist, tp = pool.level + stopDist * TP_R_MULT;
      if (stopDist <= 0 || pool.level <= stop) { rvolBlocked++; continue; }
      if (!clearsCostFloor(candle.close, tp - candle.close)) { edgeBlocked++; continue; }
      const { qty: sizedQty, riskAmt, feeEst } = sizePosition(stop, candle.close);
      if (!LIVE_MODE || isScanning) {
        // Paper/scan must model the SAME market entry the live path takes.
        // Booking entry at pool.level flatters every result: for a long sweep
        // candle.low < pool.level < candle.close, so the real fill is worse.
        openTrade = { side:'LONG', entry:candle.close, stop, tp, risk:riskAmt, qty:sizedQty, entryOpenTime:candle.openTime, regime };
        console.log('[🔥 ENTRY] ' + (isScanning?'SCAN':'PAPER') + ' LONG @ $' + candle.close.toFixed(2) + ' | Risk: $' + riskAmt.toFixed(2));
        break;
      }
      const r = await placeLiveTrade('LONG', stop, tp, stopDist, riskAmt, feeEst, i, regime, candle);
      if (r === 'SKIP') continue;
      break; // OPENED or ABORT
    }
    if (!found && pools.length > 0 && !isScanning) console.log('[BLOCK] No pool sweep LONG candle H='+candle.high.toFixed(0)+' L='+candle.low.toFixed(0)+' C='+candle.close.toFixed(0)+' pools='+pools.length+' active='+pools.filter(p=>p.formed<=i&&p.expires>=i).length);
  } else if (regime === 'BEAR') {
    for (const pool of pools) {
      if (pool.formed > i || pool.expires < i) continue;
      if (candle.high <= pool.level || candle.close >= pool.level) continue;
      found = true; sweepsDetected++;
      if ((cv - pv) >= 0) { ghostsBlocked++; if(!isScanning) console.log('[CVD] Ghost blocked SHORT pool=$' + pool.level); continue; }
      const stopDist = av * STOP_ATR_MULT;
      const stop = pool.level + stopDist, tp = pool.level - stopDist * TP_R_MULT;
      if (stopDist <= 0 || pool.level >= stop) { rvolBlocked++; continue; }
      if (!clearsCostFloor(candle.close, candle.close - tp)) { edgeBlocked++; continue; }
      const { qty: sizedQty, riskAmt, feeEst } = sizePosition(stop, candle.close);
      if (!LIVE_MODE || isScanning) {
        openTrade = { side:'SHORT', entry:candle.close, stop, tp, risk:riskAmt, qty:sizedQty, entryOpenTime:candle.openTime, regime };
        console.log('[🔥 ENTRY] ' + (isScanning?'SCAN':'PAPER') + ' SHORT @ $' + candle.close.toFixed(2) + ' | Risk: $' + riskAmt.toFixed(2));
        break;
      }
      const r = await placeLiveTrade('SHORT', stop, tp, stopDist, riskAmt, feeEst, i, regime, candle);
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
  console.log('  Sweeps: ' + sweepsDetected + ' | Ghosts: ' + ghostsBlocked + ' | RVOL skip: ' + rvolBlocked + ' | Range skip: ' + rangingSkipped + ' | Edge skip: ' + edgeBlocked);
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
  // Claim the candle synchronously (before any await) so the same candle cannot
  // be taken twice, THEN serialise the body so two different candles from the two
  // feeds cannot be processed concurrently and both open a position.
  if (candle.openTime <= lastProcessed) return false;
  lastProcessed = candle.openTime;
  return serialise(async () => {
    if (candles.length > 0 && candles[candles.length - 1].openTime === candle.openTime) candles.pop();
    candles.push(candle);
    if (candles.length > 15000) candles.shift();
    computeIndicators();
    await processCandle(candle, candles.length - 1);
    if (candles.length % 24 === 0) umpireReport();
    return true;
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  BulletBrain v3.0 — Live Runner');
  console.log('  Coin: ' + SYMBOL_UPPER + ' | Mode: ' + (LIVE_MODE ? '🔴 LIVE' : '📄 PAPER'));
  console.log('  MARKET entry | SL: STOP_MARKET | TP: LIMIT reduceOnly');
  console.log('  Fees: taker ' + (TAKER_FEE*100).toFixed(3) + '% / maker ' + (MAKER_FEE*100).toFixed(3) +
    '% → win costs ' + (WIN_COST_RATE*100).toFixed(3) + '%, loss costs ' + (LOSS_COST_RATE*100).toFixed(3) + '%');
  console.log('  Min-edge filter: ' + (MIN_EDGE_COST_MULT > 0
    ? MIN_EDGE_COST_MULT + 'x round-trip cost (BB_MIN_EDGE)' : 'DISABLED'));
  console.log('  RVOL≥' + SWEEP_RVOL_MIN + ' | ' + TP_R_MULT + 'R | ' + STOP_ATR_MULT + ' ATR');
  console.log('═══════════════════════════════════════════════');

  if (LIVE_MODE && (!API_KEY || !SECRET_KEY)) {
    console.error('FATAL: BB_LIVE=true but BINANCE_API_KEY / BINANCE_SECRET_KEY missing');
    process.exit(1);
  }

  await syncServerTime();
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
  sweepsDetected = 0; ghostsBlocked = 0; rvolBlocked = 0; rangingSkipped = 0; edgeBlocked = 0;
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
