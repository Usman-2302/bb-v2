# BulletBrain v3.0 — Development Master Plan
# From Planning to Live Trading
# Status: Active — April 2026

---

## How to Use This Document

This is the execution guide. Every phase maps directly to `backtestplan.md`.
Each step includes:
- What to build
- Exact source lines in `backtestplan.md` where the spec lives
- Done criteria (how you know the phase is complete)
- Hard rules that cannot be skipped

**The spec file:** `backtestplan.md` — read it before starting any phase.
**The validator:** `bulletbrain_v3_validator.pine` — use in TradingView before Phase D6.
**Config file:** `config.js` — ALL parameters live here. Never hardcode in strategy files.

---

## Critical Execution Rules (Read Before Starting)

```
1. Never skip a phase. Each is a prerequisite for the next.
2. Never change the engine (Phase D4) after Phase D6 starts.
   Any engine change invalidates all prior backtest results.
3. Never look at 2025 data until Phase D13. It is the final gate.
4. Every accept/reject decision gets documented with actual numbers.
5. If a strategy fails, document why and move on. Max 3 retries.
6. Run Pine Script validator before Phase D6 to visually confirm
   detectors fire on the right candles.
7. All parameters in config.js only. Zero hardcoded values in strategy files.
8. Every indicator is a pure function: (candles[]) → values[]. No side effects.
```

---

## Critical Path

```
D0 → D1 + D2 (parallel) → D3 → D4 → D5 → D6 → D7 → D8 → D9 → D10
→ D11 → D12 → D13 → D14

D1 and D2 can run in parallel (data download runs in background while
you build indicators). Everything else is sequential.
```

---

## Phase D0 — Project Setup

**Duration:** 1-2 days
**Goal:** Repo ready, dependencies installed, folder structure created, config populated.

### What to Build

```
1. npm init in bbv2/ directory

2. Install dependencies:
   npm install axios ws ndjson dotenv jest

   axios          → Binance REST API calls
   ws             → WebSocket (for live trading later)
   ndjson         → streaming NDJSON read/write
   dotenv         → API keys from .env file
   jest           → unit testing

3. Create folder structure:
   bbv2/
   ├── src/
   │   ├── indicators/
   │   ├── strategies/
   │   ├── backtest/
   │   ├── data/
   │   └── utils/
   ├── data/
   │   ├── historical/
   │   ├── oi/
   │   └── funding/
   ├── results/
   ├── config.js
   └── package.json

4. Create config.js with ALL parameters from backtestplan.md:
   - EXECUTION_PARAMS (per-symbol slippage)
   - COSTS object (fees, fill rates, signal delay)
   - FVG, OB, LSO, VPB config blocks
   - Regime thresholds (slope angle, ATR%, ER threshold)
   - RVOL thresholds per session
   - Position sizing multipliers

5. Create src/utils/logger.js
   - Timestamps, log levels (INFO/WARN/ERROR)
   - File output to logs/ directory
```

### Source in backtestplan.md
- Project scaffold: **lines 67-90** (Step 0.1)
- Config parameters: **lines 194-408** (Step 0.4 — COSTS object, fill model)
- Strategy configs: **lines 607-643** (FVG), **lines 898-931** (OB)

### Done Criteria
```
✓ npm test passes on empty test suite
✓ Folder structure matches Step 0.1 exactly
✓ config.js exists with all parameter blocks
✓ .env file created with BINANCE_API_KEY placeholder
```

---

## Phase D1 — Data Download

**Duration:** 3-5 days (download runs overnight)
**Goal:** All historical OHLCV, OI, and funding data downloaded and validated.

### What to Build

```
1. src/data/downloader.js
   - downloadKlines(symbol, interval, startTime, endTime)
   - Pagination: 1500 candles per request
   - Rate limit: sleep(100ms) between requests
   - Append to NDJSON, resume from last candle if interrupted
   - Progress logging

2. src/data/oiDownloader.js
   - Fetch CSV from Binance bulk data endpoint:
     https://data.binance.vision/data/futures/um/daily/openInterest/
   - Parse CSV → convert to NDJSON
   - Store in data/oi/{symbol}_1H.ndjson
   NOTE: This is CSV format, NOT the REST API. Different endpoint.

3. src/data/fundingDownloader.js
   - Fetch /fapi/v1/fundingRate history
   - Store in data/funding/{symbol}_8h.ndjson
   - This data is used by applyFundingCost() in the engine

4. src/data/validator.js
   - Check for gaps > 2 consecutive candles
   - Verify candle count matches expected for period
   - Filter zero-volume candles (data artifacts)
   - Output validation report to results/data_validation.json

5. Run downloads:
   Coins:      BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT
   Timeframes: 15m, 1H, 4H, Daily
   Period:     2021-01-01 to 2024-12-31
   OI:         1H resolution
   Funding:    8H resolution
   2025 data:  DO NOT DOWNLOAD YET (reserved for Phase D13)
```

### Source in backtestplan.md
- Download spec: **lines 91-128** (Step 0.2)
- OI format note: **lines 105-112** (CSV not JSON)
- Funding data: **lines 231-265** (COSTS object funding section)
- Validation rules: **lines 120-128**

### Done Criteria
```
✓ validator.js passes on all downloaded files
✓ data/historical/ has all 20 NDJSON files (5 coins × 4 timeframes)
✓ data/oi/ has 5 NDJSON files (1H OI per coin)
✓ data/funding/ has 5 NDJSON files (8H funding per coin)
✓ Validation report shows no critical gaps
```

---

## Phase D2 — Indicator Library

**Duration:** 3-4 days (runs parallel with D1)
**Goal:** All indicators as pure functions, unit tested against known values.

### What to Build

Build in this order. Each gets its own unit test file.

