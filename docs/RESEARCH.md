# BulletBrain Research Platform — Developer Documentation

How the platform works, how to extend it, and how to operate it.

---

## Quick start

```bash
npm install
npm run claude -- --once          # one full research cycle
npm run claude:auto               # continuous, for a VPS
cat results/research/LEADERBOARD.md
```

---

## Folder structure

```
config.research.js                  research config — NEVER read by production
src/research/
├── core/
│   ├── candles.js      load 15m base, resample to 1h/4h/1d, HTF alignment
│   ├── dataset.js      dataset manager: update, inventory, versioning
│   ├── features.js     indicators, market structure, VWAP, sessions, volatility
│   ├── costs.js        fee/slippage/funding model + break-even move
│   ├── engine.js       THE execution engine — single source of truth
│   ├── metrics.js      R-based PF/Sharpe/Sortino/MAR/DD/MFE/MAE
│   ├── stats.js        t-tests, Bonferroni, BH-FDR, block bootstrap, Monte Carlo
│   ├── validation.js   splits, walk-forward, acceptance
│   ├── sensitivity.js  parameter sweeps, cross-timeframe, cost resilience
│   ├── analytics.js    beta check, attribution, drawdown, edge concentration
│   ├── ranking.js      hard gates, composite score, lifecycle statuses
│   ├── experiments.js  append-only experiment archive + decay detection
│   └── journal.js      auto-written research journal
├── strategies/
│   ├── registry.js     all hypotheses
│   └── templates.js    stops/targets/manage/entries/filters + defineStrategy()
├── reports/reporter.js console + JSON + CSV + Markdown
├── orchestrator.js     one full autonomous cycle
├── run_research.js     manual batch runner
└── benchmark_beta.js   alpha-vs-beta discriminator
src/live/claude-runner.js           research runner (auto/once/replay/live)
```

---

## Architecture

```
Data Layer      dataset.js -> downloader.js -> data/historical/*.ndjson
                    |
Feature Layer   features.js  (indicators, structure, VWAP, sessions, volatility)
                    |
Strategy Layer  registry.js + templates.js
                    |
Research Engine engine.js  (honest fills, risk, sizing, trade simulation)
                    |
Validation      validation.js + stats.js + sensitivity.js
                    |
Analytics       analytics.js  (beta, attribution, drawdown, concentration)
                    |
Ranking         ranking.js  (hard gates -> score -> lifecycle status)
                    |
Reports         reporter.js -> Markdown + JSON + CSV
                    |
Archive         experiments.js (JSONL) + journal.js (Markdown)
```

**The execution engine is the single source of truth.** `claude-runner`,
`run_research` and the orchestrator all call `core/engine.js`. Any future
production runner must do the same. The deprecated system's collapse traced
directly to a paper mode that modelled fills differently from live.

---

## Strategy lifecycle

```
  NO_SIGNALS ── entry conditions never fired (a specification result)
       │
  RESEARCH ──── tested; evidence insufficient either way
       │
  REJECTED ──── significantly negative expectancy (measurably wrong)
       │
  CANDIDATE ─── passed every hard gate
       │
  PAPER_TRADING ─────── score >= 70
       │
  PRODUCTION_CANDIDATE ─ score >= 85
       │
  ARCHIVED
```

`RESEARCH` and `REJECTED` are deliberately different. "Not proven" and
"disproven" call for different follow-up: the first wants more data, the second
should never be retried.

### Hard gates (all must pass; no score can compensate)

| Gate | Requirement |
|---|---|
| `sample_size` | ≥ `acceptance.minTrades` trades |
| `positive_expectancy` | avgR > 0 |
| `profit_factor` | PF > 1 |
| `statistical_significance` | t > Bonferroni bar for the whole family |
| `two_sided_edge` | long **and** short both positive |
| `edge_distributed` | removing the best 5 trades must not flip the sign |
| `cross_symbol` | positive on every configured symbol |
| `bootstrap_ci` | block-bootstrap 95% CI lower bound > 0 |
| `walk_forward` | ≥ 60% of folds positive |
| `cost_resilient` | still positive under the harsh cost scenario |

`two_sided_edge` is a hard gate, not a score component, because a long-only
"edge" in a rising market is beta — and beta is free.

### Composite score (only computed once all gates pass)

| Component | Weight | Saturates at |
|---|---|---|
| significance | 25 | t = 5 |
| expectancy | 20 | 0.3 R/trade |
| sharpe | 15 | 2.0 |
| walk-forward consistency | 15 | 100% folds |
| two-sidedness | 15 | perfect symmetry |
| cost resilience | 10 | no degradation |

---

## How to add a strategy

Add one object to `src/research/strategies/registry.js`. **The engine is never
modified.** Either write the interface directly:

