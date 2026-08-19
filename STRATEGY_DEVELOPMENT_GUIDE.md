# BulletBrain — Strategy Development Guide
# Synthesized from: Mroziewicz & Ślepaczuk (2026) + BulletBrain post-mortem
# Purpose: Prevent every mistake made in the last 3 months from being repeated
# Status: ACTIVE REFERENCE — read before touching any strategy parameter
# Date: 2026-08-19

---

## 0. What this guide is

This is the practical distillation of two sources:

1. **The academic paper** (Mroziewicz & Ślepaczuk, arXiv:2602.10785, Feb 2026) — the most
   rigorous walk-forward study on intraday crypto strategies we have found. 40 pages condensed
   to what actually matters for our situation.

2. **Our own post-mortem** — the specific failures documented in AUDIT.md, QUANT-REVIEW.md,
   and the scalper backtests run in Aug 2026.

The two sources agree on every important point. This guide extracts the shared conclusions
and converts them into a checklist-driven development process.

---

## 1. The four mistakes that caused every failure in this codebase

Read these once and memorize them. Every strategy failure in BulletBrain traces back to
one or more of them.

### Mistake 1: Testing on data that was already used to pick the strategy

**What happened**: The live runner strategy was grid-searched on 2026 data. The grid found
"RVOL 0.3, STOP 0.3ATR, RR 2.5" as the best config. Those same candles were the ones that
produced the live trading losses.

**The paper's name for this**: "Repeated optimizations on data designated as out-of-sample"
(Section 1, Introduction). The paper describes this as "often unreported" but "a common issue."

**The fix**: Divide data into three non-overlapping segments BEFORE writing any strategy code:
- **TRAIN** (2021–2024): use freely for development and parameter search
- **VALID** (2025 Jan–Aug): allowed for one confirming look per strategy
- **OOS** (2025 Sep onwards): touched ONCE, at the end, to report final numbers. Never re-touched.

Our repo already does this correctly for the LSO strategy (Phase D13 used 2025 data once).
The live runner broke this rule entirely.

---

### Mistake 2: Not measuring the signal's raw alpha before building a strategy around it

**What happened**: The pool-sweep signal was assumed to have directional edge because it
"makes intuitive sense" — liquidity sweeps are a real market mechanism. But the signal was
never measured for predictive power before being deployed.

**The paper's equivalent**: They note that a proper framework "incorporates tools for
statistical significance evaluation" (Section 1). They test whether the strategy "is better
than random" using bootstrap methods (Section 4.4).

**Our equivalent finding from QUANT-REVIEW.md**: When the pool-sweep signal was measured
directly with no stops/targets/costs, it had a 48% hit rate vs a 50% baseline (alpha = -1.34
bps at h=8 candles). It is anti-predictive — not neutral, not weak, actively anti-predictive.

**The fix — the alpha test**:

Before building any strategy, measure the signal's raw direction-signed forward return:
```
For each signal bar i:
  forward_return[i] = sign(signal_direction) × log(close[i+h] / close[i])
  baseline[i] = log(close[i+h] / close[i])  ← unconditional
  alpha[i] = forward_return[i] - baseline[i]
```
t-stat on alpha across all signals. If |t| < 2.0 with n ≥ 100, the signal has no measurable
predictive edge. Stop there. Do not proceed to strategy construction.

This test costs 30 minutes of code. It would have prevented every scalping failure.

---

### Mistake 3: Confusing "survivable" with "profitable"

**What happened**: When fees were destroying capital at 20x leverage, the fix was to cut
leverage and widen stops. MaxDD went from 105% to 21%. This was presented as a success.
But expectancy stayed at -0.35 R/trade. The strategy was bleeding more slowly, not winning.

**The paper's language for this**: "These strategies slightly underperformed Buy-and-Hold in
the Sharpe Ratio but outperformed in maximum drawdown." (Section 6.1). The paper is clear
that better drawdown ≠ better strategy.