```
1. src/indicators/ema.js
   - ema(closes[], period) → values[]
   - Test: EMA(9) on 20 BTC 1H candles — verify against TradingView

2. src/indicators/atr.js
   - atr(candles[], period) → values[]
   - atrPct(candles[], period) → values[] (ATR / close × 100)
   - Test: ATR(14) on 20 BTC 1H candles

3. src/indicators/rvol.js
   - Time-normalized RVOL (20-day same-slot average)
   - Time slot = 15m bucket (96 slots per day)
   - rvol(candles[], period) → values[]
   - NOT a simple SMA of volume — must use same-time-slot baseline

4. src/indicators/cvd.js
   - buyVol = volume × (close - low) / (high - low)
   - sellVol = volume × (high - close) / (high - low)
   - cvdDelta = buyVol - sellVol
   - cumulativeCVD resets at 00:00 UTC daily
   - cvd(candles[]) → { delta[], cumulative[] }

5. src/indicators/swingHL.js
   - SwingHigh[i]: high[i] > high[i-1] AND high[i] > high[i-2]
                   AND high[i] > high[i+1] AND high[i] > high[i+2]
   - SwingLow[i]:  low[i] < low[i-1] AND low[i] < low[i-2]
                   AND low[i] < low[i+1] AND low[i] < low[i+2]
   - Lookback: 2 candles each side (from config.js)

6. src/indicators/volumeProfile.js
   - 24H rolling window, 50 price buckets
   - HVN, LVN, POC identification
   - volumeProfile(candles[], buckets=50) → { hvn, lvn, poc, buckets[] }

7. src/indicators/efficiencyRatio.js
   - ER = directional move / sum of absolute moves over period
   - efficiencyRatio(candles[], period=10) → values[]
   - Used by zombie detection in regime engine
```

### Source in backtestplan.md
- All indicator specs: **lines 129-193** (Step 0.3)
- CVD formula: **lines 163-172**
- Volume Profile: **lines 174-182**
- ER formula: **lines 476-487** (Zombie state section)

### Done Criteria
```
✓ All 7 indicator unit tests pass
✓ EMA, ATR values match TradingView reference within 0.01%
✓ RVOL uses time-normalized baseline (not simple SMA)
✓ CVD resets at 00:00 UTC
✓ No indicator has side effects or global state
```

---

## Phase D3 — Regime Engine

**Duration:** 2-3 days
**Goal:** Every candle tagged with regime, slope threshold calibrated and locked.

### What to Build

```
1. src/utils/regimeDetector.js

   detectRegime(btcCandles_4H, index):
     - Calculate EMA200 slope angle over last 10 periods
     - Count price above EMA200 in last 30 candles
     - CRISIS if ATR% > 5 (overrides everything)
     - BULL if slope >= threshold AND priceAboveEMA >= 20
     - BEAR if slope <= -threshold AND priceAboveEMA <= 10
     - RANGING otherwise
     - Anti-flapping: require 2 consecutive 4H closes to switch regime

   checkVolSwitch(candles_15m, currentIndex, atr_4H_baseline):
     - If 15m ATR > 3× 4H ATR baseline → return 'CRISIS' immediately
     - Bypasses the 4H anti-flapping rule
     - Catches flash crashes within 1-2 candles

   calcEfficiencyRatio(candles, period=10):
     - ER = directional move / sum of absolute moves
     - Used by zombie and prezone detection

   detectZombie(candles_4H, index, rangingATRavg):
     - If RANGING AND ER < 0.3 → RANGING_ZOMBIE
     - Disables FVG, OB, VPB

   detectPreZone(candles_4H, index, rangingATRavg):
     - ATR declining 3 consecutive checks
     - ATR < 0.70 × rangingATRavg
     - ER declining AND er_current < 0.45
     - Returns RANGING_PREZONE → 50% size, 2.5:1 R:R minimum

2. Run Step 0.7 calibration BEFORE tagging any data:
   Test slope thresholds: [8, 10, 12, 15, 18, 20, 22] degrees
   For each: tag all 4H BTC candles, compute WR delta BULL vs RANGING
   Pick threshold that maximizes separation
   Lock in config.js — document the evidence
   Expected result: optimal is likely 10-13°, not 15°

3. Tag all historical candles:
   - Run detectRegime() on all 4H BTC candles
   - Propagate regime tag to 15m and 1H candles in same window
   - Output: data/historical/{symbol}_{tf}_tagged.ndjson
   - Each candle gets .regime field

4. Visual validation:
   - Export regime periods to CSV
   - Verify: 2021 Q1-Q3 = BULL, 2022 = BEAR majority,
             2023 Q1-Q2 = RANGING→BULL, Nov 2022 = CRISIS
```

### Source in backtestplan.md
- Regime detection function: **lines 409-447** (Step 0.5)
- Vol-switch: **lines 448-470** (Step 0.5 vol-switch section)
- Zombie state + ER: **lines 471-510** (Zombie/Inertia section)
- RANGING_PREZONE: **lines 500-530** (detectPreZone section)
- Slope calibration: **lines 571-598** (Step 0.7)

### Done Criteria
```
✓ Slope threshold chosen and documented in config.js
✓ All historical candles tagged with .regime field
✓ Visual validation passes (2022 = BEAR, 2021 = BULL)
✓ Vol-switch unit test: 15m ATR spike triggers CRISIS immediately
✓ Zombie detection unit test: ER < 0.3 returns RANGING_ZOMBIE
```

---

## Phase D4 — Backtest Engine Core

**Duration:** 5-7 days
**Goal:** Engine that replays candles and simulates trades with full cost model.

**This is the most critical phase. Build it once. Test it thoroughly.
Never change the engine after Phase D6 starts.**

### What to Build

```
1. src/backtest/engine.js — core replay loop

   Core loop:
   - Stream NDJSON candles chronologically (never load all into memory)
   - On each candle: check pending orders, update open positions,
     check exit conditions, evaluate new signals

   simulateLimitFill(candle, order, strategy, rvol):
   - MISS: price didn't reach limit
   - EXACT_TOUCH: candle.low === limitPrice → no fill (back of queue)
   - CLEAN: penetration < 0.02% → fill at fill_rate probability
   - MARGINAL: penetration 0.02-0.10% → fill at 85% of fill_rate, +0.1% stop slippage
   - TOXIC: penetration > 0.10% → always fills, +0.3% stop slippage
   Returns: { fill, quality, extraStopSlippage }

   simulatePositionFill(intendedSize, rvol):
   - RVOL > 3.0 → 70% of intended size
   - RVOL > 2.0 → 82% of intended size
   - Normal → 100%

   applyFundingCost(trade, currentTimestamp, fundingDataStore):
   - Called on every 8H funding timestamp while trade is open
   - Reads from data/funding/{symbol}_8h.ndjson
   - Longs pay when rate > 0, receive when rate < 0
   - Updates trade.cumulativeFundingCost and trade.pnl

   Position state machine:
   - OPEN → PARTIAL_CLOSE (at TP1) → CLOSED (at TP2 or stop)
   - Move stop to breakeven after TP1

   Risk controls:
   - Daily loss tracker: pause all trading if daily loss > 3%
   - Portfolio heat: max 3% total risk across all open positions
   - Correlation cluster: max 1 open from [BTC/ETH/SOL/BNB] cluster

   Exit conditions (check in order on each candle):
   1. Stop hit (with extraStopSlippage if TOXIC fill)
   2. TP2 hit
   3. Time-based exit (MAX_TRADE_DURATION per regime)
   4. Momentum exit (RVOL drop, CVD flatten, rejection candle near TP)
   5. Z-score exit (30-day historical vol denominator, pctToTP2 > 0.80)
   6. CVD exhaustion exit (2 consecutive negative deltas after TP1)
   7. Crisis emergency exit (BTC -2% in 15m → exit all)

2. src/backtest/reporter.js — output generator

   Per strategy run, output JSON with:
   - WR, PF, avg R:R, max DD, Sharpe
   - Regime breakdown: WR/PF per regime
   - Ghost trade rate (exact touch fills that would have been no-fill)
   - Toxic fill rate (penetration > 0.10%)
   - Wilson CI on every WR number (reliable: true only at n >= 100)
   - Cumulative funding cost (actual rates)
   - Year-by-year breakdown: 2021 / 2022 / 2023 / 2024
   - Missed trades count

3. Engine validation tests (mandatory before Phase D6):
   - Feed 100 synthetic candles with known outcomes
   - Verify equity curve matches manual calculation exactly
   - Verify TOXIC fill adds 0.3% extra stop slippage
   - Verify MARGINAL fill adds 0.1% extra stop slippage
   - Verify funding cost matches downloaded data (not flat 0.01%)
   - Verify daily loss pause triggers at exactly 3%
   - Verify portfolio heat blocks 4th trade when 3% is reached
   - Verify Wilson CI calculation is correct
```

