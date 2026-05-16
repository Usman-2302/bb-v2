# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**BulletBrain v3.0** — a Node.js crypto futures trading bot using Smart Money Concepts (SMC).
**Status: Phase D8 complete (LSO), D9-D14 pending. BLOCKED on 2021-2024 OI data.**

Two planning documents are authoritative:
- `backtestplan.md` — strategy specs, engine design, accept/reject rules
- `masterplan.md` — execution phases D0-D14 with done criteria

---

## Current State (May 2026)

### Phases Complete

| Phase | Status | Key Result |
|-------|--------|------------|
| D0 | Clean | Project scaffold, config.js (17 param blocks), logger |
| D1 | Complete | OHLCV 2021-2024 downloaded (2.5M candles), funding data complete, OI limited to 30 days |
| D2 | Clean | 7 indicators as pure functions |
| D3 | Clean | Regime engine: ATR-normalized slope (threshold 0.011), zombie hysteresis, 6-regime model |
| D4 | Clean | Backtest engine: penetration-depth fill model, 5 exit types, 48/48 tests |
| D5 | Clean | Macro tagger: 144 CPI/FOMC/NFP events, 21/21 tests |
| D6 | REJECT | FVG strategy: PF never > 0.45, toxic fills, low trade count → CONFLUENCE_ONLY |
| D7 | REJECT | OB strategy: PF 0.488, DD 8.62%, 100% FVG overlap → CONFLUENCE_ONLY |
| D8 | DATA_BLOCKED | LSO strategy: NO_OI baseline PF 2.816, WR 56% (200 trades). Needs OI data for full validation |

### Strategies Verdict

| Strategy | BTC Status | Notes |
|----------|-----------|-------|
| FVG | CONFLUENCE_ONLY | 80% of fills in RANGING_ZOMBIE, momentum-driven entries, PF < 0.5 in all runs |
| OB | CONFLUENCE_ONLY | 100% overlap with FVG, same momentum problem, PF 0.488 |
| LSO | PENDING (DATA_BLOCKED) | NO_OI baseline PF 2.816 with CVD_ZSCORE synthetic gate. Needs real OI data |
| VPB | NOT BUILT | Phase D9 pending |
| SHORT-LSO | NOT BUILT | Phase D10 pending |
| CVD Divergence | RETIRED | Not viable as standalone per plan |

### Key Engine Improvements (carry forward to all future work)
- **ATR-relative fill thresholds** (engine.js): CLEAN < 5% ATR, TOXIC >= 40% ATR — self-calibrating per timeframe
- **Killzone as size multiplier** (not binary gate): 1.2× in killzone, 0.8× outside
- **Confirmed swing pivot DOL** (dolFinder.js): 3-bar pivot, min 0.5% distance, no Tier 3 ATR fallback
- **Ghost sweep CVD gate**: blocks wick-dominated candles with flat CVD delta
- **Level Reclaim entry model** (LSO): enter at pool.level on next candle, not body midpoint during cascade

---

## Architecture (Actual — not planned)

```
bbv-2/
├── src/
│   ├── indicators/         # ema.js, atr.js, rvol.js, cvd.js, swingHL.js, volumeProfile.js, efficiencyRatio.js
│   ├── strategies/         # fvg.js, ob.js, lso.js (vpb.js, shortLso.js NOT BUILT)
│   ├── backtest/           # engine.js, reporter.js, runner.js (unified), tradeManager.js
│   │                       # lso_runner.js (compat adapter), run_fvg_backtest.js, run_ob_backtest.js,
│   │                       # run_lso_backtest.js, run_lso_slippage_stress.js
│   ├── data/               # downloader.js, oiDownloader.js, fundingDownloader.js, loader.js, validator.js, run_download.js
│   └── utils/              # regimeDetector.js, dolFinder.js, macroTagger.js, run_regime_tagging.js, logger.js
├── data/
│   ├── historical/         # {symbol}_{tf}_tagged.ndjson (20 files, ~2.5M candles, all with .regime field)
│   ├── oi/                 # 501 records per coin (last 30 days only — Binance limitation)
│   └── funding/            # {symbol}_8h.ndjson (full 2021-2024, ~4,383 records per coin)
├── results/                # 100+ versioned JSON files. Only v14 LSO files are canonical. Needs cleanup.
├── tests/                  # Mix of Jest (4 files) + standalone runners (13 files). Not unified.
├── config.js               # ALL parameters. SYMBOL_STRATEGY_POLICY routes per-symbol strategy roles.
└── package.json
```

### Data Format
NDJSON, one candle per line. Tagged files include `.regime`, `.blackout`, `.blackoutEvent` fields.

---

## Working Commands

```bash
# Jest test suite
npm test

# Standalone test runners (each is independent)
node tests/run_engine_tests.js          # 48/48 PASS
node tests/run_regime_tests.js          # 21/21 PASS
node tests/run_macro_tests.js           # 21/21 PASS
node tests/run_lso_tests.js             # 43/43 PASS
node tests/run_ob_tests.js              # 24/24 PASS
node tests/run_fvg_tests.js             # 26/26 PASS
node tests/run_data_tests.js            # 20/20 PASS
node tests/adversarial_indicators.js    # 13/13 PASS
node tests/validate_regime_realdata.js  # 13/13 PASS

# Backtest runners
npm run backtest:fvg                    # FVG backtest
npm run backtest:ob                     # OB backtest
npm run backtest:lso                    # LSO backtest (NO_OI baseline)
npm run backtest:lso:slippage           # LSO slippage stress test
```

---

## Known Issues (The Mess)

