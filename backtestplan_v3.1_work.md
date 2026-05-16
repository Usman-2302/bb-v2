# BulletBrain v3.0 — Backtesting Master Plan
# Synthesized from plan1.2.md + Gap Analysis
# Status: Living Document (v1.0 — April 2026)

---

## Core Principle

Build the minimum infrastructure to test one strategy. Validate it. Refine it. Then add the next.
Never build everything then test. Every iteration teaches you something real.

```
The Loop (repeat for every strategy):
Build Data → Build Indicator → Code Strategy → Backtest (no filters)
→ Add Regime Filter → Add Killzone Filter → Sensitivity Test
→ Regime-Split Analysis → Accept / Reject → Next Strategy
```

---

## Honest Expectations (Bake These In Before You Start)

```
                    Paper WR    Live WR (realistic)   Live RR    Live PF
LSO (Strategy 1):  48-55%  →   40-47%                1.8:1      1.5-1.9
OB  (Strategy 2):  48-55%  →   40-47%                1.7:1      1.4-1.8
FVG (Strategy 3):  50-58%  →   42-50%                1.6:1      1.4-1.8
CVD (Strategy 4):  40-48%  →   33-40%                1.9:1      1.3-1.7
VPB (Strategy 5):  45-52%  →   38-45%                2.0:1      1.4-1.9

System (all strategies, regime-gated):
  Trades/Month:   15-30 (drops to 8-15 in slow regimes)
  Monthly Return: 2-6%
  Annual Return:  25-60% (good year) / 10-25% (bad year)
  Max Drawdown:   <18%

HARD RULES:
  If backtest WR < 45% for any strategy → do not go live
  If live WR < 35% after 50 trades → pause and investigate
  Live Sharpe will be ~50% of backtested Sharpe — plan for it
```

---

## Outcome States Per Phase

Every phase ends in exactly one of three states:

```
PASS  → Strategy accepted, move to next phase
TWEAK → Run parameter sensitivity test, adjust 1-2 params, re-run (max 3 tweaks)
FAIL  → Strategy rejected for that regime, document why, move on

TWEAK rule: A tweak is only valid if the sensitivity test shows the parameter
is NOT fragile (WR change < 15% across ±20% range). If it IS fragile,
the strategy needs structural rethinking — not more tweaking.
```

---

## Phase 0 — Foundation (Do Once, Used by All Strategies)

Everything in Phase 0 is a hard prerequisite. No strategy phase starts until all of Phase 0 is complete and validated.

---

### Step 0.1 — Project Scaffold

```
bbv2/
├── src/
│   ├── indicators/         → ema.js, atr.js, rvol.js, cvd.js, volumeProfile.js, swingHL.js
│   ├── strategies/         → fvg.js, ob.js, lso.js, cvdDiv.js, vpb.js, shortLso.js
│   ├── backtest/           → engine.js, runner.js, reporter.js, monteCarlo.js
│   ├── data/               → downloader.js, loader.js, validator.js, oiDownloader.js
│   └── utils/              → regimeDetector.js, dolFinder.js, macroTagger.js, killzoneCheck.js
├── data/
│   ├── historical/         → OHLCV files per coin per timeframe (NDJSON, not flat JSON)
│   └── oi/                 → OI history per coin (parsed from Binance CSV bulk files)
├── results/                → backtest output JSON + HTML reports per run
├── config.js               → ALL parameters in one place — never hardcode in strategy files
└── package.json
```

**Storage format decision:** Use NDJSON (newline-delimited JSON), one candle per line.
Flat JSON arrays require loading the entire file into memory. NDJSON allows streaming.
For 4 years × 5 coins × 4 timeframes ≈ 2.5M+ candles, streaming is not optional.

---

### Step 0.2 — Download Historical Data

**Coins:** BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT
**Timeframes:** 15m, 1H, 4H, Daily
**Period:** 2021-01-01 to 2024-12-31 (2025 is reserved — never touch until Phase 8)
**Source:** Binance Futures REST API `/fapi/v1/klines`

```javascript
// Pagination: Binance returns max 1500 candles per request
// For 15m data over 4 years: ~140,000 candles per coin → ~94 requests per coin
// Rate limit: 1200 weight/min. Each klines request = 1 weight. Safe to batch.

// Downloader pseudocode:
async function downloadKlines(symbol, interval, startTime, endTime) {
  let cursor = startTime;
  while (cursor < endTime) {
    const batch = await binance.klines(symbol, interval, { startTime: cursor, limit: 1500 });
    appendNDJSON(`data/historical/${symbol}_${interval}.ndjson`, batch);
    cursor = batch[batch.length - 1].openTime + 1;
    await sleep(100); // respect rate limits
  }
}
```

**OI History — Important:** Binance's `/futures/data/openInterestHist` returns CSV files
from their bulk data endpoint, NOT JSON from the REST API. The downloader must:
1. Fetch the CSV from `https://data.binance.vision/data/futures/um/daily/openInterest/`
2. Parse CSV → convert to NDJSON
3. Store in `data/oi/{symbol}_1H.ndjson`
OI resolution is 1H only. This is sufficient for LSO strategy.

**Validation after download:**
- Check for gaps > 2 candles (exchange downtime is normal, > 10 consecutive gaps = re-download)
- Verify candle count matches expected count for the period
- Check for zero-volume candles (filter these — they are data artifacts)

---

### Step 0.3 — Build Core Indicators

Build each indicator as a pure function: `(candles[]) → values[]`. No side effects.
Test each indicator against known values before using in any strategy.

**EMA(period)**
```javascript
// Standard exponential moving average
// Test: EMA(9) on first 20 candles of BTC 1H — verify against TradingView
function ema(closes, period) {
  const k = 2 / (period + 1);
  const result = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i-1] * (1 - k));
  }
  return result;
}
```

**ATR(14)**
```javascript
// True Range = max(high-low, abs(high-prevClose), abs(low-prevClose))
// ATR = EMA(14) of True Range
// ATR% = ATR / close × 100 (used for regime detection and slippage model)
```

**Swing High / Low Detector**
```javascript
// Algorithmic definition (not visual):
// SwingHigh[i] = true IF high[i] > high[i-1] AND high[i] > high[i-2]
//                        AND high[i] > high[i+1] AND high[i] > high[i+2]
// SwingLow[i]  = true IF low[i] < low[i-1] AND low[i] < low[i-2]
//                        AND low[i] < low[i+1] AND low[i] < low[i+2]
// Lookback: 2 candles each side (adjustable in config.js)
```

**Time-Normalized RVOL**
```javascript
// RVOL = current_volume / avg_volume_same_time_slot_last_20_days
// Time slot = 15m bucket (96 slots per day)
// This prevents Asian session low-volume candles from appearing as high RVOL
// relative to other Asian candles — they are compared to their own baseline
```

**CVD Approximation**
```javascript
// Candle-level approximation (no tick data required):
// buyVol  = volume × (close - low) / (high - low)
// sellVol = volume × (high - close) / (high - low)
// cvdDelta = buyVol - sellVol
// cumulativeCVD[i] = cumulativeCVD[i-1] + cvdDelta[i]
// Reset CVD at start of each trading day (00:00 UTC)
```

**Volume Profile (24H Rolling)**
```javascript
// 50 price buckets across the 24H high-low range
// For each candle, distribute volume proportionally across touched buckets
// HVN = bucket with highest volume (High Volume Node)
// LVN = bucket with lowest volume (Low Volume Node)
// POC = Point of Control = HVN
```

---

### Step 0.4 — Build Backtest Engine Core

The engine is the most critical piece. Every strategy's accept/reject decision
depends on it being correct. Build it once, test it thoroughly, never change it
mid-backtest-cycle (that invalidates all prior results).

**Engine responsibilities:**
- Chronological candle replay (never look ahead)
- Position state management (open, partial close, full close)
- Fee + slippage model (baked in from Day 1 — not optional)
- Limit order fill simulation
- Daily loss tracker
- Portfolio heat tracker (max 3 concurrent trades, max 3% total risk)
- Equity curve recorder
- Trade log (every trade: entry, exit, PnL, regime, strategy, gates passed)

**Fee + Slippage Model (non-negotiable — must be in engine before first strategy test):**
```javascript
// These are applied on EVERY trade, automatically, by the engine

// Per-symbol slippage — altcoins are 3-8× worse than BTC, same model applied to all is wrong
const EXECUTION_PARAMS = {
  BTCUSDT: { baseSlippage: 0.0004, killzoneSlippage: 0.0002, crisisSlippage: 0.0015 },
  ETHUSDT: { baseSlippage: 0.0006, killzoneSlippage: 0.0003, crisisSlippage: 0.0020 },
  SOLUSDT: { baseSlippage: 0.0012, killzoneSlippage: 0.0006, crisisSlippage: 0.0040 },
  BNBUSDT: { baseSlippage: 0.0008, killzoneSlippage: 0.0004, crisisSlippage: 0.0025 },
  XRPUSDT: { baseSlippage: 0.0015, killzoneSlippage: 0.0008, crisisSlippage: 0.0050 },
};
// If SOL or XRP strategies are not profitable after these costs → remove those coins.
// BTC + ETH alone is sufficient for the strategy count.

const COSTS = {
  fee_round_trip: 0.0004,          // 0.04% maker fee × 2 sides
  reentry_cost:   0.0004,          // 0.04% extra when cancelled order re-enters

  // [KILL 4 FIX] funding_per_8h is NO LONGER used as a per-trade cost.
  // It is kept here ONLY as a sanity-check baseline for data validation.
  // All actual per-trade funding cost is calculated by applyFundingCost() below,
  // which reads from data/funding/{symbol}_8h.ndjson (downloaded in Step 0.2).
  // Reason: in BULL regimes funding runs 0.03–0.08% per 8H (3–8× this value).
  // Using 0.01% flat in BULL underestimates 2-day hold cost by ~5×.
  // The funding_ev_check filter was useless while running on the wrong rate.
  funding_per_8h_BASELINE_ONLY: 0.0001, // DO NOT use this in P&L calculations

  // FUNDING-ADJUSTED EXPECTED VALUE CHECK — now powered by ACTUAL rate:
  funding_ev_check: {
    // applyFundingCost() reads the actual downloaded rate for each 8H interval.
    // Before entering: estimate projected hold duration → look up current funding
    // → project total cost → compare to target_R.
    threshold_reduce: 0.20,   // 20% of target R eaten by funding → half size
    threshold_skip:   0.40,   // 40% of target R eaten by funding → skip
  },
  // Historical 8H funding rates: data/funding/{symbol}_8h.ndjson (Step 0.2)

  // Signal-to-execution latency cost (separate from market impact slippage)
  // Models adverse price movement between signal fire and order arrival in book
  // This is a systematic bias, not random noise — apply as mandatory deduction
  signal_delay_cost: {
    '15m': 0.0003,   // ~500ms delay × 15m volatility ≈ 0.03% adverse move
    '1H':  0.0001,   // 1H candles move slowly, 500ms matters less
    '4H':  0.00005,  // negligible at 4H resolution
  },

  // Per-strategy fill rates — SMC levels are crowded, 85% flat is wrong
  // FVG midpoints and OB tops have deep queues of identical retail orders
  fill_rate: {
    FVG: 0.65,   // crowded level, deep queue
    OB:  0.70,   // slightly less crowded
    LSO: 0.75,   // faster, more discretionary level
    VPB: 0.72,
    CVD: 0.70,
  },

  // Crisis stop-loss fill realism
  // Emergency exits during flash crash are market orders against whatever bid exists
  // BTC -2% in 15m means bid-ask spread is 10× normal — stop fills at 0.5% worse
  crisis_stop_slippage: 0.005,  // 0.5% adverse on emergency exits in CRISIS regime
};

// [KILL 4 FIX] — Actual per-trade funding cost function.
// Called by the engine on every 8H funding timestamp while a position is open.
// Reads from pre-downloaded data/funding/{symbol}_8h.ndjson.
function applyFundingCost(trade, currentTimestamp, fundingDataStore) {
  // fundingDataStore: Map<symbol, Array<{timestamp, rate}>> loaded at engine init
  const fundingRecord = fundingDataStore.get(trade.symbol)
    ?.find(f => f.timestamp === currentTimestamp);

  if (!fundingRecord) return; // no funding event at this timestamp, nothing to do

  const rate = fundingRecord.rate;
  const notional = trade.notionalValue; // position size × current price

  // Longs pay when rate > 0 (bull market), receive when rate < 0
  // Shorts receive when rate > 0, pay when rate < 0
  const costSign = (trade.side === 'LONG') ? -1 : +1;
  const fundingPnl = notional * rate * costSign;

  trade.cumulativeFundingCost = (trade.cumulativeFundingCost || 0) + Math.abs(notional * rate);
  trade.pnl += fundingPnl;

  // Pre-entry EV check — use this BEFORE placing the order, not after:
  // estimatedFutureIntervals = projected remaining hold hours / 8
  // Look up the CURRENT funding rate from latest available record
  // projectedFutureFunding = estimatedFutureIntervals × currentRate × notional
  // If projectedFutureFunding > threshold_skip × target_R → reject trade
  // If projectedFutureFunding > threshold_reduce × target_R → halve size
  // This runs on ACTUAL rates, not the baseline constant above.
}

// Validation step: on first backtest run, compare cumulativeFundingCost total
// against (total_trades × avg_hold_days × 3 × flat_rate_0.01%).
// If actual > 3× flat estimate → confirms the bias was real; proceed with actual rates.
// If actual ≈ flat estimate → funding was not a major regime driver; keep both paths.

// Total round-trip cost example (BTC, killzone, FVG strategy):
// fee: 0.04% + slippage: 0.02% + signal delay: 0.03% + spread: 0.04% = 0.13% minimum
// Outside killzone: fee: 0.04% + slippage: 0.04% + signal delay: 0.03% = 0.11%
// A strategy needs edge > these costs per trade just to break even
// For XRPUSDT outside killzone: 0.04% + 0.15% + 0.03% = 0.22% — much harder to be profitable
```