### Source in backtestplan.md
- Engine responsibilities: **lines 194-210** (Step 0.4)
- COSTS object + per-symbol slippage: **lines 211-270** (Step 0.4)
- applyFundingCost function: **lines 271-295** (Step 0.4)
- Fill model (CLEAN/MARGINAL/TOXIC): **lines 296-370** (Step 0.4)
- Report generator output: **lines 371-408** (Step 0.4)
- Time-based exit: **lines 1469-1510** (Step 6.3)
- Momentum exit: **lines 1511-1540** (Step 6.3)
- Z-score exit: **lines 1541-1600** (Step 6.3)
- CVD exhaustion exit: **lines 1580-1600** (Step 6.3)
- Correlation cluster rule: **lines 2010-2025** (Gate 5)

### Done Criteria
```
✓ All engine validation tests pass
✓ Equity curve matches manual calculation on synthetic data
✓ TOXIC fill correctly adds 0.3% extra stop slippage
✓ Funding cost uses actual downloaded data (not flat rate)
✓ Daily loss pause triggers correctly
✓ Wilson CI outputs reliable: false when n < 100
✓ Reporter outputs all required metrics including toxic_fill_rate
```

---

## Phase D5 — Macro Event Tagger

**Duration:** 1-2 days
**Goal:** FOMC/CPI/NFP blackout windows tagged in all historical data.

### What to Build

```
1. Create data/macro_events.json
   Hard-code all 2021-2024 event timestamps:
   - US CPI releases (monthly)
   - FOMC decisions (8× per year)
   - Non-Farm Payrolls (monthly)
   Format: [{ event: "CPI", timestamp: 1234567890000, blackout_minutes: 45 }]

2. src/utils/macroTagger.js
   - isInBlackout(timestamp, macroEvents[]) → boolean
   - Blackout window: 30 min before + 15 min after each event

3. Add blackout check to engine.js:
   - On each candle: if isInBlackout(candle.openTime) → skip signal evaluation
   - Existing trades: tighten stops to 50% of normal stop distance during blackout

Expected impact: ~3% of trading time blacked out,
~25% reduction in unexpected stop-outs during event periods
```

### Source in backtestplan.md
- Macro blackout spec: **lines 548-570** (Step 0.6)
- Gate 8 macro check: **lines 2040-2055** (Gate 8 reference)

### Done Criteria
```
✓ data/macro_events.json has all 2021-2024 events
✓ Engine skips signals during blackout windows
✓ Unit test: candle during FOMC window returns isInBlackout = true
```

---

## Phase D6 — Strategy 3: FVG Fill

**Duration:** 5-7 days
**Goal:** FVG strategy validated, accept/reject decision documented.

**Before starting:** Run `bulletbrain_v3_validator.pine` in TradingView on BTCUSDT 1H.
Visually confirm FVG zones appear on the correct candles before writing any backtest code.

**Also before starting — run candle frequency analysis (1-2 hours, saves weeks):**
```
Using the tagged regime data from Phase D3, run a quick frequency count:
  - How many candles per regime (BULL/BEAR/RANGING/ZOMBIE/CRISIS)?
  - How many valid FVG candidates fire per regime per month?
  - What % of FVGs get touched within 5 candles vs never touched?
  - After applying killzone + Asian session gate: how many signals remain?

Why this matters: if your combined filters leave only 4-6 FVG trades per month
in BULL regime, you need 18+ months just to reach 100 trades for statistical
significance. Know this BEFORE building the full engine.

If signal count is too low (< 8/month in primary regime):
  → Loosen one filter (e.g., extend validity from 72 to 96 candles)
  → Or accept that this strategy needs a longer validation period
  → Document the decision before proceeding

Save output: results/signal_frequency_analysis.json
```

### What to Build

