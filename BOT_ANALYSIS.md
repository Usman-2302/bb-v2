# BulletBrain v3.0 — Live Runner Analysis

## Current Configuration (as of Jul 18, 2026)

| Setting | Value |
|---------|-------|
| Coin | ETHUSDT |
| Capital | $90 |
| Risk per trade | 2% ($1.80) |
| RVOL minimum | 0.6 |
| Stop | 0.5 ATR |
| Target | 2R |
| Regime filter | Skip RANGING |
| CVD gate | Direction confirmation |
| Pool expiry | 500 candles (~5 days) |
| Swing window | 80 candles |
| Backfill | 1500 candles |
| Mode | 🔴 LIVE (paper during scan) |

## Decision Pipeline

```
Candle arrives
  → 1. REGIME: BULL/BEAR? (skip RANGING)
  → 2. RVOL ≥ 0.6?
  → 3. POOL SWEEP: candle wicks through equal-lows/highs pool?
  → 4. CVD: delta direction confirms sweep?
  → 5. STOP VALID: entry-stop distance > 0?
  → ENTRY: Place limit order + SL/TP
```

## Backtest Results

### 6-Month (Jan-Jun) — Full Data
- 73 trades in 15 days (Jul 1-15)
- 64% WR, $90 → $336 (+$246)
- 4.9 trades/day average

### 15-Day Diagnostic Scan (Jul 2-18) — 1500 candles
- 115 trades found in warmup
- 60% WR, $90 → $512 simulated

### Last 8 Hours (Jul 18 00:00-08:00)
- 0 trades — weekend RANGING, RVOL < 0.6 on all candles

## Live Trading Log

| Date | Period | Trades | Regime | Notes |
|------|--------|--------|--------|-------|
| Jul 15 | 18:00-23:59 | 0 | BEAR→RANGING | API key format error (fixed) |
| Jul 16 | Full day | 0 | BULL→RANGING | Dead market, 0 sweeps |
| Jul 17 | Full day | 0 | BEAR→RANGING | Pool expiry fix (200→500) |
| Jul 18 | 00:00-08:00 | 0 | RANGING | Weekend, zero volume |

## Known Bugs Fixed
1. **API key not loaded** — dotenv not called → `API-key format invalid`
2. **Warmup scan ordering real trades** — added `isScanning` flag
3. **Stale pools** — expiry 200→500, swing window 50→80
4. **RVOL baseline mismatch** — backfill 1000→1500 candles

## Backtest vs Live Verification
- `src/backtest/verify_live.js` — exact replica of live bot logic
- Both use same: data source, indicators, pool detection, filters
- Difference: backfill size (1500 in both now), real-time data adjustments
