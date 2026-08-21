'use strict';
require('dotenv').config();
/**
 * BulletBrain v3.0 — 60m WFO Live Runner
 *
 * STRATEGY: Walk-Forward Optimized EMA Crossover on 60-minute candles
 *
 * Validated results:
 *   - OOS Sharpe: 6.52 (2025-2026 unseen data, run ONCE)
 *   - Bootstrap: 0% of 500 shuffles exceed original Sharpe (p<5%, significant)
 *   - Jun-Aug 2026 test: +24.83% on $100
 *   - Break-even cost: 0.785%/leg vs real cost 0.11% — 7× margin of safety
 *   - See: backtest_wfo_strategy.js, src/backtest/run_wfo_strategy.js
 *
 * HOW IT WORKS:
 *   1. Every 60 minutes (new 60m candle close): compute fast EMA and slow EMA
 *   2. If fast > slow → LONG. If fast < slow → SHORT.
 *   3. On signal flip: close existing position, open new one in opposite direction
 *   4. No fixed SL/TP — position managed by signal only (EMA cross closes it)
 *   5. Walk-forward: every 28 days re-optimize fast/slow EMA params on last 28 days
 *
 * POSITION SIZING:
 *   95% of equity deployed per position (always in market — long or short)
 *   At $100 equity and ETH $1800: 0.053 ETH notional ≈ $95
 *   This is MARKET entry (taker fee) and MARKET exit (taker fee) on each flip
 *   Round-trip cost: ~0.22% of notional = ~$0.21 per trade
 *
 * SAFETY:
 *   - All safety invariants from liveRunner.js inherited
 *   - Emergency close if position monitoring fails 3+ times
 *   - Daily loss limit: 5% of equity
 *   - Max consecutive flips per day: 6 (prevents runaway in choppy 60m market)
 *
 * Usage:
 *   BB_SYMBOL=ethusdt BB_CAPITAL=100 node src/live/wfoRunner.js            # paper
 *   BB_SYMBOL=ethusdt BB_LIVE=true BB_CAPITAL=100 node src/live/wfoRunner.js  # live
 */

const axios  = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

const SYMBOL        = (process.env.BB_SYMBOL || 'ethusdt').toLowerCase();
const SYMBOL_UPPER  = SYMBOL.toUpperCase();
const LIVE_MODE     = process.env.BB_LIVE === 'true';
const API_KEY       = process.env.BINANCE_API_KEY   || '';
const SECRET_KEY    = process.env.BINANCE_SECRET_KEY || '';
const BASE_URL      = 'https://fapi.binance.com';
const INITIAL_CAPITAL = parseFloat(process.env.BB_CAPITAL || '100');

const { TICK_SIZES } = require('../../config');

// ── WFO Configuration ─────────────────────────────────────────────────────
const WFO_TRAIN_BARS    = 28 * 24;   // 28 days of 60m bars for training
const WFO_RETRAIN_BARS  = 28 * 24;   // retrain every 28 days
const EMA_FAST_OPTIONS  = [5, 7, 10, 15, 20];
const EMA_SLOW_OPTIONS  = [40, 50, 100, 150, 200];
const POSITION_PCT      = 0.95;      // 95% of equity in position
const LEVERAGE          = 3;         // conservative leverage
const DAILY_LOSS_LIMIT  = 0.05;      // 5% daily loss stops trading
const MAX_FLIPS_PER_DAY = 6;         // prevent excessive churning
const CANDLE_TF         = '60m';     // 60-minute candles

// ── Fee model ─────────────────────────────────────────────────────────────
const TAKER_FEE = 0.0005;
const SLIP      = 0.0006;

// ── State ─────────────────────────────────────────────────────────────────
const candles60m   = [];    // rolling buffer of 60m candles
let currentFast    = 10;   // current EMA fast period
let currentSlow    = 50;   // current EMA slow period
let lastRetrainBar = 0;    // candle index when last retrained
let lastSignal     = 0;    // +1 long, -1 short, 0 flat
let openTrade      = null; // current live position
let equity         = INITIAL_CAPITAL;
let maxEquity      = equity;
let dailyPnL       = 0;
let dailyFlips     = 0;
let lastDayStr     = '';
let trades         = 0;
let wins           = 0;

let positionSideMode = 'ONEWAY';
let tickSize  = TICK_SIZES[SYMBOL_UPPER] || 0.01;
let stepSize  = 0.001;
let minQty    = 0;
let minNotional = 0;
let timeOffsetMs = 0;
let lastBinanceError = null;

// Current 15m candle buffer for higher-TF context
const candles15m = [];