**The fix**: Use the full metric set from the paper every time:
- Annualized return
- Sharpe ratio (return / volatility)
- Maximum drawdown
- Sortino ratio (return / downside volatility)
- Information ratio (return² / volatility × drawdown) ← most sensitive to cost changes
- Profit factor (sum wins / |sum losses|)

A "fix" that improves MaxDD but leaves Profit Factor at 0.50 is not a fix.

---

### Mistake 4: Treating 5m/3m scalping as a tuning problem when it's a structural problem

**What happened**: We ran 20+ signal variants at 3m/5m over 13 months. Every one failed.
This was interpreted as "we haven't found the right signal yet." The correct interpretation
was different.

**The paper's finding** (Table 3, Section 5.1): At 0.1% transaction costs, mean Sharpe is
-12.71 at 1m, -2.84 at 5m, -0.98 at 15m, -0.50 at 30m, **+0.79 at 60m**. The paper
explicitly concludes: "Higher frequency timeframe (1-15) might be unprofitable due to 0.1%
transaction costs."

Our costs are 0.22% round trip (taker + slip both sides) — more than double their assumed
0.1%. If 5m is unprofitable at 0.1% costs, it is certainly unprofitable at 0.22%.

**The paper's break-even**: ~0.36-0.40% per transaction for the 60m strategy. We pay 0.11%
per leg taker+slip. That's 0.22% round trip — well within the profitable range at 60m+.

**The fix**: Structural constraints come first, signal design comes second.
- At 3-5m with 0.22% costs: the cost floor is structurally unwinnable with OHLCV signals
- At 15m with structural stops (0.5-1%+ distance): potentially viable
- At 60m+: cost drag is a small fraction of expected move, signal quality can dominate

---

## 2. The paper's methodology — what to copy exactly

### 2.1 The double out-of-sample architecture

This is the most important structural lesson from the paper. Their architecture:

```
ALL DATA
├── GLOBAL TRAINING PERIOD (Feb 2018 – Sep 2019)
│   ├── Walk-Forward Fold 1: TRAIN → TEST
│   ├── Walk-Forward Fold 2: TRAIN → TEST
│   ├── Walk-Forward Fold 3: TRAIN → TEST
│   │   ...
│   └── Best 2 configs selected by smoothed Sharpe
│
└── UNSEEN DATA PERIOD (Nov 2019 – Aug 2021)
    └── Run ONCE with the 2 selected configs. NEVER RE-TOUCHED.
```

The key word is **ONCE**. They did not look at the unseen data, adjust parameters, and test
again. Every time you re-examine OOS data after a result, it becomes in-sample.

**Our implementation for BulletBrain**:

```
DATA SPLIT (enforce in code, not just in comments):
├── TRAIN:   2021-01-01 → 2024-12-31  (in config.js DATA.endDate)
├── VALID:   2025-01-01 → 2025-08-31  (allowed for ONE confirming pass)
└── OOS:     2025-09-01 → present     (LOCKED — read only after final strategy frozen)
```

Current status: Phase D13 (LSO forward test) used 2025 data ONCE in May 2026. That is
still valid as of Aug 2026 — the OOS data has not been re-used for parameter adjustment.
The scalping experiments used entirely different data (Aug 2025–Aug 2026) on the live
runner — but those parameters were re-tuned repeatedly, violating the rule.

### 2.2 Walk-forward validation

The paper optimizes the walk-forward window lengths themselves (not just the strategy
parameters). Key finding: longer windows (14-28 day training, 10-28 day testing) outperformed
shorter windows significantly.

For our backtests, the equivalent is:

```
Minimum walk-forward protocol before any strategy goes live:
1. Split TRAIN period into 5 rolling windows (18m train / 6m test each)
2. Optimize strategy on each train window independently
3. Report ONLY the test-period results, aggregated
4. If aggregated test Sharpe > 0: acceptable
5. Apply to VALID (one pass). If still positive: proceed to live
```

