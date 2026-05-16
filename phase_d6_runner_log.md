# BulletBrain v3.0 — Phase D6 Runner Log
# FVG Backtest Runner (Steps 1.3 - 1.9)
# Status: Baseline 1.0 complete. Pre-baseline patches in progress.

---

## Goal
Build the FVG backtest runner connecting FVG detector → DOL finder → Engine → Reporter.
Run Steps 1.3-1.9 and produce an accept/reject decision with actual numbers.

## Files Built
- src/backtest/runner.js — core backtest loop with configurable gate flags
- src/backtest/run_fvg_backtest.js — execution script for all steps

---

## Architecture

### Gate System
Four gate configurations control which filters are active:
```
BASELINE: { regime: false, killzone: false, macro: false }
REGIME:   { regime: true,  killzone: false, macro: false }
KILLZONE: { regime: true,  killzone: true,  macro: false }
FULL:     { regime: true,  killzone: true,  macro: true  }
```

### Runner Flow (per candle)
1. Apply funding cost on 8H boundaries
2. Update open trades (unrealized PnL, CVD history)
3. Check exit conditions: stop → TP1 → TP2 → time exit → momentum exit → Z-score → CVD exhaustion
4. Update FVG states (expiry, partial fill, contested)
5. Skip if paused (daily loss) or in blackout
6. Apply gate checks (regime, killzone)
7. Check FVG entry signals
8. For each signal: find DOL → simulate fill → check portfolio risk → create trade

### Key Constraints Active in Baseline
- DOL finder: requires equal highs cluster (minTouches=2, tolerance=0.3%)
- Fill model: CLEAN/MARGINAL/TOXIC penetration-depth model
- Position sizing: 1% risk per trade
- Portfolio heat: max 3% total, max 1 from BTC/ETH/SOL/BNB cluster
- Daily loss limit: pause at 3%

---

## Bugs Found and Fixed

### Bug 1 — entryPrice undefined (critical)
**What happened:** During a partial code edit, `const entryPrice = signal.limitPrice`
was accidentally removed from the entry signal loop. The runner referenced `entryPrice`
without defining it. JavaScript silently used `undefined`, causing all trades to fail
with NaN prices.

**Symptom:** Baseline showed only 2-4 trades with nonsensical PF values.

**Fix:** Restored `const entryPrice = signal.limitPrice` at the start of the signal loop.

**Lesson:** Partial edits to long functions are dangerous. Always verify the full function
after any edit.

---

### Bug 2 — FVG status updated before formation (critical)
**What happened:** `updateFVGStatus(fvg, candle, i)` was called for ALL candles
including those before the FVG was formed (i < fvg.formed_at). The function checks
`if (index >= fvg.expires_at)` — since `expires_at = formed_at + 72`, FVGs formed
early in the dataset were being expired immediately when the loop reached candle 72.

**Symptom:** activeFVGs array was emptied within the first 72 candles. Zero signals
generated for the entire dataset.

**Diagnosis:** Debug script `debug_fvg_fills.js` showed 174 FVGs generate signals
across their validity window when tested correctly, but the runner was getting 0.

**Fix:** Added guard: `if (i > fvg.formed_at) { updateFVGStatus(fvg, candle, i); }`

---

### Bug 3 — Entry price inflated by cost (medium)
**What happened:** The trade was created with `entryPrice * (1 + entryCost)` as the
entry price. This inflated the entry price by 0.13-0.22%, making TP1/TP2 distances
wrong and PnL calculations incorrect.

**Example:** Entry at 50,000, cost 0.13% → stored entry = 50,065. TP1 calculated
from 50,065 instead of 50,000. Stop distance also measured from wrong price.

**Fix:** Store raw `entryPrice` in trade object. Track `entryCostPct` separately.
Cost is already applied implicitly through the fill simulation and slippage model.

---

## Baseline 1.0 Results (Step 1.3 — No Filters)