```js
{
  name: 'my_idea_4h',
  timeframe: '4h',                       // 15m | 30m | 1h | 2h | 4h | 12h | 1d
  rationale: 'Why this should work, economically.',
  maxHoldBars: 40,
  signal: (ctx, i) => ctx.someCondition ? { dir: 1 } : null,
  stop:   (ctx, i, sig, entry) => entry - sig.dir * ctx.atr14[i] * 2,
  target: (ctx, i, sig, entry, stop) => entry + sig.dir * Math.abs(entry - stop) * 2,
  confirm: (ctx, i, sig) => true,        // optional
  manage:  (state, ctx, i) => ({}),      // optional trailing/breakeven
}
```

…or compose from templates:

```js
const T = require('./templates');
T.defineStrategy({
  name: 'my_idea_4h', timeframe: '4h', rationale: '...',
  entry: (ctx, i) => (ctx.volZ[i] < -0.5 ? { dir: 1 } : null),
  stopModel: T.stops.atr(2),
  targetModel: T.targets.rMultiple(2.5),
  manageModel: T.manage.atrTrail(3, 1),
  confirm: T.filters.all(T.filters.htfAgrees(), T.filters.session(['LONDON', 'NY'])),
  maxHoldBars: 40,
});
```

### Available context fields (`ctx`, all safe at index `i`)

`close/high/low/volume`, `ret1`, `atr14`, `atrPct`, `ema20/50/200`, `rv20`,
`volZ`, `rvol`, `donHigh/donLow`, `trend` (+1/-1/0), `bos`, `choch`,
`swingHigh/swingLow`, `vwap`, `vwapDev`, `cvdDelta`, `session`.

**Contract:** every feature at index `i` uses only candles `0..i`. Never index
forward — one violation invalidates every downstream result.

---

## How validation works

1. **Splits** — TRAIN / VALID / OOS, disjoint and chronological.
2. **Walk-forward** — 5 rolling folds; ≥60% must be positive.
3. **Block bootstrap** — stationary bootstrap (block 20) preserves regime
   clustering that an IID bootstrap would destroy.
4. **Monte Carlo** — 2,000 reshuffles with 5% dropout → drawdown distribution.
5. **Cross-symbol** — every criterion must hold on every symbol.
6. **Cost scenarios** — optimistic / measured / harsh.
7. **Multiple testing** — Bonferroni over (strategies × symbols).

Adding a strategy **raises the bar for every other strategy**, because the family
grows. That is correct and intentional: it is the price of searching more.

---

## How reports are generated

Each cycle writes to `results/research/`:

| File | Content |
|---|---|
| `LEADERBOARD.md` | current ranking + per-strategy status justification (overwritten) |
| `CYCLE_NNNN.md` | executive summary, best/worst, edge analysis, failures, next experiments |
| `RESEARCH-JOURNAL.md` | append-only: what was tested, improved, failed, why, next |
| `latest_leaderboard.json` | machine-readable current state |
| `experiments/experiments.jsonl` | append-only archive: config, dataset version, git commit, results |
| `trades_*.csv`, `summary_*.csv` | raw trades and per-strategy summaries |

---

## Operating on a VPS

```bash
git clone <repo> && cd kardiax && npm install
node src/live/claude-runner.js --once          # verify one cycle
pm2 start ecosystem.research.config.js         # continuous
pm2 logs bulletbrain-research
pm2 save && pm2 startup
```

The loop is resilient by design: data-update failures fall back to cached data,
a strategy that throws is logged and skipped, and cycle errors never exit the
process. Cycle number persists in `logs/claude-runner-state.json`, so a restart
resumes numbering rather than overwriting history.

**Disk growth:** ~28MB per symbol of 15m history, plus a few MB of JSON per
cycle. Prune `results/research/research_scenario-*.json` periodically; the
experiment archive (JSONL) is small and should be kept indefinitely.

---

## Extending the platform

Highest-value extensions, in order:

1. **More symbols** (`config.research.js` → `symbols`). Enables cross-sectional,
   market-neutral strategies, which structurally avoid the beta contamination
   that blocks most current candidates.
2. **Non-OHLCV features** — funding (a downloader already exists), liquidations,
   order-book imbalance. Add to `features.build()`; every strategy sees them.
3. **Portfolio layer** — currently each strategy is evaluated standalone. Real
   allocation needs a correlation matrix and combined-equity simulation.
4. **Parameter-stability automation** — `sensitivity.sweep()` exists but is not
   yet wired into the orchestrator's per-cycle path.

**Rule for contributors:** never modify `core/engine.js` to make a strategy work.
If a strategy needs engine behaviour that does not exist, that is a change to the
execution model and must be justified as such — it affects every historical
result and breaks comparability with the archive.
