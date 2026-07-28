# BulletBrain Quant Research Platform v1.0 — Final Report

**Date:** 2026-07-28
**Mandate:** `src/live/prompt4.txt` — convert the repository from a trading bot
into a continuously-operating quantitative research platform.
**Status:** Implemented, verified end-to-end, running autonomously.
**Production runner:** `liveRunner.js` is **frozen** and was not modified in this phase.

```bash
npm run claude:once            # one full research cycle
npm run claude:auto            # continuous (VPS)
pm2 start ecosystem.research.config.js
cat results/research/LEADERBOARD.md
cat docs/RESEARCH.md           # developer documentation
```

---

## 1. Completed Architecture

```
Data Layer          dataset.js ─ downloader.js ─ data/historical/*.ndjson
                    update · inventory · completeness · content fingerprint
                          │
Feature Layer       features.js
                    indicators · market structure (BOS/CHOCH/swings) · VWAP
                    sessions · volatility regime · order-flow proxy (CVD)
                          │
Strategy Layer      registry.js (14 hypotheses) + templates.js
                    stops · targets · management · entries · filters · builder
                          │
Research Engine     engine.js  ← SINGLE SOURCE OF TRUTH
                    honest fills · risk engine · fee-inclusive sizing · simulator
                          │
Validation Layer    validation.js · stats.js · sensitivity.js
                    walk-forward · splits · bootstrap · Monte Carlo
                    parameter stability · cross-timeframe · cost resilience
                          │
Analytics           analytics.js
                    beta check · attribution · drawdown episodes · concentration
                          │
Ranking Engine      ranking.js
                    10 hard gates → composite score → lifecycle status
                          │
Reports             reporter.js → Markdown · JSON · CSV
                          │
Archive             experiments.js (append-only JSONL) · journal.js (Markdown)
                          │
claude-runner       --auto · --once · --replay · --live
```

**Verified structural guarantee:** `claude-runner.js` has no exchange client, no
API-key read, and no signing code in its dependency graph. The only match for
order/key/signing terms in the file is the comment stating this. It cannot place
an order by construction, not by configuration.

---

## 2. Implemented Modules

| Module | Responsibility | Notable design decision |
|---|---|---|
| `core/candles.js` | Load 15m base; resample to 30m–1d; HTF alignment | Only **complete** buckets are emitted, so no partial bar can leak lookahead. HTF context is usable only once `closeTime <= current openTime` |
| `core/dataset.js` | Update, inventory, version datasets | Fingerprints by size + mtime + hash of the final 64KB. Hashing 28MB/symbol/cycle would dominate runtime; this still detects any append, truncation or rewrite |
| `core/features.js` | All features | Every value at `i` uses only `0..i`. Swing pivots expose `confirmedAt` (a pivot at `p` is unknown until `p+k`) |
| `core/costs.js` | Fee/slippage/funding | Encodes the asymmetry the old system missed: a STOP_MARKET can never be maker, so losses always pay taker twice |
| `core/engine.js` | Execution + risk + sizing | Signal on bar `i` fills at bar `i+1` **open**; stop wins intrabar ties; gaps fill at the open; risk caps loss **including both fee legs** |
| `core/metrics.js` | Performance metrics | Everything in **R**, not dollars — R survives ruin, resizing and compounding (a dollar-based run previously hit zero equity and reported "$-0.00" for every later year) |
| `core/stats.js` | Significance | Bonferroni + Benjamini-Hochberg; **stationary block bootstrap** (block 20) because IID resampling destroys the regime clustering that dominates trade outcomes |
| `core/validation.js` | Protocols | Features always computed on the full series, then trades filtered by window — slicing first would give each window a different EMA seed and make windows incomparable |
| `core/sensitivity.js` | Stability | Detects parameter **cliffs** (largest single-step drop) and single-timeframe artefacts |
| `core/analytics.js` | Explains results | Long/short decomposition, drawdown episodes, and edge concentration (does removing 5 trades flip the sign?) |
| `core/ranking.js` | Gates + score + lifecycle | Hard gates first; score cannot compensate for a failed gate |
| `core/experiments.js` | Archive | Append-only JSONL: a partial write cannot destroy prior records. Stores git commit + dataset version. Includes linear decay detection |
| `core/journal.js` | Institutional memory | Auto-writes what was tested/improved/failed/why/next; derives the research queue from observations rather than a fixed list |
| `strategies/templates.js` | Builder | `defineStrategy()` validates shape at registration, so a malformed strategy fails loudly instead of silently producing zero trades |
| `orchestrator.js` | One cycle | Every step wrapped: data failure falls back to cache, a throwing strategy is skipped, cycle errors never exit the process |
| `claude-runner.js` | Runner | `--auto` persists cycle number, handles SIGINT/SIGTERM gracefully |

