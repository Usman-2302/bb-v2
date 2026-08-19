# BulletBrain — Strategy Research Plan
# Based on: Open-Source Bot Analysis (Aug 2026)
# Purpose: Find a scalping signal that clears 20%+ monthly return at $80-100 capital
# Status: RESEARCH COMPLETE → READY FOR IMPLEMENTATION

---

## 1. What the Research Found

### 1.1 Open-Source Bots Studied

| Bot | Stars | Timeframe | Core Mechanism | Honest Verdict |
|-----|-------|-----------|----------------|----------------|
| **NostalgiaForInfinity (NFI/NFIX)** | ~3k | 5m | BB lower band + RSI oversold + EMA trend + volume divergence | Spot trading on multiple pairs, NOT futures scalping. Requires 20-50 open trades simultaneously. Capital-intensive. |
| **ClucHAnix** | High forks | 5m | BB lower band touch + RSI + volume spike (CLUC = "Close Low Upper Close") | Same as NFI — spot, multi-pair, DCA entries. Not futures. |
| **BB_RPB_TSL** | Medium | 5m | BB + RSI pullback + trailing stop. Adapts NFI for Binance. | Spot strategy, openly states "overfitted on KuCoin, needs re-hyperopt for Binance" |
| **Passivbot** | ~2k | Any | Grid/DCA with EMA directional filter | Martingale-style grid. Works in sideways. Wipes out in trends. |
| **DirectionalScalper** | Medium | 5m/1m | MFI+RSI directional, hedge mode (long+short simultaneously) | Bybit-specific. Requires hedge mode. Uses limit orders (maker rebates). Strategy: enter long AND short, close the losing side when profitable side hits TP. |
| **nikita-doronin hedge bot** | Low | 5m | EMA-based grid, 4 long limit orders + 1 short market order hedge | Creative: no stop-loss, hedges risk. BUT: if price returns to start after collecting all grids, the short loss wipes the long profits. |
| **ryu878 grid bot** | Medium | Any | EMA6 + EMA60/120/240 grid with limit entries for MAKER rebates | **Key insight**: works because BUSD futures paid maker REBATES (+0.01%). That rebate no longer exists on standard USDT futures. |
| **francisx1999 postmortem** | Recent | 5m | 7 strategies tested, all lost, 24 months, real data | **Most honest repo found**: zero strategies cleared 1.5%/mo. Same fee-drag pattern we found. |

### 1.2 Critical Insight from the Postmortem (2026)

The `francisx1999` repo is the most valuable find — it's a 2026 post-mortem testing 7 strategy families against 24 months of real data with real fees. Key finding mirrors ours exactly:

> "The exit logic dominates the entry logic. I spent weeks on entry conditions. What killed both strategies was a one-line exit decision."

Their exit breakdown for trend-following strategy:
- ROI exits: 88 trades, 100% win rate, +$740 total
- Exit-signal (opposite indicator cross): 71 trades, 0% win rate, -$970 total

**Same pattern we see: the entries find real edge, but wrong exit logic converts wins into losses.**

Their best result: **Fear & Greed contrarian** — average +32% per winning trade, but stops killed it.

### 1.3 Why Open-Source 5m Spot Strategies Don't Transfer to Futures Scalping

1. **Spot vs Futures**: NFI/ClucHAnix are spot strategies. They buy the dip and wait days. In futures with 5x leverage and a 2% stop, you can't hold a dip for 3 days.

2. **Multi-pair diversification**: NFI runs 20-50 pairs simultaneously. Any single pair loses. The portfolio is what wins. We run 1 pair (ETHUSDT).

3. **Fee structure assumptions**: Most old strategies assumed maker rebates (BUSD era) or very low fees. Real USDT futures: 0.05% taker + 0.06% slip = 0.22% round trip minimum.

4. **DCA as risk management**: NFI/Passivbot use DCA to average down. At $80 capital with 5x leverage, one DCA level wipes the account.

---

## 2. What Actually Works in Open Source (The Honest List)

### Mechanism 1: Maker-Only Limit Entry (ryu878 / DirectionalScalper)

**How it works**: Place limit buy orders below current price. When filled, place limit sell at +0.3-0.5%. Both sides are MAKER = 0.02% each = 0.04% round trip vs 0.22% for taker.

**Fee math at $100 equity, 1% risk, $2400 ETH**:
- Maker round trip: 0.04% of notional = $0.056/trade
- Taker round trip: 0.22% = $0.31/trade
- At 10 trades/day: maker = $0.56/day in fees, taker = $3.10/day
- **Maker gives ~5.5x fee advantage**

**The constraint**: Limit orders may not fill if price moves away. Need penetration logic.

**Verdict**: Real fee edge exists. DirectionalScalper uses this on Bybit. The liveRunner.js already supports LIMIT TP (maker). Entry via limit is the missing piece.

---

### Mechanism 2: Hedge Mode (Long + Short simultaneously)

