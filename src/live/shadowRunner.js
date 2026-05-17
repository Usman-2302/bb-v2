'use strict';

/**
 * BulletBrain v3.0 — Phase D14: Shadow Trading Engine
 *
 * Connects to Binance WebSocket for BTCUSDT 15m klines.
 * Runs TWO accounts in parallel:
 *   Account A (SNIPER):  LETHAL Phase D12 config — trend-focused
 *   Account B (SCALPER): REFINED Phase D13 config — range-focused
 *
 * On each 15m candle close, both strategies evaluate the same candle
 * independently. All trades are simulated (no real orders).
 *
 * The "Regime Umpire" logs which account performs better in the current
 * market regime every 24 candles (6 hours).
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────────────
// INDICATOR IMPORTS
// ────────────────────────────────────────────────────────────────────
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd } = require('../indicators/cvd');
const { ema } = require('../indicators/ema');
const { rollingVolumeProfile } = require('../indicators/volumeProfile');
const { createLSOStrategy } = require('../backtest/lso_runner');
const { createEquityTracker, updateEquity, simulateLimitFill, simulatePositionFill,
        calcEntryCost, createTrade, closeTrade, checkPortfolioRisk, isDailyLossBreached } = require('../backtest/engine');
const { processOpenTrades } = require('../backtest/tradeManager');
const { findDOL } = require('../utils/dolFinder');
const { LSO: LSO_CONFIG, TRADE, SIZING } = require('../../config');
const { checkLSORangingTimeExhaustion } = require('../strategies/lso');

// ────────────────────────────────────────────────────────────────────
// CONFIGURATIONS
// ────────────────────────────────────────────────────────────────────

const SYMBOL = 'btcusdt';
const TIMEFRAME = '15m';
const INITIAL_CAPITAL = 10000;

// Account A: LETHAL (Phase D12) — trend-focused
const CONFIG_SNIPER = {
  name: 'SNIPER',
  cvdGateVariant: 'CVD_ZSCORE',
  gateVP: true,
  gate4HTrend: true,
  obConfluenceEnabled: true,
  timeBreakeven: { enabled: false },  // no time-exhaustion
  rvolThreshold: 3.0,                  // strict RVOL
  useRangeTP2: false,                  // DOL-based TP2
};

// Account B: SCALPER (Phase D13) — range-focused
const CONFIG_SCALPER = {
  name: 'SCALPER',
  cvdGateVariant: 'CVD_ZSCORE',
  gateVP: true,
  gate4HTrend: true,
  obConfluenceEnabled: true,
  timeBreakeven: { enabled: true, checkFn: checkLSORangingTimeExhaustion },
  rvolThreshold: 2.2,                  // relaxed RVOL in ranges
  useRangeTP2: true,                   // VAH/VAL TP2
};

// ────────────────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────────────────

const candles = [];           // rolling buffer of all candles
let atr14 = [];               // ATR values (recomputed each candle)
let rvolVals = [];            // RVOL values
let cvdVals = { delta: [], cumulative: [] };
let volumeProfiles = [];      // rolling 24H volume profiles
let lastCandleTime = 0;

// Account state
const accounts = {
  [CONFIG_SNIPER.name]:   createAccountState(CONFIG_SNIPER),
  [CONFIG_SCALPER.name]:  createAccountState(CONFIG_SCALPER),
};

function createAccountState(config) {
  return {
    config,
    equity: createEquityTracker(INITIAL_CAPITAL),
    openTrades: [],
    closedTrades: [],
    strategy: null,
    activeZones: [],
    extra: {},
    sweepsDetected: 0,
    cvdFiltered: 0,
    tradedCandles: new Set(),
  };
}

// ────────────────────────────────────────────────────────────────────
// INDICATOR RECOMPUTATION (streaming)
// ────────────────────────────────────────────────────────────────────

function recomputeIndicators() {
  if (candles.length < 14) return;
  atr14 = atr(candles, 14);
  rvolVals = rvol(candles, '15m', 20);
  cvdVals = cvd(candles);
  volumeProfiles = rollingVolumeProfile(candles, '15m', 24, 50);
}

// ────────────────────────────────────────────────────────────────────
// SIMPLE REGIME DETECTION (streaming)
// ────────────────────────────────────────────────────────────────────

function detectRegimeStreaming() {
  const i = candles.length - 1;
  if (i < 200) return 'RANGING';
  const c = candles[i];
  const closes = candles.map(c => c.close);
  const ema200 = ema(closes, 200);
  if (!ema200[i]) return 'RANGING';
  const priceAbove = c.close > ema200[i];
  const emaSlope = i >= 210 ? (ema200[i] - ema200[i-10]) / ema200[i-10] : 0;
  const atrPct = atr14[i] ? (atr14[i] / c.close * 100) : 0;
  if (atrPct > 5) return 'CRISIS';
  if (emaSlope > 0.001 && priceAbove) return 'BULL';
  if (emaSlope < -0.001 && !priceAbove) return 'BEAR';
  return 'RANGING';
}

// ────────────────────────────────────────────────────────────────────
// ACCOUNT INITIALIZATION
// ────────────────────────────────────────────────────────────────────

function initAccount(acct) {
  const cfg = acct.config;
  const oiDS = new Map();
  const oiTFn = r => LSO_CONFIG.oiFlushThreshold[r] || LSO_CONFIG.oiFlushThreshold.RANGING;

  acct.extra = {
    oiDataStore: oiDS,
    oiThresholdFn: oiTFn,
    cvdGateVariant: cfg.cvdGateVariant,
    obConfluenceEnabled: cfg.obConfluenceEnabled,
    timeBreakeven: cfg.timeBreakeven,
    volumeProfiles: volumeProfiles,
    gateVP: cfg.gateVP,
    gate4HTrend: cfg.gate4HTrend,
    _rvolThreshold: cfg.rvolThreshold,
    _useRangeTP2: cfg.useRangeTP2,
    allPools: [],
    poolActivationPtr: 0,
  };

  acct.strategy = createLSOStrategy(acct.extra);
  
  // Pre-detect pools from initial candles
  acct.activeZones = acct.strategy.detectZones(candles, atr14, rvolVals, LSO_CONFIG, { extra: acct.extra, cfg: LSO_CONFIG, symbol: SYMBOL, timeframe: TIMEFRAME, gates: { regime: false, oi: false, killzone: false, macro: false }, cvdVals, atr14, rvolVals, candles });
}

// ────────────────────────────────────────────────────────────────────
// PROCESS ONE CANDLE FOR ONE ACCOUNT
// ────────────────────────────────────────────────────────────────────

function processCandleForAccount(acct, candleIndex) {
  const i = candleIndex;
  const candle = candles[i];
  const prevC = candles[i - 1] || candle;
  const regime = candle.regime || detectRegimeStreaming();
  candle.regime = regime; // tag for downstream use

  const { strategy, activeZones, extra, equity, openTrades, closedTrades } = acct;

  // Process open trades
  const tbConfig = extra.timeBreakeven || {};
  const { timeBreakevenExits } = processOpenTrades({
    candle, prevCandle: prevC, candleIndex: i,
    rvolVals, cvdVals, fundingMap: new Map(), volPerCandle: 0.001, inBlackout: false,
    openTrades, closedTrades, equity,
    timeBreakeven: tbConfig,
  });

  // Update zones
  if (strategy.updateZones) strategy.updateZones(activeZones, candle, i);
  acct.activeZones = activeZones.filter(z => strategy.isZoneActive(z));

  if (equity.paused) return;

  // Per-candle setup
  if (strategy.onCandleStart) {
    const ctx = { cfg: LSO_CONFIG, symbol: SYMBOL, timeframe: TIMEFRAME, gates: { regime: false, oi: false, killzone: false, macro: false }, extra, cvdVals, atr14, rvolVals, candles, i, candle, activeZones };
    strategy.onCandleStart(ctx);
  }

  if (activeZones.length === 0) return;
  if (acct.tradedCandles.has(i)) return;

  // Scan for entries
  for (const zone of activeZones) {
    const ctx = { cfg: LSO_CONFIG, symbol: SYMBOL, timeframe: TIMEFRAME, gates: { regime: false, oi: false, killzone: false, macro: false }, extra, cvdVals, atr14, rvolVals, candles, i };
    const signal = strategy.checkEntry(zone, candle, ctx);
    if (!signal) continue;

    // Consume pool
    if (strategy.onTradeOpened) strategy.onTradeOpened(signal, zone, activeZones);

    // Gate 7
    if (strategy.gate7) {
      const g7 = strategy.gate7(candle, cvdVals, i, { ...ctx, extra });
      if (!g7.pass) { acct.cvdFiltered++; break; }
    }

    // Validate signal
    if (strategy.validateSignal) {
      const v = strategy.validateSignal(signal, candle, i, { ...ctx, extra });
      if (!v.accept) { acct.cvdFiltered++; break; }
    }

    const entryPrice = signal.limitPrice;
    const stopPrice = signal.stopPrice;
    const riskDist = Math.abs(entryPrice - stopPrice);
    if (riskDist <= 0) continue;

    // DOL
    const dolResult = findDOL(candles, i, entryPrice, stopPrice, signal.side || 'LONG', [], atr14);
    if (!dolResult) continue;

    // Fill simulation
    const fillResult = simulateLimitFill(candle, { side: signal.side || 'LONG', limitPrice: entryPrice }, 'LSO', 'BTCUSDT', atr14[i]);
    if (!fillResult.fill) continue;

    // Sizing
    const sizeMult = strategy.getSizeMultiplier ? strategy.getSizeMultiplier(signal, candle, { ...ctx, extra }) : 1.0;
    const riskAmount = INITIAL_CAPITAL * SIZING.baseRisk * sizeMult;
    const rawSize = riskAmount / riskDist;
    const size = simulatePositionFill(rawSize, rvolVals[i]);

    // Portfolio check
    const riskCheck = checkPortfolioRisk(openTrades, 'BTCUSDT', riskAmount, equity.capital);
    if (!riskCheck.allowed) continue;
    if (isDailyLossBreached(equity.dailyPnl, equity.capital)) continue;

    const tp1 = entryPrice + riskDist * TRADE.tp1RR;
    let tp2 = dolResult.dol;

    // Range-specific TP2 override (SCALPER config)
    if (extra._useRangeTP2 && (regime === 'RANGING' || regime === 'RANGING_ZOMBIE') && volumeProfiles[i]) {
      const { computeValueArea } = require('../indicators/volumeProfile');
      const { vah, val } = computeValueArea(volumeProfiles[i]);
      if (vah > 0 && val > 0) tp2 = signal.side === 'SHORT' ? val : vah;
    }

    const extraFields = strategy.extraTradeFields ? strategy.extraTradeFields(signal, zone, i, { ...ctx, extra }) : {};
    const trade = createTrade({
      symbol: 'BTCUSDT', entryPrice, stopPrice, tp1, tp2, size, riskAmount,
      side: signal.side || 'LONG', strategy: strategy.name, regime,
      fillQuality: fillResult.quality, extraStopSlippage: fillResult.extraStopSlippage,
      entryTimestamp: candle.openTime, entryCandle: i,
      notionalValue: size * entryPrice, entryCostPct: 0.0004,
      inKillzone: false, kzSizeMult: 1.0, dolTier: dolResult.tier, dolType: dolResult.type,
      ...extraFields,
    });

    openTrades.push(trade);
    acct.tradedCandles.add(i);
    acct.sweepsDetected++;

    break; // one trade per candle
  }
}

// ────────────────────────────────────────────────────────────────────
// REGIME UMPIRE — compare accounts every 24 candles
// ────────────────────────────────────────────────────────────────────

function umpireReport() {
  const regime = candles[candles.length - 1]?.regime || 'UNKNOWN';
  const lines = [];
  lines.push('');
  lines.push('════ ════ REGIME UMPIRE @ ' + new Date().toISOString() + ' ════ ═════');
  lines.push('  Regime: ' + regime + ' | Candles: ' + candles.length);

  for (const [name, acct] of Object.entries(accounts)) {
    const eq = acct.equity;
    const trades = acct.closedTrades.length;
    const wins = acct.closedTrades.filter(t => t.realizedPnl > 0).length;
    const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : 'N/A';
    const totalPnl = acct.closedTrades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
    const pf = (() => {
      let gw = 0, gl = 0;
      acct.closedTrades.forEach(t => { if (t.realizedPnl > 0) gw += t.realizedPnl; else gl += Math.abs(t.realizedPnl); });
      return gl > 0 ? (gw / gl).toFixed(3) : (gw > 0 ? 'Inf' : 'N/A');
    })();
    const avgRR = trades > 0 ? (totalPnl / trades).toFixed(2) : 'N/A';

    lines.push(`  ${name.padEnd(10)} Cap=$${eq.capital.toFixed(0)} | Trades=${trades} | WR=${wr}% | PF=${pf} | AvgRR=$${avgRR} | DD=${(eq.maxDrawdown*100).toFixed(2)}%`);
  }

  // Determine leader
  const sniperCap = accounts.SNIPER.equity.capital;
  const scalperCap = accounts.SCALPER.equity.capital;
  lines.push(`  LEADER: ${sniperCap > scalperCap ? 'SNIPER (trend-focused)' : scalperCap > sniperCap ? 'SCALPER (range-focused)' : 'TIED'}`);

  lines.push('═══════════════════════════════════════════════════');
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// PROCESS NEW CANDLE
// ────────────────────────────────────────────────────────────────────

function onNewCandle(candle) {
  // Deduplicate
  if (candle.openTime === lastCandleTime) return;
  lastCandleTime = candle.openTime;

  // Add to rolling buffer (keep last 5000 candles for indicators)
  candles.push(candle);
  if (candles.length > 5000) candles.shift();

  // Recompute indicators
  recomputeIndicators();

  const i = candles.length - 1;
  if (i < 200) return; // need warmup

  // Process for both accounts
  // Reset poolActivationPtrs for stream processing
  for (const [, acct] of Object.entries(accounts)) {
    processCandleForAccount(acct, i);
  }

  // Log
  const regime = candle.regime || 'RANGING';
  const time = new Date(candle.openTime).toISOString();
  const sniperOpen = accounts.SNIPER.openTrades.length;
  const scalperOpen = accounts.SCALPER.openTrades.length;
  const sniperCap = accounts.SNIPER.equity.capital;
  const scalperCap = accounts.SCALPER.equity.capital;

  console.log(`[${time}] ${regime.padEnd(8)} Close=$${candle.close.toFixed(0)} | SNIPER: $${sniperCap.toFixed(0)} (${sniperOpen} open) | SCALPER: $${scalperCap.toFixed(0)} (${scalperOpen} open)`);

  // Umpire every 24 candles
  if (candles.length % 24 === 0) {
    const report = umpireReport();
    console.log(report);
    fs.appendFileSync(path.join('logs', 'umpire.log'), report + '\n');
  }
}

// ────────────────────────────────────────────────────────────────────
// WEBSOCKET CONNECTION (Hardened — heartbeat + watchdog + backoff)
// ────────────────────────────────────────────────────────────────────

let reconnectAttempt = 0;

function connectWebSocket() {
  const wsUrl = `wss://fstream.binance.com/ws/${SYMBOL}@kline_${TIMEFRAME}`;
  
  // Exponential backoff: 10s → 20s → 40s → 80s → max 5min
  if (reconnectAttempt > 0) {
    const delay = Math.min(10000 * Math.pow(2, reconnectAttempt - 1), 300000);
    console.log(`[WS] Reconnect #${reconnectAttempt} — waiting ${(delay/1000).toFixed(0)}s...`);
    return setTimeout(connectWebSocket, delay);
  }
  
  console.log(`[WS] Connecting to ${wsUrl}...`);
  const ws = new WebSocket(wsUrl);
  
  // ── Heartbeat state ──────────────────────────────────────────────
  let pingHandle = null;
  let watchdogHandle = null;
  let lastActivity = Date.now();
  
  function clearTimers() {
    if (pingHandle) { clearInterval(pingHandle); pingHandle = null; }
    if (watchdogHandle) { clearTimeout(watchdogHandle); watchdogHandle = null; }
  }
  
  function kickWatchdog() {
    lastActivity = Date.now();
  }
  
  // ── Event handlers ───────────────────────────────────────────────
  ws.on('open', () => {
    console.log('[WS] Connected. Sending heartbeat every 3m, watchdog at 10m silence.');
    reconnectAttempt = 0;
    kickWatchdog();
    
    // Ping every 3 minutes
    pingHandle = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        kickWatchdog(); // our ping counts as activity
      }
    }, 180000);
    
    // Watchdog: if 10 minutes of silence, force terminate
    watchdogHandle = setInterval(() => {
      const silent = Date.now() - lastActivity;
      if (silent > 600000) {
        console.error(`[WS] WATCHDOG: ${(silent/1000).toFixed(0)}s silence. Terminating socket.`);
        clearTimers();
        try { ws.terminate(); } catch(e) {}
      }
    }, 60000); // check every 60s
  });
  
  ws.on('message', (data) => {
    kickWatchdog();
    try {
      const msg = JSON.parse(data.toString());
      
      // Debug: log stream event types to confirm messages are arriving
      if (msg.e) {
        // Log first message of each type, then every 100th
        if (!ws._msgCount) ws._msgCount = {};
        const type = msg.e;
        ws._msgCount[type] = (ws._msgCount[type] || 0) + 1;
        if (ws._msgCount[type] === 1 || ws._msgCount[type] % 100 === 0) {
          console.log(`[WS] ${type} #${ws._msgCount[type]}`);
        }
      }
      
      if (msg.k) {
        const k = msg.k;
        const candle = {
          openTime: k.t, closeTime: k.T,
          open: parseFloat(k.o), high: parseFloat(k.h),
          low: parseFloat(k.l), close: parseFloat(k.c),
          volume: parseFloat(k.v),
        };
        if (k.x) {
          console.log(`[WS] Candle closed @ ${new Date(k.t).toISOString()} close=$${parseFloat(k.c).toFixed(0)}`);
          if (candles.length >= 200) candle.regime = detectRegimeStreaming();
          onNewCandle(candle);
        }
      }
    } catch (e) {
      console.error('[WS] Parse error:', e.message, 'raw:', String(data).slice(0, 100));
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    clearTimers();
  });

  ws.on('close', (code) => {
    clearTimers();
    reconnectAttempt++;
    console.log(`[WS] Closed (code=${code}). Reconnect #${reconnectAttempt}...`);
    
    if (reconnectAttempt > 20) {
      console.error('[WS] FATAL: 20 reconnect failures. Exiting for PM2 restart.');
      process.exit(1);
    }
    
    connectWebSocket();
  });

  return ws;
}

// ────────────────────────────────────────────────────────────────────
// REST POLLING FALLBACK (works when WebSocket frames are blocked)
// ────────────────────────────────────────────────────────────────────

let lastProcessedCandle = 0;

async function pollLatestCandle() {
  const axios = require('axios');
  try {
    const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol: 'BTCUSDT', interval: '15m', limit: 2 },
      timeout: 10000,
    });
    
    if (!resp.data || resp.data.length === 0) {
      console.log('[REST] Poll: empty response');
      return;
    }
    
    // Process only closed candles (closeTime is in the past)
    for (const k of resp.data) {
      const openTime = k[0];
      const closeTime = k[6];
      const isClosed = Date.now() > closeTime;
      
      if (!isClosed) {
        // Log once per candle, not every poll
        if (!pollLatestCandle._lastSkipped || pollLatestCandle._lastSkipped !== openTime) {
          pollLatestCandle._lastSkipped = openTime;
          console.log(`[REST] Waiting for ${new Date(openTime).toISOString()} to close at ${new Date(closeTime).toISOString()}`);
        }
        continue;
      }
      
      if (openTime <= lastProcessedCandle) {
        continue;
      }
      
      lastProcessedCandle = openTime;
      const candle = {
        openTime, closeTime,
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      };
      if (candles.length >= 200) candle.regime = detectRegimeStreaming();
      console.log(`[REST] NEW CANDLE @ ${new Date(openTime).toISOString()} close=$${candle.close.toFixed(0)} (lastProcessed=${lastProcessedCandle})`);
      onNewCandle(candle);
    }
  } catch (e) {
    console.error('[REST] Poll FAILED:', e.message);
  }
}

function startRESTPolling() {
  console.log('[REST] Polling Binance every 30s. Last backfill candle was:', lastProcessedCandle, '=', new Date(lastProcessedCandle).toISOString());
  pollLatestCandle();
  setInterval(pollLatestCandle, 30000);
}

// ────────────────────────────────────────────────────────────────────
// BACKFILL: download recent candles for warmup
// ────────────────────────────────────────────────────────────────────

async function backfillWarmup() {
  const axios = require('axios');
  console.log('Backfilling warmup candles...');
  
  try {
    const url = 'https://fapi.binance.com/fapi/v1/klines';
    const endTime = Date.now();
    // Get ~500 candles (~5 days of 15m)
    const startTime = endTime - 500 * 15 * 60 * 1000;
    
    const resp = await axios.get(url, {
      params: { symbol: 'BTCUSDT', interval: '15m', startTime, endTime, limit: 500 },
      timeout: 15000,
    });

    for (const k of resp.data) {
      const candle = {
        openTime: k[0],
        closeTime: k[6],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        regime: 'RANGING',
      };
      if (candles.length === 0 || candle.openTime > candles[candles.length-1].openTime) {
        candles.push(candle);
      }
    }

    // Tag regimes
    recomputeIndicators();
    for (let i = 0; i < candles.length; i++) {
      if (i >= 200) candles[i].regime = detectRegimeStreaming();
    }

    console.log(`  Backfilled ${candles.length} candles`);
    console.log(`  Range: ${new Date(candles[0].openTime).toISOString()} → ${new Date(candles[candles.length-1].openTime).toISOString()}`);
    console.log(`  Warmup ready. ${candles.length} candles loaded.\n`);

    // Initialize both accounts
    for (const [, acct] of Object.entries(accounts)) {
      initAccount(acct);
    }
    // Seed REST poller with last backfill candle time
    lastProcessedCandle = candles[candles.length - 1]?.openTime || 0;
    console.log('Both accounts initialized. Waiting for live candles...\n');

  } catch (e) {
    console.error('Backfill failed:', e.message);
    console.log('Starting with empty candle buffer. Will need 200 live candles for warmup.');
  }
}

// ────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('BulletBrain v3.0 — Phase D14: Shadow Trading Engine');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('Account A (SNIPER):  LETHAL D12 — Trend-focused');
  console.log('Account B (SCALPER): REFINED D13 — Range-focused');
  console.log('');
  console.log('Regime Umpire reports every 24 candles (6 hours).');
  console.log('Log: logs/umpire.log\n');

  // Ensure log dir
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });

  // Backfill
  await backfillWarmup();

  // Connect WebSocket + REST polling fallback
  connectWebSocket();
  startRESTPolling();
}

// Only auto-run when executed directly (not on require)
if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
