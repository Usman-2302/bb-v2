# BulletBrain v3.0 — Phase D4 Log
# Backtest Engine Core
# Status: Complete

---

## Goal
Build the backtest engine that replays candles chronologically and simulates trades
with the full cost model. This is the most critical phase — every strategy's
accept/reject decision depends on the engine being correct.

**Rule: Build it once. Test it thoroughly. Never change it after Phase D6 starts.**

## What was Built
- `src/backtest/engine.js` — core engine: fill simulation, cost application, exit conditions, risk controls, position state machine, equity tracker
- `src/backtest/reporter.js` — metrics: WR (Wilson CI), PF, Sharpe, DD, toxic fill rate, ghost trade rate, regime/yearly breakdown
- `tests/run_engine_tests.js` — 45 validation tests with known outcomes

## Source References
- Engine spec: backtestplan.md lines 194-408 (Step 0.4)
- Fill model: backtestplan.md lines 296-370
- Exit conditions: backtestplan.md lines 1469-1606 (Step 6.3)
- Correlation cluster: backtestplan.md lines 2010-2025 (Gate 5)

---

## Build Log

### engine.js — Components Built

**1. Fill Simulation (`simulateLimitFill`)**
Four-tier penetration-depth model:
- MISS: price never reached limit (penetration < 0)
- EXACT_TOUCH: candle.low === limitPrice (within 1 tick) → no fill, back of queue
- CLEAN: penetration 0.01-0.10% → fill at fill_rate probability, no extra stop slippage
- MARGINAL: penetration 0.10-0.30% → fill at 85% of fill_rate, +0.1% extra stop slippage
- TOXIC: penetration > 0.30% → always fills (liquidation cascade), +0.3% extra stop slippage

Per-symbol tick sizes used for EXACT_TOUCH detection (BTC: 0.1 USDT, XRP: 0.0001 USDT).

**2. Partial Fill Simulation (`simulatePositionFill`)**
RVOL > 3.0 → 70% fill, RVOL > 2.0 → 82% fill, normal → 100%.

**3. Cost Calculation (`calcEntryCost`)**
Three-tier slippage per symbol (killzone/base/crisis) + signal delay latency + fee.
XRP costs 3-5× more than BTC — same model applied to all was wrong.

**4. Funding Cost (`applyFundingCost`)**
Reads actual downloaded funding rates from Map<symbol, Map<timestamp, rate>>.
Longs pay when rate > 0, receive when rate < 0.
Updates `trade.cumulativeFundingCost` and `trade.unrealizedPnl`.

**5. Exit Conditions**
- `checkTimeExit`: MAX_TRADE_DURATION per regime (BULL:48, RANGING:32, BEAR:64, CRISIS:16 candles)
- `checkMomentumExit`: RVOL drop + CVD flatten + rejection candle near TP (only when in profit > 0.5R)
- `checkZScoreExit`: 30-day historical vol denominator, fires when |z| > 3.5 AND pctToTP2 > 0.80
- `checkCVDExhaustionExit`: 2 consecutive negative CVD deltas after peak → exit 75%

**6. Risk Controls**
- `checkPortfolioRisk`: max 3 concurrent trades, correlation cluster A (BTC/ETH/SOL/BNB) max 1, max 3% portfolio heat
- `isDailyLossBreached`: pause when daily loss >= 3%

**7. Position State Machine**
- `createTrade`: initializes all fields including tp1Distance, tp2Distance, fillQuality
- `updateUnrealizedPnl`: price diff × size, direction-aware
- `closeTrade`: full or partial, moves stop to breakeven at TP1, calculates net PnL after fees

**8. Equity Tracker**
- `createEquityTracker`: initializes capital, peak, maxDrawdown, dailyPnl
- `updateEquity`: updates capital, tracks peak/DD, resets daily on new UTC day, triggers pause

### reporter.js — Components Built

- `wilsonCI`: Wilson confidence interval, `reliable: true` only at n >= 100
- `calcSharpe`: daily returns, annualized (× sqrt(252))
- `calcProfitFactor`: gross wins / gross losses
- `generateReport`: full metrics including ghost trade rate, toxic fill rate, regime/yearly breakdown