**Limit order fill simulation (with penetration-depth adverse selection):**
```javascript
// [KILL 1 FIX] — Penetration-depth fill model.
// The original binary model (push-through = fill, exact-touch = no fill) is correct in
// direction but stops halfway. The critical missing variable is HOW FAR price pushed
// through — which determines P&L quality of the fill, not just whether a fill occurred.
//
// Three fill zones:
//   MISS:     price didn't reach the limit (candle.low > limitPrice)
//   CLEAN:    price touched shallowly (1–3 ticks) — price absorbed and reversed
//             → fill occurs at fill_rate probability, no extra stop slippage
//   MARGINAL: moderate penetration (0.02–0.10%) — price tested the level seriously
//             → fill occurs, slight extra stop slippage (0.1%)
//   TOXIC:    deep penetration (>0.10%) — liquidation cascade, price steamrolling
//             → fill certain (you're always at back of queue, all queued orders clear)
//             → apply extra stop slippage (0.3%) because stop also fills into same move
//
// The TOXIC fill is the hidden death: backtest logs it as "stopped out at stop price"
// but live execution stops 0.3–0.5% worse because the liquidation IOCO
// transacts through your limit AND your stop in the same millisecond window.

const TICK_SIZE = 0.1; // BTC: 0.1 USDT. Adjust per symbol in config.js

function simulateLimitFill(candle, order, strategy, rvol) {
  if (order.side === 'LONG') {
    const penetration = (order.limitPrice - candle.low) / order.limitPrice;

    if (penetration <= 0) return { fill: false, quality: 'MISS' };

    // Exact touch or < 1 tick: back of queue in every scenario
    if (candle.low >= order.limitPrice - TICK_SIZE) {
      return { fill: false, quality: 'EXACT_TOUCH' };
    }

    // Shallow penetration (> 1 tick but < 0.02%): clean absorption likely
    if (penetration < 0.0002) {
      const fills = Math.random() < COSTS.fill_rate[strategy];
      return { fill: fills, quality: 'CLEAN', extraStopSlippage: 0 };
    }

    // Moderate penetration (0.02–0.10%): marginal fill quality
    if (penetration < 0.001) {
      const fills = Math.random() < COSTS.fill_rate[strategy] * 0.85; // slightly worse odds
      return { fill: fills, quality: 'MARGINAL', extraStopSlippage: 0.001 };
    }

    // Deep penetration (> 0.10%): liquidation cascade — fill is certain, quality is toxic
    // fill_rate does NOT apply here — the whole queue clears when price steamrolls
    return { fill: true, quality: 'TOXIC', extraStopSlippage: 0.003 };
  }

  if (order.side === 'SHORT') {
    const penetration = (candle.high - order.limitPrice) / order.limitPrice;
    if (penetration <= 0) return { fill: false, quality: 'MISS' };
    if (candle.high <= order.limitPrice + TICK_SIZE) return { fill: false, quality: 'EXACT_TOUCH' };
    if (penetration < 0.0002) {
      return { fill: Math.random() < COSTS.fill_rate[strategy], quality: 'CLEAN', extraStopSlippage: 0 };
    }
    if (penetration < 0.001) {
      return { fill: Math.random() < COSTS.fill_rate[strategy] * 0.85, quality: 'MARGINAL', extraStopSlippage: 0.001 };
    }
    return { fill: true, quality: 'TOXIC', extraStopSlippage: 0.003 };
  }

  return { fill: false, quality: 'MISS' };
}

// When fill.quality === 'TOXIC', apply extraStopSlippage on the stop-loss exit:
//   actual_stop_price = order.stopPrice × (1 - fill.extraStopSlippage) for LONG
//   (stop fills 0.3% worse than the stop order price — models the cascade continuation)
// Log fill.quality on every trade for the toxic_fill_rate metric (see report below).

// PARTIAL FILL SIMULATION on high-RVOL candles (unchanged):
function simulatePositionFill(intendedSize, rvol) {
  if (rvol > 3.0) return intendedSize * 0.70;  // very fast candle → 70% fills
  if (rvol > 2.0) return intendedSize * 0.82;  // fast candle → 82% fills
  return intendedSize * 1.0;
}
// Missed fraction: if signal still valid on next candle, re-enter remainder at market + reentry_cost
// If signal no longer valid: log as PARTIAL_FILL_MISSED, count as reduced position trade
```

**Report generator output (per strategy run):**
```
Win Rate (WR):          %
Profit Factor (PF):     ratio
Avg R:R Achieved:       ratio
Max Drawdown (DD):      %
Trades/Month:           count
Sharpe Ratio:           value
Regime Breakdown:       WR/PF per regime
Missed Trades:          count (cancelled limit orders)
Total Cost Drag:        % (fees + slippage + funding total)
Cumulative Funding Cost: % of capital (actual rates, not baseline flat)

Ghost Trade Analysis:   % of winning trades that were "exact touch" fills
  (Exact touch = EXACT_TOUCH quality → adverse selection = no fill)
  If ghost_win_rate > 30%: strategy only works on lucky fills → structural problem

[KILL 1 NEW METRIC] Toxic Fill Analysis:
  toxic_fill_rate:      % of all fills where penetration > 0.10% (fill.quality === 'TOXIC')
  toxic_fill_wr:        WR on TOXIC fills only
  toxic_fill_avg_loss:  average loss size on TOXIC fills (should be larger than normal losses)

  If toxic_fill_rate > 40%: the strategy's fills are dominated by liquidation cascades.
    → The level is not acting as support — price is steamrolling through it.
    → Structural problem: entry level is too weak, or strategy fires into momentum, not against it.
  If toxic_fill_wr < 20%: TOXIC fills are near-certain losers. PF is being propped up by
    CLEAN fills alone. Adjust fill_rate assumptions accordingly.
  Target: toxic_fill_rate < 25% for any viable strategy.
```

---

### Step 0.5 — Tag Every Candle with Regime

Run `detectRegime()` on all 4H BTC candles first. Then propagate the regime tag
to all lower timeframe candles within that 4H window.

```javascript
function detectRegime(btcCandles_4H, index) {
  const ema200 = calculateEMA(btcCandles_4H.map(c => c.close), 200);
  const slice = btcCandles_4H.slice(index - 30, index);
  const priceAboveEMA = slice.filter((c, i) => c.close > ema200[index - 30 + i]).length;
  const atr_pct = calculateATR(btcCandles_4H, 14)[index] / btcCandles_4H[index].close * 100;

  // EMA slope: angle in degrees over last 10 periods
  const slopeRaw = (ema200[index] - ema200[index - 10]) / 10;
  const slopeAngle = Math.atan(slopeRaw / ema200[index]) * (180 / Math.PI);

  // Crisis overrides everything
  if (atr_pct > 5) return 'CRISIS';

  if (slopeAngle >= 15 && priceAboveEMA >= 20) return 'BULL';
  if (slopeAngle <= -15 && priceAboveEMA <= 10) return 'BEAR';
  return 'RANGING';
}

// Anti-flapping rule: regime only switches after 2 consecutive 4H closes
// confirming the new regime. Single-candle spikes do not change regime.
```

**Vol-Switch: Immediate CRISIS override (bypasses 4H anti-flapping rule):**
```javascript
// The 2-candle 4H anti-flapping rule creates an 8-hour lag before CRISIS activates.
// In crypto, FTX-style crashes happen in hours — the house is on fire before the
// 4H candle closes. The vol-switch forces immediate CRISIS without waiting.

function checkVolSwitch(candles_15m, currentIndex, atr_4H_baseline) {
  const atr_15m_current = calculateATR(candles_15m, 14)[currentIndex];
  const atr_15m_normalized = atr_15m_current / candles_15m[currentIndex].close * 100;

  // If 15m ATR spikes > 3× the 4H ATR baseline → force CRISIS immediately
  // atr_4H_baseline = 30-day average of 4H ATR% (pre-calculated, stored in Redis)
  if (atr_15m_normalized > 3 * atr_4H_baseline) {
    return 'CRISIS'; // override current regime — no 4H confirmation needed
  }
  return null; // no override — use normal regime detection
}
// Vol-switch is checked on every 15m candle close
// Once triggered: CRISIS mode stays until 4H ATR% drops back below 5%
// This catches flash crashes, exchange hacks, and macro shock events
// within 1-2 candles instead of waiting 8 hours
```

**[KILL 3 FIX] Crisis exit protocol — API failure fallback:**
```javascript
// The vol-switch correctly identifies CRISIS within 1–2 candles.
// The gap: at the moment it fires, the Binance API may be 503ing.
// During the Oct-10-2025 crash: 33-minute internal transfer degradation,
// API connections dropping, users unable to submit orders for 10–20 minutes.
// A vol-switch that fires an emergency exit that can't be confirmed is useless.

// MANDATORY: Use this function for ALL emergency exits in CRISIS mode.
// Never fire a bare POST /fapi/v1/order in crisis context.

async function submitCrisisExit(position, binanceAPI, telegramBot) {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const order = await binanceAPI.placeOrder({
        symbol:      position.symbol,
        side:        position.side === 'LONG' ? 'SELL' : 'BUY',
        type:        'MARKET',
        quantity:    position.size,
        reduceOnly:  true,
        recvWindow:  5000,          // tight window — stale orders are dangerous
        timestamp:   Date.now(),
      });

      // CRITICAL: verify fill — submission ≠ confirmation
      await sleep(500);
      const status = await binanceAPI.getOrder({
        symbol:  position.symbol,
        orderId: order.orderId,
      });

      if (status.status === 'FILLED') {
        telegramBot.send(`✅ Crisis exit confirmed: ${position.symbol} @ ${status.avgPrice}`);
        return { success: true, fillPrice: parseFloat(status.avgPrice) };
      }

      if (status.status === 'PARTIALLY_FILLED') {
        // Partial fill: reduce remaining size and retry immediately
        position.size -= parseFloat(status.executedQty);
        telegramBot.send(`⚠️ Partial fill on crisis exit: ${position.symbol} — retrying`);
        continue;
      }

    } catch (err) {
      // 503 / timeout: exponential backoff before retry
      const delay = Math.pow(2, attempt) * 200; // 200ms, 400ms, 800ms, 1600ms, 3200ms
      telegramBot.send(`🔴 Crisis exit attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  // All 5 attempts failed — switch to HEDGE MODE to neutralize delta
  // Hedge mode: open an equal-size opposing position to go market-neutral
  // Requires: a separate sub-account pre-funded with sufficient margin for hedging
  try {
    await binanceAPI.placeOrder({
      symbol:   position.symbol,
      side:     position.side === 'LONG' ? 'SELL' : 'BUY',
      type:     'MARKET',
      quantity: position.size,
      // NO reduceOnly: true — this opens a hedge, not closes the position
    });
    telegramBot.send(
      `🚨 HEDGE MODE ACTIVATED: Cannot close ${position.symbol} — delta-neutral hedge placed. MANUAL REVIEW REQUIRED.`
    );
  } catch (hedgeErr) {
    telegramBot.send(
      `💀 CRITICAL: Both close and hedge failed for ${position.symbol}. IMMEDIATE MANUAL INTERVENTION REQUIRED.`
    );
  }

  return { success: false, hedged: true };
}

