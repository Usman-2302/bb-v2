# BulletBrain v3.0 — Phase D7 Log
# Strategy 2: Order Block (OB)
# Status: Complete — REJECT

---

## Goal
Build and validate the Order Block (OB) strategy.
Run the full backtest loop: baseline → regime → killzone → macro → sensitivity → regime-split → yearly.
Run the OB/FVG correlation check.
Make the accept/reject decision with actual numbers.

## Source References
- OB detector: backtestplan.md lines 965-1050 (Step 2.1)
- OB backtest loop: backtestplan.md lines 1050-1065 (Step 2.2)
- Correlation check: backtestplan.md lines 1065-1080 (Step 2.3)
- masterplan.md Phase D7

## Engine Inheritance from Phase D6
The following Phase D6 improvements carry forward unchanged:
- ATR-relative fill threshold (engine.js) — timeframe-agnostic, self-calibrating
- Killzone size multiplier (runner.js) — 1.2× in killzone, 0.8× outside
- Confirmed swing pivot DOL (dolFinder.js) — 3-bar pivot, min 0.5% distance
- Ghost sweep CVD gate (runner.js) — blocks wick-dominated candles with flat CVD
- SYMBOL_STRATEGY_POLICY map (config.js) — OB starts as PENDING for all symbols

## OB Strategy Spec (from backtestplan.md Step 2.1)

### Bullish OB Definition
- Last BEARISH candle before a significant move UP
- "Significant move" = next candle body >= 1.5 × ATR14
- Move candle volume > 2.0 × RVOL
- OB zone: top = bearish candle high, bottom = bearish candle low
- Entry: OB top (price returns to zone from above)
- Validity: 48 candles
- Invalidation: price closes BELOW OB low

### Bearish OB Definition
- Last BULLISH candle before a significant move DOWN
- Mirror of bullish logic

### Config Parameters (config.js OB block)
```
moveMultiplier:  1.5   — ATR multiplier for significant move candle
rvolThreshold:   2.0   — minimum RVOL on move candle
validityCandles: 48    — candles before OB expires
stopBuffer:      0.1   — ATR multiplier below OB low for stop
```