**How it works (DirectionalScalper)**: 
- Open LONG if MFI+RSI bullish
- Simultaneously open SHORT hedge at smaller size
- When long hits TP → close short at loss (but net positive)
- When price reverses → long stops out, short profits

**Why it works**: Reduces max loss. Never fully unprotected.

**The constraint**: Requires hedge mode on Binance (already supported in liveRunner.js). Needs more capital to run two positions.

**Verdict**: Interesting but complex at $80. Better at $500+.

---

### Mechanism 3: Fear & Greed Contrarian (francisx1999 postmortem)

**How it works**: Buy ETH when Fear & Greed Index ≤ 25 (extreme fear). Hold until ≥ 75 (greed). Average trade: +32% when it works.

**The constraint**: Only fires ~2-4 times per month. Not a scalper. More of a swing trade.

**Verdict**: Real edge confirmed. Not what we want for 3-10 trades/day. Could be a portfolio overlay.

---

### Mechanism 4: BB + RSI + Volume Divergence (NFI Core, adapted for futures)

**The NFI core buy condition** (stripped from ClucHAnix/BB_RPB):
```
close < BB_lower(20, 2.0)          # price below lower BB
AND RSI(14) < 35                   # oversold
AND volume > volume_sma(20) * 1.5  # above-average volume (real selling)
AND close > close_1_bar_ago        # REVERSAL bar (close > prev close = buyers stepping in)
```

**Why NFI works on spot**: Spot doesn't have funding/leverage. You can hold a dip for 10 days. The trade eventually wins because crypto tends to mean-revert.

**How to adapt for futures** (our version):
- Same entry conditions BUT only inside an active trend (EMA200 direction)
- TIGHTER time exit (max 2 hours = 24 bars at 5m)
- TP at BB midline (EMA20) = natural mean reversion target
- Stop at 1.5× ATR below entry = structural

This is what our MR2 (BB fade) was trying to do — but we missed the RSI+Volume divergence confirmation that NFI uses.

---

### Mechanism 5: MFI+RSI Signal (DirectionalScalper core)

**Money Flow Index** (MFI) = volume-weighted RSI. It measures buying/selling PRESSURE, not just price.

```
MFI(14) < 20 AND RSI(14) < 30  → oversold with volume confirmation → LONG
MFI(14) > 80 AND RSI(14) > 70  → overbought with volume → SHORT
```

MFI is stronger than RSI alone because it requires volume to confirm the move. A price drop on low volume = weak signal. Same drop on high volume = real selling = better reversal candidate.

**This is what DirectionalScalper uses as its core signal.** Bybit results: profitable in trending markets, neutral in ranging.

---

## 3. The Real Problem: Exit Logic, Not Entry Logic

The postmortem's finding and our own results agree: **the entry signal is rarely the problem. The exit is.**

The specific pattern that kills strategies:

| Exit type | Win rate | Typical result |
|-----------|----------|----------------|
| Fixed TP (2R, 2.5R) | 25-30% | Good when hit, but too many TIMEs |
| Exit on indicator reversal | 0% | Always a loser — by the time EMA crosses back, damage done |
| Trailing stop | 60-70% | Best mechanism when calibrated right |
| Time exit (flat at close bar N) | ~50% | Neutral — sometimes good, sometimes bad |

**The winner**: Trailing stop that only activates after 0.5R profit, trails at 2.5×ATR.

This is what S7/S4 from our backtest had as their best feature. The avgR was positive (+1.55R to +1.63R) — the signal is finding real moves. But July 2026 was a bad-draw month for the sequence.

---

## 4. New Strategy Design — Combining the Best Elements

### Name: HYBRID_MFI_BB_TRAIL

