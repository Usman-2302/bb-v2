# Repository Guidelines

## Project Overview

**BulletBrain v3.0** — Node.js crypto futures trading bot using Smart Money Concepts (SMC). Currently **live paper trading** on 4 coins (ETH, BNB, BTC, SOL) via PM2 on AWS EC2. Branch: `feat/conviction-correlation`.

## Directory Structure

```
bbv-2/
├── src/
│   ├── indicators/        # pure functions: ema.js, atr.js, rvol.js, cvd.js, volumeProfile.js
│   ├── strategies/        # lso.js, shortLso.js, fvg.js, ob.js
│   ├── backtest/          # engine.js, runner.js, lso_runner.js + analysis scripts
│   ├── live/              # shadowRunner.js, convictionScore.js, signalScorer.js, riskLevel.js, circuitBreaker.js
│   ├── data/              # downloader.js, loader.js
│   └── utils/             # regimeDetector.js, dolFinder.js
├── data/historical/       # NDJSON per coin per timeframe
├── config.js              # ALL parameters — never hardcode in strategy files
└── package.json
```

## Key Commands

```bash
# Run shadow trading bot (single coin via BB_SYMBOL env)
BB_SYMBOL=ethusdt node src/live/shadowRunner.js

# Backtest LSO strategy
node src/backtest/runner.js lso

# PM2 management (on server)
pm2 start src/live/shadowRunner.js --name bulletbrain-eth
pm2 logs bulletbrain-eth --lines 50
pm2 restart all
```

## Architecture

### Shadow Runner (`src/live/shadowRunner.js`)

Live paper trading engine. Connects to Binance WebSocket + REST polling fallback. One instance per coin via `BB_SYMBOL` env var. Runs 3 accounts per coin:

| Account | Gate | Sizing | Behavior |
|---------|------|--------|----------|
| SNIPER | CVD_ZSCORE | Dynamic risk | Trend-focused, almost never trades |
| SCALPER | CVD (plain) | Dynamic risk | Higher frequency, range-focused |
| SMART | CVD (plain) | Dynamic risk + signal scoring | Same as SCALPER + quality scoring |

### Signal Pipeline

1. Detect equal-lows pools (rolling 1000-candle window, 200-candle expiry)
2. Sweep detection: candle wicks below pool, closes above (reclaim)
3. Gate7: CVD ghost sweep filter (blocks sweeps with no spot buying)
4. RVOL filter (≥ 0.8 threshold)
5. DOL finder for structural targets
6. Dynamic risk level (1-4%) based on signal quality + coin health + volume
7. Portfolio risk check (max 3 concurrent per coin)

### Dynamic Risk Engine (`src/live/riskLevel.js`)

Risk level 1-4% determined by:
- Signal quality (50% weight): from signalScorer (0-6 score)
- Coin health (30%): rolling 30-trade PF
- Volume health (20%): current RVOL vs baseline

## Configuration

All parameters in `config.js`. Key values:

```javascript
sweepRvolMin: 0.8          // minimum RVOL on sweep candle
equalLookback: 200          // pool expiry in candles (48 hours)
equalTolerance: 0.003       // 0.3% tolerance for equal levels

// GATES block
gate7_range_multiplier: 0.5 // 50% z-score reduction in RANGING
gate7_range_zscore_floor: 1.0

// LEVERAGE block — signal scoring thresholds
rvolHigh: 2.0, rvolMid: 1.5
poolDeep: 2.0, poolStandard: 1.0
scoreMap: { 2:0.5, 3:0.75, 4:1.0, 5:1.5, 6:2.0 }
```

## Backtest Guidelines

- All backtests MUST use rolling-window pool detection (1000 candle lookback). Pre-computed full-dataset pools introduce lookahead bias and inflate trade counts 100x.
- `src/backtest/coin_comparison.js` — multi-coin diagnostic
- `src/backtest/multicoin_diag.js` — per-regime breakdown
- `src/backtest/pool_compare.js` — pool lookahead vs rolling comparison
- Data stored as NDJSON in `data/historical/`. Download with `src/data/downloader.js` or Binance REST `/fapi/v1/klines`.

## Live Deployment

Server: `ubuntu@54.249.145.15` (SSH key: `bbv2-key.pem`). PM2 manages 4 instances:

```bash
bulletbrain-eth   # BB_SYMBOL=ethusdt (primary profit driver)
bulletbrain-bnb   # BB_SYMBOL=bnbusdt
bulletbrain-btc   # BB_SYMBOL=btcusdt
bulletbrain-sol   # BB_SYMBOL=solusdt
```

Umpire reports every 24 candles (6 hours) with per-coin health scores (🟢 STRONG / 🟡 OK / 🔴 WEAK). `BB_DEBUG=1` in `.env` enables sweep diagnostics.

## Known Findings

- **ETH** is the best performer (60% WR, PF 2.15 in 3-month backtest). Deep sweeps, strong reclaims.
- **BTC** sweeps are 70% ghosts — institutional efficiency makes SMC unreliable on BTC.
- **BNB** has the highest WR (64%) and lowest ghost rate (39%).
- **SOL** has deepest sweeps (0.21%) but highest ghost rate (50%).
- **Pool lookahead bias** was the #1 backtest vs live discrepancy (fixed with rolling windows).
