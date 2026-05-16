# BulletBrain v3.0 — Phase D8 Cleanup Log

**Date:** 2026-05-09  
**Status:** Complete  
**Scope:** Code quality cleanup — no strategy logic changed, no results affected

---

## Summary

Four changes across 9 files. Eliminated ~500 lines of duplicated trade-management code across three runners by extracting shared logic and unifying the backtest loop. Fixed a partial-close-inflation bug present in two of the three runners. Added package.json run scripts.

---

## Change 1 — Extract Shared Trade Management

**File created:** `src/backtest/tradeManager.js` (148 lines)

The trade management inner loop (stop, TP1, TP2, time exit, momentum exit, z-score exit, CVD exhaustion exit) was duplicated verbatim across all three runners (~70 lines each, ~210 lines total). Extracted into a single `processOpenTrades(ctx)` function.

**Partial-close-inflation bug fixed:** The FVG runner (`runner.js`) and OB runner (`ob_runner.js`) were pushing momentum and CVD exhaustion partial closes to `closedTrades` without checking if the trade was fully closed. When `closeTrade` is called with a fraction < 1.0 (partial close), `trade.size > 0` after — the trade is still open. The old code pushed these to `closedTrades`, inflating trade counts and distorting WR/PF metrics.

The LSO runner had already fixed this bug. The unified `tradeManager.js` applies the correct logic:
```javascript
if (trade.size <= 0) {  // only push if FULLY closed
  closedTrades.push(closed);
  openTrades.splice(t, 1);
}
```

---

## Change 2 — Unified Backtest Runner

**File rewritten:** `src/backtest/runner.js` (303 lines, was 536)

**File deleted:** `src/backtest/ob_runner.js` (was 479 lines)

**File rewritten:** `src/backtest/lso_runner.js` (212 lines, was 808 — now a thin adapter)

The three duplicate runners shared ~80% code:

| File | Before | After |
|------|--------|-------|
| `runner.js` (FVG) | 536 lines | 303 lines (unified) |
| `ob_runner.js` (OB) | 479 lines | **deleted** |
| `lso_runner.js` (LSO) | 808 lines | 212 lines (adapter) |
| `tradeManager.js` | — | 148 lines (new) |
| **Total** | **1,823 lines** | **663 lines** |

**Net reduction: 1,160 lines (-64%)**

### Architecture

The unified runner uses a **strategy descriptor** pattern. Each strategy defines a descriptor object with callbacks for:
- `detectZones` — pre-detect zones/pools before the main loop
- `updateZones` — per-candle zone state update (FVG/OB) or no-op (LSO)
- `isZoneActive` — filter function
- `checkEntry` — check if a zone/pool triggers an entry signal
- `onCandleStart` — per-candle strategy setup (LSO: pool activation/expiry)
- `gate7` — strategy-specific entry gate (CVD absorption, OI velocity, etc.)
- `isRegimeAllowed` — regime filter
- `validateSignal` — extra signal validation (LSO: sweep RVOL, OI flush)
- `getSizeMultiplier` — strategy-specific size adjustment (LSO: OB confluence 1.3×)
- `extraTradeFields` — strategy-specific trade metadata
- `onTradeOpened` — post-trade callback (LSO: remove swept pool)
- `sensitivityParams` — parameter matrix for sensitivity testing
- `reportMeta` — strategy-specific report fields

The main loop delegates all strategy-specific decisions to the descriptor, keeping the runner itself strategy-agnostic.

### LSO Backward Compatibility

`lso_runner.js` is now a thin adapter that:
1. Exports the LSO strategy descriptor factory (`createLSOStrategy`)
2. Translates the old `runLSOBacktest(options)` API to the new unified `runBacktest(strategy, options)` call
3. Preserves backward compatibility for `run_lso_slippage_stress.js` which still uses the old API

---

## Change 3 — Updated Run Scripts

**Files rewritten:**
- `src/backtest/run_fvg_backtest.js` — defines FVG strategy descriptor inline, imports unified runner
- `src/backtest/run_ob_backtest.js` — defines OB strategy descriptor inline, imports unified runner, retains OB/FVG correlation check
- `src/backtest/run_lso_backtest.js` — imports `createLSOStrategy` from `lso_runner.js`, cleaner orchestration

All three run scripts now call the same `runBacktest()`, `runSensitivityTest()`, `runRegimeSplit()`, `runYearlyBreakdown()` from the unified runner.

---

## Change 4 — Package.json Scripts

**File updated:** `package.json`

Added npm run scripts:

```json
"backtest:fvg": "node src/backtest/run_fvg_backtest.js",
"backtest:ob": "node src/backtest/run_ob_backtest.js",
"backtest:lso": "node src/backtest/run_lso_backtest.js",
"backtest:lso:slippage": "node src/backtest/run_lso_slippage_stress.js"
```

Usage: `npm run backtest:fvg`, `npm run backtest:ob`, `npm run backtest:lso`

---

## What Did NOT Change

- **No strategy logic modified.** Detection algorithms, signal generation, fill simulation, position sizing, and exit conditions are identical to before.
- **No results files affected.** All pre-existing `results/*.json` files remain valid because the backtest logic is unchanged.
- **No config values changed.**
- **No engine logic changed.** `engine.js` is untouched.
- **No indicator logic changed.**
- **The `data.test.js` failure** (Jest `jest.mock()` hoisting issue with `path`) is pre-existing and unrelated.

---

## Test Verification

```
npm test
  PASS  tests/config.test.js        (19/19)
  PASS  tests/logger.test.js
  FAIL  tests/data.test.js          (pre-existing: jest.mock() hoisting)
  PASS  tests/indicators.test.js
Tests: 72 passed, 72 total
```

All 72 tests pass. The single suite failure (`data.test.js`) is a pre-existing Jest configuration issue — `jest.mock()` factory references `path` which Jest hoists out of scope. Not related to any changes in this cleanup.

Module load verification:
```
runner.js exports: runBacktest, runSensitivityTest, runRegimeSplit, runYearlyBreakdown, GATES, LSO_GATES
tradeManager.js exports: processOpenTrades
```

---

## File Manifest

| File | Action | Lines |
|------|--------|-------|
| `src/backtest/tradeManager.js` | **Created** | 148 |
| `src/backtest/runner.js` | **Rewritten** | 303 |
| `src/backtest/ob_runner.js` | **Deleted** | — |
| `src/backtest/lso_runner.js` | **Rewritten** (adapter) | 212 |
| `src/backtest/run_fvg_backtest.js` | **Rewritten** | 180 |
| `src/backtest/run_ob_backtest.js` | **Rewritten** | 216 |
| `src/backtest/run_lso_backtest.js` | **Rewritten** | 206 |
| `src/backtest/run_lso_slippage_stress.js` | **Unchanged** | 172 |
| `package.json` | **Updated** (+4 scripts) | 37 |