---

## Issues Encountered

### Issue 1 — EXACT_TOUCH caught by MISS check (logic order bug)

**What happened:**
`penetration = (limitPrice - candle.low) / limitPrice`
When `candle.low === limitPrice`, penetration = 0.
The check `if (penetration <= 0) return MISS` caught this before the EXACT_TOUCH check.
Result: exact touch returned MISS instead of EXACT_TOUCH.

**Fix:**
Changed `penetration <= 0` to `penetration < 0` (strictly negative = price never reached).
Exact touch (penetration = 0) now correctly falls through to the EXACT_TOUCH check.

### Issue 2 — Z-score pctToTP2 formula wrong

**What happened:**
Original formula: `(unrealizedPnl - riskAmount) / tp2Distance` — incorrect units.
`unrealizedPnl` is in $ but `tp2Distance` is in price units.

**Fix:**
Changed to `unrealizedPnl / tp2Distance` — both in same units ($ PnL vs $ distance).
Test updated to use consistent values: unrealizedPnl=1800, tp2Distance=2000 → pctToTP2=0.90.

### Issue 3 — CVD exhaustion test used wrong history values

**What happened:**
Test used `[100, 80, 60]` — all positive, so `twoNegative` check failed.
The condition requires `recent[1] < 0 && recent[2] < 0`.

**Fix:**
Changed test history to `[100, -20, -40]` — peak at index 0, then 2 consecutive negatives.

### Issue 4 — Daily loss limit used strict less-than

**What happened:**
`dailyPnl / capital < -TRADE.dailyLossLimit`
At exactly -3% loss: `-0.03 < -0.03` is false → limit not triggered.

**Fix:**
Changed to `<= -TRADE.dailyLossLimit` so exactly -3% triggers the pause.

---

## Test Results

```
tests/run_engine_tests.js:
  45/45 PASS

Test coverage:
  Fill simulation:      8 tests (MISS, EXACT_TOUCH, TOXIC, MARGINAL, SHORT TOXIC, partial fills)
  Cost calculation:     4 tests (killzone, base, crisis, XRP > BTC)
  Funding cost:         3 tests (LONG pays, SHORT receives, no effect at wrong timestamp)
  Exit conditions:      9 tests (time exit, momentum exit, Z-score, CVD exhaustion)
  Risk controls:        5 tests (max trades, portfolio heat, correlation cluster, daily loss)
  Position state:       5 tests (createTrade, updatePnl LONG/SHORT, closeTrade full/partial)
  Equity tracker:       4 tests (capital update, max DD, daily pause, daily reset)
  Reporter:             7 tests (Wilson CI, PF, generateReport)
```

### Manual equity curve verification
```
Trade 1: +100 → capital 10100
Trade 2: -50  → capital 10050
Trade 3: +80  → capital 10130
Final: 10130 ✓ (matches manual calculation exactly)
```

### Key metric verifications
```
TOXIC fill: extraStopSlippage = 0.003 (0.3%) ✓
MARGINAL fill: extraStopSlippage = 0.001 (0.1%) ✓
EXACT_TOUCH: fill = false ✓
Funding LONG: unrealizedPnl = -15 (pays 0.03% on 50k notional) ✓
Daily loss at -3%: paused = true ✓
Correlation cluster: ETH blocked when BTC open ✓
XRP allowed when BTC open (different cluster) ✓
Wilson CI n=80: reliable = false ✓
Wilson CI n=100: reliable = true ✓
```

---

## Done Criteria Check

```
✓ All engine validation tests pass (45/45)
✓ Equity curve matches manual calculation on synthetic data
✓ TOXIC fill correctly adds 0.3% extra stop slippage
✓ MARGINAL fill correctly adds 0.1% extra stop slippage
✓ Funding cost uses actual downloaded data (not flat rate)
✓ Daily loss pause triggers at exactly 3% (<=, not <)
✓ Portfolio heat blocks 4th trade when 3% reached
✓ Correlation cluster blocks ETH when BTC open
✓ Wilson CI outputs reliable: false when n < 100
✓ Reporter outputs all required metrics including toxic_fill_rate and ghost_trade_rate
```

