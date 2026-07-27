# Repository Guidelines

## Project Overview

**BulletBrain v3.0** — a Node.js crypto futures trading system built on Smart Money Concepts (SMC), targeting Binance USDT-M perpetual futures. It has two halves:

1. **Backtesting engine** — an event-driven engine with adverse-selection fill modeling, regime detection, and a phase-gated research workflow (phases D0–D14) that evaluated several strategies (FVG, OB, LSO) against 2021–2024 historical data.
2. **Live trading** — two Node processes that consume Binance 15m klines:
   - `src/live/liveRunner.js` — **real-money** bot (places actual orders via signed REST calls). Currently the actively developed component (see git history, July 2026). Trades ETHUSDT by default with ~$90 capital, 20x isolated margin.
   - `src/live/shadowRunner.js` — **paper-trading** engine used to validate strategy variants without risking funds.

**Current branch:** `feat/conviction-correlation` (remote: `github.com/Usman-2302/bb-v2`). **Status:** live real-money trading on ETH; LSO (Liquidity Sweep + OI Flush) is the lead strategy family. FVG and OB were rejected as standalone strategies in backtests and are kept as `CONFLUENCE_ONLY`.

Two planning documents describe the research methodology (strategy specs, accept/reject rules, execution phases):
- `backtestplan.md` — strategy and engine specification
- `masterplan.md` — execution phases D0–D14 with done criteria

The root also contains many dated phase logs (`phase_d*_log.md`, `shadow_runner_master_log.md`, `deployment_conviction_correlation.md`). These are historical records. `CLAUDE.md` is an older snapshot (May 2026) — when it conflicts with the code or recent git history, trust the code.

## Tech Stack

- **Runtime:** Node.js ≥ 18 (engines field; server runs v22.15.0). Plain CommonJS, `'use strict'` per file. No TypeScript, no build step, no bundler, no linter config, no CI.
- **Dependencies (all runtime):** `axios` (REST), `ws` (WebSocket), `ndjson`, `adm-zip` (Binance Vision archives), `dotenv`.
- **Dev:** `jest@29` only.
- **Data:** NDJSON files (one candle per line) under `data/`, not a database.
- **Deployment:** PM2 on a single AWS EC2 instance (see below).

## Repository Layout

```
bbv-2/
├── config.js               # ALL backtest/shadow parameters — single source of truth
├── ecosystem.config.js     # PM2 process definitions (bb-live-eth, bulletbrain-shadow)
├── src/
│   ├── indicators/         # Pure functions: ema, atr, rvol, cvd, swingHL, volumeProfile, efficiencyRatio
│   ├── strategies/         # lso.js (lead), shortLso.js, fvg.js, ob.js (rejected → confluence only)
│   ├── backtest/
│   │   ├── engine.js       # Fill model + equity tracking. LOCKED — never change (see Rules)
│   │   ├── runner.js       # Unified strategy-agnostic backtest loop (descriptor callbacks)
│   │   ├── lso_runner.js   # LSO adapter used by both backtests and shadowRunner
│   │   ├── tradeManager.js, reporter.js
│   │   └── run_*.js        # One-off backtest/stress/forward entry points (wired to npm scripts)
│   ├── live/
│   │   ├── liveRunner.js   # REAL-MONEY bot — MARKET entry + STOP_MARKET SL + LIMIT reduceOnly TP
│   │   ├── shadowRunner.js # Paper-trading engine (umpire reports every 24 candles)
│   │   ├── convictionScore.js  # Weighted 0–1 signal-quality score → size multiplier
│   │   ├── signalScorer.js     # 0–6 score (RVOL / pool depth / regime alignment) for SMART sizing
│   │   ├── riskLevel.js        # 1–4% dynamic risk engine (signal + coin health + volume)
│   │   └── circuitBreaker.js   # 3-tier drawdown guard, currently LOG-ONLY (no intervention)
│   ├── data/               # downloader.js, fundingDownloader.js, loader.js (streaming NDJSON)
│   └── utils/              # regimeDetector.js, dolFinder.js, macroTagger.js, logger.js
├── data/historical/        # {SYMBOL}_{tf}.ndjson + *_tagged.ndjson (with .regime/.blackout fields)
├── results/                # 85+ versioned JSON backtest outputs (gitignored)
├── tests/                  # 4 Jest suites (*.test.js) + standalone node runners + debug scripts
└── logs/                   # Runtime + umpire + circuit_breaker logs (gitignored)
```

Note: `package.json` declares `"main": "src/index.js"` but that file does not exist — there is no library entry point; everything is run via scripts.

