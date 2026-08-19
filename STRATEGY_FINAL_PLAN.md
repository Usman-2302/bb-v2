# BulletBrain — Final Strategy Implementation Plan
# Synthesized from: STRATEGY_RESEARCH_PLAN.md (v1) + STRATEGY-RESEARCH-PLAN-v2.md (v2)
# Date: 2026-08-19
# Status: READY FOR IMPLEMENTATION

---

## What Both Research Passes Agree On

Before the plan, here's the consensus across all sources:

1. **The exit logic kills more strategies than the entry logic.** (francisx1999 postmortem,
   our own S7/S9 results, NFI exit design). Wrong exit = 0% win rate on those exits regardless
   of how good the entry was.

2. **OHLCV-based limit-order backtests are optimistic.** A limit fill requires price to trade
   THROUGH your level, not merely touch it. Conservative fill assumption: price must penetrate
   1-2 ticks beyond the limit, plus 1-bar delay. Any strategy that only survives optimistic fills
   doesn't get wired into liveRunner.js.

3. **Maker fee (0.02%) vs taker (0.05%) is a real cost difference, not a rebate.**
   At standard tier, maker saves 0.03% per leg = 0.06% round-trip savings.
   At 10 trades/day on $100 equity: saves ~$0.18/day. Real but not dramatic.

4. **MFI > plain RSI for volume-confirmation signals.**
   MFI = volume-weighted RSI. Requires real buying/selling pressure (volume × price move),
   not just price move alone. Eliminates false signals on low-volume bars. DirectionalScalper
   uses MFI as its core signal for exactly this reason. 8-12% better signal accuracy vs RSI
   on momentum extremes (per quantified-strategies.com analysis).

5. **The 20%/month target is aggressive.** Funding-rate carry (the most structurally real edge
   in crypto) yields 10-15%/year. Setting the acceptance bar at 5%/month (real cost, conservative
   fills) is ambitious but realistic. 20%/month in a good month is possible; as a repeatable
   monthly target it's not supported by any open-source evidence at $80-100 capital.

---

## The Strategy: HYBRID_MFI_BB_TRAIL

### Why this specific design

Every viable approach from the research converges on:
- **Entry**: price at an extreme (BB lower/upper band) with VOLUME confirming the exhaustion
  (not just price action) — this is NFI's core, validated across thousands of live trades
- **Volume confirmation via MFI**: eliminates NFI's main weakness (BB touches on no-volume noise)
  by requiring MFI to confirm the extreme, not just RSI
- **Trend filter**: EMA200 direction — only take oversold signals in uptrend, overbought in downtrend
  — this is what separates a mean-reversion scalp from catching a falling knife
- **Exit**: ATR trailing stop (not fixed TP, not indicator-cross exit) — S7's best feature,
  produces positive avgR (+1.55-1.63R) even in bad months

### Entry Conditions

**LONG (buy the dip inside uptrend):**
```
1. close > EMA(200)                 ← macro uptrend confirmed
2. close < BB(20, 2.0).lower        ← price at lower extreme
3. RSI(14) < 35                     ← oversold
4. MFI(14) < 30                     ← volume-confirmed oversold (real selling exhaustion)
5. close > prev_close               ← reversal bar: buyers already stepping in
6. RVOL >= 1.2                      ← real participation, not dead-market noise
```

**SHORT (sell the rally inside downtrend):**
```
1. close < EMA(200)                 ← macro downtrend confirmed
2. close > BB(20, 2.0).upper        ← price at upper extreme
3. RSI(14) > 65                     ← overbought
4. MFI(14) > 70                     ← volume-confirmed overbought (real buying exhaustion)
5. close < prev_close               ← reversal bar: sellers already stepping in
6. RVOL >= 1.2                      ← real participation
```