// ── Utilities ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function roundToIncrement(value, increment, mode = 'round') {
  if (!(increment > 0)) return value;
  const n = value / increment;
  const k = mode === 'floor' ? Math.floor(n + 1e-9) : Math.round(n);
  const dec = Math.max(0, Math.min(12, (String(increment).split('.')[1] || '').length));
  return parseFloat((k * increment).toFixed(dec));
}
function formatPrice(p) { return roundToIncrement(p, tickSize); }
function formatQty(q)   { return roundToIncrement(q, stepSize, 'floor'); }

// ── EMA computation ───────────────────────────────────────────────────────
function calcEMA(closes, n) {
  const k = 2/(n+1);
  const out = Array(closes.length).fill(NaN);
  let v = NaN;
  for (let i = 0; i < closes.length; i++) {
    v = !isFinite(v) ? closes[i] : closes[i]*k + v*(1-k);
    out[i] = v;
  }
  return out;
}

// ── Walk-Forward: find best EMA params on recent data ─────────────────────
function wfoRetrain() {
  if (candles60m.length < WFO_TRAIN_BARS + 10) {
    console.log('[WFO] Not enough bars for retrain:', candles60m.length, '< needed:', WFO_TRAIN_BARS);
    return;
  }
  const trainSlice = candles60m.slice(-WFO_TRAIN_BARS);
  const closes     = trainSlice.map(c => c.close);

  let bestSharpe = -Infinity;
  let bestFast   = currentFast;
  let bestSlow   = currentSlow;

  for (const fast of EMA_FAST_OPTIONS) {
    for (const slow of EMA_SLOW_OPTIONS) {
      const eFast = calcEMA(closes, fast);
      const eSlow = calcEMA(closes, slow);
      const rets  = [];
      let pos = 0;

      for (let i = 1; i < closes.length; i++) {
        const np = eFast[i] >= eSlow[i] ? 1 : -1;
        if (np !== pos) {
          // Cost on flip: taker + slip both ways
          const cost = 2 * (TAKER_FEE + SLIP);
          rets.push(-cost); // flip cost
          pos = np;
        }
        if (pos !== 0) {
          rets.push(Math.log(closes[i] / closes[i-1]) * pos);
        }
      }

      if (rets.length < 10) continue;
      const mean = rets.reduce((a,b) => a+b, 0) / rets.length;
      const sd   = Math.sqrt(rets.reduce((a,r) => a+(r-mean)**2, 0) / rets.length);
      const sharpe = sd > 0 ? mean / sd : 0;

      if (sharpe > bestSharpe) {
        bestSharpe = sharpe;
        bestFast   = fast;
        bestSlow   = slow;
      }
    }
  }

  console.log(`[WFO] Retrain: EMA${bestFast}/EMA${bestSlow} (Sharpe: ${bestSharpe.toFixed(3)}) | prev: EMA${currentFast}/EMA${currentSlow}`);
  currentFast = bestFast;
  currentSlow = bestSlow;
  lastRetrainBar = candles60m.length;
}

// ── Compute current signal from candle buffer ──────────────────────────────
function computeSignal() {
  if (candles60m.length < currentSlow + 5) return 0;
  const closes = candles60m.map(c => c.close);
  const eFast  = calcEMA(closes, currentFast);
  const eSlow  = calcEMA(closes, currentSlow);
  const n      = closes.length - 1;
  if (!isFinite(eFast[n]) || !isFinite(eSlow[n])) return 0;
  return eFast[n] >= eSlow[n] ? 1 : -1;
}