```
1. src/strategies/fvg.js
   Bullish FVG detector:
   - candle[i-1].high < candle[i+1].low (gap exists)
   - candle[i] body > config.FVG.bodyMultiplier × ATR14_1H
   - candle[i] volume > config.FVG.rvolThreshold × RVOL
   - Valid for config.FVG.validityCandles (72) candles
   - Invalidated if price closes below FVG bottom
   - Asian session hard gate: DISABLED 22:00-07:00 UTC (no exceptions)

   Bearish FVG (for short strategies):
   - Mirror of bullish logic

2. src/utils/dolFinder.js
   findDOL(candles, signalIndex, entryPrice, direction):
   - LOOKAHEAD BIAS GUARD: only consider candles with openTime < signalOpenTime
   - Scan for nearest: equal highs cluster, bearish OB, bearish FVG
   - Priority: equal highs > bearish OB > bearish FVG
   - Reject if no DOL within 5% of entry
   - Reject if R:R < 1.8
   - Assert in dev mode: throw if any candidate has openTime >= signalOpenTime

3. Optional: CVD absorption entry (Step 1.2b)
   - Backtest both versions: static limit vs CVD absorption trigger
   - If Version B WR > Version A by >= 5pp → use Version B
   - If improvement < 5pp → static limit is sufficient

4. Run backtest sequence (save each result):
   Step 1.3: Baseline (no filters) → results/fvg_baseline.json
   Step 1.4: Add regime filter → results/fvg_regime.json
   Step 1.5: Add killzone + Asian session gate → results/fvg_regime_killzone.json
   Step 1.6: Add macro blackout → results/fvg_full_gates.json

5. Parameter sensitivity test (Step 1.7):
   Test each parameter at ±20% of chosen value:
   - bodyMultiplier: [1.0, 1.2, 1.4]
   - rvolThreshold: [1.5, 1.8, 2.0]
   - validityCandles: [58, 72, 86]
   - stopBuffer: [0.08, 0.10, 0.12]
   PASS: WR variation < 15pp across range
   FAIL: WR variation > 15pp → structural problem, not a tweak issue
   Save: results/fvg_sensitivity.json

6. Regime-split analysis (Step 1.8):
   Run separately: BULL / BEAR / RANGING / CRISIS / ZOMBIE / PREZONE
   30-trade minimum floor: < 30 trades = INSUFFICIENT_DATA (not PASS/FAIL)
   Save: results/fvg_regime_split.json

7. Year-by-year breakdown:
   Run separately: 2021 / 2022 / 2023 / 2024
   Save: results/fvg_yearly.json

8. Accept/reject decision (Step 1.9):
   ACCEPT if ALL:
   - PF > 1.5 (full gates)
   - Max DD < 8%
   - Positive PF in at least 2 regimes (with >= 30 trades each)
   - All parameters pass sensitivity test
   - WR > 42%
   - Year-by-year PF >= 1.2 in at least 3 of 4 years
   Document decision with actual numbers.
```

### Source in backtestplan.md
- FVG detector: **lines 607-643** (Step 1.1)
- DOL finder + lookahead guard: **lines 644-679** (Step 1.2)
- CVD absorption entry: **lines 680-707** (Step 1.2b)
- Baseline backtest: **lines 708-732** (Step 1.3)
- Regime filter: **lines 733-750** (Step 1.4)
- Killzone + Asian gate: **lines 751-782** (Step 1.5)
- Macro blackout: **lines 783-798** (Step 1.6)
- Sensitivity test: **lines 799-834** (Step 1.7)
- Regime-split: **lines 835-860** (Step 1.8)
- Accept/reject: **lines 861-891** (Step 1.9)

**Phase D6 RANGING_ZOMBIE policy (updated from backtest evidence):**
Original plan blocked FVG in RANGING_ZOMBIE. Backtest showed 80% of FVG fills
occur in RANGING_ZOMBIE — FVG is structurally mean-reversion, not trend-following.
Policy: RANGING_ZOMBIE allowed at 0.5× size. BEAR and CRISIS remain blocked.
This matches the Phase D11 regime router. runner.js is the source of truth.

### Done Criteria
```
✓ Pine Script validator confirms FVG zones on correct candles
✓ Lookahead bias guard throws in dev mode if violated
✓ Asian session hard gate confirmed (no FVG trades 22:00-07:00 UTC)
✓ All 4 backtest runs saved to results/
✓ Sensitivity test results documented
✓ Regime-split results documented (with INSUFFICIENT_DATA flags)
✓ Accept/reject decision documented with actual WR, PF, DD numbers
```

---

## Phase D7 — Strategy 2: Order Block (OB)

**Duration:** 3-5 days
**Goal:** OB validated, correlation check with FVG completed.

### What to Build

```
1. src/strategies/ob.js
   Bullish OB detector:
   - Last bearish candle before significant move UP
   - Move candle body >= config.OB.moveMultiplier × ATR14_1H
   - Move candle volume > config.OB.rvolThreshold × RVOL
   - Valid for config.OB.validityCandles (48) candles
   - Invalidated if price closes below OB low
   - Asian session hard gate: DISABLED 22:00-07:00 UTC

   Bearish OB (for short strategies):
   - Mirror logic

2. Run same backtest loop as FVG:
   Baseline → regime → killzone → macro blackout → sensitivity → regime-split → yearly
   Save all to results/ob_*.json

3. Correlation check (Step 2.3):
   For every OB trade: check if FVG signal was also active within ±2 candles
   overlap_rate = overlapping signals / total OB signals × 100
   If overlap > 40%: OB takes precedence over FVG when both fire
   If overlap < 40%: both can be active (portfolio heat limit still applies)
   Save: results/ob_fvg_correlation.json

4. Accept/reject: PF > 1.5, max DD < 8%, passes sensitivity test
```

### Source in backtestplan.md
- OB detector: **lines 898-931** (Step 2.1)
- OB backtest loop: **lines 932-944** (Step 2.2)
- Correlation check: **lines 945-965** (Step 2.3)

### Done Criteria
```
✓ OB zones confirmed visually in Pine Script validator
✓ All backtest runs saved to results/ob_*.json
✓ Correlation check result documented
✓ Accept/reject decision documented
```

---

## Phase D8 — Strategy 1: LSO (Liquidity Sweep + OI Flush)

**Duration:** 7-10 days
**Goal:** LSO validated with OI interpolation and Gate 7 variant chosen.

**This is the most complex strategy. The OI interpolation and CVD validation
are critical — do not skip them.**

### What to Build

