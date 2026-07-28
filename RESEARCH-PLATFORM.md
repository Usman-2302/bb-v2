# BulletBrain — Research Platform & Phase 2 Strategy Discovery

**Date:** 2026-07-28
**Mandate:** `src/live/prompt3.txt` — treat the existing strategy as deprecated,
build a professional quant research platform, and discover a strategy that
genuinely deserves deployment.

```bash
npm run research                      # full pipeline: all strategies, all symbols
npm run research -- --scenario harsh  # cost sensitivity
npm run research:beta                 # is the edge alpha, or long-side beta?
npm run claude                        # research runner, replay mode
npm run claude:live                   # research runner, live stream (no orders)
```

---

## 1. Overall Architecture

```
config.research.js                 research config, fully separate from production
src/research/
├── core/
│   ├── candles.js     load 15m base, resample to 1h/4h/1d, HTF alignment
│   ├── features.js    indicators, market structure (BOS/CHOCH), VWAP, sessions
│   ├── costs.js       taker/maker/slippage/funding + break-even move
│   ├── engine.js      the pluggable pipeline + all execution realism
│   ├── metrics.js     R-based PF/Sharpe/Sortino/MAR/DD/MFE/MAE
│   ├── stats.js       t-tests, Bonferroni, Benjamini-Hochberg, bootstrap, Monte Carlo
│   └── validation.js  splits, walk-forward, acceptance gate
├── strategies/registry.js         10 independent hypotheses
├── reports/reporter.js            console + JSON + CSV + Markdown
├── run_research.js                batch runner
└── benchmark_beta.js              alpha-vs-beta discriminator
src/live/claude-runner.js          research runner (replay + live, NEVER trades)
```

**Pipeline:** `signal → context → confirmation → risk → entry → exit → management → evaluation`.
Each layer is independently replaceable. Adding a hypothesis means adding one
object to the registry; the engine is never edited.

**The single most important design decision:** `claude-runner.js` and
`run_research.js` both call the *same* `core/engine.js`. A number seen in the
research runner is reproducible in the offline pipeline by construction. The
deprecated system's failure mode was a paper mode that booked a flat `risk*1.8`
on any target touch and could not lose money to fees — divergence between what
was measured and what was traded.

### Execution realism enforced by the engine (not by strategy authors)

| Rule | Why |
|---|---|
| Signal on bar *i* is filled at bar *i+1* **open** | Deciding and filling on the same closed bar is unachievable live and quietly worth several bps |
| Market entries pay slippage + taker | Entry is always a taker fill |
| Stops are STOP_MARKET: taker + slippage | A stop-market can never rest as maker — losses are structurally dearer than wins |
| Targets are resting LIMIT: maker, no slippage | Price came to you |
| Bar containing both stop and target → **stop fills first** | OHLC cannot resolve order; the optimistic reading is how backtests lie |
| Gap through the stop fills at the **open**, not the stop | Stop-market guarantees trigger, not price |
| `riskDollars` caps total loss **including both fee legs** | The old sizing made a "2%" trade lose 2.76% |

### Statistical standards enforced by the acceptance gate

A strategy is accepted only if, **on both symbols**: ≥50 trades, expectancy > 0,
|t| > Bonferroni bar, PF > 1, no split with ≥10 trades negative, bootstrap 95% CI
lower bound > 0, and ≥60% of walk-forward folds positive.

---

## 2. Strategies Researched

Ten independent hypotheses, each with an economic rationale, none a variant of
the deprecated sweep system. Timeframe was treated as the primary design variable
because QUANT-REVIEW.md established that 15m OHLCV alpha (1–3 bps) sits an order
of magnitude below the round-trip cost floor (7–10 bps).

| Strategy | TF | Hypothesis |
|---|---|---|
| `ts_momentum_1d` | 1d | Time-series momentum (Moskowitz/Ooi/Pedersen 2012) |
| `donchian_breakout_4h` | 4h | Trend-following breakout (Donchian/Turtle) |
| `htf_trend_pullback_4h` | 4h | Buy pullbacks inside an established trend |
| `bos_continuation_4h` | 4h | Break-of-structure continuation |
| `choch_reversal_4h` | 4h | Change-of-character reversal (paired control vs BOS) |
| `vol_squeeze_breakout_4h` | 4h | Volatility clustering (Engle/ARCH) |
| `lowvol_trend_4h` | 4h | Trend conditioned on low realised vol — the one 15m near-miss, promoted |
| `vwap_reversion_1h` | 1h | Reversion to the institutional execution benchmark |
| `zscore_reversion_1h` | 1h | Overextension reversion / inventory rebuild |
| `trend_pullback_1h` | 1h | **Timeframe control**: identical logic to the 4h pullback |