**Bug found and fixed in my own code during verification:** the leaderboard
comparator was poisoned by `NaN`. `range_fade_4h` produces zero trades →
`avgR = NaN` → NaN comparisons return NaN (treated as 0) → the ordering of every
row compared against it was scrambled, which pushed the best candidate to rank 8.
Fixed by mapping non-finite values to `-Infinity`, and by introducing a distinct
`NO_SIGNALS` status so "produced no evidence" is never filed as "performed badly".

---

## 3. Research Results (cycle 4, measured costs)

14 strategies × 2 symbols = 28 tests → Bonferroni bar |t| > 3.12.

| Rank | Strategy | TF | Status | PF | Expectancy | Sharpe | Robustness | Beta check |
|---|---|---|---|---|---|---|---|---|
| 1 | mtf_structure_align_4h | 4h | RESEARCH | 1.24 | **+0.1080R** | 0.82 | 80% | **symmetric** |
| 2 | donchian_breakout_4h | 4h | RESEARCH | 1.18 | +0.0988R | 0.38 | 70% | LONG-ONLY |
| 3 | lowvol_trend_4h | 4h | RESEARCH | 1.17 | +0.0896R | 0.56 | 70% | LONG-ONLY |
| 4 | composite_trend_vol_4h | 4h | RESEARCH | 1.10 | +0.0524R | 0.33 | 60% | **symmetric** |
| 5 | ts_momentum_1d | 1d | RESEARCH | 1.12 | +0.0484R | 0.24 | 70% | LONG-ONLY |
| 6 | bos_continuation_4h | 4h | RESEARCH | 1.02 | +0.0113R | 0.10 | 60% | **symmetric** |
| 7 | session_breakout_1h | 1h | RESEARCH | 0.90 | −0.0458R | −0.66 | 40% | both negative |
| 8 | vol_squeeze_breakout_4h | 4h | RESEARCH | 0.84 | −0.1001R | −0.37 | 20% | both negative |
| 9 | range_fade_4h | 4h | NO_SIGNALS | — | — | — | — | — |
| 10 | choch_reversal_4h | 4h | REJECTED | 0.82 | −0.1220R | −1.07 | 20% | both negative |
| 11 | zscore_reversion_1h | 1h | REJECTED | 0.65 | −0.1675R | −4.48 | 0% | both negative |
| 12 | vwap_reversion_1h | 1h | REJECTED | 0.58 | −0.1791R | −11.09 | 0% | both negative |
| 13 | htf_trend_pullback_4h | 4h | REJECTED | 0.70 | −0.2259R | −2.01 | 0% | both negative |
| 14 | trend_pullback_1h | 1h | REJECTED | 0.55 | −0.3402R | −7.21 | 0% | both negative |

**Nothing is promoted.** No strategy cleared all ten hard gates.

### The one genuinely new finding

`mtf_structure_align_4h` (require confirmed market structure, the slow trend
filter, and a break of structure to all agree) is the **first candidate in this
project that is both positive and not beta**:

- expectancy **+0.108R**, PF 1.24, Sharpe 0.82
- **80% of walk-forward folds positive** — highest in the registry
- lowest drawdown among positives (11.6R)
- **passes the two-sided gate**: long and short both profitable

It fails exactly two gates: significance (t = 1.90 vs bar 3.12) and bootstrap CI
lower bound (−0.074R). That is an honest "promising but unproven", which is why
its status is `RESEARCH` and not `CANDIDATE`.

This also answers a question left open in the previous phase. At 15m, stacking
confirmations destroyed alpha monotonically. At 4h, the *most* confirmation-heavy
strategy is the best one. Confirmation stacking is not inherently harmful — it was
harmful at 15m because each filter cost trade count without adding move size to
pay for fixed fees.

### Findings that are solid regardless of promotion

1. **Mean reversion is significantly unprofitable after costs.**
   `vwap_reversion_1h` wins **52.4%** of trades with **t = −26.1**. High win rate
   with negative expectancy is the signature of a payoff smaller than its cost.
2. **Continuation beats reversal.** Matched pair, built deliberately to resist
   confirmation bias: `bos_continuation_4h` +0.011R vs `choch_reversal_4h`
   −0.122R (t = −2.50).
3. **Cost damage scales inversely with holding period.** Identical logic loses
   0.239R per trade to a cost doubling at 1h, 0.139R at 4h, and 0.003R at 1d.