## Key Commands

```bash
# Tests
npm test                          # Jest (jest --runInBand), suites under tests/*.test.js
node tests/run_engine_tests.js    # Standalone runners — see "Testing" below for the full list

# Backtests (2021–2024 NDJSON data must exist under data/historical/)
npm run backtest:lso              # LSO — lead strategy
npm run backtest:shortlso
npm run backtest:lso:slippage     # slippage stress test
npm run backtest:fvg / backtest:ob
npm run backtest:stress
npm run backtest:forward          # 2025 forward test (run_forward_2025.js)

# Live / shadow (env-var driven)
BB_SYMBOL=ethusdt node src/live/shadowRunner.js          # paper trading
BB_SYMBOL=ethusdt BB_LIVE=true BB_CAPITAL=90 node src/live/liveRunner.js  # REAL ORDERS

# Server process management (on the EC2 box)
pm2 start ecosystem.config.js
pm2 logs bb-live-eth --lines 50
```

Environment variables (see `.env.example`): `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, optional `COINGLASS_API_KEY`, `BB_DEBUG=1` enables verbose sweep diagnostics, `BB_SYMBOL` selects the coin, `BB_LIVE=true` arms real order placement in `liveRunner.js` (without it the bot is paper-only).

## Testing

Two parallel test systems exist; run both after touching engine/strategy code:

- **Jest** (`npm test`): `config.test.js`, `indicators.test.js`, `logger.test.js`, `data.test.js`.
- **Standalone runners** (plain node scripts, not integrated into Jest):
  `run_engine_tests.js` (48), `run_regime_tests.js` (21), `run_macro_tests.js` (21),
  `run_lso_tests.js` (43), `run_ob_tests.js` (24), `run_fvg_tests.js` (26),
  `run_data_tests.js` (20), `adversarial_indicators.js`, `validate_regime_realdata.js`.

**Verified state (2026-07-27):** Jest reports 72/72 tests passing across 3 suites — but `tests/data.test.js` **fails to load** (`jest.mock()` factory references out-of-scope variable `path`). Standalone runners: engine, regime, macro, lso, ob, data all fully pass; `run_fvg_tests.js` is 24/26 (2 entry-level assertions fail — pre-existing). `tests/debug_*.js`, `trace_*.js`, `slope_distribution.js` are ad-hoc diagnostics, not tests.

## Architecture Notes

### Backtest pipeline
1. `loader.js` streams tagged NDJSON candles (each candle carries `.regime` precomputed by `utils/run_regime_tagging.js`).
2. A strategy descriptor (zones/pools lifecycle, gates, regime filter) plugs into the unified `runner.js` loop.
3. `engine.js` simulates fills with penetration-depth and ATR-relative thresholds (CLEAN < 5% ATR, TOXIC ≥ 40% ATR), per-symbol slippage from `config.js`, and portfolio-risk caps.
4. `reporter.js` writes versioned JSON into `results/`.

### Regime model (6 regimes)
`BULL / BEAR / RANGING / RANGING_PREZONE / RANGING_ZOMBIE / CRISIS`, driven by ATR-normalized EMA200 slope (`slopeThreshold: 0.011`, locked), Efficiency-Ratio zombie detection with hysteresis, and an ATR% > 5 crisis override. Regime gates sizing multipliers and strategy eligibility.

### liveRunner.js (real money — read before touching)
- Self-contained file: its own regime detector (EMA200 slope + price side), pool detector, and **hardcoded parameters at the top** (`SWEEP_RVOL_MIN`, `STOP_ATR_MULT`, `TP_R_MULT`, `RISK_PCT`) — a deliberate exception to the config.js rule. Do not "fix" this by rewiring it to config.js without understanding the grid-searched values.
- Pipeline per 15m candle close: regime (skip RANGING) → RVOL ≥ 0.3 → pool sweep (wick through equal highs/lows, close back) → CVD direction confirms (ghost filter) → MARKET entry + STOP_MARKET SL + LIMIT reduceOnly TP, 20x isolated margin.
- Warmup: backfills 1500 candles, runs a diagnostic scan (`isScanning` flag prevents ordering during warmup), trims to 500 candles, then live. WS (`fstream.binance.com`) primary + 30s REST polling fallback.
- Order-result quirks already handled: BigInt `orderId` precision (`transformResponse` reviver), quantity/stepSize rounding from `exchangeInfo`, hedge vs one-way position mode.

### shadowRunner.js (paper)
Same LSO lineage as the backtest (`lso_runner.js` adapter). Adds conviction scoring, signal scoring, dynamic risk level, circuit breaker (log-only), a shared order book to prevent account cannibalization, and a regime "Umpire" report every 24 candles appended to `logs/umpire.log`. **Caveat:** the working tree currently creates only the SCALPER account, but umpire/logging code still references `accounts.SNIPER` — check and reconcile before running it locally; the deployed server version may differ.

## Configuration Conventions

- **`config.js` is the single source of truth** for all backtest/shadow parameters (17 blocks: DATA, EXECUTION_PARAMS, COSTS, REGIME, SIZING, LEVERAGE, FVG, OB, LSO, VPB, DOL, RVOL, SESSIONS, TRADE, MACRO, GATES, ENGINE, MONITORING, SYMBOL_STRATEGY_POLICY). Never hardcode strategy parameters in `src/backtest` or `src/strategies` files. (`liveRunner.js` is the one documented exception.)
- Changing a parameter in `config.js` invalidates prior backtest results — re-run the full cycle.
- All indicators are **pure functions**: `(inputs) → values[]`, no side effects, no I/O.
- `SYMBOL_STRATEGY_POLICY` routes per-symbol strategy roles: `LEAD_STRATEGY`, `CONFLUENCE_ONLY`, `DISABLED`, `PENDING`.

## Hard Rules (from masterplan.md — still enforced)

1. **Never change `src/backtest/engine.js`.** The ATR-relative fill thresholds and killzone size multiplier are locked since Phase D6; any change invalidates all prior results.
2. **Never overwrite a results file.** Use a new versioned filename when re-running.
3. **30-trade minimum floor:** any regime split with < 30 trades is `INSUFFICIENT_DATA`.
4. **Backtests must use rolling-window pool detection** (live-style, ~1000-candle lookback). Pre-computing pools over the full dataset introduces lookahead bias and inflates trade counts ~100x — this was the #1 backtest-vs-live discrepancy.
5. Time-based breakeven gates were tested and reverted twice (D7, D8) — do not reintroduce.

## Code Style

- CommonJS modules, `'use strict'` header, 2-space indent, ASCII box-drawing section banners (`// ────...`).
- Heavy JSDoc-style header comments on each file stating phase, spec source (line refs into `backtestplan.md`), and design rationale — keep these updated when behavior changes.
- No formatter/linter is configured; match the surrounding style of the file you edit.