// DEAD MAN'S SWITCH — runs as a separate process on a geographically separate VPS:
// Every 60 seconds, the main trading process writes a heartbeat timestamp to a shared
// Redis key: SET heartbeat:bulletbrain <timestamp> EX 120
// Watchdog process (on a different VPS) checks the key every 30 seconds.
// If key expires (gap > 120 seconds = main process died or API hung):
//   → Watchdog connects to Binance via its OWN API key (separate sub-account)
//   → Issues market close orders for all known open positions
//   → Sends emergency Telegram alert
// This is the failsafe for "everything failed including the hedge."
// Setup: required BEFORE going live. Not optional. Two servers, one trading, one watching.

// Pre-live requirement: fund a separate "hedge sub-account" with:
//   margin capacity = max concurrent positions × avg position notional × 10%
//   (10% of notional is sufficient for short-duration delta hedge in CRISIS)
// This sub-account is NEVER used for trading — only for crisis hedges.
  const slopeAngle = Math.atan(slopeRaw / ema200[index]) * (180 / Math.PI);

  // Crisis overrides everything
  if (atr_pct > 5) return 'CRISIS';

  if (slopeAngle >= 15 && priceAboveEMA >= 20) return 'BULL';
  if (slopeAngle <= -15 && priceAboveEMA <= 10) return 'BEAR';
  return 'RANGING';
}

// Anti-flapping rule: regime only switches after 2 consecutive 4H closes
// confirming the new regime. Single-candle spikes do not change regime.
```

**Zombie/Inertia State — 5th regime condition (sub-state of RANGING):**
```javascript
// The 4-state model defaults to RANGING when ATR is low and slope is flat.
// But "low-vol grind" is different from ranging:
//   RANGING: price oscillates between clear boundaries, FVG/OB levels bounce
//   ZOMBIE:  price drifts slowly with no energy — FVG/OB levels get drifted through
//
// FVG and OB require impulse to work. In Zombie state, there is no impulse.
// These levels become random price points, not structural magnets.

function calcEfficiencyRatio(candles, period = 10) {
  // ER = directional move / sum of absolute moves over period
  // ER near 1.0 = strong trend (efficient movement)
  // ER near 0.0 = choppy/zombie (inefficient, random movement)
  const directional = Math.abs(candles[period-1].close - candles[0].close);
  const totalPath = candles.slice(1).reduce((sum, c, i) =>
    sum + Math.abs(c.close - candles[i].close), 0);
  return totalPath === 0 ? 0 : directional / totalPath;
}

// Add to regime detection:
// After classifying as RANGING, check ER on 4H candles over last 10 periods
// If ER < 0.3 → classify as ZOMBIE (sub-state of RANGING)
// ZOMBIE disables: FVG, OB, VPB (all require impulse)
// ZOMBIE allows: LSO only (sweeps still happen in zombie markets — stops get hunted)
// Tag candles: candle.regime = 'RANGING_ZOMBIE' for analysis

// Expected: 10-20% of RANGING periods will be ZOMBIE
// Expected impact: removes the worst-performing RANGING trades from FVG/OB results
```

**[KILL 7 FIX] RANGING_PREZONE — catch the zombie transition before it completes:**
```javascript
// The ZOMBIE filter (ER < 0.3, ATR < 0.5× avg) only fires AFTER the market has
// fully compressed. The transition from normal RANGING into zombie takes 3–10 days:
// ATR decays → RVOL baseline also decays (20-day avg includes compression) →
// tiny moves now pass the FVG/OB impulse filters → system fires on garbage setups.
//
// RANGING_PREZONE catches this transition window and reduces size before zombie confirms.

function detectPreZone(candles_4H, index, rangingATRavg) {
  // Condition 1: ATR declining for 3 consecutive 4H checks
  const atrs = [0, 1, 2, 3, 4, 5].map(i =>
    calculateATRpct(candles_4H, index - i)
  );
  const declining = atrs[0] < atrs[1] && atrs[1] < atrs[2] && atrs[2] < atrs[3];

  // Condition 2: ATR already below 70% of RANGING average (softer than zombie's 50%)
  const nearThreshold = atrs[0] < 0.70 * rangingATRavg;

  // Condition 3: Efficiency Ratio also declining (not just ATR)
  const er_current = calcEfficiencyRatio(candles_4H.slice(index - 10, index));
  const er_prior   = calcEfficiencyRatio(candles_4H.slice(index - 15, index - 5));
  const erDeclining = er_current < er_prior && er_current < 0.45;

  return (declining && nearThreshold && erDeclining) ? 'RANGING_PREZONE' : null;
}

// RANGING_PREZONE rules (sits between RANGING and RANGING_ZOMBIE):
//   FVG: allowed but size reduced to 50% of normal
//   OB:  allowed but size reduced to 50% of normal
//   VPB: DISABLED (breakouts in pre-zone are overwhelmingly false)
//   LSO: allowed at full size (sweeps are structural, not volatility-dependent)
//   Minimum R:R gate tightened: require >= 2.5:1 instead of 1.8:1
//   (Low-vol market is less likely to reach distant DOL targets)

// Regime state priority order:
//   CRISIS > BULL > BEAR > RANGING_ZOMBIE > RANGING_PREZONE > RANGING
// Pre-zone overrides RANGING but is overridden by ZOMBIE.
// Tag candles: candle.regime = 'RANGING_PREZONE'

// Expected: 15-25% of RANGING periods will be PREZONE before full ZOMBIE
// Expected impact: 50% size reduction during transition = halves loss during worst
//   RANGING sub-period without eliminating setups entirely
// Backtest: compare RANGING vs RANGING_PREZONE vs RANGING_ZOMBIE separately
//   If PREZONE PF < 1.0 even at 50% size → tighten to DISABLED (treat as ZOMBIE)
//   If PREZONE PF 1.1-1.4 at 50% size → keep with size reduction confirmed

**Regime tagging output:** Each candle in every dataset gets a `.regime` field.
Store tagged datasets separately: `data/historical/BTCUSDT_15m_tagged.ndjson`

**Validation:** Plot regime periods on a chart. Visually verify:
- 2021 Q1-Q3 = BULL
- 2022 = BEAR
- 2023 Q1-Q2 = RANGING → BULL
- Nov 2022 FTX crash = CRISIS
If the regime labels look wrong visually, fix `detectRegime()` before proceeding.

---

### Step 0.6 — Tag Macro Event Blackout Windows

High-impact macro events destroy technical setups. Tag them in historical data
so strategy backtests measure "normal market" WR, not event-contaminated WR.

**Events to tag:**
- US CPI release (monthly): blackout = 30 min before + 15 min after
- FOMC decision (8×/year): blackout = 30 min before + 15 min after
- Non-Farm Payrolls (monthly): blackout = 30 min before + 15 min after

**Implementation:**
```javascript
// Hard-code 2021-2024 event timestamps in a JSON file: data/macro_events.json
// Engine checks: if candle.timestamp is within any blackout window → skip signal
// This is NOT optional — FOMC candles can move 3-5% instantly and blow stops
// on otherwise valid setups. Including them inflates loss rate artificially.

// Expected impact: ~3% of trading time blacked out, ~25% reduction in
// unexpected stop-outs during event periods
```

---

### Step 0.7 — Regime Slope Threshold Calibration (Do Before Any Strategy Backtest)

The 15-degree slope threshold for BULL/BEAR was never empirically validated — it's
a reasonable starting guess. The wrong threshold misclassifies regime periods and
corrupts every strategy's regime-split results. Calibrate it once, lock it in.

```javascript
// Test slope thresholds: [8°, 10°, 12°, 15°, 18°, 20°, 22°]
// For each threshold:
//   1. Tag all 4H BTC candles 2021-2024 with that threshold
//   2. Compute: % time in BULL, % in BEAR, % in RANGING
//   3. Visual check: does 2022 label as BEAR majority? Does 2021 Q1-Q3 label as BULL?
//   4. Compute WR delta: (avg WR of BULL-tagged candles) - (avg WR of RANGING-tagged candles)
//      using a simple price-direction proxy (did price go up in next 4H?)

// Pick the threshold where:
//   a) WR delta between BULL and RANGING is maximized (clearest separation)
//   b) Visual validation passes (2022 = BEAR, 2021 = BULL)
//   c) Not so tight that RANGING is > 60% of all time (over-conservative)

// Document the chosen threshold with evidence. Never change it again.
// Expected result: optimal threshold is likely 10°-13°, not 15°
// At 15°, you may be misclassifying 20-30% of BULL periods as RANGING
// and leaving valid trades on the table.
```

---

## Phase 1 — Strategy 3: FVG Fill (Start Here)

**Why FVG first?** Highest fill rate of all SMC concepts (50-58% paper WR).
Most mechanical to code. Easiest to validate. Good baseline before harder strategies.
FVG has the fewest dependencies — it does not require OI data.

---

### Step 1.1 — Code FVG Detector

```javascript
// Bullish FVG definition:
// candle[i-1].high < candle[i+1].low  → gap exists between candle i-1 top and candle i+1 bottom
// candle[i] body > 1.2 × ATR14_1H    → impulse candle (not a small drift candle)
// candle[i] volume > 1.8 × RVOL      → volume confirms institutional participation

// FVG zone:
//   top    = candle[i+1].low
//   bottom = candle[i-1].high
//   mid    = (top + bottom) / 2  ← entry target

// Validity: 72 candles (1H timeframe = 3 days)
// Invalidation: price closes BELOW FVG bottom (zone is mitigated)

// Bearish FVG (for short strategies, Phase 5.5):
// candle[i-1].low > candle[i+1].high → gap exists
// candle[i] body > 1.2 × ATR14_1H
// candle[i] volume > 1.8 × RVOL
// Entry at FVG midpoint (short)
// Invalidation: price closes ABOVE FVG top
```

**Config parameters (all in config.js):**
```javascript
FVG: {
  bodyMultiplier: 1.2,      // ATR multiplier for impulse candle
  rvolThreshold: 1.8,       // minimum RVOL on impulse candle
  validityCandles: 72,      // candles before FVG expires (1H)
  entryAtMid: true,         // enter at 50% of FVG zone
  stopBuffer: 0.1,          // ATR multiplier below FVG bottom for stop
}
```

---

### Step 1.2 — Code DOL Target Finder

DOL (Draw on Liquidity) = the nearest structural target price will be pulled toward.

```javascript
// Scan forward from entry for the nearest unmitigated:
// 1. Bearish OB above price (for long trades)
// 2. Equal highs cluster (abs diff < 0.3% within last 50 candles)
// 3. Unfilled bearish FVG above price

// Priority: equal highs cluster > bearish OB > bearish FVG
// If no DOL found within 5% of entry → reject trade (R:R cannot be calculated)
// R:R = (DOL - entry) / (entry - stop)
// Reject if R:R < 1.8

// LOOKAHEAD BIAS GUARD — most dangerous silent bug in backtesting:
// Every candle the DOL finder considers must have formed BEFORE the signal candle.
// If any candidate candle's openTime >= signal candle's openTime → exclude it.
// One assertion, added once, prevents spectacular backtest results that
// collapse entirely in live trading.
function findDOL(candles, signalIndex, entryPrice, direction) {
  const signalOpenTime = candles[signalIndex].openTime;
  // Only consider candles strictly before the signal candle
  const validCandles = candles.filter(c => c.openTime < signalOpenTime);
  // ... rest of DOL scan logic on validCandles only
  // ASSERT: if any candidate has openTime >= signalOpenTime → throw error in dev mode
  if (process.env.NODE_ENV === 'development') {
    validCandles.forEach(c => {
      console.assert(c.openTime < signalOpenTime, 'DOL lookahead bias detected');
    });
  }
}
```