---

## 3. Results

Pooled across ETH + BTC, measured costs, 1% risk/trade, Bonferroni bar |t| > 3.02
(20 tests).

| Strategy | TF | n | WR | avgR | PF | t | Sharpe | maxDD(R) | verdict |
|---|---|---|---|---|---|---|---|---|---|
| donchian_breakout_4h | 4h | 269 | 38.3% | **+0.0988** | 1.18 | 0.90 | 0.38 | 16.1 | reject |
| lowvol_trend_4h | 4h | 616 | 39.9% | **+0.0915** | 1.17 | 1.34 | 0.57 | 29.4 | reject |
| ts_momentum_1d | 1d | 176 | 44.9% | **+0.0484** | 1.12 | 0.54 | 0.24 | 9.7 | reject |
| bos_continuation_4h | 4h | 600 | 42.7% | +0.0113 | 1.02 | 0.24 | 0.10 | 24.3 | reject |
| vol_squeeze_breakout_4h | 4h | 136 | 32.4% | −0.1001 | 0.84 | −0.85 | −0.37 | 24.9 | reject |
| choch_reversal_4h | 4h | 775 | 31.9% | −0.1220 | 0.82 | −2.50 | −1.07 | 99.3 | reject |
| zscore_reversion_1h | 1h | 3152 | 41.3% | −0.1675 | 0.65 | −10.54 | −4.48 | 528 | reject |
| vwap_reversion_1h | 1h | 12622 | 52.4% | −0.1791 | 0.58 | −26.09 | −11.09 | 2262 | reject |
| htf_trend_pullback_4h | 4h | 807 | 28.6% | −0.2247 | 0.70 | −4.66 | −2.00 | 183 | reject |
| trend_pullback_1h | 1h | 3874 | 27.9% | −0.3402 | 0.55 | −16.98 | −7.21 | 1325 | reject |

### 3.1 Three findings that are robust regardless of acceptance

**(a) Mean reversion is reliably unprofitable after costs.** `vwap_reversion_1h`
has a 52.4% win rate — and t = **−26.1**. That is not noise; it is a
*significantly negative* edge. It wins slightly more often than it loses and still
bleeds, because the fixed cost exceeds the small captured move. High win rate
with negative expectancy is the classic signature of a strategy whose payoff is
smaller than its cost.

**(b) Direction of structure matters, and the paired control proves it.**
`bos_continuation_4h` (+0.011R) versus `choch_reversal_4h` (−0.122R) — same
feature, opposite reading. Trend continuation is weakly positive; counter-trend
reversal is significantly negative (t = −2.50). This was deliberately built as a
matched pair to guard against confirmation bias, and it resolved cleanly.

**(c) The timeframe control quantifies the cost thesis.** Identical pullback logic:

| | 1h | 4h |
|---|---|---|
| expectancy | −0.3402 R | −0.2247 R |
| cost sensitivity (optimistic → harsh) | −0.2410 → −0.4804 (**Δ 0.239**) | −0.1679 → −0.3067 (Δ 0.139) |

The 1h version loses **72% more per trade** to the same cost increase. Extending
to the daily strategy, `ts_momentum_1d` moves only 0.0396 → 0.0368 (**Δ 0.003**)
across a doubling of costs — it is essentially cost-immune. This is the timeframe
thesis measured rather than asserted: **fixed costs punish short holding periods
in direct proportion.**

### 3.2 The finding that kills the positive candidates

Three of the four positive strategies decompose as follows:

| Strategy | LONG n | LONG avgR | SHORT n | SHORT avgR | verdict |
|---|---|---|---|---|---|
| donchian_breakout_4h | 154 | **+0.2080** | 115 | −0.0475 | LONG-ONLY |
| lowvol_trend_4h | 308 | **+0.1924** | 308 | −0.0094 | LONG-ONLY |
| ts_momentum_1d | 81 | **+0.1337** | 95 | −0.0244 | LONG-ONLY |
| bos_continuation_4h | 309 | +0.0040 | 291 | +0.0190 | symmetric |

**Their entire edge sits on the long side.** Over this sample ETH returned 2.59×
and BTC 2.17×. A long-biased system in a rising market captures drift and reports
it as skill. Buy-and-hold earned that same drift with no fees, no slippage and no
execution risk.