4. **Long-only "edges" are beta.** Three strategies with PF 1.12–1.18 had their
   entire edge on the long side while ETH returned 2.59× over the sample. This is
   now an automated hard gate, not a manual observation.

---

## 4. VPS Operation & Automation Workflow

```bash
git clone <repo> && cd kardiax && npm install
node src/live/claude-runner.js --once          # verify
pm2 start ecosystem.research.config.js
pm2 save && pm2 startup
pm2 logs bulletbrain-research
```

Each cycle (~5–7s at 2 symbols × 14 strategies, hourly by default):

```
download latest candles  → dataset.updateAll (incremental, resumable)
update features          → per (symbol, timeframe), cached within the cycle
run strategy battery     → all 14 strategies, both symbols
validate                 → splits · walk-forward · bootstrap · Monte Carlo · costs
analyse                  → beta · attribution · drawdown · concentration
rank                     → 10 hard gates → score → lifecycle status
report                   → LEADERBOARD.md · CYCLE_NNNN.md · JSON · CSV
archive                  → experiments.jsonl (config + dataset version + git commit)
journal                  → RESEARCH-JOURNAL.md (tested/improved/failed/why/next)
```

Resilience, verified by test: data-update failure falls back to cached data; a
throwing strategy is logged and skipped; cycle errors are logged without exiting;
cycle number persists across restarts (observed continuing 1→2→3→4); SIGINT
finishes the current cycle and exits cleanly.

**Disk:** ~28MB per symbol of history, plus ~6MB of JSON per scenario per cycle.
Prune `research_scenario-*.json` periodically; keep `experiments.jsonl` forever
(it is small and is the decay-detection substrate).

---

## 5. Example Outputs

`LEADERBOARD.md` — ranking plus a written justification per strategy:

```
| 1 | mtf_structure_align_4h | 4h | 0 | **RESEARCH** | 1.24 | 0.1080R | 0.82 | 80% | low |

### mtf_structure_align_4h — RESEARCH
Did not clear all hard gates; evidence is insufficient rather than damning.
Beta check: symmetric — genuine two-sided edge
Failed gates:
- statistical_significance: t=1.90 (bar 3.12)
- bootstrap_ci: 95% CI lower -0.0737R
```

`RESEARCH-JOURNAL.md` — auto-written, with a data-derived research queue:

```
### Edge decay watch
- mtf_structure_align_4h: stable (0.1080R → 0.1080R over 4 cycles)

### What should be tested next
- Regress donchian_breakout_4h, lowvol_trend_4h, ts_momentum_1d against
  buy-and-hold and test residual alpha — they show positive expectancy but only
  on one side, which is beta, not skill.
- Run parameter-stability sweeps on mtf_structure_align_4h, lowvol_trend_4h —
  positive but not significant; stability would distinguish a weak real effect
  from noise.
- Test the INVERSE of vwap_reversion_1h, trend_pullback_1h — significantly
  negative expectancy is exploitable information if it survives costs in reverse.
```

---

## 6. Remaining Limitations

1. **Two-symbol universe.** The single largest constraint. It blocks
   cross-sectional/market-neutral strategies — the family that structurally
   avoids the beta contamination currently disqualifying three candidates.
2. **OHLCV-only features.** No funding, liquidations, order-book imbalance or
   cross-exchange basis. `fundingDownloader.js` exists but is not wired into
   `features.build()`.
3. **`sensitivity.sweep()` is implemented but not orchestrated.** Cross-timeframe
   and cost resilience run per cycle; parameter sweeps must be invoked manually.
   The mandate lists parameter stability as automatic — it is available, not yet
   automatic.
4. **No portfolio layer.** Strategies are evaluated standalone. There is no
   correlation matrix, no combined equity curve, no allocation logic.
5. **No hypothesis *generation*.** The mandate asks the platform to "generate
   hypotheses". It evaluates, ranks and *suggests* next experiments, but a human
   still writes each strategy object. Genuine automated generation (feature
   search / symbolic regression) is not implemented — and would need far stronger
   overfitting controls than are in place.
6. **Beta separation is a gate, not a regression.** The platform flags long-only
   edges but does not regress strategy returns on buy-and-hold to report residual
   alpha with its own t-stat.
7. **Resampled HTF bars** derive from 15m data. Self-consistent, but boundary
   handling may differ marginally from exchange-native 4h bars.
8. **Single-machine, in-process.** No job queue, no parallelism across cores, no
   database. Fine at 14×2; a 500-strategy × 50-symbol sweep would need both.
9. **Production log investigation still outstanding** — the VPS blocks this
   machine's IP (see `QUANT-REVIEW.md` §9).