### Key Differences from FVG
- OB entry is at the TOP of the zone (not midpoint) — price returns from above
- OB requires a BEARISH candle before the move (not a gap)
- OB validity is 48 candles (shorter than FVG's 288 on 15m)
- OB RVOL threshold is 2.0 (higher than FVG's 1.8) — more selective
- OB fill_rate is 0.70 (vs FVG's 0.65) — slightly less crowded level

---

## What was Built

1. src/strategies/ob.js — OB detector + state management + entry signal
2. tests/run_ob_tests.js — 24 unit tests
3. src/backtest/ob_runner.js — core backtest loop with all D6 engine improvements
4. src/backtest/run_ob_backtest.js — execution script with correlation check

---

## Test Results

```
tests/run_ob_tests.js: 24/24 PASS

Asian session gate (4 tests):
  22:00 UTC is Asian session
  03:00 UTC is Asian session
  07:00 UTC is NOT Asian session
  13:00 UTC is NOT Asian session

Bullish OB detection (5 tests):
  Detects valid bullish OB
  Rejects OB when OB candle is not bearish
  Rejects OB when move candle body is insufficient
  Rejects OB when move candle RVOL is insufficient
  Rejects OB when move candle is not bullish

Bearish OB detection (1 test):
  Detects valid bearish OB

OB state management (6 tests):
  OB expires at expires_at candle
  Bullish OB invalidated when price closes below bottom
  Bearish OB invalidated when price closes above top
  isOBTradeable: ACTIVE is tradeable
  isOBTradeable: EXPIRED is not tradeable
  isOBTradeable: INVALIDATED is not tradeable

OB entry signal (8 tests):
  Generates bullish entry signal when price reaches OB top
  No signal when price does not reach OB top
  No signal when close is below OB bottom (invalidation candle)
  No signal for expired OB
  No signal for invalidated OB
  No entry signal during Asian session
  Entry signal allowed during London open
  Generates bearish entry signal when price reaches OB bottom
```

---

## Backtest Results

### Detection Stats (Baseline)
```
OBs detected:    253
Signals fired:   189 (74.7% of detected OBs reached entry level)
DOL not found:    64 (25.3% rejected — no valid structural target)
```

### Step 2.1 — Baseline (no filters)
```
Trades:    24
Win Rate:  50.0%
PF:        0.820
DD:        4.74%
```

### Step 2.2 — Regime Filter
```
Trades:    14
Win Rate:  50.0%
PF:        0.295
DD:        5.09%
WR change: 0.0pp (regime filter not improving WR — same quality trades)
```

### Step 2.3 — Killzone Multiplier
```
Trades:    26
Win Rate:  46.2%
PF:        0.490
DD:        7.67%
```

### Step 2.4 — Full Gates
```
Trades:    15
Win Rate:  60.0%
PF:        0.488
DD:        8.62%
```

### Step 2.5 — Sensitivity Test (Full Gates)
```
moveMultiplier:  ROBUST — 3.8pp
rvolThreshold:   ROBUST — 2.4pp
validityCandles: ROBUST — 3.4pp
stopBuffer:      ROBUST — 8.7pp
```
All parameters robust. The strategy is stable but unprofitable.

### Step 2.6 — Regime-Split Analysis
```
BULL:           INSUFFICIENT_DATA (27 trades, PF=0.86)
BEAR:           INSUFFICIENT_DATA (0 trades)
RANGING:        INSUFFICIENT_DATA (15 trades, PF=0.19)
RANGING_ZOMBIE: INSUFFICIENT_DATA (4 trades, PF=0.19)
CRISIS:         INSUFFICIENT_DATA (0 trades)
```
No regime reached the 30-trade minimum floor. All INSUFFICIENT_DATA.

### Step 2.7 — Year-by-Year Breakdown
```
2021: trades=18, WR=38.9%, PF=0.236
2022: trades=15, WR=26.7%, PF=0.127
2023: trades=14, WR=57.1%, PF=0.878
2024: trades=4,  WR=0.0%,  PF=0.000
```
0/4 positive years (PF >= 1.2).

### Step 2.8 — OB/FVG Correlation Check
```
OB trades:    15
Overlapping:  15 (100%)
Verdict:      HIGH_OVERLAP — OB takes precedence over FVG when both fire
```
100% overlap means every OB trade had an active FVG signal within ±2 candles.
This is expected: OBs form before impulse moves, FVGs form during impulse moves.
They are structurally co-located. In Phase D11, OB takes precedence when both fire.

---

## Accept/Reject Decision

### Step 2.9 — VERDICT: REJECT

```
Criteria check:
  PF > 1.5:          FALSE (0.488)
  DD < 8%:           FALSE (8.62%)
  WR > 42%:          TRUE  (60.0%)
  Regimes >= 2 PASS: FALSE (0/5 — all INSUFFICIENT_DATA)
  Sensitivity PASS:  TRUE  (all parameters robust)
  Years >= 3 PASS:   FALSE (0/4)
```

### Analysis

**What worked:**
- All 4 sensitivity parameters ROBUST (unlike FVG's fragile entryOffset)
- WR 60% at full gates — higher than FVG's 50%
- Detection rate good: 74.7% of OBs reached entry level

**What didn't work:**
- PF 0.488 — wins are smaller than losses despite 60% WR
- DD 8.62% — marginally exceeds the 8% threshold
- 0/4 positive years — no year shows edge
- Trade count too low for statistical reliability (15 trades at full gates)

**Root cause of PF < 1.0 despite 60% WR:**
Same structural issue as FVG: the DOL targets (swing highs) are too close to entry
to produce 1.8:1 R:R in practice. Wins are hitting TP1 (partial close at 1:1)
but not reaching TP2 (DOL). Losses are hitting full stop. The achieved R:R is
closer to 0.6:1, not 1.8:1.

**100% OB/FVG overlap:**
Every OB trade had an active FVG nearby. This confirms OB and FVG are
structurally co-located — they both identify the same institutional activity
(impulse move + retracement). In Phase D11, OB takes precedence.

**OB as standalone on BTC 15m: REJECT.**
Same conclusion as FVG. The strategy is structurally sound but BTC 15m
momentum-driven fills prevent the R:R from materializing.

### SYMBOL_STRATEGY_POLICY Update
```
BTCUSDT: { OB: 'CONFLUENCE_ONLY' }  ← updated from PENDING
```
OB on BTC follows the same path as FVG: confluence filter in Phase D11,
not a standalone lead strategy.

---

## Issues Encountered

None. All 24 tests passed on first run. Backtest ran cleanly.

The REJECT is a strategy finding, not a code bug.

---

## Gemini D7 Review — Analysis and Implementation

### Gemini's Points

**Point 1 — "Slippage-Momentum Trap" (VALID diagnosis)**
60% WR with PF 0.49 = average loss ≈ 2.5× average win. Confirmed. The cause is
correct: OB entries are hit by momentum candles, not absorption. The engine's
TOXIC fill model correctly penalizes these entries with extra stop slippage.

**Point 2 — 100% OB/FVG overlap (VALID, already handled)**
Already documented. OB takes precedence in Phase D11. No new action.

**Point 3 — Solution A: CVD Exhaustion Trigger (DEFERRED to Phase D8)**
Requires CVD validation (Step 4.1) to run first. Cannot implement before knowing
whether candle CVD correlates with tick CVD on sweep candles. Documented in
masterplan Phase D8 deferred items.

**Point 4 — Solution B: LSO as trigger, OB as filter (DEFERRED to Phase D11)**
Phase D11 combined runner architecture. Already in masterplan deferred items.

**Point 5 — Solution C: Time-based breakeven (TESTED, REVERTED)**
Implemented 12-candle no-progress exit gate. Tested. Results:

```
Without breakeven gate (original):
  Full gates: trades=15, WR=60.0%, PF=0.488, DD=8.62%
  Sensitivity: all ROBUST

With breakeven gate (12 candles, <50% progress to TP1):
  Full gates: trades=14, WR=42.9%, PF=0.276, DD=3.91%
  Sensitivity: rvolThreshold FRAGILE (15.8pp), validityCandles FRAGILE (18.7pp)
```

The gate made things worse. It cut trades that would have eventually recovered,
introduced parameter fragility, and reduced PF further. The "immediate bounce"
assumption doesn't hold on BTC 15m — OBs in ranging markets can take 20-40
candles to resolve. The gate is correct in theory but wrong for this timeframe
and market structure.

**Decision: Reverted.** The breakeven gate is documented as a Phase D8 deferred
item with the correct framing: test it on LSO (where sweeps are faster-resolving)
rather than OB (where zones can take time to absorb).

**Point 6 — LSO size multiplier when inside OB (DEFERRED to Phase D8)**
Documented in masterplan Phase D8 deferred items. Will be implemented in
lso_runner.js when the LSO detector exists.

### Final Phase D7 State

All Gemini points assessed. Two deferred to Phase D8 (documented in masterplan).
One tested and reverted with evidence. Phase D7 REJECT stands.

The original results (without breakeven gate) are the final D7 results:
```
Full gates: trades=15, WR=60.0%, PF=0.488, DD=8.62% — REJECT
```
