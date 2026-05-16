# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

---

## Project Overview

**BulletBrain v3.0** — a Node.js crypto futures trading bot using Smart Money Concepts (SMC). Status: **pre-development** (planning complete, no source code exists yet). The two planning documents (`backtestplan.md`, `plan1.2.md`) are the authoritative specification.

---

## Planned Commands

Once scaffolded (Phase 0), the expected scripts in `package.json`:

```
node src/data/downloader.js          # download historical OHLCV + OI data
node src/backtest/runner.js fvg      # run FVG strategy backtest
node src/backtest/runner.js combined # run all accepted strategies
node src/backtest/monteCarlo.js      # run 1000 Monte Carlo simulations
node src/backtest/runner.js forward  # Phase 8 forward test (2025 data only)
```

Test framework not yet selected. When added, indicator unit tests must validate against TradingView reference values (e.g., EMA(9) on BTC 1H first 20 candles).

---

## Architecture

### Directory Structure (to be created in Phase 0)

```
bbv-2/
├── src/
│   ├── indicators/     # pure functions: ema.js, atr.js, rvol.js, cvd.js, volumeProfile.js, swingHL.js
│   ├── strategies/     # fvg.js, ob.js, lso.js, cvdDiv.js, vpb.js, shortLso.js
│   ├── backtest/       # engine.js, runner.js, reporter.js, monteCarlo.js
│   ├── data/           # downloader.js, loader.js, validator.js, oiDownloader.js
│   └── utils/          # regimeDetector.js, dolFinder.js, macroTagger.js, killzoneCheck.js
├── data/
│   ├── historical/     # NDJSON files per coin per timeframe (*_tagged.ndjson after Step 0.5)
│   └── oi/             # OI history from Binance CSV bulk data
├── results/            # per-strategy JSON results (never delete — they are the accept/reject record)
├── config.js           # ALL parameters live here — never hardcode in strategy files
└── package.json
```

### Data Format

**NDJSON (newline-delimited JSON)**, one candle per line. Never flat JSON arrays — 2.5M+ candles must stream, not load entirely into memory.

### Core Concepts

**Market Regime Engine** — the most critical architectural component. Every trade is gated by regime first:
- `BULL`: EMA200 slope ≥ 15°, price above EMA200 ≥ 20 of last 30 4H candles
- `BEAR`: EMA200 slope ≤ -15°, price below EMA200 ≥ 20 of last 30 candles
- `RANGING`: EMA200 flat (< 5°), price oscillating within 8% band for ≥ 3 days
- `CRISIS`: 4H ATR% > 5% — overrides everything else

Regime is computed on BTC 4H candles only, propagated to all lower timeframes. Requires 2 consecutive 4H closes to switch (prevents flapping). Stored in Redis: `"regime:BTC"`.

**9 Quality Gates** — every trade must pass all of them (one failure = skip):
- Gate 0: regime compatibility for this strategy
- Gate 1: HTF trend alignment (4H EMA200 + EMA50 direction)
- Gate 2: strategy produces a valid, fresh signal (≤ 2 candles old)
- Gate 3: time-normalized RVOL (threshold varies by session: 1.5× killzone, 2.5× Asian)
- Gate 4: R:R ≥ 1.8 via DOL (Draw on Liquidity) structural target
- Gate 5: portfolio state (max 3 concurrent, max 3% total risk, no correlated pairs)
- Gate 6: execution feasibility (spread < 0.05%, ATR_15m > 0.3%)
- Gate 7: OI flush ≥ 1.5% (LSO only) + CVD direction confirmation
- Gate T: temporal/killzone (London 07:00–09:00 UTC, NY 13:00–15:00 UTC)
- Gate 8: macro sentiment (no blackout window, F&G in range, funding rate not extreme)

