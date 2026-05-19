# BulletBrain v3.0 — Deployment Record
# Phase: feat/conviction-correlation (Shadow Trading)
# Deployed: 2026-05-19 ~20:20 UTC
# Server: ubuntu@54.249.145.15

---

## SERVER DETAILS

| Field | Value |
|-------|-------|
| IP | 54.249.145.15 |
| User | ubuntu |
| SSH Key | `C:\Users\usman\Downloads\bbv2-key.pem` |
| SSH Command | `ssh -i "C:\Users\usman\Downloads\bbv2-key.pem" ubuntu@54.249.145.15` |
| Project Path | `~/bulletbrain` |
| PM2 Process | `bulletbrain-shadow` (PID 374471 at deploy time) |
| Node Version | v22.15.0 |

---

## BRANCH & COMMIT

| Field | Value |
|-------|-------|
| Branch | `feat/conviction-correlation` |
| Remote | `origin/feat/conviction-correlation` |
| Base | `master` |
| Commit at deploy | `b0a66d1` — "docs: comprehensive phase log for conviction-correlation implementation" |

---

## WHAT WAS DEPLOYED (3 Changes)

### 1. Conviction Score Engine
- **File:** `src/live/convictionScore.js` (226 lines, NEW)
- **Replaces:** Old multiplier chain `OB × 4H trend × CVD tier`
- **With:** Weighted sum of 6 sub-scores → unified 0-1 score
- **Weights:** CVD z-score(0.30) + VP(0.25) + 4H trend(0.20) + OB(0.10) + Killzone(0.05) + RVOL(0.10)
- **Sizing:** <0.35→SKIP, 0.35-0.50→0.5x, 0.50-0.65→0.8x, 0.65-0.80→1.0x, >0.80→1.2x

### 2. Structural Correlation Fix
- **File:** `src/live/shadowRunner.js` (modified, +135 lines)
- **Fix:** Shared `globalOrderBook` prevents SNIPER/SCALPER from entering same price
- **Priority:** SNIPER leads in BULL/BEAR, SCALPER leads in RANGING/ZOMBIE
- **Precision:** 0.05% price buckets

### 3. Soft Circuit Breaker (Logging Only)
- **File:** `src/live/circuitBreaker.js` (217 lines, NEW)
- **3 Tiers:** All LOG ONLY, no trade intervention
- **Tier 1:** 10-trade WR < 25% OR 4 consecutive losses
- **Tier 2:** 20-trade WR < 20% OR 6 consecutive losses OR 4% daily loss
- **Tier 3:** 30-trade PF < 0.70 OR 12% DD OR 6% daily loss
- **Log:** `logs/circuit_breaker.log`

### Supporting Change
- **File:** `src/backtest/lso_runner.js` (+13 lines)
- **Change:** Stores intermediate gate results (`_cvdZscore`, `_vpResult`, `_trend4hState`, `_insideOB`) for conviction score computation. No logic changed.

---

## CONFIGURATION (per account)

| Parameter | SNIPER (LETHAL D12) | SCALPER (REFINED D13) |
|-----------|---------------------|-----------------------|
| CVD Gate | CVD_ZSCORE | CVD_ZSCORE |
| Gate VP | Yes (POC + VAL) | Yes (POC + VAL) |
| 4H Trend | Yes (HH/HL) | Yes (HH/HL) |
| OB Confluence | Yes (1.3× in old chain) | Yes |
| Time-Exhaustion | Disabled | 16 candles in RANGING |
| RVOL Tier 2 | 3.0× | 2.2× in RANGING |
| TP2 Target | DOL (structural) | VAH/VAL in RANGING |

> Note: Conviction Score replaces the old `getSizeMultiplier` chain. Old multiplier is still logged for A/B comparison.

---

## HOW TO MONITOR

### Live logs
```bash
ssh -i "C:\Users\usman\Downloads\bbv2-key.pem" ubuntu@54.249.145.15
pm2 logs bulletbrain-shadow
```

### Umpire Report (every 6 hours / 24 candles)
```bash
cat ~/bulletbrain/logs/umpire.log
```

Expected format:
```
════ ════ REGIME UMPIRE @ 2026-05-19T... ════ ═════
  Regime: BULL | Candles: 524
  SNIPER     Cap=$10234 | Trades=3 | WR=66.7% | PF=2.150 | DD=0.45% | avgCS=0.720
  SCALPER    Cap=$10112 | Trades=4 | WR=50.0% | PF=1.340 | DD=0.62% | avgCS=0.650
  CS_COMPARE SNIPER_avgCS=0.720 (0 skips) | SCALPER_avgCS=0.650 (1 skips)
  LEADER: SNIPER (trend-focused)
```