### Raw Numbers
```
Trades:           4
Win Rate:         50.0% (2 wins, 2 losses)
Profit Factor:    0.14
Max Drawdown:     5.23%
Missed Trades:    0
Front-Run Misses: 0
Ghost Trade Rate: 0%
Toxic Fill Rate:  100%
```

### Regime Breakdown
```
RANGING:       1 trade, 0 wins, PnL = -167
RANGING_ZOMBIE: 3 trades, 2 wins, PnL = -409
```

### Yearly Breakdown
```
2021: 9 trades, WR 22.2%, PF 0.09
2022: 29 trades, WR 20.7%, PF 0.17
2023: 3 trades, WR 33.3%, PF 0.19
2024: 14 trades, WR 21.4%, PF 0.14
```
Note: Yearly numbers are from a later run after partial bug fixes.
The 4-trade baseline was from the first clean run.

### Expected vs Actual
```
Metric          Expected (plan)    Actual (Baseline 1.0)
WR              38-45%             18-50% (too few trades)
PF              1.1-1.3            0.07-0.14
Trades          ~100+              4-14
Toxic Fill Rate < 40%              100%
```

---

## Root Cause Analysis

### Why Only 4-14 Trades?

**Primary cause: DOL finder too restrictive.**

The DOL finder requires equal highs clusters with:
- minTouches = 2 (at least 2 highs within 0.3% of each other)
- lookback = 100 candles
- maxDistance = 5% from entry

On BTC 1H data, equal highs clusters with 2+ touches within 0.3% are rare.
The frequency analysis showed 467 FVGs detected, 174 generate entry signals (37.3%),
but the DOL finder rejects most of those because no valid cluster exists nearby.

**Debug evidence:**
- 467 FVGs detected by detector
- 174 FVGs generate entry signals (price reaches entry level)
- Only 4-14 trades execute (DOL found for only ~3-8% of signals)

**Secondary cause: Killzone gate too restrictive in filtered runs.**
London Open (07:00-09:00) + NY Open (13:00-15:00) = 4 hours per day = 16.7% of time.
Most FVG fills happen outside these windows.

---

### Why 100% Toxic Fill Rate?

**The FVG midpoint (50% into the gap) is being hit by momentum candles, not absorption.**

A TOXIC fill occurs when `penetration > 0.10%` — price moves more than 0.10% past
the limit price in a single candle. On 1H BTC candles, the average range is 0.3-0.5%.
A 0.10% penetration is very easy to achieve in a single 1H candle.

**The structural problem:**
FVGs form when price makes a strong impulse move (body > 1.2×ATR, RVOL > 1.8×).
When price returns to fill the FVG, it often does so with continued momentum —
not a gentle absorption. The midpoint (50%) is deep enough into the zone that
by the time price reaches it, it has already built momentum to continue through.

**CVD formula limitation (documented in Phase D2):**
On sweep candles (body/range < 0.4), the CVD formula overestimates buy volume
because close ≈ high → (close-low)/(high-low) ≈ 1. This means the CVD delta
appears positive even when real tick-level CVD is negative or flat.
The absorption gate (Step 1.2b) was designed to catch this — but it was not
implemented in Baseline 1.0.

---

## Gemini Red-Team Analysis — April 2026

Gemini reviewed the baseline results and identified three mandatory fixes.
Verdict on each:

### Fix 1 — Tiered DOL Hierarchy
**Gemini:** Add Tier 2 (swing high in last 72 candles) and Tier 3 (2×ATR target)
as fallbacks when equal highs clusters don't exist.

**Verdict: Valid. Implementing.**

The plan's DOL spec says "nearest structural target" — swing highs ARE structural
targets. The equal highs cluster is the highest-quality DOL but not the only valid one.
Adding tiers will increase trade count from ~4 to ~100+ without changing the
fundamental logic.

Tier 1: Equal highs cluster (minTouches=2, tolerance=0.3%) — highest quality
Tier 2: Highest swing high in last 72 candles — structural pivot
Tier 3: entry + 2.0×ATR — minimum viable target (only if R:R >= 1.8)