**Why 6 conditions?** We tested the ablation ladder (QUANT-REVIEW.md): every confirmation
filter on the old pool-sweep signal made alpha WORSE. This signal is different — it's confirming
a reversal (not chasing a continuation), so each condition eliminates a specific false-signal type:
- Without EMA200: catches falling knives in downtrends
- Without BB: fires mid-range, no mean-reversion target
- Without RSI: fires on normal price level, not at extreme
- Without MFI: fires on low-volume fake moves (NFI's main failure mode)
- Without reversal bar: enters BEFORE buyers show up, not after
- Without RVOL: fires in dead overnight sessions with no follow-through

Expected frequency: 1-4 trades/day on 5m. Lower than previous tests (3-20/day) but each signal
is meaningfully more selective.

### Stop-Loss

```
SL = entry - dir * ATR(14) * 2.0
```

At 5m ETH median ATR ~$12-15 (~0.5% at $2500):
- Stop distance: ~$24-30 (~1% of price)
- Fee as % of stop (taker): 0.22% / 1.0% = 22% — manageable
- Break-even win rate at 2R: 33%

### Take-Profit / Exit

**Primary exit: ATR trailing stop**
- Activates after: 0.5R profit (half the stop distance in our favour)
- Trail width: 2.5 × ATR(14)
- This is what produced S7's +1.63R average on high-volume impulse trades

**Secondary target: BB midline (EMA20)**
- Natural mean-reversion target for a BB fade
- If BB midline is > 2.5R away: use 2.5R fixed TP instead (cap the trade)
- If BB midline is < 1.0R away: skip the trade (target too close to clear fees)

**Time exit: 20 bars = 100 min max hold**
- No position held overnight (relevant for funding fee accumulation)
- Consistent with "scalper" brief: exit within 1-2 hours

### Timeframes to Test

Test BOTH, compare directly:
- **5m** — 1-4 trades/day, median stop ~1% of price
- **15m** — 0.5-1.5 trades/day, median stop ~2-3% of price (3x ATR vs 5m)
  - Better fee-to-stop ratio (0.22% / 2.5% = 9%)
  - Less frequent but mathematically stronger fee clearance

---

## Implementation Plan (6 Phases)

### Phase 0 — Fix the Backtest Fill Model

**File: update `backtest_scalper.js` and `backtest_mean_reversion.js`**

Add two fill modes:
```js
// OPTIMISTIC (current): limit fills when price touches the level
const filled_optimistic = bar.low <= limitPrice;

// CONSERVATIVE (add): limit fills when price trades THROUGH by 1 tick + 1 bar delay
const filled_conservative = bar.low <= limitPrice - tickSize && (i - signalBar) >= 1;
```

Run every strategy in both modes. Report side-by-side. Only trust conservative results.

This addresses v2's primary correction. Takes ~1 hour to implement.

---

### Phase 1 — Build and Backtest HYBRID_MFI_BB_TRAIL

**File to create: `backtest_hybrid.js`**

What to build:
- Add MFI indicator function (14-period, volume-weighted RSI formula)
- 6-condition entry filter as described above
- ATR trailing stop + BB midline TP + 20-bar time exit
- Run on ETHUSDT 1m data resampled to 5m AND 15m
- Monthly breakdown Aug 2025 → Aug 2026 (all 12 months available)
- Zero-cost vs real-cost comparison in every run
- Both optimistic AND conservative fill assumptions

**Accept the strategy if:**
- Zero-cost avg monthly return > +10% (signal has real edge)
- Real-cost (taker fills, conservative) avg monthly return > +3% (fees don't kill it)
- Profitable months ≥ 7/12 under conservative real-cost
- PF > 1.2 under conservative real-cost

**If 5m fails but 15m passes**: use 15m. Frequency goal adjusts to 0.5-1.5 trades/day.

---

### Phase 2 — Exit Variant Optimization

Once Phase 1 identifies a passing timeframe, test these 4 exit variants on it:

| Variant | TP | Trail | Time exit |
|---------|-----|-------|-----------|
| E1 | 2.5R fixed | None | 20 bars |
| E2 | BB midline | None | 20 bars |
| E3 | 3.0R fixed | ATR 2.5× at 0.5R | 20 bars |
| **E4 (default)** | BB midline or 2.5R max | ATR 2.5× at 0.5R | 20 bars |
| E5 | None | ATR 2.5× at 0.5R | 20 bars |

Pick the variant with best avg monthly return under conservative real-cost fills.
The winning variant becomes the production exit config.

---

### Phase 3 — 90-Day Validation on Most Recent Data

Run the Phase 1+2 winning config (timeframe + exits) on:
- ETHUSDT last 90 days (May–Aug 2026)
- Conservative fill assumption only

Accept if: avg R > 0, PF > 1.3, at least 2 of the 3 months profitable.
This is the final gate before touching liveRunner.js.

---

### Phase 4 — Wire into liveRunner.js

**Changes to `src/live/liveRunner.js`** (execution layer stays unchanged):

1. **Add MFI indicator** to the warmup indicator stack
   ```js
   // New: Money Flow Index
   function mfi14(candles) { /* 14-period MFI */ }
   let mfiVals = [];
   // computed alongside atr14, rvolVals, etc.
   ```

2. **Replace `detectPools()` entry logic with `detectHybridSignal()`**
   ```js
   function detectHybridSignal(i) {
     // 6-condition HYBRID_MFI_BB_TRAIL entry
     // returns { dir: 1|-1, stopDist, tpTarget } or null
   }
   ```

3. **Replace fixed 2.5R TP with dynamic BB midline TP**
   ```js
   const tp = bbMid[i];  // natural mean-reversion target
   ```

4. **Add trailing stop update in candle management loop**
   ```js
   // in processCandle → active trade management
   if (openTrade && hasProfit >= 0.5 * stopDist) {
     const trail = currentPrice - dir * atr14[i] * 2.5;
     openTrade.stop = dir > 0 ? Math.max(openTrade.stop, trail) : Math.min(openTrade.stop, trail);
   }
   ```

5. **Keep all execution code unchanged** — the MARKET entry, STOP_MARKET SL, LIMIT TP,
   emergency close, safety invariants, serialisation chain — all of it stays exactly as-is.
   The execution layer is solid. We're only replacing the signal logic.

**Estimated changes**: ~100 lines modified, ~50 lines new. Everything else unchanged.

---

### Phase 5 — Local Run (no live orders)

Run without `BB_LIVE=true` for 3-5 days watching real signals fire:

```bash
BB_SYMBOL=ethusdt BB_CAPITAL=100 node src/live/liveRunner.js
```

Check:
- Signals fire at rate matching backtest (~1-4/day at 5m)
- Stop placement looks structurally correct on the chart
- No runaway entries or zero-distance stops
- Regime filter working (RANGING = no trades)

Only after this confirms behavior matches backtest: enable `BB_LIVE=true`.

---

## What NOT To Build (Final List)

| Approach | Reason |
|----------|--------|
| Any trend-continuation signal at 5m | Shown to have negative alpha in 12+ months (QUANT-REVIEW.md). MFE/MAE < 1 at every horizon. |
| Scalping at >10 trades/day | Fee drag exceeds signal edge at $80-100 capital |
| Grid / DCA / Passivbot style | Wipes out in trending months; no stop-loss = catastrophic drawdown |
| DirectionalScalper hedge mode | Needs two simultaneous positions; margin cramped at <$500 |
| Funding-rate arb | Needs spot + perp legs; doubles capital requirement |
| Backtest with optimistic fills only | Confirms nothing; must pass conservative fills |
| 1m timeframe | Fee-to-ATR ratio unwinnable at <$500 (proven in backtest_mean_reversion.js) |
| Wider entry filters (RVOL < 1.0, RSI < 45) | Ablation ladder in QUANT-REVIEW: adding weak conditions makes alpha worse, not better |

---

## Key Numbers Summary

| Metric | Value |
|--------|-------|
| Starting equity | $100 |
| Risk per trade | 1% = $1 |
| Taker fee | 0.05% |
| Maker fee (TP) | 0.02% |
| Slippage/side | 0.06% |
| Round-trip (taker in, maker TP) | ~0.19% |
| 5m ATR (ETH median) | ~$12-15 (~0.5%) |
| Stop at 2×ATR | ~$24-30 (~1%) |
| Fee as % of stop | ~19-22% |
| Break-even WR at 2R | 33% |
| Break-even WR at 2.5R | 29% |
| Target monthly return | 5%+ real-cost, conservative fills |
| Maximum acceptable monthly return claim | Treat anything >20% with skepticism until proven on 6+ months |

---

## Sequence

```
Phase 0  →  Fix fill assumptions in backtest engine          (1 hour)
Phase 1  →  Build + run backtest_hybrid.js                   (3-4 hours)
Phase 2  →  Exit variant comparison                           (1-2 hours)
Phase 3  →  90-day validation                                 (30 min)
Phase 4  →  Wire into liveRunner.js                           (2-3 hours)
Phase 5  →  Local paper run 3-5 days                          (passive)
LIVE     →  Enable BB_LIVE=true                               (only after Phase 5)
```

Total active work before going live: approximately 8-12 hours of implementation.

---

*Final plan synthesized 2026-08-19*
*Based on: 15+ open-source repos, 13 months of ETH 1m data, 20+ backtest runs, v1+v2 research plans*