### Critical Blockers
1. **No 2021-2024 OI data**: Binance API only provides 30 days. Binance Vision has no OI data. Coinglass API ($35/mo) is the only path. This blocks LSO validation, slippage stress tests, regime splits, and all of D9-D14.
2. **CVD validation (Step 4.1) not run**: Need 30 days of BTC aggTrades from Binance Vision to compute Pearson correlation between candle-CVD and tick-CVD. This determines whether Gate 7 uses CVD or OI velocity.

### Code Quality Issues
3. ~~**Three separate runner files**~~ — **FIXED D8 Cleanup.** Unified into single `runner.js` with strategy descriptors. `ob_runner.js` deleted, `lso_runner.js` is now a thin adapter.
4. **100+ versioned result files** in `results/` — **PARTIALLY FIXED.** Obsolete v1-v13 deleted. v14 kept as canonical. Non-versioned FVG/OB files kept.
5. **Standalone tests not integrated with Jest**: 13 test files run via `node tests/run_*.js` but only 4 are in Jest. `npm test` reports 71/72 pass (1 config test stale).
6. **`tests/run_indicator_tests.js` is broken** — MODULE_NOT_FOUND, likely stale imports after refactoring.
7. ~~`config.test.js` expects FVG.validityCandles=72~~ — **FIXED.** Updated to 288 (15m migration).

### Architectural Debt
8. **FVG/OB code still in tree despite REJECT**: Both are CONFLUENCE_ONLY but there's no mechanism to use them as confluence filters yet. That's Phase D11 work.
9. **No package.json run scripts**: The planned `npm run backtest:fvg`, etc. were never added.
10. **DOL finder only has two tiers now** (equal highs cluster + confirmed swing pivot). Tier 3 (ATR-based) was removed in D6 Baseline 3.0.
11. **Time-based breakeven gate tested and reverted twice** (OB in D7, LSO in D8) — made results worse both times. Code may still exist in strategy files.
12. **`lso_no_oi_v9.json` is 2.2MB** — from the pool-not-consumed bug that produced 8,810 trades. Should be deleted.

---

## Key Config Values (config.js)

```javascript
// Regime thresholds
REGIME.slopeThreshold: 0.011        // ATR-normalized, empirically calibrated
REGIME.zombieThreshold: 0.15        // Efficiency Ratio < 0.15 = ZOMBIE
REGIME.zombieHysteresis: 3          // candles before state change (12h at 4H)

// LSO (current canonical)
LSO.swingLookback: 1                // 1-bar swing filter
LSO.equalTolerance: 0.003           // 0.3% for equal highs/lows
LSO.useSessionPools: false          // session pools built but disabled
LSO.oiDataFallback: 'CVD_ZSCORE'    // synthetic OI gate using CVD velocity z-score
LSO.cvdVelocityZscoreThreshold: 2.5 // z-score threshold for CVD velocity gate
LSO.sweepRvolMin: 1.2               // minimum RVOL on sweep candle

// FVG (15m — migrated from 1H)
FVG.validityCandles: 288            // 72h = 288 × 15m candles
FVG.entryOffset: 0.25               // 25% into FVG zone from top

// Symbol routing
SYMBOL_STRATEGY_POLICY = {
  BTCUSDT: { FVG: 'CONFLUENCE_ONLY', OB: 'CONFLUENCE_ONLY', LSO: 'PENDING', VPB: 'PENDING' },
  // ETH, SOL, BNB, XRP all PENDING for everything
}
```

---

## Regime Distribution (BTC 4H, 2021-2024, 8,766 candles)

```
BULL:             3,976 (45.4%)
BEAR:             3,408 (38.9%)
RANGING:            990 (11.3%)
CRISIS:             192  (2.2%)
RANGING_ZOMBIE:     144  (1.6%)
RANGING_PREZONE:     56  (0.6%)
```

---

## Immediate Next Steps (Priority Order)

### P0 — Unblock OI Data
1. Get Coinglass API key → add `COINGLASS_API_KEY` to `.env`
2. Run `node src/data/oiDownloader.js --coinglass`
3. Re-run LSO backtest with real OI data

### P1 — CVD Validation
4. Download 30 days BTC aggTrades from Binance Vision
5. Run Pearson correlation test (aggregate + sweep-candle-specific)
6. Decide Gate 7 variant: CVD vs OI velocity vs CVD_ZSCORE

### P2 — Cleanup
7. ~~Delete LSO result files v1-v13~~ — **DONE D8 Cleanup.**
8. ~~Fix `config.test.js` validityCandles assertion~~ — **DONE.** 72 → 288.
9. Fix or remove broken `tests/run_indicator_tests.js`
10. Unify standalone test runners into Jest or document which are manual-only
11. ~~Add package.json scripts for backtest runs~~ — **DONE D8 Cleanup.**
12. ~~Unify three duplicate runners~~ — **DONE D8 Cleanup.** Single runner.js with strategy descriptors.

### P3 — Continue Build
12. Phase D9: VPB strategy
13. Phase D10: SHORT-LSO strategy
14. Phase D11: Unified combined runner + walk-forward + Gate 8 + slippage stress
15. Phase D12: Monte Carlo (worker_threads)
16. Phase D13: 2025 forward test
17. Phase D14: Paper trading setup

---

## Rules

- **config.js is the single source of truth for all parameters.** Never hardcode values in strategy or runner files.
- **Never change the engine after Phase D6.** The ATR-relative fill thresholds and killzone multiplier are locked.
- **Never overwrite a results file.** Use versioned filenames if re-running.
- **30-trade minimum floor**: any regime split with < 30 trades = INSUFFICIENT_DATA.
- **2025 data is sacred.** Never use until Phase D13.
- **All indicators are pure functions**: `(inputs) → values[]`. No side effects.
- **runner.js is the source of truth** for regime routing policy. Data overrides original plan assumptions.