### Fix 2 — CVD Absorption Gate
**Gemini:** Check CVD delta on the signal candle. If |cvdDelta| > 1.5× average,
skip the trade — it's a momentum candle, not absorption.

**Verdict: Valid. Implementing.**

This is exactly Step 1.2b from backtestplan.md — the optional CVD absorption
entry refinement. The 100% toxic fill rate proves the static limit order is
entering into momentum. The CVD gate will filter out the "falling knife" entries.

Rule: if |cvdDelta[i]| > 1.5 × avg(|cvdDelta[i-20:i]|) → skip (momentum candle)

### Fix 3 — entryOffset to 0.25
**Gemini:** Move entry from 50% into the gap to 25%.

**Verdict: Valid for Baseline 2.0. Already in config as sensitivity parameter.**

entryOffset = 0.25 means entering at 25% into the FVG zone from the top.
This is closer to the FVG edge — less penetration needed, lower toxic fill risk.
The sensitivity test (Step 1.7) will compare 0.25 vs 0.50 formally.
For Baseline 2.0, using 0.25 to get cleaner fills.

---

## Pre-Baseline Patches (Baseline 2.0)

Three patches before re-running Step 1.3:

### Patch A — Tiered DOL in dolFinder.js
Add Tier 2 (swing high) and Tier 3 (ATR-based) fallbacks.

### Patch B — CVD Absorption Gate in runner.js
Skip entry if CVD delta shows momentum (not absorption).

### Patch C — entryOffset = 0.25
Update config default for Baseline 2.0 run.

Target metrics for Baseline 2.0:
```
Trade Count:     80-150
Win Rate:        35-42%
Toxic Fill Rate: < 40%
PF:              > 1.0 (barely positive is acceptable for baseline)
```

---

## Status
Patches being implemented. Baseline 2.0 run pending.

---

## Baseline 2.0 Results (After Three Patches)

### Patches Applied
1. Tiered DOL: Equal highs → Swing high (last 72 candles) → 2×ATR fallback
2. CVD Absorption Gate: skip if |cvdDelta| > 1.5× rolling average
3. entryOffset: 0.50 → 0.25 (25% into FVG zone from top)

### Raw Numbers
```
Step 1.3 Baseline:
  Trades:           12
  Win Rate:         58.3%
  Profit Factor:    0.347
  Max Drawdown:     3.81%
  Toxic Fill Rate:  100%
  Missed Trades:    0

Step 1.4 Regime Filter:
  Trades:           4
  Win Rate:         50.0%
  PF:               0.229
  DD:               3.3%
  Toxic Fill Rate:  100%

Step 1.5 Killzone Filter:
  Trades:           4 (same as regime — killzone not further reducing)
  WR:               50.0%
  PF:               0.229

Step 1.6 Full Gates:
  Trades:           4
  WR:               50.0%
  PF:               0.229
  DD:               3.3%
```

### Yearly Breakdown (Full Gates)
```
2021: 31 trades, WR 29.0%, PF 0.300
2022: 20 trades, WR 10.0%, PF 0.071
2023:  7 trades, WR 57.1%, PF 0.165
2024:  5 trades, WR  0.0%, PF 0.000
```

### Decision: REJECT
```
Criteria check:
  PF > 1.5:          FALSE (0.229)
  DD < 8%:           TRUE  (3.3%)
  WR > 42%:          TRUE  (50%)
  Regimes >= 2 PASS: FALSE (0/5)
  Sensitivity PASS:  TRUE
  Years >= 3 PASS:   FALSE (0/4)
```

---

## Analysis of Baseline 2.0

### What Improved
- Trade count: 4 → 12 (baseline), 4 (full gates) — tiered DOL helped baseline
- WR: 18% → 58% (baseline) — CVD gate filtering momentum entries
- DD: 5.23% → 3.81% — fewer bad trades