The existing backtest engine (`src/backtest/runner.js`) already supports this.
The `runYearlyBreakdown()` function is a simpler version — use it as minimum validation.

### 2.3 Bootstrap significance testing

The paper used two bootstrap methods to test "is this better than random?":

**Method 1 — Random parameter bootstrap**: Instead of using the best parameters, use
randomly drawn parameters. The strategy should outperform random by a statistically
significant margin (5% confidence level).

**Method 2 — Shuffled transaction blocks**: Keep the same position blocks (long/short
sequences) but randomize their order. If the strategy's Sharpe is better than 95% of
shuffled versions, the sequence matters (not just the direction ratio).

We already have Monte Carlo in `ENGINE.monteCarlo`. That addresses Method 2.
Method 1 can be added to `runSensitivityTest()` with random parameter draws.

**What the paper actually found**: Their shuffled-blocks bootstrap showed statistical
significance at 5% for both selected configurations. But the random-EMA bootstrap was
weaker — only 8-13% of random parameter sets beat the selected ones. That is NOT
statistically significant at 5%. This matters: even a legitimately good strategy can fail
one of two bootstrap tests. Use both, report both honestly.

### 2.4 Cost sensitivity: test at 3 fee levels

The paper tested 0.05%, 0.07%, 0.10%, 0.20%, 0.30%, 0.40%, 0.50% per transaction.
Their break-even was ~0.36%.

**For our system**, always run every strategy at three cost levels:
1. Zero cost (signal quality test)
2. Measured cost (0.05% taker + 0.06% slip = 0.11% per leg = 0.22% round trip)
3. Stressed cost (2× slippage = 0.17% per leg = 0.34% round trip)

If a strategy is profitable at zero cost but not at measured cost:
→ Fee drag is the problem. The signal has edge but not enough per trade.
→ Solutions: higher timeframe, fewer trades, or capital increase.

If a strategy is unprofitable even at zero cost:
→ The signal has no edge. No execution improvement can fix this.
→ Stop immediately. Do not tune.

This test takes 10 minutes and we now have the infrastructure for it.

---

## 3. What we know about specific signal families

### 3.1 Pool sweep + CVD (the original live runner signal)

**Status: No edge. Do not revive.**

- Measured alpha: -1.34 bps at h=8 candles (QUANT-REVIEW.md §4.1)
- Hit rate: 48% vs 50% baseline — anti-predictive
- Zero-cost PF: 0.86 (worse than coin flip)
- Adding filters (RVOL, CVD) made alpha monotonically WORSE
- 5.5-year walk-forward: PF 0.34/0.10/0.01/0.04/0.51 — zero profitable years

This is the most thoroughly tested signal in the codebase. The evidence is unambiguous.

### 3.2 OHLCV scalping at 3m/5m

**Status: Structurally unviable at $80-100 capital with 0.22% costs.**

- 13 months × 20+ variants tested: zero profitable months
- Zero-cost test confirms most have no signal edge either
- Exception: VWAP fade (MR4) has zero-cost positive 9/13 months
  BUT: fails BTC cross-validation (p=0.825) — likely noise
  AND: real-cost monthly return = -51% at $100 equity
- Fee drag at 3-5m with $100: 50-60%/month — math doesn't work

This is not a signal design problem. It is a structural constraint.

### 3.3 LSO-Long (the validated strategy)

**Status: Positive evidence. Best option available. Not yet deployed live.**

- 2021-2024 in-sample: PF 2.755-3.079, WR 51-58%, MaxDD 1.2-1.65%
- 2025 OOS (one pass, Phase D13): PF 2.300, WR 54.1%, MaxDD 2.20%
- Stress tests passed: Monte Carlo P95 DD 2.35%, slippage stress PF>2.5
- Cross-regime: BULL 100%, RANGING 44% WR PF 1.400 (still profitable)
- Degradation from IS to OOS: 28% (marginally above 25% threshold but explained by regime shift)