```
1. src/strategies/lso.js — equal highs/lows detector
   equalLows: abs(low[i] - low[j]) / low[i] < 0.003
   within last 50 candles, >= 5 candles apart
   Neither low swept between i and j

2. src/strategies/lso.js — sweep detector
   Bullish sweep:
   - candle.low < equalLows.level (wick below pool)
   - candle.close > equalLows.level (closes back above)
   - body/wick ratio < 0.4

3. src/strategies/lso.js — OI flush detector
   getInterpolatedOI(symbol, timestamp_15m, oiDataStore):
   - Linear interpolation between hourly OI values
   - Returns null if data gap (do not fabricate)

   checkOIFlush(symbol, sweepTimestamp_15m, oiDataStore, threshold=0.030):
   - Uses interpolated OI (not raw 1H bucket)
   - Default threshold: 3.0% (not 1.5%)
   - Test both 2.0% and 3.0% during backtest

   LSO regime OI thresholds:
   - BULL:    >= 3.0%
   - BEAR:    >= 4.0%
   - RANGING: >= 3.0%
   - CRISIS:  >= 4.5%

4. CVD validation (Step 4.1) — run before Gate 7 decision:
   a. Download 30 days BTC aggTrades from:
      https://data.binance.vision/data/futures/um/daily/aggTrades/
   b. Calculate TRUE CVD from aggTrades (sum of signed volume per candle)
   c. Calculate APPROXIMATED CVD using candle formula
   d. Compute Pearson correlation: aggregate (all candles)
   e. Compute Pearson correlation: sweep candles only
      (sweep candle = (high-low) > 2 × abs(close-open))

   Decision matrix:
   - Aggregate >= 0.75 AND sweep-candle >= 0.70 → use candle CVD in Gate 7
   - Aggregate >= 0.75 AND sweep-candle < 0.70  → use checkOIVelocityGate()
   - Aggregate < 0.75                            → disable all CVD usage

5. If CVD fails sweep-candle test: build checkOIVelocityGate()
   - velocity_sweep = OI change in sweep candle (interpolated)
   - velocity_prior = OI change in prior 15m candle
   - PASS: fastDrop (< -0.3%) AND decelerating AND not cascading (> -1.5%)
   - Returns: { pass, reason }

6. Run backtest sequence:
   Step 3.4: Baseline (sweep + CVD only, no OI filter) → results/lso_no_oi.json
   Step 3.5: Add OI filter → results/lso_with_oi.json
             Expected WR improvement: +8-12%
             If improvement < 5%: OI data alignment issue — investigate
   Step 3.6: Add regime + killzone + macro blackout → results/lso_full_gates.json

7. Sensitivity test, regime-split, yearly breakdown
   Save: results/lso_sensitivity.json, lso_regime_split.json, lso_yearly.json

8. Accept/reject: PF > 1.5, OI filter shows measurable improvement
```

### Source in backtestplan.md
- Equal highs/lows: **lines 973-988** (Step 3.1)
- Sweep detector: **lines 989-1004** (Step 3.2)
- OI flush + interpolation: **lines 1005-1066** (Step 3.3)
- LSO baseline: **lines 1067-1079** (Step 3.4)
- LSO with OI: **lines 1080-1097** (Step 3.5)
- LSO full gates: **lines 1098-1111** (Step 3.6)
- CVD validation: **lines 1119-1198** (Step 4.1)
- OI velocity gate: **lines 1131-1175** (checkOIVelocityGate)

### Done Criteria
```
✓ OI interpolation unit test: interpolated value between two hourly points
✓ CVD correlation test run and result documented
✓ Gate 7 variant chosen (CVD or OI velocity) and documented
✓ OI filter shows >= 5% WR improvement (if < 5%, investigate before proceeding)
✓ All backtest runs saved to results/lso_*.json
✓ Accept/reject decision documented
```

### Deferred Items from Phase D7 (implement at start of D8)

```
D7 Deferred Item 1 — LSO size multiplier when inside an OB zone
Why deferred: requires LSO detector to exist first.
Source: Gemini D7 review — Solution B ("Use OB as filter, LSO as trigger").

What to implement in lso_runner.js:
- After LSO signal fires, check if the sweep candle is inside an active OB zone
- If LSO sweep is inside a bullish OB: apply 1.3× size multiplier (high confluence)
- If LSO sweep is NOT inside an OB: standard 1.0× size
- Log ob_confluence: true/false on every LSO trade for analysis
- This merges D6/D7 findings into D8 without changing the LSO entry logic

D7 Deferred Item 2 — CVD Exhaustion Trigger as OB/FVG entry confirmation
Why deferred: requires CVD validation (Step 4.1) to be run first.
Source: Gemini D7 review — Solution A ("CVD Exhaustion Trigger").

What to implement after Step 4.1 CVD validation:
- If CVD sweep-candle correlation >= 0.70: add CVD exhaustion entry gate to OB/FVG
- Gate logic: price enters OB zone → wait → only enter if CVD delta stops falling
  (delta[i] > delta[i-1] for 2 consecutive candles = sellers exhausted)
- This eliminates "falling knife" entries where price crashes through the OB
- Only implement if CVD sweep-candle correlation passes — otherwise use OI velocity gate
- Test: run ob_runner.js with and without this gate, compare WR and PF

D7 Deferred Item 3 — Time-based breakeven gate for LSO (NOT OB)
Why deferred: tested on OB in Phase D7, made results worse (PF 0.488 → 0.276).
The "immediate bounce" assumption doesn't hold for OB on BTC 15m — zones take
20-40 candles to resolve in ranging markets. However, LSO sweeps are faster-
resolving by nature (sweep + close back above = immediate reversal signal).
Source: Gemini D7 review — Solution C, tested and reverted.

What to implement in lso_runner.js:
- If LSO trade has not reached 50% of TP1 distance within 8 candles (2 hours),
  close at market (tighter than OB's 12 candles — sweeps resolve faster)
- Test with and without gate, compare WR and PF
- Only keep if PF improves AND sensitivity remains ROBUST
```

---

## Phase D9 — Strategy 5: VPB

**Duration:** 3-5 days
**Goal:** VPB validated. (CVD divergence already retired as standalone.)

### What to Build

```
1. src/strategies/vpb.js
   Breakout detector:
   - price closes ABOVE HVN on 1H
   - volume > 2.0 × RVOL
   - price was BELOW HVN for >= 3 consecutive candles

   Retest entry (15m):
   - After breakout, wait for pullback to HVN
   - Enter on 15m close ABOVE HVN (HVN becomes support)
   - Stop: HVN - (0.1 × ATR14_15m)
   - Target: DOL upward

   VPB regime rules:
   - BULL: allowed (breakouts follow through)
   - RANGING: DISABLED (false breakouts dominate)
   - ZOMBIE/PREZONE: DISABLED
   - Asian session: DISABLED (same as FVG/OB)

2. Run same backtest loop as FVG/OB
   Save: results/vpb_*.json

3. Accept/reject: PF > 1.5, works in BULL regime, passes sensitivity test
```

### Source in backtestplan.md
- VPB calculator: **lines 1234-1251** (Step 5.1)
- Breakout detector: **lines 1252-1268** (Step 5.2)
- VPB backtest: **lines 1269-1281** (Step 5.3)

### Done Criteria
```
✓ VPB signals confirmed visually in Pine Script validator
✓ All backtest runs saved to results/vpb_*.json
✓ Accept/reject decision documented
```

---

## Phase D10 — Short-Side: SHORT-LSO

**Duration:** 3-4 days
**Goal:** SHORT-LSO validated on BEAR regime periods.

### What to Build

