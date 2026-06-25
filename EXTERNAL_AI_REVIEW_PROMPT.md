You are reviewing a crypto futures trading bot called BulletBrain v3.0. Below is the complete system architecture, strategy, backtest data, and live performance. After reading everything, provide:

1. A mirror: what are we doing wrong that we can't see?
2. A new strategy recommendation that can actually profit in current market conditions
3. Concrete implementation steps

---

## SYSTEM OVERVIEW

**Tech stack:** Node.js, Binance Futures API, PM2 process manager
**Timeframe:** 15-minute candles
**Capital:** Paper trading $10K per account, 3 accounts per coin
**Coins:** BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT
**Infrastructure:** 3 PM2 instances running 24/7 on AWS EC2 (ubuntu@54.249.145.15)
**Runtime:** ~30 days, 0 crashes

---

## THE STRATEGY (LSO — Liquidity Sweep + Order Block)

**Concept:** Smart Money Concepts (SMC). Find equal-lows liquidity pools. When price wicks below a pool (sweeping stop-losses) and closes back above (reclaim), enter LONG at the pool level. Stop at sweep low. Target at Draw-on-Liquidity (DOL) level above.

**Signal chain:**
1. Detect equal-lows pools (2 swing lows within 0.5% of each other, 2-50 candles apart)
2. Wait for bullish sweep: candle low < pool level AND candle close > pool level
3. Gate7: CVD (Cumulative Volume Delta) confirmation — CVD delta must increase on sweep candle (not a ghost sweep)
4. DOL Finder: Find nearest structural liquidity target above
5. Limit order fill simulation (85% fill rate, 0.04% fee, 0.05% slippage)
6. Position sizing: 1% risk per trade, conviction-adjusted (0.5x-2x)

**3 account types:**
- SNIPER: Strict CVD_ZSCORE gate (z ≥ 2.5). Almost never trades.
- SCALPER: CVD plain gate (just direction check). Trades more.
- SMART: Signal-strength scoring (RVOL + Pool Depth + Regime alignment → 0.5x-2x risk)

---

## 3-MONTH BACKTEST RESULTS (Mar 24 - Jun 22, 2026, 8,640 candles)

| Coin | Trades | WR | PF | PnL |
|------|--------|-----|-----|-----|
| ETHUSDT | 87 | 59.8% | 2.149 | +$3,520 |
| BNBUSDT | 27 | 44.4% | 1.602 | +$962 |
| SOLUSDT | 14 | 57.1% | 1.140 | +$110 |
| BTCUSDT | 109 | 26.6% | 0.491 | -$4,577 |

**Regime breakdown (ETH, CVD gate):**
- BULL: +$3,517 (89 trades)
- RANGING: +$4,732 (92 trades)
- BEAR: +$4,258 (86 trades)

**Regime breakdown (BTC, CVD gate):**
- BULL: -$442
- RANGING: -$5,138
- BEAR: +$648

**BTC sweep diagnostics:**
- 856 sweeps detected
- 604 blocked by CVD ghost detection (70.5% fake sweeps)
- Only 109 trades, 26.6% WR

---

## LIVE PERFORMANCE (Jun 10-25, ~15 days)

| Coin | Total Trades | Wins | Losses | PnL |
|------|-------------|------|--------|-----|
| BTCUSDT | 3 | 1 | 2 | +$610 |
| ETHUSDT | 2 | 0 | 2 | -$170 |
| BNBUSDT | 0 | 0 | 0 | $0 |
| SOLUSDT | 0 | 0 | 0 | $0 |

Only 5 trades across 4 coins in 15 days. Backtest predicted 237 trades in 90 days (~79/month). Live is 10x below prediction.

**Root cause of missing trades:**
- Live sweep detection finds far fewer sweeps than backtest
- Most sweeps have RVOL (Relative Volume) below 0.8 threshold
- 70% of BTC sweeps, 61% of ETH sweeps are ghost sweeps (no CVD confirmation)
- Pools are often 1-2% away from price, so sweeps don't reach them
- Binance volume at October 2020 lows — market is dead

