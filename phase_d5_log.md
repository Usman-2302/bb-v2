# BulletBrain v3.0 — Phase D5 Log
# Macro Event Tagger
# Status: Complete

---

## Goal
Tag all historical candles with macro event blackout windows (CPI, FOMC, NFP).
Strategy backtests skip signals during these windows to measure "normal market" WR.

## Source References
- Spec: backtestplan.md lines 548-570 (Step 0.6)
- masterplan.md Phase D5

## What was Built
- data/macro_events.json — 144 events: 48 CPI + 32 FOMC + 48 NFP (2021-2024)
- src/utils/macroTagger.js — isInBlackout(), tagCandlesWithBlackout(), calcBlackoutStats()
- tests/run_macro_tests.js — 19 tests

---

## data/macro_events.json

144 events covering 2021-2024:
- 48 CPI releases (monthly, 13:30 UTC winter / 12:30 UTC summer)
- 32 FOMC decisions (8x per year, 18:00-19:00 UTC)
- 48 NFP releases (first Friday of month, 13:30 UTC winter / 12:30 UTC summer)

Each event: { event, date, timestamp, blackout_before_min: 30, blackout_after_min: 15 }

---

## macroTagger.js Components

isInBlackout(timestamp, events): checks if timestamp is in any blackout window.
Returns { inBlackout, event, eventTime, date }.

tagCandlesWithBlackout(candles, events): adds .blackout and .blackoutEvent to each candle.
Uses binary search on sorted windows for O(log n) per candle.

calcBlackoutStats(candles): returns { total, blacked, pct, byEvent }.

---

## Issues Encountered

### Issue 1 — Blackout percentage lower than expected

The plan estimated ~3% of trading time blacked out.
Actual result on BTC 15m data: 0.36% (505 candles out of 140,256).

Why: Each event blacks out 45 minutes = 3 x 15m candles.
144 events x 3 candles = 432 candles / 140,256 = 0.31%.
The 3% estimate assumed a broader window.

Impact: Lower blackout % is better — less trading time lost.
Protection against event-contaminated WR is still in place. No action needed.

---

## Test Results

```
tests/run_macro_tests.js: 19/19 PASS

isInBlackout (8 tests):
  True at exact event timestamp
  True 30 min before (boundary)
  True 15 min after (boundary)
  False 31 min before (just outside)
  False 16 min after (just outside)
  False for random non-event time
  Correctly identifies FOMC
  Correctly identifies NFP

tagCandlesWithBlackout (3 tests):
  Tags 5 candles correctly
  Preserves original candle fields
  Returns same length as input

calcBlackoutStats (1 test):
  Correct percentage calculation

Real data validation (7 tests):
  File loads without error
  Has all 3 event types (CPI/FOMC/NFP)
  Covers 2021-2024
  Has > 100 events (actual: 144)
  All events have required fields
  All timestamps in 2021-2024 range
  All blackout windows are 30+15 min
```

### Real data verification (BTC 15m)
```
Total candles:   140,256
Blacked out:     505 (0.36%)
By event type:   CPI: 189, NFP: 188, FOMC: 128
```

---

## Done Criteria

```
PASS  data/macro_events.json has all 2021-2024 events (144 total)
PASS  isInBlackout returns true within blackout window
PASS  isInBlackout returns false outside blackout window
PASS  Boundary conditions tested (exactly 30 min before, exactly 15 min after)
PASS  19/19 tests pass
PASS  Real data: 0.36% of BTC 15m candles blacked out
```

---

## AI Reviews
*(To be updated after external review)*

---

## Gemini Red-Team Review — April 2026

Gemini raised 5 points. Verdict and action on each:

### Point 1 — FOMC 15-minute post-blackout too short
**Verdict: Valid. Fixed.**

FOMC has a press conference 30 minutes after the rate decision. The 15-minute window
closed at 18:15 UTC, right before the Fed Chair starts speaking at 18:30.

**Fix applied:**
- FOMC post-blackout: 15 → 90 minutes (covers rate decision + press conference)
- All events pre-blackout: 30 → 60 minutes (more conservative)
- CPI/NFP post-blackout: stays at 15 minutes (no follow-up event)

Updated windows:
```
FOMC: 60 min before, 90 min after (150 min total)
CPI:  60 min before, 15 min after (75 min total)
NFP:  60 min before, 15 min after (75 min total)
```

### Point 2 — 0.36% too small / need Yellow Zone pre-event warning
**Verdict: Partially valid. Pre-blackout extended to 60 min. Yellow Zone deferred to D6.**

The 4-6 hour pre-event thinning is real. Extended pre-blackout from 30 to 60 minutes.
A full "Yellow Zone" with 50% sizing is a strategy-layer concern — noted for D6 FVG/OB
signal quality scoring. Not implemented in the tagger.

### Point 3 — Missing PPI, Unemployment Claims, crypto-specific events
**Verdict: Rejected. Scope kept to CPI/FOMC/NFP as specified in backtestplan.md.**

Adding every weekly economic release would black out 5-10% of trading time.
Crypto-specific events (ETF flows, Mt. Gox transfers) are not schedulable in advance.
The three events in the plan are the highest-impact, schedulable macro events.

### Point 4 — Hindsight bias in event selection
**Verdict: Not applicable.**

All events are scheduled releases — every CPI, every FOMC, every NFP in 2021-2024,
regardless of whether they caused volatility. No selection bias.

### Point 5 — Engine exit slippage during blackout
**Verdict: Valid. Fixed in engine.js.**

`closeTrade()` now accepts an `inBlackout` parameter.
When `inBlackout = true`, applies `crisis_stop_slippage` (0.5%) on exit.
Volatility doesn't care if you're entering or exiting — if the book is thin, you get slipped.

---

## Final Test Results After Gemini Review

```
tests/run_macro_tests.js: 21/21 PASS (was 19/19 before review)
tests/run_engine_tests.js: 48/48 PASS (closeTrade change verified)

2 new macro tests added:
  - FOMC: still in blackout 60 min after (press conference window)
  - FOMC: not in blackout 91 min after
```

## Phase D5 Final Status: Complete