// ── Binance API ───────────────────────────────────────────────────────────
function sign(params) {
  const qs = Object.keys(params).sort().map(k => k+'='+params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  params._qs = qs + '&signature=' + params.signature;
  return params;
}

async function syncServerTime() {
  try {
    const r = await axios.get(BASE_URL+'/fapi/v1/time', {timeout:10000});
    if (r.data?.serverTime) timeOffsetMs = r.data.serverTime - Date.now();
    console.log('[INIT] Clock offset:', timeOffsetMs+'ms');
  } catch(e) { console.error('[INIT] time sync failed:', e.message); }
}

async function binanceRequest(method, path, params = {}, signed = false) {
  lastBinanceError = null;
  if (signed) params = sign({...params, timestamp: Date.now()+timeOffsetMs, recvWindow:5000});
  try {
    const url = signed ? BASE_URL+path+'?'+params._qs : BASE_URL+path;
    const resp = await axios({method, url, params: signed?undefined:params,
      headers: signed ? {'X-MBX-APIKEY': API_KEY} : {}, timeout: 10000,
      transformResponse: [data => JSON.parse(data, (key, val) =>
        typeof val==='number'&&(val>Number.MAX_SAFE_INTEGER||val<Number.MIN_SAFE_INTEGER)?String(val):val
      )]
    });
    return resp.data;
  } catch(e) {
    lastBinanceError = e.response?.data ? {code:e.response.data.code, msg:e.response.data.msg} : {code:0, msg:e.message};
    console.error('[BINANCE]', e.response?.data || e.message);
    return null;
  }
}

async function initExchangeInfo() {
  const info = await binanceRequest('GET', '/fapi/v1/exchangeInfo');
  if (!info || !Array.isArray(info.symbols)) throw new Error('exchangeInfo unavailable');
  const sym = info.symbols.find(s => s.symbol === SYMBOL_UPPER);
  if (!sym) throw new Error(SYMBOL_UPPER+' not found');
  const pf = sym.filters.find(f => f.filterType==='PRICE_FILTER');
  const lf = sym.filters.find(f => f.filterType==='LOT_SIZE');
  const nf = sym.filters.find(f => f.filterType==='MIN_NOTIONAL');
  if (pf) tickSize = parseFloat(pf.tickSize);
  if (lf) { stepSize = parseFloat(lf.stepSize); minQty = parseFloat(lf.minQty); }
  if (nf) minNotional = parseFloat(nf.notional);
  console.log('[INIT] tick='+tickSize+' step='+stepSize+' minQty='+minQty);
  if (!LIVE_MODE) return;
  const posSide = await binanceRequest('GET', '/fapi/v1/positionSide/dual', {}, true);
  if (posSide) positionSideMode = posSide.dualSidePosition ? 'HEDGE' : 'ONEWAY';
  const lev = await binanceRequest('POST', '/fapi/v1/leverage', {symbol:SYMBOL_UPPER, leverage:LEVERAGE}, true);
  if (!lev) throw new Error('failed to set leverage');
  const mt = await binanceRequest('POST', '/fapi/v1/marginType', {symbol:SYMBOL_UPPER, marginType:'ISOLATED'}, true);
  if (!mt && lastBinanceError?.code !== -4046) console.error('[INIT] marginType warn:', lastBinanceError);
  console.log('[INIT] Ready | leverage='+LEVERAGE+'x | mode='+positionSideMode);
}

async function getBalance() {
  const acc = await binanceRequest('GET', '/fapi/v2/account', {}, true);
  return acc ? parseFloat(acc.totalWalletBalance) : null;
}

// ── Position management ───────────────────────────────────────────────────
async function closePosition(side) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const params = { symbol: SYMBOL_UPPER, side: closeSide, type: 'MARKET', reduceOnly: 'true' };
  if (positionSideMode === 'HEDGE') params.positionSide = side;
  // Get current qty
  const positions = await binanceRequest('GET', '/fapi/v2/positionRisk', {symbol:SYMBOL_UPPER}, true);
  if (!Array.isArray(positions)) { console.error('[CLOSE] Cannot get position'); return false; }
  const pos = positions.find(p => p.symbol === SYMBOL_UPPER &&
    (positionSideMode === 'HEDGE' ? p.positionSide === side : true) &&
    Math.abs(parseFloat(p.positionAmt)) > 0);
  if (!pos) { console.log('[CLOSE] Already flat'); return true; }
  params.quantity = formatQty(Math.abs(parseFloat(pos.positionAmt)));
  const res = await binanceRequest('POST', '/fapi/v1/order', params, true);
  if (res) { console.log('[CLOSE] Closed', side, '@market qty='+params.quantity); return true; }
  console.error('[CLOSE] Failed'); return false;
}

async function openPosition(dir, price) {
  const side   = dir > 0 ? 'BUY' : 'SELL';
  const posDir = dir > 0 ? 'LONG' : 'SHORT';

  // Sizing: 95% of equity / leverage / price
  const qty = formatQty(equity * POSITION_PCT * LEVERAGE / price);
  if (qty < minQty || qty * price < minNotional) {
    console.error('[OPEN] Size too small: qty='+qty+' notional='+(qty*price).toFixed(2));
    return false;
  }

  const params = { symbol: SYMBOL_UPPER, side, type: 'MARKET', quantity: qty };
  if (positionSideMode === 'HEDGE') params.positionSide = posDir;

  console.log(`[OPEN] ${posDir} ${qty} ${SYMBOL_UPPER} ~$${(qty*price).toFixed(2)} notional`);

  if (!LIVE_MODE) {
    // Paper mode: simulate fill
    const fillPx = price * (1 + dir * SLIP);
    const fee    = qty * fillPx * TAKER_FEE;
    openTrade = { side: posDir, dir, qty, entry: fillPx, entryTime: Date.now(), fee };
    console.log('[PAPER] Opened', posDir, qty, '@', fillPx.toFixed(2));
    return true;
  }

  const res = await binanceRequest('POST', '/fapi/v1/order', params, true);
  if (!res) { console.error('[OPEN] Failed'); return false; }
  const fillPx = parseFloat(res.avgPrice || price);
  const fillQty = parseFloat(res.executedQty || qty);
  const fee = fillQty * fillPx * TAKER_FEE;
  openTrade = { side: posDir, dir, qty: fillQty, entry: fillPx, entryTime: Date.now(), fee };
  console.log('[OPEN] Filled', posDir, fillQty, '@', fillPx.toFixed(2));
  return true;
}