---

### Step 1.2b — CVD Absorption Entry Refinement (Optional Enhancement)

Static limit orders at FVG midpoint invite adverse selection — you enter whether
price is absorbing or crashing through. The absorption trigger improves fill quality.

```javascript
// Instead of placing a limit order immediately when FVG is detected:
// 1. Set an ALERT when price reaches FVG midpoint (don't place order yet)
// 2. Check 1m CVD at the level:
//    - If 1m CVD shows aggressive selling has STOPPED (cvdDelta flattening or turning positive)
//      while price is at the FVG midpoint → THEN place limit order
//    - If 1m CVD is still strongly negative (sellers still active) → WAIT or SKIP
// 3. Entry: limit at current price (not pre-set midpoint)
// 4. Stop: FVG bottom - (0.1 × ATR) — unchanged

// Data needed: 1m CVD from aggTrades (already downloaded in Step 4.1 validation)
// This is an OPTIONAL refinement — backtest both versions:
//   Version A: static limit at FVG midpoint (current plan)
//   Version B: CVD absorption trigger at FVG midpoint
// Compare WR and fill rate. If Version B WR > Version A by >= 5pp → use Version B.
// If improvement < 5pp → static limit is sufficient, don't add complexity.

// Expected: Version B will have fewer fills (misses some trades) but higher WR
// The trades it misses are the ones where price crashed through — the losers.
```

---

### Step 1.3 — Backtest FVG in Isolation (Baseline)

**No regime filter. No killzone filter. No macro blackout.**
This is the raw baseline — it will look worse than the filtered version.
That's the point. You need to see the unfiltered numbers first.

```
Entry:  limit order at FVG midpoint
Stop:   FVG bottom - (0.1 × ATR14_1H)
Target: DOL (nearest structural target)
TP1:    50% of position at 1:1 R:R, move stop to breakeven
TP2:    remaining 50% at DOL

Engine applies: fees + slippage + 85% fill rate (automatically)
```

**Expected baseline result (before filters):**
- WR: 38-45% (regime noise will drag this down)
- PF: 1.1-1.3 (barely positive or breakeven)
- This is normal. The filters are what create the edge.

**Record:** Save results to `results/fvg_baseline.json`

---

### Step 1.4 — Add Regime Filter, Backtest Again

Enable regime routing. FVG is allowed in: BULL (long), RANGING (long/short at boundaries).
FVG is DISABLED in: BEAR (skip long FVGs), CRISIS (skip all FVGs).

```
Run same backtest with regime gate active.
Compare to baseline:
  Expected WR improvement: +8-15%
  Expected trade count reduction: 20-35% (fewer but better trades)
  Expected PF improvement: +0.2-0.4
```

**Record:** Save to `results/fvg_regime.json`
**Decision point:** If WR improvement < 5% → regime engine may have a bug. Investigate before continuing.

---

### Step 1.5 — Add Killzone Filter (Gate T), Backtest Again

Killzones: London Open (07:00-09:00 UTC), NY Open (13:00-15:00 UTC)

**Asian session rule (22:00-07:00 UTC) — FVG and OB DISABLED entirely:**
```
Asian session volume spikes are frequently market maker liquidity sweeps
before London open, not genuine institutional participation.
FVG/OB logic assumes trend continuation after absorption.
In Asian session, the "absorption" is often a fake-out that reverses at London open.
The 2.5× RVOL threshold does NOT filter this — the spike IS the manipulation.

DISABLED in Asian session (22:00-07:00 UTC): FVG, OB, VPB
ALLOWED in Asian session: LSO only (liquidity sweeps are valid — equal lows/highs
  get hunted before London open, which is exactly what LSO detects)

This is not a soft threshold — it is a hard time gate.
No FVG or OB trade can open between 22:00 and 07:00 UTC regardless of RVOL.
```

```
Run same backtest with killzone gate active.
Compare to regime-only version:
  Expected WR improvement: +3-8%
  Expected trade count reduction: 15-25% (Asian session FVG/OB removed)
  Expected PF improvement: +0.1-0.2
```

**Record:** Save to `results/fvg_regime_killzone.json`

---

### Step 1.6 — Add Macro Event Blackout, Backtest Again

Enable the macro event blackout tags from Step 0.6.
No trades during CPI, FOMC, NFP windows.

```
Compare to regime+killzone version:
  Expected WR improvement: +2-5% (removes event-contaminated losses)
  Expected trade count reduction: 2-4%
```

**Record:** Save to `results/fvg_full_gates.json`
This is the "final" FVG result used for accept/reject.

---

### Step 1.7 — Parameter Sensitivity Test (Replaces "Max 3 Tweaks" Rule)

For every numerical parameter in FVG config, test ±20% of the chosen value.
This is an objective pass/fail test — not a judgment call.

```
Test matrix:
  bodyMultiplier:  [1.0, 1.2, 1.4]
  rvolThreshold:   [1.5, 1.8, 2.0]
  validityCandles: [58, 72, 86]
  stopBuffer:      [0.08, 0.10, 0.12]

For each parameter variation, run the full backtest (with all gates).
Record WR for each.

PASS: WR variation across the range < 15 percentage points
FAIL: WR variation > 15 percentage points → parameter is fragile

Example:
  bodyMultiplier 1.0 → WR 44%
  bodyMultiplier 1.2 → WR 46%
  bodyMultiplier 1.4 → WR 43%
  Range = 3pp → PASS (robust)

  rvolThreshold 1.5 → WR 48%
  rvolThreshold 1.8 → WR 46%
  rvolThreshold 2.0 → WR 31%
  Range = 17pp → FAIL (fragile — rethink RVOL gate structure)
```

**If a parameter fails:** Do NOT tweak it to find a "better" value.
The fragility means the strategy is sensitive to that threshold in a way
that won't generalize. Rethink the gate logic structurally.

---

### Step 1.8 — Regime-Split Analysis

Run FVG backtest separately for each regime period.

```
BULL periods only:    record WR, PF, DD, trade count
BEAR periods only:    record WR, PF, DD, trade count
RANGING periods only: record WR, PF, DD, trade count
CRISIS periods only:  record WR, PF, DD, trade count (expect very few trades)

30-TRADE MINIMUM FLOOR (hard rule):
  Any regime split with fewer than 30 trades → label result INSUFFICIENT_DATA
  Do NOT use it to accept or reject. Do NOT disable the strategy for that regime.
  Strategy stays active in that regime by default until the floor is met.
  A PF of 0.8 from 8 trades in CRISIS regime is random noise, not signal.
  This floor applies to every strategy in every phase.

Decision rule (only applies when trade count >= 30):
  If PF < 1.2 in any regime → DISABLE FVG for that regime
  (Even if overall PF is positive — a regime with PF < 1.2 is a drag)
```

**Record:** Save to `results/fvg_regime_split.json`

---

### Step 1.9 — FVG Accept/Reject Decision

```
ACCEPT FVG if ALL of:
  ✓ PF > 1.5 (full gates, all regimes combined)
  ✓ Max DD < 8%
  ✓ Positive PF in at least 2 regimes
  ✓ All parameters pass sensitivity test (WR variation < 15pp)
  ✓ WR > 42% (live-adjusted estimate still above 35% floor)
  ✓ Year-by-year PF >= 1.2 in at least 3 of 4 years (2021/2022/2023/2024)
    (A strategy profitable overall but losing in 2022 alone is not stable)

REJECT FVG if ANY of:
  ✗ PF < 1.5 after all gates
  ✗ Max DD > 8%
  ✗ Negative PF in more than 2 regimes
  ✗ Any parameter shows fragility (WR variation > 15pp) AND structural fix not found
  ✗ PF < 1.0 in any individual calendar year

On REJECT: Document exact failure reason. Do not retry more than 3 times.
```

**Year-by-year breakdown (run for every strategy, every phase):**
```
Record separately: 2021 only | 2022 only | 2023 only | 2024 only
If PF in any individual year < 1.2 → strategy is partially regime-captured
but not stable across calendar time → investigate which regime dominated that year
```

---

## Phase 2 — Strategy 2: Order Block (OB)

Same loop as Phase 1. OB requires the same infrastructure — no new dependencies.

---

### Step 2.1 — Code OB Detector

```javascript
// Bullish OB definition:
// Last BEARISH candle before a significant move UP
// "Significant move" = next candle body >= 1.5 × ATR14_1H
// Move candle volume > 2.0 × RVOL (institutional participation)

// OB zone:
//   top    = bearish candle high
//   bottom = bearish candle low
//   entry  = OB top (price returns to the zone from above)

// Validity: 48 candles (1H timeframe = 2 days)
// Invalidation: price closes BELOW OB low (zone is mitigated)

// Bearish OB (for short strategies):
// Last BULLISH candle before a significant move DOWN
// Entry at OB bottom (price returns to zone from below)
// Invalidation: price closes ABOVE OB high
```

**Config parameters:**
```javascript
OB: {
  moveMultiplier: 1.5,      // ATR multiplier for the "significant move" candle
  rvolThreshold: 2.0,       // minimum RVOL on move candle
  validityCandles: 48,      // candles before OB expires (1H)
  stopBuffer: 0.1,          // ATR multiplier below OB low for stop
}
```

---

### Step 2.2 — Backtest OB (Same Loop as FVG)

Run the same 4-step sequence:
1. Baseline (no filters) → `results/ob_baseline.json`
2. Add regime filter → `results/ob_regime.json`
3. Add killzone + macro blackout → `results/ob_full_gates.json`
4. Parameter sensitivity test (same ±20% rule)
5. Regime-split analysis

**Accept OB if:** PF > 1.5, max DD < 8%, passes sensitivity test

---

### Step 2.3 — Correlation Check: OB vs FVG

Do OB and FVG fire on the same candle frequently?

```javascript
// For every trade in ob_full_gates results:
//   Check if an FVG signal was also active within ±2 candles
// Calculate overlap rate: (overlapping signals / total OB signals) × 100

// If overlap > 40%:
//   They are effectively the same signal — cannot run both simultaneously
//   Priority rule: OB takes precedence over FVG when both fire
//   (OB is more specific — it identifies the exact candle, not a gap)

// If overlap < 40%:
//   They are complementary — both can be active simultaneously
//   Still apply portfolio heat limit (max 3 concurrent trades total)
```

---

## Phase 3 — Strategy 1: LSO (Liquidity Sweep + OI Flush)

Most complex strategy. Requires OI data. Build after FVG and OB are validated
so the engine is proven before adding the OI dependency.

---

### Step 3.1 — Code Equal Highs/Lows Detector

```javascript
// Equal Lows (buy-side liquidity pool):
// For candles i and j (j > i, j - i >= 5, both within last 50 candles):
//   abs(low[i] - low[j]) / low[i] < 0.003  → within 0.3% of each other
//   Neither low has been swept (no candle between i and j went below)
// Store: equalLows = { level: avg(low[i], low[j]), formed_at: j }

// Equal Highs (sell-side liquidity pool):
// Same logic but for highs
// abs(high[i] - high[j]) / high[i] < 0.003
```

---

### Step 3.2 — Code Sweep Detector

```javascript
// Bullish sweep (long setup):
// current 15m candle LOW < equalLows.level   → wick below the pool
// current 15m candle CLOSE > equalLows.level → closes back above (trap)
// body/wick ratio < 0.4                       → wick-dominated candle

// Bearish sweep (short setup — Strategy 6):
// current 15m candle HIGH > equalHighs.level
// current 15m candle CLOSE < equalHighs.level
// body/wick ratio < 0.4
```

---

### Step 3.3 — Code OI Flush Detector