### Circuit Breaker Events
```bash
cat ~/bulletbrain/logs/circuit_breaker.log
```

### PM2 Status
```bash
pm2 status
pm2 logs bulletbrain-shadow --lines 10 --nostream
```

---

## WHAT TO EXPECT

### First 6 hours (warmup period):
- Bot backfills 500 candles, connects WebSocket, waits for live candles
- Each candle close: logs regime, close price, account capital
- With `BB_DEBUG=1`: logs pool distances, missed setups with reasons
- No trades expected initially — needs sweeps to fire

### First 24 hours:
- First umpire report appears after candle 524 (24 candles after warmup)
- `avgCS` will show "N/A" until first trades close
- May see `order_book_conflict` in debug logs if both accounts target same price

### First week:
- Expect 3-8 trades per account (normal for 15m BTC)
- avgCS should stabilize around 0.55-0.75
- Circuit breaker T1 may fire on normal losing streaks
- Circuit breaker T3 should NEVER fire

---

## HOW TO RESTART / UPDATE

### Restart without changes:
```bash
pm2 restart bulletbrain-shadow
```

### Pull latest and restart:
```bash
cd ~/bulletbrain
git pull origin feat/conviction-correlation
pm2 restart bulletbrain-shadow
pm2 save
```

### Full redeploy from scratch:
```bash
cd ~/bulletbrain
pm2 delete bulletbrain-shadow
git fetch origin
git checkout feat/conviction-correlation
git pull origin feat/conviction-correlation
BB_DEBUG=1 pm2 start src/live/shadowRunner.js --name bulletbrain-shadow
pm2 save
```

### Switch back to master:
```bash
pm2 delete bulletbrain-shadow
git checkout master
pm2 start src/live/shadowRunner.js --name bulletbrain-shadow
pm2 save
```

---

## LOG FILES

| File | Description | Rotation |
|------|-------------|----------|
| `logs/umpire.log` | 6-hour regime umpire reports with CS comparison | Append-only |
| `logs/circuit_breaker.log` | Circuit breaker events (all tiers, logging only) | Append-only |
| `logs/bulletbrain-*.log` | General application logs (old format) | Daily |
| `~/.pm2/logs/bulletbrain-shadow-out.log` | PM2 stdout | PM2 managed |
| `~/.pm2/logs/bulletbrain-shadow-err.log` | PM2 stderr | PM2 managed |

---

## BACKTEST REFERENCE (2021-2024, Gate VP + 4H Trend)

| Metric | Phase D9 Canonical | This Branch | Status |
|--------|-------------------|-------------|--------|
| Trades | 127 | 128 | ✓ |
| Win Rate | ~56% | 51.6% | ✓ |
| Profit Factor | 3.079 | 2.755 | ✓ Above 1.5 |
| Max Drawdown | 1.65% | 1.22% | ✓ Improved |

---

## 7-DAY REVIEW CHECKLIST (Due: 2026-05-26)

```
[ ] Circuit breaker Tier 3 fired 0 times
[ ] avgCS per account is stable (0.50-0.80 range)
[ ] Order book conflicts correctly resolved by regime priority
[ ] No unhandled exceptions or crashes
[ ] PM2 uptime is continuous (no restarts needed)
[ ] First trades executed with conviction score sizing
[ ] CS vs old multiplier comparison shows CS producing better sizing
```

---

## 14-DAY ACTIVATION CHECKLIST (Due: 2026-06-02)

```
[ ] Review 14 days of circuit_breaker.log
[ ] If Tier 3 never fired → thresholds correctly calibrated
[ ] If Tier 1 fires rarely (1-2x/week) → normal variance
[ ] If Tier 1 fires daily → tighten thresholds
[ ] Decision: activate Tier 1+2 auto-sizing? [YES/NO]
[ ] Decision: keep Tier 3 as alert-only? [YES/NO]
[ ] Decision: switch backtest runner to conviction score? [YES/NO]
```

---

## GIT REFERENCE

```
Remote:  https://github.com/Usman-2302/bb-v2
Branch:  feat/conviction-correlation
Commits:
  b0a66d1 docs: comprehensive phase log for conviction-correlation implementation
  58c8760 feat: conviction score + correlation fix + circuit breaker (logging-only)
```

---

*Deployment Record — 2026-05-19 — Bot is LIVE with conviction score, order book fix, and circuit breaker.*