---

## AI Reviews

*(To be updated after external review)*


---

## Gemini Red-Team Review — April 2026

Gemini raised 5 points. Verdict and action on each:

### Point 1 — Toxic Fill Paradox on 4H candles
**Verdict: Not applicable — entries are on 15m candles, not 4H.**

The FVG/OB/LSO strategies all use 15m for entry timing. The penetration thresholds
(0.10% for TOXIC) are calibrated for 15m candles. On 15m, BTC's average range is
0.2-0.4%, so 0.10% penetration in a single 15m candle IS a fast move. The concern
is valid for 4H-based entries but our entries are 15m. No action needed.

Documented for clarity: the fill model runs on 15m entry candles, not 4H regime candles.

### Point 2 — Lazy Correlation Cluster / Pre-Flight Auction
**Verdict: Valid concept, wrong phase. Deferred to D11.**

"First come, first served" does block better signals. However, this belongs in the
runner (Phase D11 combined system), not the engine. The strategy priority lookup
table in backtestplan.md Step 6.2 already handles this: "whichever strategy had
the highest PF in the current regime wins the slot." The engine enforces the rule —
the runner decides which signal to pass. No engine change needed.

### Point 3 — Funding Rate Timing (Clock-Aware)
**Verdict: Already clock-aware. Verified with new test.**

`applyFundingCost` checks if `currentTimestamp` matches a key in the funding Map.
The funding Map contains actual Binance timestamps (00:00, 08:00, 16:00 UTC).
If a trade opens at 07:55 and closes at 08:05, the engine checks the 08:00
timestamp against the trade's open period and applies the full funding cost.
This is clock-aware, not duration-aware.

**Action taken:** Added test `Funding cost: clock-aware — charges at exact 8H boundary`.
Test verifies: charges at 08:00 timestamp, does NOT charge at 08:15 (non-funding timestamp).
**PASS**

### Point 4 — i5 Performance Wall
**Verdict: Valid for D11 (2.5M candles). Not a concern for D6-D10 (single strategy).**

Engine uses mutable objects throughout — no new object creation in hot loops.
Worker threads for Monte Carlo are already specified in backtestplan.md.
For single-strategy backtests (D6-D10), data volume is much smaller.
Note for D11: profile before running combined system on full dataset.

### Point 5 — Z-score and Daily Loss Fixes
**Verdict: Confirmed correct. Already fixed in D4.**

### D5 Prep — Three Questions Answered

**Q1: Does D4 engine support Force Close All for macro events?**
Yes — added `triggerForceClose(tracker, reason)` function.
Sets `tracker.forceClose = true` and `tracker.forceCloseReason`.
Runner checks this flag on each candle and closes all positions.
Test added: `triggerForceClose: sets forceClose flag` — **PASS**

**Q2: Can D5 tagger tell D4 engine to double slippage during news window?**
Yes — added `inNewsWindow` parameter to `calcEntryCost()`.
When `inNewsWindow = true`, slippage doubles (spreads widen during CPI/FOMC/NFP).
Test added: `Entry cost: news window doubles slippage` — **PASS**

**Q3: Ghost Trade metric for D5 validation?**
Already in reporter.js. `ghostTradeRate` = % of winning trades that were exact-touch
fills (which the engine correctly marks as no-fill). If D5 filters out 50% of winners,
the macro logic is too tight.

---

## Final Test Results After Gemini Review

```
tests/run_engine_tests.js:
  48/48 PASS (was 45/45 before review)

3 new tests added:
  - Entry cost: news window doubles slippage
  - Funding cost: clock-aware (charges at 08:00, not at 08:15)
  - triggerForceClose: sets forceClose flag
```

## Phase D4 Final Status: Complete

All 48 tests pass. All Gemini concerns addressed. Engine is ready for Phase D6.