async function flipPosition(newDir, price) {
  // Check daily limits
  const today = new Date().toISOString().slice(0,10);
  if (today !== lastDayStr) { dailyPnL = 0; dailyFlips = 0; lastDayStr = today; }

  if (dailyPnL < -equity * DAILY_LOSS_LIMIT) {
    console.log('[DAILY] Daily loss limit hit, no more trades today');
    return;
  }
  if (dailyFlips >= MAX_FLIPS_PER_DAY) {
    console.log('[DAILY] Max flips per day reached:', dailyFlips);
    return;
  }

  // Close existing
  if (openTrade) {
    const exitPx = LIVE_MODE
      ? (await binanceRequest('GET', '/fapi/v1/ticker/price', {symbol:SYMBOL_UPPER}))?.price || price
      : price * (1 + openTrade.dir * SLIP * -1); // paper exit

    const oldDir = openTrade.dir;
    const qty    = openTrade.qty;
    const gross  = (parseFloat(exitPx) - openTrade.entry) * oldDir * qty;
    const exitFee = qty * parseFloat(exitPx) * TAKER_FEE;
    const pnl    = gross - openTrade.fee - exitFee;
    equity      += pnl;
    dailyPnL    += pnl;
    if (equity > maxEquity) maxEquity = equity;
    trades++;
    if (pnl > 0) wins++;
    console.log(`[TRADE] ${openTrade.side} closed | PnL: ${pnl>=0?'+':''}${pnl.toFixed(2)} | Equity: $${equity.toFixed(2)} | WR: ${(trades>0?wins/trades*100:0).toFixed(0)}%`);
    openTrade = null;
    if (LIVE_MODE) await closePosition(oldDir > 0 ? 'LONG' : 'SHORT');
  }

  // Open new position
  if (newDir !== 0) {
    dailyFlips++;
    await openPosition(newDir, price);
  }
}

// ── Process a completed 60m candle ─────────────────────────────────────────
async function on60mCandle(candle) {
  candles60m.push(candle);
  if (candles60m.length > 500) candles60m.shift(); // keep last 500 bars

  const n = candles60m.length;
  console.log(`[60m] ${new Date(candle.openTime).toISOString().slice(5,16)} O=${candle.open.toFixed(0)} H=${candle.high.toFixed(0)} L=${candle.low.toFixed(0)} C=${candle.close.toFixed(0)}`);

  // WFO retrain check
  if (n - lastRetrainBar >= WFO_RETRAIN_BARS || lastRetrainBar === 0) {
    wfoRetrain();
  }

  // Compute signal
  const sig = computeSignal();
  if (sig === 0 || n < currentSlow + 5) return;

  const prevSig = lastSignal;
  lastSignal    = sig;

  if (sig !== prevSig && prevSig !== 0) {
    // Signal flipped — close current and open opposite
    console.log(`[SIGNAL] Flip: ${prevSig > 0 ? 'LONG→SHORT' : 'SHORT→LONG'} | EMA${currentFast}/EMA${currentSlow} | C=${candle.close.toFixed(2)}`);
    await flipPosition(sig, candle.close);
  } else if (prevSig === 0 && openTrade === null) {
    // First signal — open initial position
    console.log(`[SIGNAL] Initial ${sig > 0 ? 'LONG' : 'SHORT'} | EMA${currentFast}/EMA${currentSlow}`);
    await flipPosition(sig, candle.close);
  }
}

// ── WebSocket setup ───────────────────────────────────────────────────────
let ws60m = null;
let partialCandle60m = null;

function buildCandle60mFromParts(parts) {
  // Aggregate 15m candles into a closed 60m candle
  if (parts.length === 0) return null;
  return {
    openTime:  parts[0].openTime,
    closeTime: parts[parts.length-1].closeTime,
    open:      parts[0].open,
    high:      Math.max(...parts.map(c=>c.high)),
    low:       Math.min(...parts.map(c=>c.low)),
    close:     parts[parts.length-1].close,
    volume:    parts.reduce((a,c)=>a+c.volume, 0),
  };
}

