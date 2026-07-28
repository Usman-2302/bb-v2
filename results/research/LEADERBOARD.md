# Strategy Leaderboard

_Updated 2026-07-28T09:00:19.979Z — experiment `exp_20260728090019_pog0ex`, dataset `8af5b6cca1337e68`, scenario measured_

| Rank | Strategy | TF | Score | Status | PF | Expectancy | Sharpe | Robustness | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | mtf_structure_align_4h | 4h | 0 | **RESEARCH** | 1.24 | 0.1080R | 0.82 | 80% | low |
| 2 | donchian_breakout_4h | 4h | 0 | **RESEARCH** | 1.18 | 0.0988R | 0.38 | 70% | very low |
| 3 | lowvol_trend_4h | 4h | 0 | **RESEARCH** | 1.17 | 0.0896R | 0.56 | 70% | low |
| 4 | composite_trend_vol_4h | 4h | 0 | **RESEARCH** | 1.10 | 0.0524R | 0.33 | 60% | very low |
| 5 | ts_momentum_1d | 1d | 0 | **RESEARCH** | 1.12 | 0.0484R | 0.24 | 70% | very low |
| 6 | bos_continuation_4h | 4h | 0 | **RESEARCH** | 1.02 | 0.0113R | 0.10 | 60% | very low |
| 7 | session_breakout_1h | 1h | 0 | **RESEARCH** | 0.90 | -0.0458R | -0.66 | 40% | low |
| 8 | vol_squeeze_breakout_4h | 4h | 0 | **RESEARCH** | 0.84 | -0.1001R | -0.37 | 20% | very low |
| 9 | range_fade_4h | 4h | 0 | **NO_SIGNALS** | n/a | n/aR | n/a | 0% | unknown |
| 10 | choch_reversal_4h | 4h | 0 | **REJECTED** | 0.82 | -0.1220R | -1.07 | 20% | moderate |
| 11 | zscore_reversion_1h | 1h | 0 | **REJECTED** | 0.65 | -0.1675R | -4.48 | 0% | high |
| 12 | vwap_reversion_1h | 1h | 0 | **REJECTED** | 0.58 | -0.1791R | -11.09 | 0% | high |
| 13 | htf_trend_pullback_4h | 4h | 0 | **REJECTED** | 0.70 | -0.2259R | -2.01 | 0% | high |
| 14 | trend_pullback_1h | 1h | 0 | **REJECTED** | 0.55 | -0.3402R | -7.21 | 0% | high |

## Why each strategy has its status

### mtf_structure_align_4h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: symmetric — genuine two-sided edge

Failed gates:
- statistical_significance: t=1.90 (bar 3.12)
- bootstrap_ci: 95% CI lower -0.0737R

### donchian_breakout_4h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: LONG-ONLY — indistinguishable from beta

Failed gates:
- statistical_significance: t=0.90 (bar 3.12)
- two_sided_edge: LONG-ONLY — indistinguishable from beta
- edge_distributed: FRAGILE — expectancy depends on <=5 trades
- bootstrap_ci: 95% CI lower -0.1366R

### lowvol_trend_4h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: LONG-ONLY — indistinguishable from beta

Failed gates:
- statistical_significance: t=1.31 (bar 3.12)
- two_sided_edge: LONG-ONLY — indistinguishable from beta
- bootstrap_ci: 95% CI lower -0.1211R
- cost_resilient: fails under higher costs

### composite_trend_vol_4h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: symmetric — genuine two-sided edge

Failed gates:
- statistical_significance: t=0.77 (bar 3.12)
- edge_distributed: FRAGILE — expectancy depends on <=5 trades
- bootstrap_ci: 95% CI lower -0.1426R

### ts_momentum_1d — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: LONG-ONLY — indistinguishable from beta

Failed gates:
- statistical_significance: t=0.54 (bar 3.12)
- two_sided_edge: LONG-ONLY — indistinguishable from beta
- edge_distributed: FRAGILE — expectancy depends on <=5 trades
- bootstrap_ci: 95% CI lower -0.1472R

### bos_continuation_4h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: symmetric — genuine two-sided edge

Failed gates:
- statistical_significance: t=0.24 (bar 3.12)
- edge_distributed: FRAGILE — expectancy depends on <=5 trades
- cross_symbol: 1/2 symbols positive
- bootstrap_ci: 95% CI lower -0.1123R

### session_breakout_1h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.0458R
- profit_factor: PF 0.90
- statistical_significance: t=-1.55 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.1571R
- walk_forward: 40% of folds positive
- cost_resilient: fails under higher costs

### vol_squeeze_breakout_4h — RESEARCH

Did not clear all hard gates; evidence is insufficient rather than damning.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.1001R
- profit_factor: PF 0.84
- statistical_significance: t=-0.85 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.4249R
- walk_forward: 20% of folds positive
- cost_resilient: fails under higher costs

### range_fade_4h — NO_SIGNALS

Generated zero trades — the entry conditions never co-occurred. This is a specification result, not a performance result: either the conditions are over-constrained or the regime it needs is absent from the sample.

Beta check: single-sided sample

Failed gates:
- no trades generated

### choch_reversal_4h — REJECTED

Significantly negative expectancy — this hypothesis is measurably wrong, not merely unproven.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.1220R
- profit_factor: PF 0.82
- statistical_significance: t=-2.50 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.2989R
- walk_forward: 20% of folds positive
- cost_resilient: fails under higher costs

### zscore_reversion_1h — REJECTED

Significantly negative expectancy — this hypothesis is measurably wrong, not merely unproven.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.1675R
- profit_factor: PF 0.65
- statistical_significance: t=-10.54 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.2206R
- walk_forward: 0% of folds positive
- cost_resilient: fails under higher costs

### vwap_reversion_1h — REJECTED

Significantly negative expectancy — this hypothesis is measurably wrong, not merely unproven.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.1791R
- profit_factor: PF 0.58
- statistical_significance: t=-26.09 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.2093R
- walk_forward: 0% of folds positive
- cost_resilient: fails under higher costs

### htf_trend_pullback_4h — REJECTED

Significantly negative expectancy — this hypothesis is measurably wrong, not merely unproven.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.2259R
- profit_factor: PF 0.70
- statistical_significance: t=-4.69 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.3699R
- walk_forward: 0% of folds positive
- cost_resilient: fails under higher costs

### trend_pullback_1h — REJECTED

Significantly negative expectancy — this hypothesis is measurably wrong, not merely unproven.

Beta check: both sides negative

Failed gates:
- positive_expectancy: expectancy -0.3402R
- profit_factor: PF 0.55
- statistical_significance: t=-16.98 (bar 3.12)
- two_sided_edge: both sides negative
- cross_symbol: 0/2 symbols positive
- bootstrap_ci: 95% CI lower -0.4107R
- walk_forward: 0% of folds positive
- cost_resilient: fails under higher costs