```
1. src/strategies/shortLso.js
   Mirror of LSO for downside:
   - Equal highs swept UP (wick above, close below)
   - OI flush >= 4.0% (BEAR regime threshold)
   - CVD negative (or OI velocity gate if CVD failed)
   - Entry: limit at 50% of sweep candle body (short above market)
   - Stop: sweep candle HIGH + (0.07 × ATR14_15m) — tighter than long
   - Target: DOL downward (nearest equal lows, bullish OB below)
   - Activation: BEAR regime only
   - Regime must have been BEAR for >= 6 consecutive hours before entry

   Short-specific rules:
   - Futures only (no spot short)
   - Maximum 2× leverage
   - Tighter stop: 0.07 × ATR (vs 0.10 for longs)

2. Run backtest on BEAR regime periods only
   30-trade minimum floor: if < 30 trades → INSUFFICIENT_DATA
   Flag for 2025 forward test validation if insufficient data
   Save: results/short_lso_full_gates.json

3. Accept/reject: PF > 1.4 (lower bar — fewer BEAR periods to test on)

NOTE: SHORT-OB and SHORT-FVG are deferred to Year 2.
SHORT-CVD is removed entirely.
```

### Source in backtestplan.md
- Short strategy detectors: **lines 1289-1311** (Step 5.5.1)
- Short backtest rules: **lines 1312-1324** (Step 5.5.2)

### Done Criteria
```
✓ SHORT-LSO fires only in BEAR regime
✓ Regime must be BEAR for >= 6 hours before entry (unit test)
✓ Backtest result saved to results/short_lso_full_gates.json
✓ Accept/reject documented (INSUFFICIENT_DATA is a valid outcome)
```

---

## Phase D11 — Combined System Backtest

**Duration:** 5-7 days
**Goal:** All accepted strategies running together, full validation suite passed.

### Deferred Items from Phase D6 (implement at start of D11)

```
D6 Deferred Item 1 — FVG entryOffset Boolean Shift
Why deferred: entryOffset showed 39pp WR fragility as a standalone parameter.
The fix requires the lead strategy (LSO/OB) to exist first — FVG can't be a
confluence filter until there's something to filter for.

What to implement:
- Read SYMBOL_STRATEGY_POLICY from config.js for each symbol
- When FVG policy = 'CONFLUENCE_ONLY': ignore entryOffset entirely
- FVG zone check becomes boolean: is_price_inside_active_fvg_zone (true/false)
- The entry trigger, limitPrice, and stopPrice all come from the lead strategy
- FVG zone presence adds a CONFIDENCE_MULT boost (e.g., 1.1×) to the lead trade
- entryOffset parameter is still tested in sensitivity for LEAD_STRATEGY symbols

D6 Deferred Item 2 — ETH/SOL FVG lead strategy test
Why deferred: D6 REJECT is BTC-specific. ETH has more institutional absorption.
SOL has higher mean-reversion tendency. Both are PENDING in SYMBOL_STRATEGY_POLICY.

What to implement:
- Run the full D6 backtest sequence on ETHUSDT_15m_tagged.ndjson
- Run the full D6 backtest sequence on SOLUSDT_15m_tagged.ndjson
- If PF > 1.5 on either: update policy to 'LEAD_STRATEGY' for that symbol
- If PF < 1.0 on both: update policy to 'CONFLUENCE_ONLY' for both
- Document results before building the combined runner
- Do NOT assume BTC result applies — test independently

D6 Deferred Item 3 — WR improvement warning recalibration
Why deferred: the warning "WR improvement < 5pp — regime engine may have a bug"
was calibrated for the pre-ghost-sweep baseline. With the ghost sweep gate active,
the baseline is already cleaner, so the regime filter's marginal WR improvement
is smaller. The warning is a false alarm in the current configuration.

What to implement:
- In the combined runner, remove the hardcoded 5pp threshold warning
- Replace with: log the WR delta per strategy and flag only if WR DECREASES
  by more than 10pp (genuine regression, not just a smaller improvement)
- The current warning fires on -5.6pp which is a known artifact, not a bug

D7 Deferred Item 4 — SOL/ETH OB lead strategy test
Why deferred: D7 REJECT is BTC-specific. Gemini noted SOL has more impulsive
microstructure and less efficient mean reversion than BTC. OB zones on SOL may
not be hunted by $100M liquidity clusters the way BTC OBs are.

What to implement:
- Run the full D7 backtest sequence on SOLUSDT_15m_tagged.ndjson
- Run the full D7 backtest sequence on ETHUSDT_15m_tagged.ndjson
- If PF > 1.5 on either: update SYMBOL_STRATEGY_POLICY OB to 'LEAD_STRATEGY'
- If PF < 1.0 on both: confirm 'CONFLUENCE_ONLY' for all symbols
- Do NOT assume BTC result applies — test independently
- This is the same pattern as D6 Deferred Item 2 for FVG
```

### What to Build

```
1. src/backtest/runner.js — combined system runner

   Regime router:
   - On each candle: determine current regime (from tagged data)
   - Route to allowed strategies per regime:
     BULL:    LSO, VPB, OB, FVG (priority from Phase D6-D9 PF results)
     BEAR:    SHORT-LSO only
     RANGING: FVG, OB only
     ZOMBIE:  LSO only (FVG/OB at 0.5× size when used as confluence filter)
     PREZONE: FVG (50% size), OB (50% size), LSO (full)
     CRISIS:  LSO only (OI flush >= 4.5%)

   Strategy priority lookup table:
   - Build from actual PF results from Phases D6-D10
   - Stored in config.js as STRATEGY_PRIORITY object
   - When multiple strategies fire same candle: take highest priority

   Adaptive position sizing:
   - BASE_RISK = 1% of capital
   - × REGIME_MULT (BULL:1.0, RANGING:0.7, BEAR_SHORT:1.0, BEAR_LONG:0.5, CRISIS:0.5)
   - × streakMult (0-2 losses:1.0, 3:0.75, 4:0.5, 5+:0.25)
   - × CONFIDENCE_MULT (standard:1.0, high_confluence:1.3, crowded_reversal:1.2)
   - × atrVolMult (ATR 2×normal:0.5, 1.5×:0.7, 0.5×:1.2)
   - Hard cap: min(result, 0.020) — never exceed 2.0%
   - ULTRA_CONFLUENCE_MULT (1.5×) only when:
     oiZScore < 1.5 AND atrRatio < 1.5 AND projectedHoldDays < 1

   Position scaling (pyramiding):
   - After TP1 with stop at breakeven
   - Add 25-50% of original size if continuation signal fires within 2 candles
   - Risk on add-on: 0.5% max
   - Run WITH and WITHOUT pyramiding, compare PF and DD

2. Step 6.4 — Rolling walk-forward (5 windows):
   Window 1: Train 2021-01→2022-06  | Test 2022-07→2022-12
   Window 2: Train 2021-07→2023-01  | Test 2023-02→2023-06
   Window 3: Train 2022-01→2023-07  | Test 2023-08→2023-12
   Window 4: Train 2022-07→2024-01  | Test 2024-02→2024-06
   Window 5: Train 2023-01→2024-07  | Test 2024-08→2024-12
   PASS: PF degrades < 20% Window 1 to Window 5
   FAIL: > 20% degradation OR cliff-edge drop at any window
   Save: results/combined_walkforward.json

3. Step 6.5 — Gate 8 ON vs OFF:
   Run A: Gate 8 disabled (no F&G, no funding adjustments)
   Run B: Gate 8 enabled
   Expect: Run B PF > Run A PF by >= 0.1
   If Run B PF < Run A PF: investigate which gate is dragging
   Save: results/gate8_comparison.json

4. Step 6.6 — Slippage stress test:
   Run A: base costs (current model)
   Run B: 2× slippage on all symbols
   Run C: 3× slippage + fill rate reduced to 70%
   PASS: Run B PF > 1.3 for all strategies
   WARN: Run B PF 1.1-1.3 → edge is marginal
   FAIL: Run B PF < 1.1 → do not go live with that strategy
   Save: results/slippage_stress_test.json

5. Full system acceptance criteria:
   PF > 1.6, annual return > 35% after costs, max DD < 15%, Sharpe > 1.5
   Reject if: DD > 20% in any crisis simulation, annual return < 25%
```