## Deployment

- Server: `ubuntu@54.249.145.15` (AWS EC2, Tokyo), project at `~/bulletbrain`, SSH key `bbv2-key.pem` (repo root, gitignored).
- PM2 apps (`ecosystem.config.js`): `bb-live-eth` (`liveRunner.js`, `BB_LIVE=true`, `BB_CAPITAL=90` — real money) and `bulletbrain-shadow` (`shadowRunner.js`, paper).
- Typical update: `git pull origin feat/conviction-correlation && pm2 restart all && pm2 save`.
- Logs: `logs/umpire.log` (6h health reports), `logs/circuit_breaker.log`, PM2 logs under `~/.pm2/logs/`.
- `setup_vps.sh` provisions a fresh Ubuntu box (Node 20.x, PM2, deps).

## Security Considerations

- `.env` (gitignored) holds Binance API keys. Keys are used for WebSocket auth and, in `liveRunner.js`, **signed order placement with real funds at 20x leverage** — treat any change to order/risk logic in that file as money-critical.
- `bbv2-key.pem` is a live SSH private key sitting in the repo root (gitignored, but present on disk) — do not exfiltrate, print, or commit it.
- `data/`, `results/`, `logs/` are gitignored; historical data is re-downloadable via `src/data/downloader.js`.
- The circuit breaker (`src/live/circuitBreaker.js`) is currently **logging-only** — there is no automated kill switch in live trading; daily-loss limits exist in config but the live path relies on exchange-side SL/TP orders.

## Known Issues / Gotchas

- `tests/data.test.js` Jest suite fails to load (see Testing).
- `shadowRunner.js` single-account refactor left stale `accounts.SNIPER` references (see above).
- `src/live/liveRunner.js.bak`, root-level debug scripts (`check_now.js`, `check_candle_time.js`, `fix_both.js`, `test_live_*.js`), and the stray `:USERPROFILE/.deepcode` directory are ad-hoc artifacts — verify before reusing or deleting.
- Full-history OI (open interest) data is unavailable from Binance (30-day API limit); LSO backtests use the `CVD_ZSCORE` synthetic gate as the OI-flush proxy (`LSO.oiDataFallback`).