```javascript
// OI data is 1H resolution. For a 15m sweep candle, DO NOT use the raw 1H bucket.
// [KILL 5 FIX] Use 15m interpolation to reduce the temporal misalignment window
// from ±60 minutes to ±15 minutes.
//
// WHY: In active sessions, 30–40% of 1H candles have an OI change ≥ 1.5% from
// normal trading noise. The original code read the entire 1H bucket's OI change,
// meaning an OI drop at 09:05 would "confirm" a sweep at 09:45 — 40 minutes later.
// The error is systematic (not random), which means it creates directional false positives.

// [KILL 5 PRIMARY FIX] Linear interpolation to 15m resolution:
function getInterpolatedOI(symbol, timestamp_15m, oiDataStore) {
  // oiDataStore: Map<symbol, Array<{timestamp, oi}>> at 1H resolution
  const hourStart = Math.floor(timestamp_15m / 3600000) * 3600000;
  const hourEnd   = hourStart + 3600000;

  const oi_open  = oiDataStore.get(symbol)?.find(o => o.timestamp === hourStart)?.oi;
  const oi_close = oiDataStore.get(symbol)?.find(o => o.timestamp === hourEnd)?.oi;

  if (!oi_open || !oi_close) return null; // data gap — skip OI check, don't fabricate

  const fraction = (timestamp_15m - hourStart) / 3600000; // 0.0 to 1.0
  return oi_open + (oi_close - oi_open) * fraction;
}

// OI flush check (using interpolated values):
function checkOIFlush(symbol, sweepTimestamp_15m, oiDataStore, threshold = 0.030) {
  // threshold defaults to 3.0% (tightened from 1.5% — see below)
  const oi_at_sweep  = getInterpolatedOI(symbol, sweepTimestamp_15m, oiDataStore);
  const oi_prior_15m = getInterpolatedOI(symbol, sweepTimestamp_15m - 900000, oiDataStore);

  if (!oi_at_sweep || !oi_prior_15m) return false;

  const oiDelta = (oi_at_sweep - oi_prior_15m) / oi_prior_15m;
  return oiDelta < -threshold; // OI dropped by threshold% in this 15m window
}

// [KILL 5 SECONDARY FIX] Threshold: use 3.0% (not 1.5%) as the default.
// Rationale: after interpolation reduces the window from 60→15 minutes,
// the signal-to-noise ratio improves. But 1.5% is still catchable from noise
// in 15 minutes during active sessions. 3.0% requires genuine forced liquidations.
// During backtesting, test both 2.0% and 3.0%:
//   If WR improvement from OI filter is similar at 3.0% vs 1.5% → use 3.0% (fewer false positives)
//   If WR improvement collapses at 3.0% → investigate: OI filter may have been riding noise

// LSO regime OI thresholds (updated):
//   BULL:    oiFlush >= 3.0%  (was 1.5%)
//   BEAR:    oiFlush >= 4.0%  (was 2.5%)
//   RANGING: oiFlush >= 3.0%  (was 1.5%)
//   CRISIS:  oiFlush >= 4.5%  (was 3.0%)

// ALIGNMENT GAP: reduced from ±60 min to ±15 min after interpolation.
// Log field: trade.oi_alignment_gap_minutes = 15 (updated from 60).
// For live trading: replace with real-time OI WebSocket feed — gap becomes ~0.
```

---

### Step 3.4 — Backtest LSO Without OI Filter (Baseline)

```
Entry:  limit order at 50% of sweep candle body
Stop:   sweep candle low - (0.1 × ATR14_15m)
Target: DOL upward (nearest equal highs, bearish OB above, bearish FVG above)
Gates:  sweep + CVD positive only (no OI filter yet)

Record: results/lso_no_oi.json
```

---

### Step 3.5 — Backtest LSO With OI Filter

Add the OI flush gate: `oiFlush >= 1.5%` required on sweep candle.

```
Compare to no-OI baseline:
  Expected WR improvement: +8-12%
  Expected trade count reduction: 30-40% (OI filter is strict)
  Expected PF improvement: +0.3-0.5

If WR improvement < 5%: OI data quality issue — validate OI data alignment
If WR improvement > 15%: OI is a strong filter — consider tightening to 2.0%
```

**Record:** `results/lso_with_oi.json`

---

### Step 3.6 — Add Regime + Killzone + Macro Blackout

LSO regime rules:
- BULL:    allowed (full size), OI flush >= 3.0% (interpolated, was 1.5%)
- BEAR:    allowed ONLY if OI flush >= 4.0% (interpolated, was 2.5%)
- RANGING: allowed, OI flush >= 3.0% (interpolated, was 1.5%)
- CRISIS:  allowed ONLY if OI flush >= 4.5% (interpolated, was 3.0%)

Run full gates. Sensitivity test. Regime-split analysis.

**Accept LSO if:** PF > 1.5, OI filter shows measurable improvement, passes sensitivity test

---

## Phase 4 — Strategy 4: CVD Divergence

CVD is the hardest strategy to validate because it depends on approximation quality.
Validate the approximation FIRST before coding the strategy.

---

### Step 4.1 — Validate CVD Approximation Quality (Objective Test)

The candle-level CVD approximation (from Step 0.3) must be validated before use.
The aggregate Pearson correlation across 30 days is not sufficient — the approximation
fails specifically on sweep candles (wick > body), which is exactly when LSO needs it.

```javascript
// TWO-LEVEL validation required:

// Level 1: Aggregate correlation (existing test)
//   Pearson correlation >= 0.75 across all candles in 30-day sample
//   Source: https://data.binance.vision/data/futures/um/daily/aggTrades/

// Level 2: Sweep-candle-specific correlation (NEW — critical for LSO Gate 7)
//   Filter to sweep candles only: (high - low) > 2 × abs(close - open)
//   Compute Pearson correlation on this subset separately
//
//   WHY: On fast sweep candles, ~60-70% of volume transacts in the first 30 seconds
//   near the candle open. The approximation assumes uniform distribution across the
//   range — it overestimates buy volume on bullish sweep candles, creating artificial
//   positive CVD even when real tick-level CVD was negative.
//   This means Gate 7 (CVD confirmation) may be passing garbage signals on LSO.

// Decision matrix:
//   Aggregate >= 0.75 AND sweep-candle >= 0.70 → CVD usable everywhere
//   Aggregate >= 0.75 AND sweep-candle < 0.70  → [KILL 2 FIX] Replace CVD in Gate 7
//                                                 with OI velocity proxy (see below).
//                                                 Keep CVD divergence as standalone only.
//   Aggregate < 0.75                            → Disable all CVD usage entirely
//                                                 Use aggTrades or remove CVD

// [KILL 2 FIX] — OI Velocity Proxy (replaces CVD in Gate 7 when sweep-candle r < 0.70):
//
// WHY CVD FAILS ON SWEEP CANDLES:
// On a bullish LSO sweep candle (wick down, close near top):
//   Formula: buyVol = volume × (close-low)/(high-low) → close near high → 85% buy volume
//   Reality: the wick is a liquidation cascade (aggressive market SELLS).
//            The close recovery is genuine absorption.
//            Net tick CVD is often flat or negative despite the formula showing strongly positive.
//   Result:  Gate 7 is always green on sweep candles regardless of real buying pressure.
//            The gate produces approximately zero marginal filtering information.
//
// OI VELOCITY PROXY: measures the RATE of OI change, not just total change.
// Genuine forced liquidations have a characteristic velocity signature:
//   Fast OI drop (> 0.5% in the 15m sweep window) = mass forced closings
//   OI stabilization after drop = liquidations exhausted, potential floor
//   OI continuing to drop after sweep close = cascading continues, NOT a floor

function checkOIVelocityGate(symbol, sweepTimestamp_15m, oiDataStore) {
  const oi_now    = getInterpolatedOI(symbol, sweepTimestamp_15m, oiDataStore);
  const oi_minus1 = getInterpolatedOI(symbol, sweepTimestamp_15m - 900000, oiDataStore);
  const oi_minus2 = getInterpolatedOI(symbol, sweepTimestamp_15m - 1800000, oiDataStore);

  if (!oi_now || !oi_minus1 || !oi_minus2) return { pass: false, reason: 'DATA_GAP' };

  const velocity_sweep = (oi_now - oi_minus1) / oi_minus1;        // OI change in sweep candle
  const velocity_prior = (oi_minus1 - oi_minus2) / oi_minus2;     // OI change in prior candle

  // PASS conditions (absorption signal):
  //   1. OI dropped fast during sweep (force-closed longs) → velocity_sweep < -0.003 (−0.3%)
  //   2. Rate of drop is DECELERATING vs prior candle (liquidation exhausting)
  //      velocity_sweep > velocity_prior (less negative = slowing)
  const fastDrop        = velocity_sweep < -0.003;
  const decelerating    = velocity_sweep > velocity_prior; // less negative than prior
  const notCascading    = velocity_sweep > -0.015;         // not still in freefall (> -1.5%)

  if (fastDrop && decelerating && notCascading) {
    return { pass: true, reason: 'OI_VELOCITY_ABSORPTION' };
  }

  // FAIL conditions:
  if (velocity_sweep < -0.015) return { pass: false, reason: 'OI_CASCADE_CONTINUING' };
  if (!fastDrop) return { pass: false, reason: 'OI_DROP_TOO_SMALL' };
  if (!decelerating) return { pass: false, reason: 'OI_ACCELERATING' };

  return { pass: false, reason: 'OI_VELOCITY_INCONCLUSIVE' };
}

// Gate 7 replacement logic:
//   If sweep-candle CVD correlation >= 0.70: use candle CVD (original Gate 7)
//   If sweep-candle CVD correlation < 0.70:  use OI velocity proxy (this function)
//   If OI velocity data unavailable:          skip Gate 7 entirely (no gate = lower WR expected)
//
// Log which gate variant fired on every LSO trade for validation analysis.

// NOTE: CVD divergence as a STANDALONE strategy (Phase 4) has a low bar to clear:
//   Paper WR 40-48%, live WR 33-40%, PF 1.3-1.7
//   If the sweep-candle correlation fails, retire CVD as standalone entirely.
//   Keep it only as a confirmation signal where the bar is lower (direction, not divergence).
```

---

### Step 4.2 — Code CVD Divergence Detector

```javascript
// Bullish divergence:
//   price[i] < price[i-3]   → price made a lower low
//   CVD[i] > CVD[i-3]       → CVD made a higher low (buyers absorbing)
//   Confirmation: next candle closes UP + RVOL > 1.3×
//   Context: price must be at a known structural level (OB, FVG, or swing low)
//            (divergence in open air = noise)

// Bearish divergence (for short strategies):
//   price[i] > price[i-3]   → price made a higher high
//   CVD[i] < CVD[i-3]       → CVD made a lower high (sellers absorbing)
//   Confirmation: next candle closes DOWN + RVOL > 1.3×
//   Context: price at known structural level (bearish OB, bearish FVG, swing high)
```

---

### Step 4.3 — Backtest CVD (Same Loop)

Run baseline → regime → killzone → macro blackout → sensitivity test → regime-split.

**Accept CVD if:** PF > 1.4 (lower bar — CVD is harder to model accurately)

**Note:** If CVD fails as a standalone strategy but the approximation correlation
was >= 0.75, keep CVD as a confirmation gate in LSO. The divergence pattern
is a higher bar than single-candle direction confirmation.

---

## Phase 5 — Strategy 5: Volume Profile Breakout (VPB)

---

### Step 5.1 — Build Volume Profile Calculator

```javascript
// 24H rolling window, 50 price buckets
// For each 1H candle:
//   priceRange = high - low
//   bucketSize = priceRange / 50
//   For each bucket: volume += candle.volume × (overlap with bucket / priceRange)

// HVN = bucket with highest accumulated volume (High Volume Node)
// LVN = bucket with lowest accumulated volume (Low Volume Node)
// POC = Point of Control = HVN price level

// Update every 1H candle close (rolling — drop oldest 24H, add newest)
```

---

### Step 5.2 — Code Breakout Detector

```javascript
// Breakout conditions:
//   price closes ABOVE HVN on 1H timeframe
//   volume > 2.0 × RVOL (institutional breakout, not a drift)
//   price was BELOW HVN for >= 3 consecutive candles (accumulation below)

// Retest entry (15m):
//   After breakout, wait for pullback to HVN level
//   Enter on 15m candle close ABOVE HVN (HVN becomes support)
//   Stop: HVN - (0.1 × ATR14_15m)
//   Target: DOL upward (next HVN above, equal highs cluster)
```

---

### Step 5.3 — Backtest VPB (Same Loop)

Run baseline → regime → killzone → macro blackout → sensitivity test → regime-split.

**VPB regime notes:**
- Works best in BULL (breakouts follow through)
- Unreliable in RANGING (false breakouts dominate)
- Disable in RANGING regime regardless of backtest result