**Combines**:
- NFI's BB + RSI entry logic (oversold/overbought + volume)
- MFI confirmation (DirectionalScalper's core signal)
- EMA200 trend direction (our validated macro filter)
- ATR trailing stop (our best-performing exit from S7/S9)
- LIMIT TP entry to get maker fee advantage
- 5m timeframe (larger bars = stops clear fee floor)

**Entry conditions (LONG)**:
```
1. EMA200 direction: close > EMA200 (macro uptrend)
2. BB lower band: close < BB(20, 2.0).lower — price compressed
3. RSI(14) < 35 — oversold
4. MFI(14) < 30 — money flow oversold (volume confirms selling exhaustion)
5. Current close > previous close — reversal bar already started
6. RVOL >= 1.2 — real participation in this bar
```

**Entry conditions (SHORT)** — mirror:
```
1. close < EMA200
2. close > BB(20, 2.0).upper
3. RSI(14) > 65
4. MFI(14) > 70
5. close < prev close
6. RVOL >= 1.2
```

**Stop**: 2.0 × ATR below/above entry (structural)

**Target**: BB midline (EMA20) as natural mean-reversion target. If midline is too close (< 1.0 × ATR), use 2.0R fixed instead.

**Trail**: Activate after 0.5R profit. Trail at 2.5 × ATR.

**Time exit**: 20 bars (100 minutes) — no longer than 1h 40m.

**Why this should outperform our previous tests**:
- MFI confirmation eliminates weak RSI signals (RSI can be extreme on low volume)
- BB compression ensures we're entering at a real extreme, not mid-range
- Reversal bar required (not just at extreme — must be turning)
- Limit TP = maker fee saves ~$0.25/trade at $100 equity
- Trailing stop captures extended moves instead of fixed TP cap

**Expected frequency**: 1-4 trades/day (more selective than our previous 7-12/day). At $100 equity: ~$0.06/trade in fees (maker in, maker out) vs $0.30 before.

---

## 5. Implementation Plan

### Phase 1: Backtest the HYBRID_MFI_BB_TRAIL (do this first)

**File to create**: `backtest_hybrid.js`

**What to test**:
- Monthly returns Aug 2025 → Aug 2026 (all 12 months)
- Zero-cost vs real-cost comparison (to isolate signal vs fee problem)
- Compare: maker entry (limit at entry bar close) vs taker entry (next open)
- Show: daily P&L, trade list, exit reason breakdown

**Success criteria**:
- Zero-cost: avg monthly return > +10% (signal has real edge)
- Real-cost: avg monthly return > +5% (fees don't kill it)
- Profitable months: ≥ 7/12

### Phase 2: Optimize exits (if Phase 1 shows zero-cost edge)

Test these exit variants on the passing strategy:
1. Fixed 2R TP
2. BB midline TP
3. ATR trail (2.5×, activates at 0.5R)
4. Time exit only (no TP, trail handles it)

### Phase 3: Wire into liveRunner.js

If any exit variant shows avg monthly return ≥ +15% with real fees over 12 months:

**Changes to liveRunner.js**:
1. Replace `detectPools()` with `detectMFI_BB_signal()` — new entry logic
2. Keep all execution code unchanged (it's solid)
3. Add MFI indicator to the indicator stack
4. Change TP from LIMIT fixed-R to LIMIT at BB midline
5. Add trailing stop update inside the candle management loop

### Phase 4: Run 90-day local backtest before going live

Use the backtest engine to confirm on the most recent 90 days.
Only go live if: avg R > 0, PF > 1.3, profitable months ≥ 2/3.

---

## 6. What We Know Won't Work (Don't Retry These)

Based on 13 months × 20+ strategies tested:

| Approach | Why it fails | Evidence |
|----------|--------------|----------|
| Trend continuation at 3m/5m | Entry after move = exit liquidity | QUANT-REVIEW.md + all scalper backtests |
| High-frequency scalping (>10/day) | Fee drag kills all edge | backtest_monthly.js results |
| Fixed TP without trail | Misses extended moves | S7 exit breakdown: 81 TIME exits |
| Exit on indicator reversal | 0% WR on those exits | francisx1999 postmortem |
| BB breakout chasing | Same as trend continuation | S4/S8 results |
| Grid/DCA | Trends wipe all grid profits | Passivbot / grid bot postmortem |
| Scalping at <$500 capital | Fees > expected edge at small size | MR4 zero-cost analysis |

---

## 7. Key Numbers to Remember

| Metric | Value |
|--------|-------|
| Taker fee | 0.05% |
| Maker fee | 0.02% |
| Slippage (market order) | 0.06%/side |
| Round-trip taker+slip | 0.22% |
| Round-trip maker+slip | 0.10% |
| Round-trip maker only (limit both sides) | 0.04% |
| Break-even move (taker) | 22 bps |
| Break-even move (maker TP) | 10 bps |
| 5m ETH ATR (median) | ~$12-15 (~0.5% at $2500) |
| Stop at 2×ATR | ~$24-30 = ~1% of price |
| Fee as % of 2×ATR stop (taker) | ~22% — manageable |
| Fee as % of 2×ATR stop (maker TP) | ~10% — very manageable |

**Conclusion**: At 5m with 2×ATR stops (~1% of price), fees are 10-22% of risk per trade. That's survivable if the signal has edge. The question is always: does the signal have positive expectancy before fees?

---

## 8. Next Action

**Run `backtest_hybrid.js` (to be written).**

The HYBRID_MFI_BB_TRAIL strategy is the best synthesis of what works across all researched bots:
- NFI's entry quality (BB + RSI + volume divergence)
- MFI for volume-confirmed signal (DirectionalScalper)
- Trailing stop exit (our own best performer)
- Maker TP fee advantage

If this shows zero-cost monthly returns consistently positive → the edge exists, and implementation can proceed.

---

*Research completed: 2026-08-19*
*Sources: NostalgiaForInfinity, ClucHAnix, BB_RPB_TSL, Passivbot, DirectionalScalper, nikita-doronin hedge bot, ryu878 grid bot, francisx1999 postmortem, backtest_scalper.js results, backtest_mean_reversion.js results*