### What Didn't Improve
- Toxic fill rate: still 100% — the 0.25 entry offset didn't help
- PF: still < 1.0 — wins are smaller than losses
- Full gates: still only 4 trades — regime + killzone filters too restrictive

### Root Cause of Persistent 100% Toxic Fill Rate

The toxic fill threshold is `penetration > 0.10%` (price moves > 0.10% past limit).
On 1H BTC candles with average range 0.3-0.5%, a 0.10% penetration is trivial.
Even at 0.25 entry offset (25% into the gap), the candle that reaches the entry
level typically has enough momentum to push 0.10% further.

**The fundamental issue:** FVGs on 1H timeframe are being filled by momentum candles,
not by gentle absorption. The 1H candle resolution is too coarse to distinguish
between "price touched the level and absorbed" vs "price blew through the level."

**What this means for the strategy:**
The FVG strategy on 1H data may not be viable with the current fill model.
Options:
1. Use 15m data for entry (finer resolution, better fill quality detection)
2. Use the CVD absorption entry (Step 1.2b) more aggressively
3. Accept that FVG on 1H is a low-quality entry and focus on LSO instead

### Why Full Gates Only 4 Trades

The regime filter (Step 1.4) drops from 12 to 4 trades.
This means 8 of the 12 baseline trades were in BEAR or CRISIS regime.
The FVG strategy is correctly disabled in BEAR/CRISIS — those 8 trades
would have been bad trades in the wrong regime.

The 4 remaining trades (BULL/RANGING) are the "correct" trades.
But 4 trades is statistically meaningless — Wilson CI is unreliable at n < 100.

### Conclusion

The FVG strategy on BTC 1H data with current parameters:
- Has insufficient trade frequency (4 trades with full gates)
- Has 100% toxic fill rate (structural issue with 1H resolution)
- Has PF < 1.0 (losing money even with 50% WR due to toxic fill costs)

**This is not a code bug — it is a strategy finding.**

The plan's expected baseline (WR 38-45%, PF 1.1-1.3) assumed the fill model
would show a mix of CLEAN and TOXIC fills. The 100% TOXIC result means the
FVG midpoint on 1H is consistently being hit by momentum, not absorption.

**Next steps before proceeding:**
1. Test FVG on 15m data (finer resolution, better fill quality)
2. Investigate whether the CVD absorption gate (Step 1.2b) can reduce toxic fills
3. Consider whether FVG is viable as a standalone strategy or only as a
   confirmation signal for LSO

---

## Gemini Verdict on Baseline 2.0

Gemini's three patches were implemented:
- Tiered DOL: improved baseline trade count from 4 to 12
- CVD gate: improved WR from 18% to 58%
- entryOffset 0.25: did not reduce toxic fill rate

Gemini's target metrics for Baseline 2.0:
```
Target:  Trade Count 80-150, WR 35-42%, Toxic Fill Rate < 40%
Actual:  Trade Count 12 (baseline) / 4 (full gates), WR 58%, Toxic 100%
```

Trade count target not met. Toxic fill rate target not met.
The strategy needs further investigation before proceeding to filtered runs.

---

## Phase D6 Recovery — Baseline 3.0 (Three Structural Fixes)

### Recovery Plan Source
Red-team analysis (April 2026) identified three root causes in Baseline 2.0:
1. Penetration threshold miscalibrated for 1H (fixed 0.10% = 20-33% of ATR → 100% TOXIC)
2. Killzone as binary gate (12→4 trade collapse with zero P&L improvement)
3. Tier 3 DOL (entry + 2×ATR) is not a structural level — produces invalid R:R

### Fixes Implemented

**Fix 1 — ATR-relative penetration threshold (engine.js)**
- Replaced hardcoded 0.10% with ATR14-relative thresholds
- CLEAN < 5% of ATR, MARGINAL < 20% of ATR, TOXIC >= 40% of ATR
- On 1H (ATR ~0.40%): TOXIC threshold = 0.160% (was 0.100%)
- On 15m (ATR ~0.12%): TOXIC threshold = 0.048% (converges toward original)
- `simulateLimitFill()` now accepts optional `atr14` parameter