**Accept VPB if:** PF > 1.5, works in BULL regime, passes sensitivity test

---

## Phase 5.5 — Short-Side Strategies (BEAR Regime)

Short strategies are the mirror of long strategies. They activate in BEAR regime only.
Without them, the system sits idle or loses during bear markets.

---

### Step 5.5.1 — Code Short Strategy Detectors

```javascript
// SHORT-LSO (Strategy 6): Mirror of LSO — KEEP THIS ONE
//   Equal highs swept UP → wick above, close below → OI flush → CVD negative
//   Entry: limit at 50% of sweep candle body (short above market)
//   Stop:  sweep candle HIGH + (0.07 × ATR14_15m)  ← tighter than long (squeeze risk)
//   Target: DOL downward (nearest equal lows, bullish OB below, bullish FVG below)
//   Activation: BEAR regime only (or BULL with F&G > 80 AND funding > +0.12%)

// SHORT-OB, SHORT-FVG: DEFERRED to Year 2 (after long strategies proven in live trading)
// SHORT-CVD: REMOVED (CVD divergence retired as standalone — same reasoning applies short side)

// Short-specific risk rules:
//   Futures only (no spot short)
//   Maximum 2× leverage
//   Tighter stop multiplier: 0.07 × ATR (vs 0.10 for longs)
//   Activate only when regime has been BEAR for >= 6 consecutive hours
//   (Prevents entering shorts on a single-candle regime flip)
```

---

### Step 5.5.2 — Backtest Short Strategies

Run each short strategy through the same loop as long strategies.
Use BEAR regime periods only for primary validation.

**Key difference:** Short strategies are tested on BEAR regime candles only.
If there are insufficient BEAR regime candles in 2021-2024 data for statistical
significance (< 100 trades), note this and flag for 2025 forward test validation.

**Accept short strategies if:** PF > 1.4 (lower bar — fewer BEAR regime periods to test on)

---

## Phase 6 — Combined System Backtest

All accepted strategies run together. This is where the system is tested as a whole.

---

### Step 6.1 — Run All Accepted Strategies Together

```
Active: all strategies that passed Phases 1-5.5
Regime router: active (strategy only fires if regime allows it)
All 9 gates: active (Gates 0-8 + Gate T)
Max 3 concurrent trades: enforced by engine
Adaptive position sizing: active (regime + streak multipliers)
Macro event blackout: active
```

**Adaptive position sizing (from plan1.2.md Layer 3):**
```javascript
const BASE_RISK = 0.01; // 1% of capital

const REGIME_MULT = { BULL: 1.0, RANGING: 0.7, BEAR_SHORT: 1.0, BEAR_LONG: 0.5, CRISIS: 0.5 };

function streakMult(consecutiveLosses) {
  if (consecutiveLosses <= 2) return 1.0;
  if (consecutiveLosses === 3) return 0.75;
  if (consecutiveLosses === 4) return 0.5;
  return 0.25; // 5+
}

const CONFIDENCE_MULT = {
  standard:          1.0,   // all gates pass
  high_confluence:   1.3,   // all gates + F&G + funding + OI >= 2.5%
  crowded_reversal:  1.2,   // extreme funding + LSO (reduced from 1.5 — see note below)
  weak:              0.7,   // outside killzone or Gate T relaxed
};
// NOTE on crowded_reversal: 1.5× was too aggressive. Extreme funding (> +0.1%) can
// persist for weeks in a strong bull trend (Feb-Mar 2024 BTC ran with funding > +0.15%
// for 4+ weeks). Sizing up into counter-trend reversals at 1.5× during that period
// was systematically wrong. 1.2× is the correct premium.
// Reserve 1.5× ONLY for the rarest setup: LSO + extreme funding + CVD divergence
// + OI flush >= 3% ALL simultaneously. This combination is genuinely rare.
const ULTRA_CONFLUENCE_MULT = 1.5; // only when all 4 conditions above are true

// [KILL 6 FIX] — ULTRA_CONFLUENCE_MULT is gated by market stress indicators.
// The 1.5× multiplier was most likely to be active in extended BULL runs —
// which are precisely the periods just before BULL→CRISIS transitions.
// High confluence in an overheated, overleveraged market is not a signal to size up.
// It's a signal that the setup looks perfect to everyone, including the algos
// that will liquidate it into a cascade.

function isUltraConfluenceAllowed(symbol, oiDataStore, atrData) {
  // Gate 1: OI z-score — market must NOT be in an OI overextension
  const currentOI  = getCurrentOI(symbol, oiDataStore);
  const oi30dMean  = get30DayMeanOI(symbol, oiDataStore);
  const oi30dStd   = get30DayStdOI(symbol, oiDataStore);
  const oiZScore   = oi30dStd === 0 ? 0 : (currentOI - oi30dMean) / oi30dStd;
  // OI z-score > 1.5 = market is overloaded with leveraged longs → crash risk elevated
  if (oiZScore > 1.5) return { allowed: false, reason: 'OI_OVEREXTENDED' };

  // Gate 2: ATR ratio — pre-crash volatility expansion often precedes the crash itself
  const atr_current = getCurrentATR(symbol, atrData);
  const atr_30d_avg = get30DayAvgATR(symbol, atrData);
  if (atr_current / atr_30d_avg > 1.5) return { allowed: false, reason: 'ATR_EXPANDING' };

  // Gate 3: Trade must not be a multi-day hold candidate
  // (Ultra-size is only acceptable for intraday exits, not 2-day OB holds)
  // This check is passed in from the strategy's projected hold duration
  // projectedHoldDays is estimated in the pre-entry EV check
  return { allowed: true };
}

// HARD COMBINED RISK CAP — non-negotiable ceiling on all multipliers combined:
const risk = Math.min(
  clamp(
    BASE_RISK * REGIME_MULT[regime] * streakMult(losses) * CONFIDENCE_MULT[type] * atrVolMult(symbol),
    0.0025,   // 0.25% minimum
    0.015     // 1.5% Phase 1 maximum
  ),
  0.020  // [KILL 6 FIX] 2.0% ABSOLUTE HARD CAP — no multiplier combination can exceed this.
         // Reason: 3.0% risk + 0.5% crisis stop slippage = 3.5% single-trade loss.
         // That triggers the 3% daily loss pause AFTER the damage is done.
         // Keeping combined risk at 2.0% max means worst-case is 2.5% (survivable).
);

const risk = clamp(
  BASE_RISK * REGIME_MULT[regime] * streakMult(losses) * CONFIDENCE_MULT[type] * atrVolMult(symbol),
  0.0025,  // 0.25% minimum
  0.015    // 1.5% maximum
);

// ATR-INVERSE VOLATILITY MULTIPLIER (new):
// If current ATR is 2× the 30-day average ATR, you're risking the same 1% on a trade
// that can move twice as far against you. A volatile loser hits harder than a quiet loser.
// This multiplier normalizes risk to volatility — same dollar risk regardless of ATR state.
function atrVolMult(symbol) {
  const atr_current = getCurrentATR(symbol);       // current 4H ATR%
  const atr_30d_avg = get30DayAvgATR(symbol);      // 30-day average 4H ATR%
  const ratio = atr_current / atr_30d_avg;

  if (ratio > 2.0) return 0.5;   // ATR 2× normal → half size
  if (ratio > 1.5) return 0.7;   // ATR 1.5× normal → 70% size
  if (ratio < 0.5) return 1.2;   // ATR very low → slight size increase (tight market)
  return 1.0;                     // normal ATR → no adjustment
}
// This is separate from the CRISIS regime multiplier (which is a hard 0.5× cap).
// atrVolMult fires WITHIN a regime when volatility spikes intra-regime.
// Example: BULL regime, sudden news spike → ATR doubles → atrVolMult = 0.5×
//          Combined: 1.0 (BULL) × 0.5 (atrVol) = 0.5× effective size
//          Without this: you'd take full 1% risk on a 2× volatility candle
```

---

### Step 6.2 — Strategy Priority (Regime-Dynamic, Not Static)

The priority order is NOT fixed. It is determined by which strategy had the
highest PF in the current regime during the Phase 1-5 backtests.

```javascript
// Build this lookup table from your Phase 1-5 regime-split results:
const STRATEGY_PRIORITY = {
  BULL:    ['LSO', 'VPB', 'OB', 'FVG'],   // CVD retired as standalone
  BEAR:    ['SHORT_LSO'],                   // SHORT-OB/FVG deferred to Year 2
  RANGING: ['FVG', 'OB'],
  CRISIS:  ['LSO'],
};

// When multiple strategies fire on the same candle:
//   Take the highest-priority strategy for that regime
//   Skip the rest (portfolio heat limit applies)
```

---

### Step 6.2b — Position Scaling (Pyramiding Into Winners)

This is where real PF improvement comes from — not more trades, but growing
the ones that are already working. The plan has entries and exits but no
mechanism for adding to winning positions.

```javascript
// Conditions to add to an open trade (pyramid in):
//   1. Trade has reached TP1 (1:1 R:R) — stop moved to breakeven
//   2. Strong continuation signal on 15m within 2 candles of TP1:
//      - New FVG or OB forms in trade direction
//      - OR RVOL > 1.5× on the continuation candle
//      - OR CVD confirms direction (if CVD passed Step 4.1)
//   3. Regime still allows the strategy
//   4. Portfolio heat after add-on still < 3% total

// Add-on sizing:
//   Add 25-50% of original position size (not a full new position)
//   New stop = breakeven of combined position (original entry)
//   New target = original TP2 (no change)
//   Risk on add-on = 0.5% max (half normal risk)

// Why this matters:
//   Without pyramiding: a 2R winner contributes 2R to PF
//   With pyramiding:    same trade contributes 2.5-3R to PF
//   Over 200 trades/year, this difference is significant
//   This is how PF moves from 1.5 to 1.8 without changing entry logic

// Backtest this separately:
//   Run Phase 6 combined system WITH and WITHOUT pyramiding
//   Compare PF, DD, and avg R:R achieved
//   If DD increases > 3% with pyramiding → reduce add-on size to 25%
```

---

### Step 6.3 — Full System Metrics + Time-Based Exit

```
Target thresholds (must ALL pass):
  PF > 1.6
  Annual return > 35% (after all costs)
  Max DD < 15%
  Sharpe > 1.5
  Trades/month: 15-30

Reject if:
  DD > 20% in any crisis simulation period
  Annual return < 25% after costs
  PF < 1.5
```

**Time-based exit mechanism (prevents winners becoming breakeven):**
```javascript
// In ranging markets, price often reaches 0.8× R:R then reverses before hitting 1:1.
// A winning trade becomes breakeven. Time-based partial exit fixes this.

const MAX_TRADE_DURATION = {
  BULL:    12 * 4,   // 12 hours at 15m = 48 candles
  RANGING:  8 * 4,   // 8 hours (ranging moves faster, reverses faster)
  BEAR:    16 * 4,   // 16 hours for short trades in bear regime
  CRISIS:   4 * 4,   // 4 hours maximum in crisis
};

// On each candle, check open trades:
//   If trade duration >= MAX_TRADE_DURATION[regime]:
//     If current profit >= 0.7× R:R → close 25% of remaining position at market
//     If current profit < 0.7× R:R → close entire position at market
//   This reduces average R:R slightly but dramatically cuts "winners that became losers"
//   Prevents trades from sitting as dead weight and tying up portfolio heat
```

**Momentum-based early exit (protects profits before reversal):**
```javascript
// Time-based exit handles duration. Momentum exit handles deterioration.
// Check on every candle for open trades that are in profit (> 0.5× R:R):

function checkMomentumExit(trade, candles, currentIndex) {
  const c = candles[currentIndex];
  const prev = candles[currentIndex - 1];

  // Signal 1: RVOL drops sharply (momentum drying up)
  const rvolDropped = c.rvol < 0.8 && prev.rvol > 1.5;

  // Signal 2: CVD flattens or reverses (buyers/sellers exhausted)
  const cvdFlattened = Math.abs(c.cvdDelta) < 0.1 * Math.abs(prev.cvdDelta);

  // Signal 3: Rejection candle forms near TP (wick > 60% of candle range, pointing against trade)
  const candleRange = c.high - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const rejectionNearTP = (upperWick / candleRange > 0.6) &&
                           (c.high >= trade.tp1 * 0.95); // within 5% of TP

  if (rvolDropped || cvdFlattened || rejectionNearTP) {
    // Close 50% of remaining position at market — don't close all (may still reach TP)
    return { action: 'PARTIAL_EXIT', fraction: 0.5, reason: 'momentum_deterioration' };
  }
  return null;
}
// Only trigger when trade is in profit (> 0.5× R:R) — don't exit losers early
// Log every momentum exit with reason for backtest analysis
```