### Source in backtestplan.md
- Combined system setup: **lines 1325-1411** (Step 6.1)
- Strategy priority: **lines 1412-1432** (Step 6.2)
- Position scaling: **lines 1433-1468** (Step 6.2b)
- Full system metrics + exits: **lines 1469-1606** (Step 6.3)
- Walk-forward: **lines 1607-1634** (Step 6.4)
- Gate 8 comparison: **lines 1635-1659** (Step 6.5)
- Slippage stress test: **lines 1660-1692** (Step 6.6)
- Adaptive sizing: **lines 1331-1411** (Step 6.1 sizing section)

### Done Criteria
```
✓ Strategy priority table built from actual Phase D6-D10 PF results
✓ Walk-forward results saved (5 windows)
✓ Gate 8 comparison documented
✓ Slippage stress test: all strategies pass at 2× slippage
✓ Pyramiding tested WITH and WITHOUT — DD impact documented
✓ Combined system meets all acceptance criteria
```

---

## Phase D12 — Monte Carlo + Anti-Overfitting

**Duration:** 3-4 days
**Goal:** Statistical robustness confirmed for all accepted strategies.

### What to Build

```
1. src/backtest/monteCarlo.js — worker_threads implementation

   Block shuffle (NOT individual trade shuffle):
   - Group trades into 4-week calendar blocks
   - Shuffle the blocks (preserves within-window temporal clustering)
   - Real drawdowns cluster in time — individual shuffle destroys this

   Per simulation:
   - Shuffle 4-week blocks
   - Add ±0.05% noise to fill prices
   - Remove 5% of trades randomly

   Run 1000 simulations per strategy using worker_threads:
   - Split across all CPU cores (one worker per core)
   - Main thread aggregates results

   Output per strategy:
   - p10, p50, p90 of final equity
   - Median DD, p90 DD
   - Wilson CI on WR for each simulation
   PASS: p10 equity > starting equity (positive expectancy at 10th percentile)
   FAIL: p10 equity < starting equity → fragile, do not go live

2. Step 7.2 — Crisis period check:
   Verify combined system backtest includes:
   - May 2021 (China mining ban): BTC -55%, expect BEAR regime
   - Nov 2022 (FTX collapse): BTC -25% in 3 days, expect CRISIS
   - Q4 2025 (if data available): expect BEAR regime
   Acceptable: DD < 20% in each period
   If DD > 20%: fix crisis regime handling before Phase D13

3. Funding rate validation:
   Run combined backtest with flat 0.01% AND actual funding data
   If P&L delta > 3% annual → confirms flat assumption was wrong
   Document the delta
```

### Source in backtestplan.md
- Monte Carlo spec: **lines 1697-1814** (Step 7.1)
- Block shuffle: **lines 1697-1760** (groupIntoWeeklyBlocks)
- Worker threads: **lines 1761-1814** (worker thread implementation)
- Wilson CI: **lines 1815-1840** (calcWRConfidenceInterval)
- Crisis period check: **lines 1841-1897** (Step 7.2)

### Done Criteria
```
✓ Monte Carlo runs on worker_threads (not blocking main thread)
✓ Block shuffle confirmed (4-week blocks, not individual trades)
✓ p10 equity > starting equity for all accepted strategies
✓ Crisis periods show DD < 20%
✓ Funding rate delta documented (flat vs actual)
```

---

## Phase D13 — 2025 Forward Test (Final Gate)

**Duration:** 1-2 days
**Goal:** Final validation on data never seen before.

**This data has never been touched. Do not download or look at 2025 data
until this phase. It is the only honest measure of live viability.**

### What to Build

```
1. Download 2025 data (first time):
   Same coins, same timeframes, period: 2025-01-01 to 2025-12-31
   OI and funding data for 2025 as well

2. Step 8.1 — Run combined system on 2025 data:
   Use ALL parameters from Phase D11 (no changes allowed after seeing 2025 data)
   Run full combined system with all gates and adaptive sizing
   Save: results/forward_2025.json

3. Step 8.2 — Accept/reject:
   PASS (ready for paper trading):
   - System is profitable (positive equity at year end)
   - Max DD < 20%
   - PF > 1.3 (lower bar — forward test is harder)
   - No strategy shows WR < 30% on 2025 data

   FAIL (return to Phase D6):
   - System unprofitable, DD > 20%, or PF < 1.0
   - Identify which strategy degraded most
   - Check if 2025 introduced new regime pattern
   - Re-run from Phase D6 for failing strategy only
   - Do NOT re-run all strategies (contaminates forward test)

4. Step 8.3 — ETH-only out-of-sample test:
   Run combined system on ETHUSDT 2025 data only
   Use BTC-trained parameters (unchanged)
   Accept if: PF > 1.1
   Reject if: PF < 1.0 (parameters don't generalize at all)
   Save: results/forward_2025_eth_only.json

NOTE: 2025 crisis parameters were designed knowing 2025 had severe drawdowns.
The ETH test provides a second data point that is genuinely uncontaminated.
```