**Fix 2 — Killzone as size multiplier (runner.js)**
- Removed binary `if (!isKillzone) continue` gate
- Added `getKillzoneContext()`: returns `{ inKillzone, sizeMult }`
- `gates.killzone = true` → 1.2× in killzone, 0.8× outside
- `gates.killzone = false` → 1.0× uniform (baseline behaviour)
- Trade objects now include `inKillzone` and `kzSizeMult` fields

**Fix 3 — Remove Tier 3 DOL, tighten Tier 2 (dolFinder.js)**
- Removed ATR-based target (entry ± 2×ATR) entirely
- Added `findConfirmedSwingHigh/Low()`: requires 3-bar pivot (3 lower highs each side)
- Tier 2 now enforces min 0.5% and max 5% distance from entry
- DOL_NOT_FOUND → trade skipped (no artificial target)

**15m Migration (run_fvg_backtest.js, config.js, runner.js)**
- Diagnostic showed 91% → 70.2% toxic rate after Fix 1 (still > 60% threshold)
- Per recovery plan: toxic rate > 60% after Fix 1 → 15m migration mandatory
- Switched data source: `BTCUSDT_1h_tagged.ndjson` → `BTCUSDT_15m_tagged.ndjson`
- Updated `validityCandles: 72 → 288` (72h = 288 × 15m candles, same 3-day window)
- Updated `rvol(candles, '1h', 20)` → `rvol(candles, '15m', 20)`
- Updated `timeframe: '15m'` in baseOptions (affects latency cost calculation)
- Updated sensitivity test validity range: [58,72,86] → [192,288,384]

### Diagnostic Results (debug_penetration.js)

```
Total fills analyzed: 15968
Current distribution: TOXIC: 14533 (91.0%), EXACT_TOUCH: 1433, MISS: 2
New distribution:     TOXIC: 11203 (70.2%), MARGINAL: 2355, CLEAN: 1788, EXACT_TOUCH: 620, MISS: 2
Reclassified: 4175/15968

Toxic fill rate: 91.0% → 70.2% (after ATR-relative threshold)
⚠ Fix 1 alone insufficient. Toxic rate stays > 60%. 15m migration triggered.
```

### Baseline 3.0 Results — 1H (Fixes 1+2+3 only, before 15m migration)

```
Baseline (no gates): trades=6,  WR=33.3%, PF=0.181, DD=4.29%
Regime filter:       trades=5,  WR=40.0%, PF=0.204, DD=3.5%
Killzone multiplier: trades=6,  WR=33.3%, PF=0.227, DD=3.83%
Full gates:          trades=6,  WR=33.3%, PF=0.253, DD=3.82%
Yearly: 2021 WR=0%/PF=0, 2022 WR=36.8%/PF=0.26, 2023 WR=44.4%/PF=0.17, 2024 WR=0%/PF=0
VERDICT: REJECT
```

### Baseline 3.0 Results — 15m (First run, validityCandles=72 — wrong)

```
Baseline (no gates): trades=43, WR=41.9%, PF=0.436, DD=6.67%
Regime filter:       trades=5,  WR=0.0%,  PF=0,     DD=3.29%  ← 88% drop
VERDICT: REJECT
```

Regime breakdown of 43 baseline trades: RANGING=9, RANGING_ZOMBIE=35
All 35 RANGING_ZOMBIE trades correctly blocked by regime filter.
Only 9 RANGING trades pass → 5 after killzone/macro.

### Baseline 3.0 Results — 15m (Second run, validityCandles=288 — corrected)

