# BulletBrain v3.0 — Phase D6 Log
# Strategy 3: FVG Fill
# Status: Strategy built and unit tested. Backtest runs pending.

---

## Goal
Build and validate the FVG (Fair Value Gap) strategy.
Run the full backtest loop: baseline → regime → killzone → macro → sensitivity → regime-split → yearly.
Make the accept/reject decision with actual numbers.

## Source References
- FVG detector: backtestplan.md lines 607-643 (Step 1.1)
- DOL finder: backtestplan.md lines 644-679 (Step 1.2)
- Backtest loop: backtestplan.md lines 708-891 (Steps 1.3-1.9)
- masterplan.md Phase D6

---

## Pre-Phase: Candle Frequency Analysis

Ran frequency analysis on BTC 1H tagged data before writing strategy code.

Results:
```
Total valid FVG candidates: 306 (over 48 months, 2021-2024)
Average per month: 6.4
Months with < 8 signals: 32/48

By regime:
  BULL:           134 (43.8%)
  BEAR:           128 (41.8%)
  RANGING:         34 (11.1%)
  CRISIS:           6  (2.0%)
  RANGING_ZOMBIE:   4  (1.3%)
```

Assessment: 6.4 FVGs/month is below the 8/month target but 306 total trades over
4 years is statistically sufficient (> 100 needed for Wilson CI reliability).
The monthly distribution is uneven but the total is adequate. Proceeded as specified.

---

## What was Built

### src/strategies/fvg.js

detectBullishFVGs(candles, atr14, rvolVals):
  - Gap condition: candle[i-1].high < candle[i+1].low
  - Body filter: candle[i] body > 1.2 × ATR14
  - RVOL filter: candle[i] RVOL > 1.8
  - Gap size filter: gap > 0.05% of price
  - Asian session hard gate: DISABLED 22:00-07:00 UTC
  - Returns FVG zone objects with top/bottom/mid/status/fill_pct

detectBearishFVGs: mirror of bullish logic

updateFVGStatus(fvg, candle, index):
  - Tracks expiry (at expires_at candle)
  - Tracks invalidation (close below bottom for bullish)
  - Tracks partial fills (overlap % with zone)
  - Tracks contested touches (3+ touches without fill → CONTESTED)

checkFVGEntry(fvg, candle):
  - Fires when price reaches FVG midpoint
  - Returns { type, limitPrice, stopPrice, fvgTop, fvgBottom, fvgMid }

### src/utils/dolFinder.js

findEqualHighsClusters(candles, options):
  - Finds groups of highs within 0.3% tolerance
  - Minimum 2 touches to form a cluster
  - Deduplicates overlapping clusters

findDOL(candles, signalIndex, entryPrice, stopPrice, direction, activeFVGs):
  - LOOKAHEAD BIAS GUARD: only uses candles with openTime < signalOpenTime
  - Scans for: equal highs/lows clusters, active FVGs as targets
  - Sorts candidates by distance (nearest first)
  - Rejects targets with R:R < 1.8
  - Rejects targets beyond 5% of entry price

---

## Issues Encountered

None during unit testing. All 24 tests passed on first run.

---

## Test Results

```
tests/run_fvg_tests.js: 24/24 PASS

Asian session gate (4 tests):
  22:00 UTC is Asian session
  03:00 UTC is Asian session
  07:00 UTC is NOT Asian session
  13:00 UTC is NOT Asian session

Bullish FVG detection (5 tests):
  Detects valid bullish FVG
  Rejects FVG in Asian session
  Rejects FVG with insufficient body size
  Rejects FVG with insufficient RVOL
  Returns empty array when no gap exists

FVG state management (8 tests):
  Expires at expires_at candle
  Invalidated when price closes below bottom
  PARTIALLY_FILLED when 50%+ of zone touched
  CONTESTED after 3 touches without fill
  isTradeable: ACTIVE, PARTIALLY_FILLED, EXPIRED, CONTESTED

FVG entry signal (3 tests):
  Generates signal when price reaches midpoint
  No signal when price above midpoint
  No signal for expired FVG

DOL finder (4 tests):
  Detects equal highs cluster
  Returns null when no valid target
  Lookahead bias guard verified
  Rejects target with R:R < 1.8
```

---

## Backtest Runs

### Step 1.3 — Baseline (no filters)
Status: Pending

### Step 1.4 — Add Regime Filter
Status: Pending

### Step 1.5 — Add Killzone + Asian Session Gate
Status: Pending

### Step 1.6 — Add Macro Blackout
Status: Pending

### Step 1.7 — Parameter Sensitivity Test
Status: Pending

### Step 1.8 — Regime-Split Analysis
Status: Pending

### Step 1.9 — Accept/Reject Decision
Status: Pending

---

## AI Reviews
*(To be updated after external review)*

---

## Gemini Red-Team Review — April 2026

Gemini raised 5 points. Verdict and action on each:

### Point 1 — Midpoint entry opportunity cost / front-run errors
**Verdict: Valid. Fixed.**

Added `entryOffset` to config.js (default 0.50 = midpoint).
Sensitivity test will compare 0.25 vs 0.50 in Step 1.7.
Runner will track "front-run misses" (price hit FVG edge, reached TP, never hit entry level).

### Point 2 — Nearest-first DOL bias
**Verdict: Partially valid. No change to DOL logic.**

Nearest-first is correct for TP2. The "big extension" concern is handled by the
pyramiding logic (Step 6.2b) — after TP1, the system can add to the position.
DOL finder's job is to find a valid TP2, not predict maximum extension.

### Point 3 — Asian session blind spot (detection vs entry)
**Verdict: Valid. Fixed.**

Changed Asian session gate from detection to entry:
- Detection: ALLOWED in all sessions (FVGs can form during Asian session)
- Entry: BLOCKED during Asian session (22:00-07:00 UTC)
- FVGs detected during Asian session can be filled during London open

This is a real improvement — Asian session FVGs that fill at London open are
often high-probability trades (the sweep happened during thin liquidity,
the fill happens when real volume arrives).

### Point 4 — Statistical sparsity (6.4/month)
**Verdict: Already acknowledged. No new action.**

Wilson CI will flag results as unreliable until n >= 100.
Sensitivity test will be rigorous given the low trade count.

### Point 5 — Overlapping signals / portfolio heat
**Verdict: Already handled by engine.**

checkPortfolioRisk() in engine.js handles this. Runner will call it before
placing any trade. No new action needed.

---

## Final Test Results After Gemini Review

```
tests/run_fvg_tests.js: 26/26 PASS (was 24/24 before review)

2 new tests added:
  - No entry signal during Asian session (entry gate)
  - Entry signal allowed during London open for Asian-detected FVG

1 test updated:
  - Asian session test now verifies detection ALLOWED, entry BLOCKED
```

## Changes Made
- config.js: added FVG.entryOffset = 0.50 (sensitivity test parameter)
- fvg.js: detection gate removed, entry gate moved to checkFVGEntry()
- fvg.js: checkFVGEntry uses entryOffset for configurable entry depth