---

## 7. Future Roadmap & Recommended Research Priorities

**Priority 1 — Expand the universe to 20+ symbols.** Highest value per unit of
effort. Enables cross-sectional momentum (the best-documented effect the platform
cannot currently see) and is naturally market-neutral, removing the beta problem
at the source. Cost: config change plus download time.

**Priority 2 — Resolve `mtf_structure_align_4h`.** It is the only two-sided
positive with meaningful robustness. Run parameter-stability sweeps and, once the
universe is larger, re-test significance on a bigger sample. Either it clears the
bar or it dies honestly.

**Priority 3 — Wire funding-rate features in.** The downloader exists; funding is
the cheapest non-OHLCV signal available and has genuine economic content
(positioning stress).

**Priority 4 — Automate parameter stability** into the orchestrator, so every
positive candidate is stability-tested every cycle without a human asking.

**Priority 5 — Beta regression** replacing the current binary gate, so a
long-biased strategy can be assessed as a *risk overlay* on honest terms rather
than simply disqualified.

**Priority 6 — Portfolio layer**: correlation, allocation, combined equity.

**Not recommended:** more OHLCV indicators at 15m–1h. Twelve hypotheses in the
previous phase and six more here have now failed there, for a structural reason
that is measured rather than guessed.

---

## 8. Platform Maturity Assessment

### Honest completeness: **62%** of a genuine institutional research stack.

Scored by component, weighted by how much each matters:

| Layer | Weight | Score | Assessment |
|---|---|---|---|
| Execution/backtest engine | 20% | **90%** | Genuinely strong. Conservative fills, correct fee asymmetry, fee-inclusive sizing, no lookahead. The best part of the platform |
| Statistical validation | 20% | **80%** | Walk-forward, splits, block bootstrap, Monte Carlo, multiple-testing correction all present and enforced. Missing: purged/embargoed CV, deflated Sharpe, PBO |
| Data layer | 12% | **65%** | Incremental, resumable, versioned, completeness-checked. Missing: funding integration, tick/order-book data, a real store (still flat NDJSON) |
| Feature layer | 12% | **55%** | Solid OHLCV/structure/session/volatility coverage. No order-book, liquidation, funding or cross-asset features |
| Strategy layer | 10% | **70%** | Clean registry + template builder; adding a hypothesis needs no engine change. Only 14 hypotheses, all human-written |
| Analytics | 8% | **65%** | Beta check, attribution, drawdown episodes, concentration. No factor decomposition, no regression-based attribution |
| Ranking/lifecycle | 8% | **75%** | Hard gates before score, explicit statuses, written justification per verdict. Thresholds are judgement calls, not calibrated |
| Automation/ops | 6% | **70%** | Autonomous, resilient, PM2-ready, archived, journalled. Single-process, no queue, no alerting |
| Portfolio construction | 4% | **0%** | Not implemented |

**Weighted total ≈ 62%.**

### What the remaining 38% requires

- **Cross-sectional infrastructure** (~8%): 20+ symbols, universe management,
  cross-sectional ranking, market-neutral construction.
- **Non-OHLCV data** (~8%): order book, liquidations, funding, basis. This is
  where crypto effects that survive costs actually live, and it is a data
  engineering project, not a modelling one.
- **Advanced overfitting controls** (~7%): purged k-fold with embargo, deflated
  Sharpe ratio, probability of backtest overfitting, White's reality check. The
  platform corrects for multiple testing but does not yet quantify selection bias
  across an entire search.
- **Portfolio layer** (~6%): correlation, allocation, risk parity, combined
  drawdown.
- **Automated hypothesis generation** (~5%): feature/structure search under
  strict selection-bias control.
- **Infrastructure hardening** (~4%): job queue, parallel execution, a real
  database, monitoring and alerting.

### Honest framing

This is a **competent single-researcher platform with institutional-grade
validation discipline**, not institutional infrastructure. Its genuine strengths
are the honest execution engine and the fact that the acceptance gate cannot be
argued with — it rejected every strategy including the ones I would have been
tempted to promote, and it caught a NaN-ordering bug in its own ranking.

Its genuine weakness is breadth: two symbols and one data modality. That is a
data problem, not a code problem, and it is why the platform can currently prove
things are *not* edges far more convincingly than it can find one.

**Deployment recommendation: unchanged — deploy nothing.** The best candidate
(`mtf_structure_align_4h`) is promising, two-sided and robust across folds, but
t = 1.90 against a bar of 3.12 is not evidence, and the honest response is more
data rather than a lower bar.