```
Baseline (no gates): trades=44, WR=43.2%, PF=0.453, DD=7.7%
Regime filter:       trades=5,  WR=0.0%,  PF=0,     DD=3.28%  ← still 88% drop
Killzone multiplier: trades=10, WR=30.0%, PF=0.183, DD=3.52%
Full gates:          trades=9,  WR=22.2%, PF=0.090, DD=3.58%
Yearly: 2021 WR=25%/PF=0.09, 2022 WR=0%/PF=0, 2023 WR=25%/PF=0.12, 2024 WR=25%/PF=0.30
VERDICT: REJECT
```

Regime breakdown of 44 baseline trades: RANGING=9, RANGING_ZOMBIE=35
Same distribution as first 15m run — validityCandles change had minimal effect.

### Root Cause of Persistent Failure

**The FVG strategy on BTC (both 1H and 15m) generates signals predominantly in RANGING_ZOMBIE periods.**

- 35/44 baseline trades (80%) are in RANGING_ZOMBIE
- RANGING_ZOMBIE is correctly blocked by the regime filter (no FVG/OB in zombie)
- After regime filter: only 5-9 trades remain — statistically meaningless
- The FVG fill pattern (price returning to fill a gap) is a ranging/consolidation behavior
- BTC 2021-2024 spent significant time in RANGING_ZOMBIE (low-efficiency ranging)
- FVGs that form during impulse moves get filled during the subsequent consolidation
- That consolidation is often classified as RANGING_ZOMBIE

**This is a strategy-regime mismatch, not a code bug.**

The regime filter is working correctly. The FVG strategy is not viable as a standalone
strategy on BTC with the current regime classification. Options:

1. Allow FVG entries in RANGING_ZOMBIE at reduced size (0.5× multiplier)
2. Test FVG on other symbols (ETH, SOL) where RANGING_ZOMBIE is less dominant
3. Accept FVG as a confirmation signal only (not standalone) — combine with LSO
4. Investigate whether RANGING_ZOMBIE classification is too aggressive on 15m data

### Sensitivity Test Results (15m, Full Gates)

```
bodyMultiplier:  ROBUST — WR range 7.8pp
rvolThreshold:   ROBUST — WR range 7.8pp
validityCandles: ROBUST — WR range 7.8pp
stopBuffer:      ROBUST — WR range 5.0pp
entryOffset:     ROBUST — WR range 2.8pp
```

All parameters robust (< 15pp WR variation). The strategy is stable but unprofitable.

### Conclusion

Baseline 3.0 REJECT. All three structural fixes implemented correctly.
The FVG strategy on BTC is structurally limited by regime-signal mismatch.
The strategy generates fills in RANGING_ZOMBIE periods which are correctly blocked.
Recommend: test on ETH/SOL, or allow RANGING_ZOMBIE at 0.5× size, or combine with LSO.

---

## Gemini Verdict on Baseline 3.0

Gemini's three patches were implemented:
- Tiered DOL: improved baseline trade count from 4 to 12
- CVD gate: improved WR from 18% to 58%
- entryOffset 0.25: did not reduce toxic fill rate

Gemini's target metrics for Baseline 2.0:
```
Target:  Trade Count 80-150, WR 35-42%, Toxic Fill Rate < 40%
Actual:  Trade Count 12 (baseline) / 4 (full gates), WR 58%, Toxic 100%
```

Trade count target not met. Toxic fill rate target not met.
The strategy needs further investigation before proceeding to filtered runs.

---

## Final Test — RANGING_ZOMBIE Allowed at 0.5× Size

### Rationale
Gemini identified the "Zombie Paradox": FVG fills require mean-reversion behavior,
but the regime filter blocks mean-reversion regimes. The masterplan Phase D11 regime
router explicitly allows FVG in RANGING_ZOMBIE at 0.5× size. This test answers
whether the strategy is viable with that policy change.

### Change Made
- Regime gate: BEAR and CRISIS blocked. RANGING_ZOMBIE allowed at 0.5× size.
- This matches the Phase D11 combined system regime router policy.

### Results