**Caveats from the paper**:
- "A single-pass OOS is good but not a rolling walk-forward" — the paper warns that PF
  can drop 30% when you go from single-OOS to rolling WF validation
- OOS was run in May 2026 and covered Jan 2025–Apr 2026. It's now Aug 2026 — another
  4 months of out-of-sample data exists. Re-run before going live.
- The strategy is implemented in `src/backtest/lso_runner.js` and backtested correctly.
  The remaining work is porting its signal logic into `src/live/liveRunner.js`.

---

## 4. The portfolio insight from the paper

This is the strongest practical finding in the Mroziewicz & Ślepaczuk paper (Section 6.2,
Table 11) and it directly applies to our situation.

**Their finding**: Combining Buy-and-Hold + two walk-forward strategies produced:
- Best Sharpe ratio (1.921 vs 1.542 for Buy-and-Hold alone)
- Best Sortino ratio (+30% improvement)
- Best Information ratio (2× improvement)
- **Lowest drawdown**: reduced from 68% to 44%

Why? Because the active strategy (trend-following EMA) performs differently in different
market regimes:
- During crashes/high volatility: EMA strategy protects capital
- During strong bull runs: Buy-and-Hold wins
- Combined: you get the best of both

**The BulletBrain equivalent**:

The LSO strategy also has regime-dependent performance:
- BULL regime: exceptional (6/6 wins in 2025 OOS)
- RANGING: profitable but weaker (PF 1.400)
- The bot being flat in RANGING + holding spot = natural hedge

At $80-100 capital, we can't run a separate "Buy-and-Hold" leg, but this tells us:
- Don't force trades in RANGING. The LSO correctly skips them.
- The strategy's natural rest periods in RANGING are a feature, not a flaw.

---

## 5. The step-by-step process for any new strategy

Use this checklist for every strategy, in order. Do not skip steps.

### Step 1: Signal alpha test (30 min)

Before writing any full backtest:
```
For signal type S and direction dir:
  alpha = direction-signed forward return − unconditional forward return
  t-stat = alpha_mean / (alpha_std / sqrt(n))
```
Accept threshold: |t| ≥ 2.0 with n ≥ 100 observations (two-tailed, p < 0.05).
Test at 3 horizons: h=4, h=8, h=16 bars.
Cross-validate on BTC and ETH independently. Edge must appear on BOTH.

If zero-cost alpha is negative or not significant: STOP. Do not proceed to Step 2.

### Step 2: Cost floor check (10 min)

```
Min stop distance = 3 × round_trip_cost × price
  = 3 × 0.22% × $2500
  = $16.50  (for ETH at $2500, 3m bars)

At 15m: median ATR ~$12-15
  → ATR stop would need ~1.0-1.5× ATR to clear cost floor at 3×
  → This is achievable

At 3m: median ATR ~$6-8
  → ATR stop at 2× = $12-16 — barely clears
  → Any smaller and cost floor is unwinnable structurally
```

If the signal requires stops tighter than 3× round-trip cost to be valid:
STOP. The timeframe is wrong for this cost structure.

### Step 3: In-sample backtest on TRAIN data only (2-4 hours)

Run the strategy on 2021-2024 data (tagged NDJSON from `data/historical/`).
Use `src/backtest/runner.js` with the strategy descriptor pattern.
Run `runYearlyBreakdown()` to see year-by-year results.

Accept criteria (from config.js ENGINE.acceptance):
- PF ≥ 1.5
- MaxDD ≤ 8%
- WR ≥ 42%
- Profitable in ≥ 3 of 4 years
- ≥ 30 trades per regime with data

If any criterion fails: adjust signal design. Do NOT touch the OOS data.

### Step 4: Parameter sensitivity test (1 hour)

Use `runSensitivityTest()`. For each parameter, test ±20% variants.
Accept criteria: WR variation across range < 15pp.