### Source in backtestplan.md
- Forward test: **lines 1898-1939** (Step 8.1, 8.2)
- ETH out-of-sample: **lines 1940-1962** (Step 8.3)

### Done Criteria
```
✓ 2025 data downloaded for first time in this phase
✓ Forward test result saved to results/forward_2025.json
✓ ETH out-of-sample result saved
✓ Go/no-go decision documented with actual numbers
```

---

## Phase D14 — Paper Trading Setup

**Duration:** 60+ days (minimum), 40+ trades
**Goal:** Live system on testnet, validated across regime change and macro event.

### What to Build

```
1. Crisis API failure fallback (build BEFORE going live):
   submitCrisisExit(position, binanceAPI, telegramBot):
   - 5 retry attempts with exponential backoff
   - Verify fill via order status (not just submission success)
   - After 5 failures: switch to HEDGE MODE
     (market SHORT of equal size to neutralize delta)
   - Requires pre-funded hedging margin in separate sub-account
   - Send Telegram alert on hedge activation

   Dead man's switch (separate process, separate VPS):
   - Main bot writes heartbeat file every 60 seconds
   - Watchdog on separate VPS monitors heartbeat
   - If gap > 120 seconds → watchdog places emergency closes
   - Pre-fund watchdog sub-account with enough margin

2. Strategy self-monitoring (MongoDB):
   Collection: strategy_performance
   Schema: { strategy, regime, period, trades, wins, losses, win_rate, pf, status }
   WATCH trigger: rolling 25-trade WR < 35% OR PF < 1.2 OR 4 consecutive losses
   PAUSE trigger: rolling 50-trade WR < 30% OR PF < 1.0 OR daily loss > 3%
   RESUME: manual only, 7-day minimum, 5 paper trades validated first
   Telegram alerts on all state changes

3. Deploy on Binance Futures testnet:
   - All 9 gates active
   - Adaptive sizing active
   - Self-monitoring active
   - Crisis fallback active

4. Paper trading requirements:
   Duration: minimum 60 days, minimum 40 trades
   MANDATORY coverage:
   - At least 1 regime change (BULL→RANGING or RANGING→BEAR)
   - At least 1 major macro event (FOMC or CPI)
   If 60 days passes without both: extend until both conditions met

5. Weekly comparison (live vs backtest):
   If live WR < backtest WR by > 10pp → investigate signal detection
   If live PF < 1.2 after 40 trades → pause, investigate
   If live DD > 10% → do not go live with real capital

6. Risk scaling protocol:
   Phase 1 live (first 60 trades): max risk = 1.5% per trade
   Phase 2 live (after 60 trades, if ALL conditions met):
   - Live WR within 8pp of backtest WR
   - Live PF > 1.35
   - No month worse than -5%
   - Live DD never exceeded 12%
   → Unlock 2.0% max risk in high-confluence setups only
   Revert to 1.5% immediately if any condition breaks
```

### Source in backtestplan.md
- Paper trading setup: **lines 1963-1995** (Step 9.1)
- Risk scaling protocol: **lines 1996-2027** (Step 9.1b)
- Self-monitoring: **lines 2028-2070** (Step 9.2)
- Crisis API fallback: **lines 1870-1897** (Step 7.2 crisis section)
- Gate 5 correlation cluster: **lines 2010-2025** (Quality Gate Reference)

### Done Criteria
```
✓ Crisis API fallback tested on testnet (simulate 503 response)
✓ Dead man's switch deployed on separate VPS
✓ Self-monitoring Telegram alerts working
✓ 60 days completed, 40+ trades logged
✓ Paper period included at least 1 regime change
✓ Paper period included at least 1 FOMC or CPI event
✓ Live WR within 10pp of backtest WR
✓ Go/no-go decision for real capital documented
```

---

## Anti-Overfitting Final Checklist

Run this before Phase D13. All boxes must be checked.

```
□ Every strategy has <= 8 tunable parameters
□ Every parameter passed sensitivity test (WR variation < 15pp across ±20%)
□ Walk-forward shows < 20% PF degradation across 5 rolling windows
□ Monte Carlo p10 percentile positive for every strategy
□ Crisis periods show DD < 20%
□ Gate 8 ON shows better PF than Gate 8 OFF
□ CVD sweep-candle correlation tested separately (not just aggregate Pearson)
□ Short strategies tested on BEAR regime periods only
□ 2025 data never used in any optimization step
□ Macro event blackout windows tagged in all historical data
□ Toxic fill rate < 40% on FVG/OB
□ Funding rate backtest run with ACTUAL per-8H data (not flat 0.01%)
□ OI interpolated to 15m resolution for LSO Gate 7
□ Slippage stress test passed (PF > 1.3 at 2× slippage for all strategies)
□ Crisis API failure fallback built and tested before Phase D14
□ Dead man's switch watchdog deployed on separate VPS before going live
```

### Source in backtestplan.md
- Full checklist: **lines 2095-2115** (Anti-Overfitting Checklist section)

---

## Results File Reference

All backtest outputs go to `results/`. Never overwrite — use versioned filenames
if re-running (e.g., `fvg_baseline_v2.json`).

```
results/
├── data_validation.json          ← Phase D1
├── fvg_baseline.json             ← Phase D6
├── fvg_regime.json
├── fvg_regime_killzone.json
├── fvg_full_gates.json
├── fvg_sensitivity.json
├── fvg_regime_split.json
├── fvg_yearly.json
├── ob_baseline.json              ← Phase D7
├── ob_full_gates.json
├── ob_sensitivity.json
├── ob_regime_split.json
├── ob_yearly.json
├── ob_fvg_correlation.json
├── lso_no_oi.json                ← Phase D8
├── lso_with_oi.json
├── lso_full_gates.json
├── lso_sensitivity.json
├── lso_regime_split.json
├── lso_yearly.json
├── cvd_correlation.json          ← Phase D8 (CVD validation)
├── vpb_full_gates.json           ← Phase D9
├── short_lso_full_gates.json     ← Phase D10
├── combined_system.json          ← Phase D11
├── combined_walkforward.json
├── gate8_comparison.json
├── slippage_stress_test.json
├── regime_calibration.json       ← Phase D3
├── montecarlo/                   ← Phase D12
│   ├── fvg_mc.json
│   ├── ob_mc.json
│   ├── lso_mc.json
│   └── combined_mc.json
├── crisis_periods.json
├── forward_2025.json             ← Phase D13 (never open until D13)
└── forward_2025_eth_only.json
```

---

*End of BulletBrain v3.0 Development Master Plan*
*Start with Phase D0. The spec is in backtestplan.md.*