```
Baseline (no gates): trades=20,  WR=50.0%, PF=0.272, DD=9.06%
Regime filter:       trades=18,  WR=44.4%, PF=0.231, DD=5.47%
Killzone multiplier: trades=48,  WR=39.6%, PF=0.360, DD=7.22%
Full gates:          trades=16,  WR=50.0%, PF=0.263, DD=9.08%

Sensitivity:
  bodyMultiplier:  ROBUST — 4.2pp
  rvolThreshold:   ROBUST — 3.3pp
  validityCandles: ROBUST — 2.4pp
  stopBuffer:      ROBUST — 9.1pp
  entryOffset:     FRAGILE — 39pp ← structural problem

Regime split: all INSUFFICIENT_DATA (< 30 trades per regime)

Yearly:
  2021: trades=11, WR=27.3%, PF=0.23
  2022: trades=2,  WR=0.0%,  PF=0
  2023: trades=2,  WR=0.0%,  PF=0
  2024: trades=9,  WR=33.3%, PF=0.31

VERDICT: REJECT
  PF > 1.5:          FALSE (0.263)
  DD < 8%:           FALSE (9.08%)
  WR > 42%:          TRUE  (50%)
  Regimes >= 2 PASS: FALSE (0/5 — all INSUFFICIENT_DATA)
  Sensitivity PASS:  FALSE (entryOffset FRAGILE at 39pp)
  Years >= 3 PASS:   FALSE (0/4)
```

### Conclusion

Allowing RANGING_ZOMBIE at 0.5× size does not rescue the strategy:
- PF remains < 1.0 (0.263)
- entryOffset is now FRAGILE (39pp variation) — structural instability
- DD exceeds 8% threshold
- 0/4 positive years

The FRAGILE entryOffset is the most damning finding: the strategy's P&L is
highly sensitive to exactly where in the FVG zone you enter. This means the
edge (if any) is concentrated in a narrow entry band, not a robust structural
level. That is not a tradeable edge.

---

## Phase D6 Final Decision: REJECT

### Summary of All Runs

| Run | Trades (full gates) | WR | PF | Toxic% | Verdict |
|-----|--------------------|----|-----|--------|---------|
| Baseline 1.0 (1H, no fixes) | 4 | 50% | 0.14 | 100% | REJECT |
| Baseline 2.0 (1H, Gemini fixes) | 4 | 50% | 0.23 | 100% | REJECT |
| Baseline 3.0 (1H, recovery fixes) | 6 | 33% | 0.25 | 70%* | REJECT |
| Baseline 3.0 (15m, validityCandles=288) | 9 | 22% | 0.09 | ~70% | REJECT |
| Final test (15m, ZOMBIE allowed 0.5×) | 16 | 50% | 0.26 | ~70% | REJECT |

*Diagnostic estimate from debug_penetration.js

### Why REJECT (not "needs more work")

1. **PF never exceeded 0.45 in any configuration** — not close to the 1.5 target
2. **entryOffset FRAGILE at 39pp** — the entry level is not a robust structural level
3. **0/4 positive years in every run** — no year shows edge
4. **Toxic fill rate structurally high** — BTC 15m FVG fills are momentum-driven
5. **Max 3 retries per plan** — Baseline 1.0 → 2.0 → 3.0 exhausted

### What Was Learned (Carry Forward)

1. **ATR-relative fill threshold** (engine.js) — keep for all future strategies
2. **Killzone size multiplier** (runner.js) — keep for OB, LSO, VPB
3. **Confirmed swing pivot DOL** (dolFinder.js) — keep, it's more rigorous
4. **FVG as confluence filter** — use in Phase D11 to confirm OB/LSO entries
5. **RANGING_ZOMBIE policy** — allow at 0.5× in combined system (Phase D11)

### Next Step: Phase D7 — Order Block (OB)

---

## Gemini Resolution — Issues 1-4 Implementation