The only strategy with a genuine two-sided edge is `bos_continuation_4h` — whose
expectancy is +0.011R at t = 0.24, i.e. statistically indistinguishable from zero.

---

## 4. Strategies Accepted

**None.**

No hypothesis met the acceptance criteria. The closest, `lowvol_trend_4h`,
reaches t = 1.74 under optimistic costs — short of even a naive |t| > 2, let alone
the multiple-testing bar of 3.02 — and its edge is long-only.

I am not going to manufacture an acceptance. A PF of 1.17 at t = 1.34 that
disappears on the short side is exactly the kind of result the deprecated system
was built on.

---

## 5. Statistical Justification

- **Multiple testing.** 20 tests (10 strategies × 2 symbols) → Bonferroni |t| >
  3.02 at family α = 0.05. A naive |t| > 2 would admit ~1 false positive here.
- **Splits.** TRAIN 2021-01→2025-06, VALID 2025-07→2026-02, OOS 2026-03→present;
  disjoint and chronological.
- **Walk-forward.** 5 rolling folds; ≥60% must be positive.
- **Bootstrap.** Stationary block bootstrap (block 20) on the R series;
  requires the 95% CI lower bound above zero. Block resampling preserves the
  regime clustering an IID bootstrap destroys.
- **Monte Carlo.** 2,000 reshuffles with 5% dropout for drawdown distribution.
- **Cost sensitivity.** Three scenarios spanning 2–12 bps slippage.
- **Cross-symbol.** Every criterion must hold on ETH *and* BTC.
- **Beta control.** Long/short decomposition plus buy-and-hold benchmark.

---

## 6. Remaining Weaknesses

1. **The universe is two symbols.** Cross-sectional strategies (relative strength,
   pairs, basis) are the largest untested family and need 20+ symbols.
2. **Still OHLCV-only.** Order-book imbalance, liquidations, funding dislocation
   and cross-exchange basis remain untested — and are where crypto effects that
   survive costs generally live.
3. **No parameter sensitivity surfaces yet.** Strategies use single fixed
   parameterisations. Deliberate: sweeping parameters before establishing a
   significant base effect is how curve-fitting starts.
4. **Long-only beta is not fully separated.** The benchmark identifies it; a
   proper treatment would regress strategy returns on buy-and-hold and report
   the residual alpha with its own t-stat.
5. **Resampled HTF bars** are built from 15m data. Correct and self-consistent,
   but boundary handling could differ marginally from exchange-native 4h bars.
6. **Live mode evaluates signals only.** It never simulates fills in real time, so
   live/offline agreement is guaranteed by shared code rather than verified by
   parallel execution.

---

## 7. Deployment Recommendation

**Deploy nothing.** No strategy in this study earned it.

Ranked next experiments, by expected information per unit of effort:

1. **Regress the long-only candidates against buy-and-hold** and test whether any
   residual alpha survives. If `lowvol_trend_4h` beats buy-and-hold risk-adjusted
   (its Sharpe 0.57 vs buy-and-hold 0.22–0.24 is suggestive, and its drawdown is
   far smaller), it may have value as a **risk-management overlay** — not as an
   alpha source. That is a legitimate, honest use of a beta-timing signal.
2. **Expand the universe to 20+ symbols** and test cross-sectional momentum. This
   is the best-documented effect in the literature that this platform cannot
   currently see, and it is naturally market-neutral — which structurally removes
   the beta contamination that defeated three candidates here.
3. **Add non-OHLCV data**, in order of expected value: funding rates (already
   downloadable by `fundingDownloader.js`), liquidation clusters, order-book
   imbalance.
4. **Only then** consider parameter sensitivity surfaces, and only for a strategy
   that has already cleared significance at a single sensible parameterisation.

**Unchanged from previous reviews:** do not re-enable `BB_LIVE=true` on the
deprecated sweep strategy, and do not treat exchange migration as a fix.

---

## 8. Honest Summary

The platform works, is reusable, and enforces the discipline that was missing.
Ten economically justified hypotheses were tested to institutional standards.

**No statistically significant edge was found.** Three strategies looked
profitable until the beta control ran, and the fourth was statistically zero.
The clearest positive results in the entire study are negative ones: mean
reversion is reliably unprofitable after costs (t = −26), counter-trend reversal
is significantly worse than continuation, and cost damage scales inversely with
holding period by a measured factor of ~70× between daily and hourly.

Those are real, reusable findings. They just are not a trading strategy.