If a parameter is fragile (WR varies >15pp when changed ±20%): that parameter
is overfit to the training data. The strategy is not robust. Do not proceed.

### Step 5: Stress tests (1 hour)

Three tests, all must pass:
- **Monte Carlo** (1000 block-shuffled runs): P95 MaxDD < 10%
- **Slippage stress** (2× all costs): PF still > 1.5
- **Walk-forward** (5 rolling 18m/6m windows): all 5 windows profitable

### Step 6: VALID data (one pass only) (30 min)

Run on 2025 Jan–Aug data. Do not re-run after seeing the result.
Accept: PF > 1.3, WR > 35%, MaxDD < 20%.

If it fails: go back to Step 3 and redesign the signal. Do NOT tune parameters
to pass VALID — that turns VALID into in-sample data.

### Step 7: OOS data (one pass, final gate)

Run on 2025 Sep–present. Report the numbers. This is the number that matters.

Degrade threshold: if OOS PF < 0.80 × VALID PF, the strategy is degrading too fast.
Acceptable: some degradation is expected (the paper saw 20-30% drop from IS to OOS).

### Step 8: Wire into liveRunner.js

Only after Step 7 passes. Keep the execution layer (market entry, algo SL, limit TP,
emergency close, serialization) completely unchanged. Only replace the signal detection
functions (`detectPools()`, `processCandle()` signal logic).

### Step 9: Local paper run (3-5 days)

Run `BB_SYMBOL=ethusdt BB_CAPITAL=100 node src/live/liveRunner.js` (without BB_LIVE=true).
Verify signal fires at expected rate. Verify stop/TP placement looks structurally correct.
No orders are placed. This is purely to validate the live implementation matches backtest logic.

### Step 10: Enable BB_LIVE=true

Only after Step 9 shows behavior matching the backtest. Start with 0.5% risk (half of
RISK_PCT). Run for 20+ live trades before increasing size.

---

## 6. The position sizing rule that was violated

From the paper (Section 4.5, cost sensitivity): strategy becomes unprofitable at ~0.4%
per transaction. Our cost: 0.22% round trip = 0.11% per leg. Well inside the viable range.

But only if RISK_PCT actually governs size — which it didn't.

The live runner bug (confirmed in AUDIT.md §3.4): at $95 equity with 20x leverage,
the leverage cap bound sizing on every trade. "2% risk" was never executed.

**Rule**: Before deploying, verify RISK_PCT is the binding constraint, not the leverage cap.

```
riskQty = (equity × RISK_PCT) / (stopDist + entry × LOSS_COST_RATE)
maxQty  = equity × 0.8 × LEVERAGE / price
cappedBy = riskQty < maxQty ? 'RISK_PCT' : 'LEVERAGE'
```

If `cappedBy === 'LEVERAGE'`, reduce leverage until RISK_PCT binds.
At $100 equity, 1% risk ($1), stop = 1% of price ($25), position = $100 notional.
At 5x leverage, maxQty = $400 notional → RISK_PCT binds. ✓
At 20x leverage, maxQty = $1,600 notional → RISK_PCT also binds. ✓
(The old problem: stop was 0.09% not 1%, so riskQty was enormous.)

---

## 7. The fee math reference table

Always use these numbers. Never estimate.

| Metric | Value | Source |
|---|---|---|
| Taker fee | 0.05% | Account's own userTrades fills |
| Maker fee | 0.02% | Account's own userTrades fills |
| Slippage (market order) | 0.06%/side | liveRunner.js SLIP constant |
| Round trip (taker in, maker TP) | 0.13% | WIN path |
| Round trip (taker in, taker SL) | 0.22% | LOSS path |
| Break-even stop distance (LOSS path) | 0.22% of price | |
| ETH at $2500: break-even stop | $5.50 | |
| 5m ATR for ETH | ~$6-8 | |
| 15m ATR for ETH | ~$12-15 | |
| 60m ATR for ETH | ~$25-35 | |