**Why the trades that DID happen lost:**
- Trade 1 (SCALPER BTC Jun 17): Entered at $65,607, stopped out by wick, price reversed up after. Classic stop-hunt.
- Trade 2 (SCALPER BTC Jun 17): Entered while first trade was still losing. Doubled into loser.
- Trade 3 (SNIPER BTC Jun 17): Entered at local top, BTC dropped $600 in 45 min.
- Trades 4-5 (ETH Jun 22-23): Both small losses. Stop-hunted in RANGING.

---

## PARAMETERS CURRENTLY IN USE

```
sweepRvolMin: 0.8        // minimum relative volume on sweep candle
equalLookback: 50        // max candles between equal lows
equalTolerance: 0.005    // 0.5% tolerance for equal lows
equalMinGap: 2           // min candles between equal lows
stopBuffer: 0.1          // stop = sweep low - (0.1 * ATR)
cvdVelocityLookback: 96  // 24H lookback for CVD z-score
gate7_range_multiplier: 0.5  // 50% z-score reduction in RANGING
gate7_range_zscore_floor: 1.0 // never drop below z=1.0
baseRisk: 0.01           // 1% per trade
maxConcurrentTrades: 3
maxPortfolioRisk: 0.03
```

---

## FAILURE POINTS IDENTIFIED

1. **Ghost sweep problem:** 61-70% of sweeps have no CVD confirmation. The price wick is noise, not genuine buy pressure.

2. **Stop-hunt vulnerability:** Stops at 0.3% below entry get hit by natural 15m noise. ATR is 0.3-0.5%, so stop is within 1 candle's wick range.

3. **No breakeven rule:** Trade went +$88 profit → reversed to -$56 loss. No protection.

4. **Second entries into losers:** SCALPER opened trade #2 while BTC was already declining from trade #1.

5. **RANGING regime failure on BTC:** BTC lost -$5,138 in RANGING. The sweep-reclaim pattern doesn't work in tight ranges.

6. **Volume dependency:** Strategy requires RVOL ≥ 0.8. Current market RVOL is 0.2-0.6 on most candles. Dead market = dead strategy.

7. **Single-direction:** Only LONG trades. Market is BEAR/RANGING. No short capability enabled.

8. **Pool formation gap:** Backtest pre-computes pools from full dataset. Live bot detects pools incrementally from a 500-candle window, missing pools formed before warmup.

9. **Backtest vs live discrepancy:** Backtest found 5 live-period trades that the bot missed. Incremental indicator computation differs from pre-computed.

10. **No per-coin health tracking:** BTC was losing -$4,577 for 3 months before we noticed. No automatic pause for underperforming coins.

---

## WHAT WE'VE TRIED AND FAILED

- CVD_ZSCORE gate: mathematically impossible to reach in low-vol markets
- Adaptive Gate7 (50% reduction in RANGING): still insufficient
- sweepRvolMin scanning (0.5 to 1.6): optimal at 0.88-1.1, small edge
- Signal-strength risk scoring (SMART account): directionally correct but small sample
- Multi-coin deployment (ETH, BNB, BTC): increased trade count but still tiny
- Conviction score sizing: replaced old multiplier chain, backtest validated
- Circuit breaker: logging-only, never triggered

---

## MARKET CONTEXT

- BTC: $126K ATH (Oct 2024) → $60-65K current. Down 53% from peak.
- 2026 is worst yearly start on record (-23% first 50 trading days)
- Binance volume at October 2020 lows
- Market in BEAR/RANGING with no clear trend
- RVOL (relative volume) on sweep candles: 0.2-0.6 typical, rare spikes to 1.5

---

## WHAT WE NEED FROM YOU

1. **Diagnosis:** What are we fundamentally doing wrong? Is the strategy viable, or is the market structure broken for this approach?

2. **Strategy redesign:** Given current low-vol, ranging/bear conditions, what strategy CAN make profit? Not a parameter tweak — a fundamental approach change.

3. **Concrete implementation:** Specific rules we can code. Entry conditions, exit conditions, risk management. Something we can backtest and deploy within days.

4. **Honest assessment:** Is this worth pursuing, or should we pivot to a completely different approach (mean reversion, trend following, arbitrage, market making)?

Be brutally honest. We've spent a month on this and need a real answer.