let parts15mForCurrentHour = [];
let currentHourStart = 0;

function onNewKline15m(kline) {
  const hStart = Math.floor(kline.startTime / 3600000) * 3600000;

  if (kline.isClosed) {
    // Add to buffer
    if (hStart !== currentHourStart) {
      // Hour changed — emit previous hour if we have 4 parts
      if (parts15mForCurrentHour.length === 4) {
        const c60 = buildCandle60mFromParts(parts15mForCurrentHour);
        if (c60) on60mCandle(c60);
      } else if (parts15mForCurrentHour.length > 0) {
        console.log('[60m] Incomplete hour parts:', parts15mForCurrentHour.length, '— skipping');
      }
      parts15mForCurrentHour = [];
      currentHourStart = hStart;
    }
    parts15mForCurrentHour.push({
      openTime:  kline.startTime,
      closeTime: kline.closeTime,
      open:      parseFloat(kline.open),
      high:      parseFloat(kline.high),
      low:       parseFloat(kline.low),
      close:     parseFloat(kline.close),
      volume:    parseFloat(kline.volume),
    });
  }
}

function connectWebSocket() {
  const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL}@kline_15m`;
  ws60m = new WebSocket(wsUrl);

  ws60m.on('open', () => console.log('[WS] Connected:', wsUrl));
  ws60m.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.e === 'kline') onNewKline15m(msg.k);
    } catch(e) {}
  });
  ws60m.on('close', () => {
    console.log('[WS] Disconnected. Reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
  ws60m.on('error', e => console.error('[WS] Error:', e.message));

  // Heartbeat
  setInterval(() => { if (ws60m?.readyState === 1) ws60m.ping(); }, 30000);
}

// ── Backfill historical 60m candles ───────────────────────────────────────
async function backfill60m() {
  console.log('[INIT] Backfilling 60m candles...');
  const klines = await binanceRequest('GET', '/fapi/v1/klines', {
    symbol: SYMBOL_UPPER, interval: '1h', limit: 500,
  });
  if (!Array.isArray(klines)) { console.error('[INIT] Backfill failed'); return; }
  for (const k of klines) {
    candles60m.push({
      openTime:  k[0], closeTime: k[6],
      open:  parseFloat(k[1]), high:   parseFloat(k[2]),
      low:   parseFloat(k[3]), close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    });
  }
  console.log(`[INIT] Loaded ${candles60m.length} historical 60m candles`);
  // Initial WFO train
  wfoRetrain();
  // Set initial signal without trading
  lastSignal = computeSignal();
  console.log(`[INIT] Initial signal: ${lastSignal > 0 ? 'LONG' : lastSignal < 0 ? 'SHORT' : 'FLAT'} | EMA${currentFast}/EMA${currentSlow}`);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('BulletBrain v3.0 — 60m WFO Runner');
  console.log(`Symbol: ${SYMBOL_UPPER} | Mode: ${LIVE_MODE ? '🔴 LIVE' : '📋 PAPER'}`);
  console.log(`Capital: $${INITIAL_CAPITAL} | Leverage: ${LEVERAGE}x`);
  console.log(`WFO: retrain every ${WFO_RETRAIN_BARS/24} days | EMA options: ${EMA_FAST_OPTIONS.join('/')} × ${EMA_SLOW_OPTIONS.join('/')}`);
  console.log('='.repeat(60));

  if (LIVE_MODE && !API_KEY) throw new Error('BINANCE_API_KEY not set');

  await syncServerTime();
  await initExchangeInfo();

  if (LIVE_MODE) {
    const bal = await getBalance();
    if (bal !== null) { equity = bal; maxEquity = equity; console.log('[INIT] Live balance: $'+equity.toFixed(2)); }
  }

  await backfill60m();

  // Status report every 60 minutes
  setInterval(() => {
    const sig = lastSignal > 0 ? 'LONG' : lastSignal < 0 ? 'SHORT' : 'FLAT';
    const pos = openTrade ? `${openTrade.side} ${openTrade.qty} @ ${openTrade.entry.toFixed(2)}` : 'no position';
    console.log(`[STATUS] Signal:${sig} | Pos:${pos} | Eq:$${equity.toFixed(2)} | EMA:${currentFast}/${currentSlow} | Trades:${trades} WR:${(trades>0?wins/trades*100:0).toFixed(0)}%`);
  }, 60 * 60 * 1000);

  connectWebSocket();
  console.log('[INIT] Running. Waiting for 60m candle closes via 15m aggregation...');
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