Break-even win rate at 2R, 0.22% loss cost:
```
need WR ≥ loss_cost / (win_reward + loss_cost)
     WR ≥ 0.22% / (0.44% + 0.22%) = 33%
```

At 15m with 1% stop (4× ATR): loss cost is 0.22% / 1.0% = 22% of risk. Viable.
At 5m with 0.25% stop (0.5× ATR): loss cost is 0.22% / 0.25% = 88% of risk. Unwinnable.

---

## 8. The regime insight from the paper

The paper found (Section 6.1, Figure 7): "Problematic periods when the strategy started
to lose steadily were the periods when Buy-and-Hold recovered and flat periods with low
volatility."

This matches our LSO results exactly: RANGING PF 1.400 vs BULL PF ∞ in 2025 OOS.

**Implication**: The LSO strategy should NOT trade in RANGING. It already has a regime
filter for this. The filter is not a bug or a loss of opportunity — it is the correct behavior
validated by the academic literature and our own backtest data.

When the bot is flat in RANGING, that is the strategy working correctly. Do not relax the
regime filter to get more trades.

---

## 9. The one-sentence version of every important lesson

For when you need to remember this quickly:

1. **Never tune parameters on data you've already seen results for.** Once you've seen the
   number, that data is in-sample.

2. **Measure raw alpha before building.** If forward returns after the signal are not
   statistically better than unconditional returns, no amount of strategy construction will fix it.

3. **Better MaxDD ≠ better strategy.** Check Profit Factor, Sharpe, and zero-cost expectancy.

4. **The timeframe determines whether fees are a problem.** At 3-5m with 0.22% costs,
   the math is structurally unwinnable. At 60m+, fees are ~5-10% of the expected move.

5. **The paper's OOS result was NOT better than Buy-and-Hold on Sharpe.** But its
   drawdown control was dramatically better. Combined with Buy-and-Hold, it outperformed
   everything. This is the realistic expectation for any active crypto strategy.

6. **The LSO-Long strategy has real evidence.** It is the only thing in this codebase that
   has passed a proper OOS test. Use it.

7. **Walk-forward window length matters as much as the strategy itself.** The paper found
   3-day training windows performed terribly, while 14-day training performed well. Don't
   assume your backtest represents production just because it's "out-of-sample."

---

## 10. Current action state (Aug 2026)

**What is done:**
- LSO-Long strategy: fully backtested, 4-year in-sample + 2025 OOS pass ✓
- liveRunner.js execution layer: all 14 bugs fixed ✓
- Fee model: correct (taker+maker on notional) ✓
- Position sizing: fee-aware, leverage-checked ✓
- Conservative backtest fills: 1-tick penetration + 1-bar delay ✓

**What is NOT done:**
- LSO-Long has not been re-validated on 2025 Sep–Aug 2026 data (16 new months)
- LSO-Long signal has not been ported from `src/backtest/lso_runner.js` into `src/live/liveRunner.js`
- The live runner still uses the broken pool-sweep + CVD signal

**Next actions in order:**
1. Run `npm run backtest:lso` on full dataset including 2025-2026 data
2. Check if PF has degraded further (expected; measure how much)
3. If PF still > 1.3 on all available data: proceed to Step 4 from Section 5
4. Port LSO signal logic into liveRunner.js (replace `detectPools()` + signal section only)
5. Local paper run to verify
6. Enable live trading only after paper run confirms

**What not to do:**
- Do not attempt any more scalping strategy development at 3-5m
- Do not build new signals without running the alpha test first (Section 5, Step 1)
- Do not touch the 2025 Sep–present data until the strategy is frozen

---

*Guide created: 2026-08-19*
*Sources: arXiv:2602.10785 (Mroziewicz & Ślepaczuk), AUDIT.md, QUANT-REVIEW.md,
backtest_scalper.js results, backtest_mean_reversion.js results, backtest_vwap_funding.js results*