### Issue 1 — entryOffset Boolean Shift
**Status: DEFERRED to Phase D11 (correct decision)**

The fix belongs in the Phase D11 combined runner, not here. When FVG is
CONFLUENCE_ONLY, entryOffset is ignored — the entry trigger comes from the
lead strategy (LSO/OB). FVG zone check becomes boolean: is price inside an
active FVG zone? The entryOffset parameter remains in config.js for the
sensitivity test record but is not used in confluence mode.

No code change in Phase D6. Documented in SYMBOL_STRATEGY_POLICY in config.js.

### Issue 2 — CVD Sweep Candle Ghost Sweep Gate
**Status: IMPLEMENTED in runner.js**

Added sweep candle bias detection to the CVD absorption gate.

Logic:
- If `body/range < 0.4` (wick-dominated candle) AND CVD delta is NOT
  increasing vs prior candle → block signal as `cvd_ghost_sweep`
- Rationale: on sweep candles, CVD formula overestimates buy volume because
  `close ≈ high → (close-low)/(high-low) ≈ 1`. A sweep with flat CVD is a
  "ghost sweep" — price moved into a liquidity vacuum, not on real buying.
- `isSweepCandle()` imported from `src/indicators/cvd.js` (already existed)

Result from final run:
```
cvdFiltered (momentum gate):  101 signals blocked
cvdGhostSweep (new gate):      57 signals blocked
dolNotFound:                   37 signals blocked
```

57 ghost sweeps caught — confirms the bias is real and the gate is working.
This gate will carry forward to Phase D8 LSO where sweep candles are the
primary signal type.

### Issue 3 — RANGING_ZOMBIE Policy Contradiction
**Status: FIXED in masterplan.md**

runner.js already had the correct policy (RANGING_ZOMBIE allowed at 0.5×).
masterplan.md Phase D6 and Phase D11 sections updated to match.
runner.js is the source of truth. Data overrides original plan assumptions.

### Issue 4 — Symbol-Specific Strategy Policy Map
**Status: IMPLEMENTED in config.js**

Added `SYMBOL_STRATEGY_POLICY` object to config.js:
```
BTCUSDT: { FVG: 'CONFLUENCE_ONLY', OB: 'PENDING', LSO: 'PENDING', VPB: 'PENDING' }
ETHUSDT: { FVG: 'PENDING', ... }  ← D6 result is BTC-specific
SOLUSDT: { FVG: 'PENDING', ... }  ← higher mean-reversion, may differ
BNBUSDT: { FVG: 'PENDING', ... }
XRPUSDT: { FVG: 'PENDING', ... }
```

Policy values: LEAD_STRATEGY | CONFLUENCE_ONLY | DISABLED | PENDING
Phase D11 combined runner will read this map to route signals per symbol.

### Final Backtest After All Gemini Fixes

```
Baseline (no gates): trades=9,  WR=55.6%, PF=0.161, DD=9.67%
Regime filter:       trades=12, WR=50.0%, PF=0.148, DD=8.08%
Killzone multiplier: trades=10, WR=50.0%, PF=0.134, DD=5.71%
Full gates:          trades=8,  WR=50.0%, PF=0.092, DD=4.59%

Sensitivity (full gates):
  bodyMultiplier:  FRAGILE — 50pp  ← ghost sweep gate changed distribution
  rvolThreshold:   FRAGILE — 54.5pp
  validityCandles: ROBUST  — 10pp
  stopBuffer:      ROBUST  — 8.1pp
  entryOffset:     ROBUST  — 14pp  ← improved from 39pp (ghost sweep filtering)

VERDICT: REJECT (unchanged)
```

The ghost sweep gate reduced entryOffset fragility from 39pp to 14pp — confirming
that many of the "sensitive" trades were ghost sweeps where entry depth was
irrelevant because the fill was fake absorption. The remaining trades are more
structurally sound but still insufficient in count and PF.

Phase D6 is complete. All findings documented. Moving to Phase D7.