**5 Long Strategies + 2 Short Mirrors + 1 Pyramiding Rule:**
- LSO (Liquidity Sweep + OI Flush) — 15m setup, requires OI data
- OB (Order Block retest) — 1H context
- FVG (Fair Value Gap fill) — start here (Phase 1), fewest dependencies
- CVD Divergence — requires approximation quality validation (Pearson ≥ 0.75) first
- VPB (Volume Profile Breakout) — 24H rolling 50-bucket profile
- SHORT-LSO / SHORT-OB / SHORT-FVG / SHORT-CVD — BEAR regime only, tighter stops (0.07× ATR)
- Strategy 7 (breakeven pyramid) — position management, not a new entry

**Backtest Engine invariants** (build once, never change mid-cycle — invalidates results):
- Fees: 0.04% round-trip maker
- Slippage: 0.05% (killzone) / 0.10% (normal) / 0.25% (crisis) per side
- Fill rate: 85% of limit orders; exact-touch (candle.low == limitPrice) = no fill
- Adverse selection: price must trade ≥ 1 tick BELOW limit to guarantee a long fill
- Funding: 0.01% per 8H holding cost

**DOL (Draw on Liquidity)** — must have a strict lookahead bias guard:
```javascript
// Only candles with openTime < signalCandle.openTime are valid
// In dev mode, assert this — one violation = silent backtest disaster
if (process.env.NODE_ENV === 'development') {
  console.assert(candidate.openTime < signal.openTime, 'DOL lookahead bias');
}
```

**Adaptive Position Sizing:**
```
risk = BASE_RISK(1%) × REGIME_MULT × STREAK_MULT × CONFIDENCE_MULT
     clamped to [0.25%, 1.5%]
```
REGIME: BULL=1.0, RANGING=0.7, BEAR_SHORT=1.0, BEAR_LONG=0.5, CRISIS=0.5
STREAK: 0-2 losses=1.0, 3=0.75, 4=0.5, 5+=0.25 (+ Telegram alert)
CONFIDENCE: standard=1.0, high-confluence=1.3, crowded-reversal=1.5, weak=0.7

**Monte Carlo** — must use `worker_threads` (one worker per CPU core). Running 1000 simulations on the main thread will crash the V8 heap on large trade sets.

### Results Files

Every backtest run saves to `results/`. The naming convention is strict:
`{strategy}_{filter_stage}.json` e.g. `fvg_baseline.json` → `fvg_regime.json` → `fvg_full_gates.json` → `fvg_sensitivity.json` → `fvg_regime_split.json`.

**Never overwrite a results file** — each one is a data point in the accept/reject decision.

### Accept/Reject Rules

Each strategy is accepted if **all** of:
- PF > 1.5 (CVD: > 1.4, forward test: > 1.3)
- Max DD < 8% isolated (< 15% combined, < 20% forward)
- All parameters pass sensitivity test: WR variation < 15pp across ±20% parameter range
- Walk-forward PF degradation < 20% across 5 rolling windows
- Monte Carlo 10th percentile > starting equity

**30-trade minimum floor** — any regime split with < 30 trades is `INSUFFICIENT_DATA`, not a reject signal.

### External Data Sources

- Binance Futures REST: `/fapi/v1/klines` (OHLCV), `/fapi/v1/premiumIndex` (funding)
- Binance bulk data: `data.binance.vision/data/futures/um/daily/openInterest/` (OI CSV)
- Binance aggTrades: `data.binance.vision/data/futures/um/daily/aggTrades/` (CVD validation)
- Fear & Greed: `api.alternative.me/fng/`
- Coinglass: liquidation heatmap, economic calendar
- Whale Alert API: large transaction monitoring

### MongoDB Schema

`strategy_performance` collection tracks rolling per-strategy stats. Auto-PAUSE when 50-trade WR < 30% or PF < 1.0. RESUME is manual-only (7-day minimum, 5 paper trades first).

### 2025 Data Is Sacred

`data/historical/*_2025_*.ndjson` (or equivalent) must never be used until Phase 8. It is the only honest forward test. Any optimization touching 2025 data invalidates the entire forward test.