**[KILL 8 FIX] Z-Score Distance Exit (corrected — uses 30-day historical vol, not 20-candle rolling):**
```javascript
// ORIGINAL PROBLEM: 20-candle rolling std produced inverted behavior.
// In trending markets → mean is high, std elevated → blow-off candle doesn't reach 3σ → hold too long.
// In choppy markets  → mean ≈ 0, std tiny → normal +0.3% candle fires 4σ → exit randomly.
//
// FIX: Use 30-day historical vol per 15m candle as denominator.
// "3σ" now means "3× normal per-candle volatility" — an absolute, regime-stable measure.

function checkZScoreExit(trade, candles, currentIndex, historicalVolStore) {
  if (trade.currentProfit < trade.tp1Distance) return null; // only after TP1

  const currentReturn = (candles[currentIndex].close - candles[currentIndex - 1].close)
    / candles[currentIndex - 1].close;

  // 30-day annualized vol scaled to 15m candle:
  // historicalVolStore: pre-calculated Map<symbol, annualizedVol>
  const annualizedVol = historicalVolStore.get(trade.symbol); // e.g. 0.65 for BTC
  const perCandleVol  = annualizedVol / Math.sqrt(365 * 96); // 96 × 15m candles/day

  const zScore = perCandleVol === 0 ? 0 : currentReturn / perCandleVol;

  // [NEW] Trade must be >= 85% of way to TP2 for a full exit.
  // Without this, fast NY session candles near TP1 trigger premature exits.
  const pctToTP2 = trade.tp2Distance === 0 ? 0 :
    (trade.currentProfit - trade.tp1Distance) / (trade.tp2Distance - trade.tp1Distance);

  const inTradeFavor = (trade.side === 'LONG' && zScore > 0) ||
                       (trade.side === 'SHORT' && zScore < 0);
  if (!inTradeFavor) return null;

  if (Math.abs(zScore) > 3.5 && pctToTP2 > 0.80) {
    return { action: 'FULL_EXIT', reason: 'zscore_blowoff', zScore, pctToTP2 };
  }
  if (Math.abs(zScore) > 2.5 && pctToTP2 > 0.90) {
    return { action: 'FULL_EXIT', reason: 'zscore_nearTP2', zScore, pctToTP2 };
  }
  return null;
}

// CVD-exhaustion complement (add alongside Z-score — whichever fires first wins):
// After TP1, when cumulative holding-period CVD peaks and prints 2 consecutive
// negative deltas → buyers exhausted → exit 75% immediately.
// Fires 1–3 candles before price turns, before any momentum indicator reacts.
function checkCVDExhaustionExit(trade, cvdDeltaHistory) {
  if (trade.currentProfit < trade.tp1Distance) return null;
  const recent = cvdDeltaHistory.slice(-3);
  if (recent.length < 3) return null;
  const peakReached = recent[0] > recent[1] && recent[1] > recent[2];
  const twoNegative = recent[1] < 0 && recent[2] < 0;
  if (peakReached && twoNegative) {
    return { action: 'PARTIAL_EXIT', fraction: 0.75, reason: 'cvd_exhaustion' };
  }
  return null;
}
// Log every exit reason for analysis.
```

**[KILL 9 REMOVED] Breakout Fallback — DELETED:**
```
// checkBreakoutFallback() has been removed entirely.
//
// WHY: The R:R math makes this a systematic loss generator.
//
// Original limit entry example (BTC FVG trade):
//   Entry:  $100,000 (FVG midpoint)
//   Stop:   $99,600  (FVG bottom − 0.1 ATR)
//   TP2:    $101,800 (DOL)
//   R:R:    1800 / 400 = 4.5:1
//
// After limit miss, price breaks above signal candle high ($100,600):
//   Fallback entry: $100,600 (market at breakout close)
//   Stop unchanged: $99,600
//   TP2 unchanged:  $101,800
//   R:R:            1200 / 1000 = 1.2:1
//
// For PF > 1.2 at 1.2:1 R:R, WR must be > 50%.
// FVG live WR estimate: 42–50%. The fallback requires the TOP of the entire WR range
// just to break even — and that's before market-order slippage on a fast breakout candle.
//
// Missed trades are missed. Accept it. Log them as MISSED_LIMIT for analysis.
// DO NOT chase. DO NOT fallback.
// If a strategy is generating too many missed limits, the fix is to widen the entry
// zone (e.g., FVG top to FVG bottom, not just midpoint) — not to chase at market.
```

---

### Step 6.4 — Rolling Walk-Forward Validation (Fixed 18-Month Windows)

Anchored walk-forward (expanding training set) masks concept drift — later windows
have seen more data and look artificially stable. Use a fixed 18-month training window
that rolls forward, so every window tests the same amount of training data.

```
Window 1: Train 2021-01 → 2022-06  |  Test 2022-07 → 2022-12
Window 2: Train 2021-07 → 2023-01  |  Test 2023-02 → 2023-06
Window 3: Train 2022-01 → 2023-07  |  Test 2023-08 → 2023-12
Window 4: Train 2022-07 → 2024-01  |  Test 2024-02 → 2024-06
Window 5: Train 2023-01 → 2024-07  |  Test 2024-08 → 2024-12

For each window, record: PF, WR, DD, trade count
Plot the degradation curve.

PASS: PF degrades < 20% from Window 1 to Window 5
FAIL: PF degrades > 20% OR shows cliff-edge drop at any window

Cliff-edge pattern (e.g., PF 1.8 → 1.9 → 1.7 → 0.9 at Window 4):
  → Strategy hit a regime in that window the regime engine didn't classify correctly
  → Investigate which regime changed at that window boundary — it's a bug, not bad luck

Smooth gradual decline (1.9 → 1.6 → 1.4): acceptable and expected.
```

---

### Step 6.5 — Gate 8 ON vs OFF Comparison (Macro Gates)

v3.0's macro gates (F&G, funding rates) adjust position size and signal confidence.
This step validates whether they actually improve results or just reduce trade count.

```
Run combined system twice:
  Run A: Gate 8 DISABLED (no F&G, no funding rate adjustments)
  Run B: Gate 8 ENABLED  (full macro gates active)

Compare:
  PF delta:          expect Run B PF > Run A PF by >= 0.1
  WR delta:          expect Run B WR > Run A WR by >= 3pp
  Trade count delta: expect Run B has 10-20% fewer trades
  DD delta:          expect Run B DD < Run A DD

If Run B PF < Run A PF: macro gates are hurting, not helping
  → Investigate which gate is causing the drag
  → Disable that specific gate, not all of Gate 8

Record: results/gate8_comparison.json
```

---

### Step 6.6 — Slippage Sensitivity Stress Test

The 9-gate system filters aggressively. The risk is that the edge is too thin
to survive live execution costs that are worse than modeled. This test exposes that.

```
Run the combined system THREE times with different cost assumptions:
  Run A: Base costs (current model — already realistic)
  Run B: 2× slippage on all symbols, all conditions
  Run C: 3× slippage + 90% fill rate reduced to 70%

For each strategy, record PF in Run A, B, C:

  Strategy    Run A    Run B    Run C    Verdict
  FVG         1.6      ?        ?        Edge thin if Run B < 1.3
  OB          1.5      ?        ?        Edge thin if Run B < 1.2
  LSO         1.7      ?        ?        Edge thin if Run B < 1.3

PASS: Run B PF > 1.3 for all strategies (edge survives 2× slippage)
WARN: Run B PF 1.1-1.3 → edge is marginal, live execution must be tight
FAIL: Run B PF < 1.1 → strategy does not survive realistic cost variance

If a strategy fails the stress test:
  → Do NOT go live with that strategy regardless of base backtest results
  → The edge is too thin — it only exists in ideal execution conditions
  → Either find a way to improve fill quality (tighter entry, better timing)
    or accept the strategy is not viable for live trading

Record: results/slippage_stress_test.json
```

---

## Phase 7 — Monte Carlo + Anti-Overfitting Validation

---

### Step 7.1 — Monte Carlo (1000 Simulations Per Strategy)

```javascript
// For each accepted strategy, run 1000 simulations:
// Each simulation randomizes:
//   1. Trade ORDER — but shuffle 4-WEEK BLOCKS, not individual trades
//      Real drawdowns cluster in calendar time (Oct 2022 was all losses).
//      Shuffling individual trades destroys that structure and understates real DD risk.
//      Shuffling 4-week blocks preserves within-window correlation while testing
//      different sequences of market regimes — the actual uncertainty.
//   2. Fill prices: add random noise ±0.05% to each fill
//   3. Remove 5% of trades randomly (simulates missed signals)

// For each simulation, calculate: final equity, max DD, PF

// Results:
//   10th percentile equity > starting equity → ROBUST
//   10th percentile equity < starting equity → FRAGILE (do not go live)
//   Median DD < 15% → acceptable drawdown profile
//   90th percentile DD < 25% → worst-case drawdown is survivable

function groupIntoWeeklyBlocks(trades, weeksPerBlock = 4) {
  // Group trades by their 4-week calendar window
  const blocks = {};
  trades.forEach(t => {
    const blockKey = Math.floor(t.openTime / (weeksPerBlock * 7 * 24 * 3600 * 1000));
    if (!blocks[blockKey]) blocks[blockKey] = [];
    blocks[blockKey].push(t);
  });
  return Object.values(blocks); // array of blocks, each block = array of trades
}

// WARNING: Running 1000 simulations × all strategies sequentially on the main thread
// will lock the Node.js event loop and can crash the V8 heap on large trade sets.
// Monte Carlo MUST run in worker_threads — one worker per CPU core.

// backtest/monteCarlo.js
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

if (isMainThread) {
  // Main thread: splits simulations across CPU cores
  function runMonteCarlo(trades, simulations = 1000) {
    return new Promise((resolve) => {
      const numCPUs = os.cpus().length;
      const simsPerWorker = Math.ceil(simulations / numCPUs);
      const allResults = [];
      let completed = 0;

      for (let i = 0; i < numCPUs; i++) {
        const worker = new Worker(__filename, {
          workerData: { trades, sims: simsPerWorker }
        });
        worker.on('message', (workerResults) => {
          allResults.push(...workerResults);
          completed++;
          if (completed === numCPUs) {
            resolve({
              p10:      percentile(allResults.map(r => r.finalEquity), 10),
              p50:      percentile(allResults.map(r => r.finalEquity), 50),
              p90:      percentile(allResults.map(r => r.finalEquity), 90),
              medianDD: percentile(allResults.map(r => r.maxDD), 50),
              p90DD:    percentile(allResults.map(r => r.maxDD), 90),
            });
          }
        });
      }
    });
  }
} else {
  // Worker thread: runs its share of simulations without blocking main thread
  const results = [];
  for (let i = 0; i < workerData.sims; i++) {
    const shuffled = shuffle([...workerData.trades]);
    const sampled = shuffled.filter(() => Math.random() > 0.05);
    const noisyFills = sampled.map(t => ({
      ...t,
      entry: t.entry * (1 + (Math.random() - 0.5) * 0.001),
      exit:  t.exit  * (1 + (Math.random() - 0.5) * 0.001),
    }));
    results.push(simulateEquityCurve(noisyFills));
  }
  parentPort.postMessage(results);
}
// Also use worker_threads for Phase 6 combined system backtest when streaming
// millions of NDJSON candles — the 24H rolling Volume Profile and EMA200
// calculations are CPU-heavy enough to stall the event loop on the main thread.
```

