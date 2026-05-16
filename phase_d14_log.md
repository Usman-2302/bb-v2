# BulletBrain v3.0 — Phase D14 Log
# Shadow Trading Engine (Dual-Runner)
# Status: BUILT — Ready for Live Deployment
# Date: 2026-05-14

---

## PHASE OVERVIEW

- **Goal:** Run LETHAL (D12) and REFINED (D13) configs simultaneously against live Binance data
- **Status:** Complete — shadow runner built, tested, ready to deploy
- **Architecture:** Shared candle buffer, dual account state, regime umpire

---

## WHAT WAS BUILT

### `src/live/shadowRunner.js` — Shadow Trading Engine

**Architecture:**

```
Binance WebSocket (BTCUSDT 15m)
        │
        ▼
┌───────────────────┐
│  Candle Buffer     │  ← Rolling 5000-candle buffer
│  Indicator Engine  │  ← ATR, RVOL, CVD, EMA200, Volume Profile
│  Regime Detector   │  ← Streaming EMA200-based regime
└───────┬───────────┘
        │
   ┌────┴────┐
   ▼         ▼
┌──────┐ ┌──────┐
│SNIPER│ │SCALPER│  ← Two independent virtual accounts
│Account│ │Account│
└──┬───┘ └──┬───┘
   │        │
   ▼        ▼
┌───────────────────┐
│  Regime Umpire     │  ← Compares every 24 candles (6 hours)
│  logs/umpire.log   │
└───────────────────┘
```

### Account Configurations

| Parameter | SNIPER (D12 LETHAL) | SCALPER (D13 REFINED) |
|-----------|---------------------|-----------------------|
| CVD Gate | CVD_ZSCORE | CVD_ZSCORE |
| Gate VP | Yes (POC + VAL) | Yes (POC + VAL) |
| 4H Trend | Yes (HH/HL) | Yes (HH/HL) |
| TP2 Target | DOL (structural) | VAH/VAL in RANGING |
| Time-Exhaustion | Disabled | 16 candles in RANGING |
| RVOL Tier 2 | 3.0× | 2.2× in RANGING |

### Key Features

1. **WebSocket Connection** — `wss://fstream.binance.com/ws/btcusdt@kline_15m`
2. **Auto-Reconnect** — 10-second retry on disconnect
3. **Backfill Warmup** — downloads 500 recent candles for indicator initialization
4. **Streaming Indicators** — recomputed each candle (rolling window)
5. **Streaming Regime Detection** — EMA200-based, same as backtest
6. **Independent Trade Management** — each account has separate equity, positions, trade log
7. **Regime Umpire** — reports every 24 candles: capital, trades, WR, PF, AvgRR, DD, leader

### Verification

```
✓ Syntax check:     PASS (node --check)
✓ Module load:      PASS (no auto-execute on require)
✓ Binance API:      PASS (5 candles, BTC=$81,763)
✓ ATR indicator:    PASS (last=351.47)
✓ Strategy creation: PASS (LSO descriptor)
```

---

## HOW TO RUN

```bash
node src/live/shadowRunner.js
```

**Expected output:**
```
═══════════════════════════════════════════════════════
BulletBrain v3.0 — Phase D14: Shadow Trading Engine
═══════════════════════════════════════════════════════

Account A (SNIPER):  LETHAL D12 — Trend-focused
Account B (SCALPER): REFINED D13 — Range-focused

Regime Umpire reports every 24 candles (6 hours).
Log: logs/umpire.log

Backfilling warmup candles...
  Backfilled 500 candles
  Range: 2026-05-09T... → 2026-05-14T...
  Warmup ready. 500 candles loaded.

Both accounts initialized. Waiting for live candles...

Connecting to wss://fstream.binance.com/ws/btcusdt@kline_15m...
WebSocket connected. Waiting for candle data...

[2026-05-14T18:30:00.000Z] BULL     Close=$81800 | SNIPER: $10000 (0 open) | SCALPER: $10000 (0 open)
...
```

**Every 24 candles (6 hours):**
```
════ ════ REGIME UMPIRE @ 2026-05-14T... ════ ═════
  Regime: BULL | Candles: 524
  SNIPER     Cap=$10234 | Trades=3 | WR=66.7% | PF=2.150 | AvgRR=$78.00 | DD=0.45%
  SCALPER    Cap=$10112 | Trades=4 | WR=50.0% | PF=1.340 | AvgRR=$28.00 | DD=0.62%
  LEADER: SNIPER (trend-focused)
═══════════════════════════════════════════════════════
```

---

## 48-HOUR VALIDATION CHECKLIST

After 48 hours of live data, check `logs/umpire.log` for:

| Metric | Expected | How to Read |
|--------|----------|-------------|
| Total trades per account | 5-20 each | More trades = more active in current regime |
| Win Rate comparison | SNIPER > SCALPER in trends, SCALPER > SNIPER in ranges | Which account captures current market? |
| PF comparison | Higher PF = better risk/reward | The "weighting" signal for production |
| Avg RR comparison | Higher = better profit capture | SNIPER should have higher RR in breakouts |
| Regime leader | Depends on market | Production bot should weight toward leader |

### Decision Rule for Production

```
If SNIPER leads in BULL/BEAR AND SCALPER leads in RANGING:
  → Hybrid mode: use SNIPER config in trends, SCALPER in ranges

If SNIPER leads in ALL regimes:
  → Lock SNIPER (LETHAL D12) as production config

If SCALPER leads in ALL regimes:
  → Lock SCALPER (REFINED D13) as production config
```

---

## FILES CREATED

| File | Description |
|------|-------------|
| `src/live/shadowRunner.js` | Shadow trading engine (491 lines) |
| `logs/umpire.log` | Regime umpire output (created on first run) |

---

## KNOWN LIMITATIONS

1. **No Order Book simulation** — fill simulation uses historical model, not real-time spread
2. **Network dependency** — requires stable Binance WebSocket connection
3. **Single symbol** — BTCUSDT 15m only
4. **No real orders** — all trades are virtual (shadow mode)
5. **RIO (require in object) for `checkLSORangingTimeExhaustion`** — passed as function reference. If the module is reloaded, stale reference

---

*Phase D14 Log — 2026-05-14 — Shadow runner built and verified. Ready for 48-hour live test.*