**Wilson Confidence Interval — add to every WR result in every results file:**
```javascript
// 30 trades is statistically weak. At 40% WR, 30-trade 95% CI = 23%-59% (useless).
// At 100 trades, 95% CI = 30%-50% (actionable). Report CI alongside every WR number.

function calcWRConfidenceInterval(wins, total) {
  const p = wins / total;
  const z = 1.96; // 95% CI
  const n = total;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  const denom = 1 + z * z / n;
  return {
    lower: (center - margin) / denom,
    point: p,
    upper: (center + margin) / denom,
    reliable: total >= 100,   // only flag as STATISTICALLY_RELIABLE at n >= 100
    n: total,
  };
}

// Every results file must include CI alongside WR:
// { wr: 0.46, ci_lower: 0.38, ci_upper: 0.54, reliable: false, n: 52 }
// Do NOT make accept/reject decisions on WR alone when reliable: false
// Use PF as the primary metric when n < 100 (PF is more stable at small samples)
```

---

### Step 7.2 — Survivorship Bias / Crisis Period Check

Verify the combined system backtest includes these specific crash periods:

```
Period 1: March 2020 (COVID crash)
  BTC: -50% in 2 days
  Expected: CRISIS regime activates, LSO only, 0.5% size
  Acceptable: DD < 20% during this period

Period 2: May 2021 (China mining ban)
  BTC: -55% over 3 weeks
  Expected: BEAR regime, short strategies active
  Acceptable: DD < 20%

Period 3: November 2022 (FTX collapse)
  BTC: -25% in 3 days
  Expected: CRISIS regime, emergency stops trigger
  Acceptable: DD < 20%

Period 4: Q4 2025 (altcoin bloodbath — if data available)
  Expected: BEAR regime, short strategies active

If DD > 20% in ANY of these periods:
  → Fix crisis regime handling before proceeding to Phase 8
  → Specifically: verify emergency exit trigger (BTC -2% in 15m = exit all)
  → Verify CRISIS regime activates within 1-2 candles of the crash start
```

---

## Phase 8 — 2025 Forward Test (Final Gate)

**This data has never been touched. It is the only honest measure of live viability.**

---

### Step 8.1 — Run Combined System on 2025 Data

```
Use: all parameters from Phase 6 (no changes allowed after seeing 2025 data)
Run: full combined system, all gates, adaptive sizing
Period: 2025-01-01 to 2025-12-31

Record: results/forward_2025.json
```

---

### Step 8.2 — Forward Test Accept/Reject

```
PASS (ready for paper trading):
  ✓ System is profitable (positive equity at year end)
  ✓ Max DD < 20%
  ✓ PF > 1.3 (lower bar — forward test is harder than backtest)
  ✓ No strategy shows WR < 30% on 2025 data

FAIL (return to Phase 1):
  ✗ System is unprofitable
  ✗ Max DD > 20%
  ✗ PF < 1.0

On FAIL:
  → Identify which strategy degraded most on 2025 data
  → Check if 2025 introduced a new regime pattern not seen in 2021-2024
  → Adjust regime detection if needed (this is the one valid reason to change parameters)
  → Re-run from Phase 1 for the failing strategy only
  → Do NOT re-run all strategies (that would contaminate the forward test)
```

---

### Step 8.3 — Secondary Out-of-Sample Test (ETH-Only)

The 2025 forward test has a known limitation: the CRISIS handling parameters
were designed knowing 2025 had severe drawdowns. This is subtle cognitive
contamination that cannot be undone.

Mitigation: run a secondary forward test using ETH-only data with BTC-trained parameters.
ETH was never used to train any parameter — it is a genuine out-of-sample instrument.

```
Run: combined system on ETHUSDT data only, 2025 full year
Parameters: unchanged from Phase 6 (BTC-trained)
Expected: PF will be lower (ETH has different microstructure)
Accept if: PF > 1.1 (lower bar — cross-instrument test)
Reject if: PF < 1.0 (parameters don't generalize at all)

This is not a replacement for the 2025 BTC forward test.
It is a second data point that confirms (or challenges) generalizability.
Record: results/forward_2025_eth_only.json
```

---

## Phase 9 — Paper Trading Transition

Only reached after Phase 8 PASS.

---

### Step 9.1 — Paper Trading Setup

```
Duration: minimum 60 days, minimum 40 trades
  (30 days / 20 trades is not enough — at 40% WR, a 20-trade sample has a
  confidence interval so wide you could get 8 wins by pure variance and
  incorrectly conclude the strategy is broken)

Exchange: Binance Futures testnet OR real account with 0.1% of intended capital
Monitoring: all 9 gates logged per signal, all trades logged with full context

MANDATORY coverage requirements — paper period MUST include:
  ✓ At least ONE regime change (e.g., BULL → RANGING or RANGING → BEAR)
  ✓ At least ONE major macro event (FOMC or CPI release)
  If the 60-day paper period falls entirely in a single quiet BULL regime
  with no events, extend it until both conditions are met.
  A paper period in ideal conditions only proves the system works in ideal
  conditions — not that it works.

Live vs backtest comparison (check weekly):
  If live WR < backtest WR by > 10pp → investigate signal detection
  If live PF < 1.2 after 40 trades → pause, investigate
  If live DD > 10% in paper trading → do not go live with real capital
```

---

### Step 9.1b — Risk Scaling Protocol (Phase 1 → Phase 2)

The 1.5% risk cap is correct for an unproven system. But pros scale risk
after validation — not before, not never. This is the gating structure:

```
PHASE 1 LIVE (first 60 trades):
  Max risk per trade: 1.5% (current cap — unchanged)
  Reason: system unproven, edge not confirmed at live execution quality

PHASE 2 LIVE (after 60 trades, if ALL conditions met):
  Max risk per trade: 2.0% in high-confluence setups ONLY
  Conditions to unlock Phase 2:
    ✓ 60 live trades completed
    ✓ Live WR within 8pp of backtest WR
    ✓ Live PF > 1.35
    ✓ No individual month worse than -5%
    ✓ Live DD never exceeded 12%

  High-confluence definition for 2.0% sizing:
    All 9 gates pass + OI flush >= 2.5% + funding confirms direction
    (Same as "high_confluence" multiplier — not a new category)

  If any Phase 2 condition breaks after unlocking:
    → Revert to Phase 1 cap (1.5%) immediately
    → Re-qualify after next 30 trades

This is not aggressive — it's disciplined scaling after evidence.
```

---

### Step 9.2 — Strategy Self-Monitoring Setup (Pre-Live)

Before going live, set up the per-strategy performance tracker:

```javascript
// MongoDB collection: strategy_performance
// Schema per entry:
{
  strategy: "LSO",          // strategy name
  regime: "BULL",           // regime at time of trade
  period: "2026-04",        // monthly bucket
  trades: 0,
  wins: 0,
  losses: 0,
  win_rate: 0,
  avg_rr_achieved: 0,
  profit_factor: 0,
  status: "ACTIVE"          // ACTIVE | WATCH | PAUSED
}

// Alert thresholds (checked every 25 trades or weekly):
// WATCH:  rolling 25-trade WR < 35% OR PF < 1.2 OR 4 consecutive losses
// PAUSE:  rolling 50-trade WR < 30% OR PF < 1.0 OR daily loss > 3%
// RESUME: manual only, 7-day minimum pause, 5 paper trades validated first

// Telegram alerts:
// "⚠️ Strategy LSO entering WATCH mode — 25-trade WR: 34%"
// "🛑 Strategy CVD AUTO-PAUSED — 50-trade WR: 28%"
// "✅ Strategy OB resumed after manual review"
```

---

## Quality Gate Reference (All 9 Gates)

Every trade must pass ALL gates. One failure = no trade.

```
GATE 0 — Regime Compatibility
  Strategy is allowed in current regime (per strategy routing table)
  Regime has been stable for >= 2 consecutive 4H closes

GATE 1 — HTF Trend Alignment
  LONG:  4H EMA200 pointing up AND price above 4H EMA50
  SHORT: 4H EMA200 pointing down AND price below 4H EMA50

GATE 2 — Setup Validity
  One of the 7 strategies produces a valid signal (fresh, within 2 candles)

GATE 3 — RVOL Confirmation (time-normalized)
  Inside killzone:   RVOL > 1.5×
  NY PM session:     RVOL > 1.8×
  Asian session:     RVOL > 2.5×

GATE 4 — R:R Minimum via DOL
  DOL target identified (structural)
  Calculated R:R >= 1.8:1

GATE 5 — Portfolio State
  Max 3 concurrent open trades
  Daily loss < 3% → pause 24H

  CORRELATION CLUSTER RULE (replaces "BTC+ETH only" — that was too loose):
  Actual 2024-2026 correlation matrix:
    BTC ↔ ETH: 0.85-0.92  |  BTC ↔ SOL: 0.78-0.88  |  BTC ↔ BNB: 0.72-0.82
  Having BTC long + SOL long + BNB long = economically 3× BTC exposure.
  All three hit stops simultaneously during a BTC flush.

  Rule: Two correlation clusters defined:
    Cluster A: [BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT]
    Cluster B: [XRPUSDT]
  At any time: max 1 open position from Cluster A.
  Max 2 total concurrent trades (1 from A + 1 from B).
  This is stricter than the previous "max 3" rule but eliminates correlated drawdowns.

GATE 6 — Execution Feasibility
  Spread < 0.05%
  ATR_15m > 0.3% of price

GATE 7 — OI Confirmation (LSO only)
  OI_delta < -1.5% on sweep candle (long LSO)
  OI_delta > +1.5% on sweep candle (short LSO)
  CVD direction confirms trade direction

GATE T — Temporal / Killzone
  London Open (07:00-09:00 UTC): standard thresholds
  NY Open (13:00-15:00 UTC): standard thresholds
  Asian session (22:00-07:00 UTC):
    LSO: allowed (liquidity sweeps are valid — equal lows/highs hunted before London)
    FVG: DISABLED (hard gate — no exceptions regardless of RVOL)
    OB:  DISABLED (hard gate — Asian session OBs are market maker fakeouts)
    VPB: DISABLED
  Outside all killzones (09:00-13:00, 15:00-22:00 UTC):
    All strategies: RVOL threshold increases to 2.0× (stricter than killzone)

GATE 8 — Macro Sentiment
  No macro blackout window active (CPI, FOMC, NFP)
  F&G within acceptable range for current regime
  Funding rate not extreme in same direction as trade
  Strategy not in WATCH mode (if WATCH: reduce size 50%)
  Strategy not in PAUSE mode (if PAUSE: reject)
```

---

## Results File Structure

```
results/
├── fvg_baseline.json
├── fvg_regime.json
├── fvg_full_gates.json
├── fvg_sensitivity.json
├── fvg_regime_split.json
├── fvg_yearly.json               ← 2021/2022/2023/2024 breakdown
├── ob_baseline.json
├── ob_regime.json
├── ob_full_gates.json
├── ob_sensitivity.json
├── ob_regime_split.json
├── ob_yearly.json
├── lso_no_oi.json
├── lso_with_oi.json
├── lso_full_gates.json
├── lso_sensitivity.json
├── lso_regime_split.json
├── lso_yearly.json
├── cvd_correlation.json          ← aggregate + sweep-candle-specific Pearson test
├── vpb_full_gates.json
├── short_lso_full_gates.json     ← SHORT-LSO only (SHORT-OB/FVG deferred)
├── combined_system.json
├── combined_walkforward.json     ← 5 rolling 18-month windows
├── gate8_comparison.json         ← Gate 8 ON vs OFF
├── regime_calibration.json       ← slope threshold grid (Step 0.7)
├── montecarlo_per_strategy/
│   ├── fvg_mc.json               ← includes Wilson CI on all WR numbers
│   ├── ob_mc.json
│   └── ...
├── crisis_periods.json           ← DD during each crash period
└── forward_2025.json             ← final gate — never open until Phase 8
```

---

## Anti-Overfitting Checklist (Run Before Phase 8)

```
□ Every strategy has <= 8 tunable parameters
□ Every parameter passed sensitivity test (WR variation < 15pp across ±20% range)
□ Walk-forward shows < 20% PF degradation across 5 rolling windows
□ Monte Carlo 10th percentile is positive for every strategy
□ Crisis periods show DD < 20%
□ Gate 8 ON shows better PF than Gate 8 OFF
□ CVD approximation correlation >= 0.75 (or CVD disabled)
□ Short strategies tested on BEAR regime periods only
□ 2025 data has never been used in any optimization step
□ Macro event blackout windows are tagged in all historical data
```

---

*End of BulletBrain v3.0 Backtesting Master Plan*
*Next step: Start Phase 0 — build the scaffold, download data, build indicators*
