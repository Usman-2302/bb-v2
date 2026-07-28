# Research Cycle 4 — 2026-07-28

## Executive Summary

- 14 strategies evaluated, 0 passed all hard gates.
- Best ranked: **mtf_structure_align_4h** (RESEARCH, score 0, 0.1080R, t=1.90).
- Cost model: taker 5.0bps / maker 2.0bps / slip 6.0bps per side / funding 1.0bps per 8h -> break-even move 19.0bps
- Multiple-testing bar: |t| > 3.12
- Dataset: `8af5b6cca1337e68`

**No strategy is deployable.** No promotion is recommended.

## Best strategies

| Strategy | TF | n | WR | Expectancy | PF | Sharpe | t | maxDD(R) |
|---|---|---|---|---|---|---|---|---|
| mtf_structure_align_4h | 4h | 472 | 43.4% | 0.1080R | 1.24 | 0.82 | 1.90 | 11.6 |
| donchian_breakout_4h | 4h | 269 | 38.3% | 0.0988R | 1.18 | 0.38 | 0.90 | 16.1 |
| lowvol_trend_4h | 4h | 617 | 39.9% | 0.0896R | 1.17 | 0.56 | 1.31 | 29.4 |
| composite_trend_vol_4h | 4h | 552 | 40.2% | 0.0524R | 1.10 | 0.33 | 0.77 | 22.9 |
| ts_momentum_1d | 1d | 176 | 44.9% | 0.0484R | 1.12 | 0.24 | 0.54 | 9.7 |

## Worst strategies

- **trend_pullback_1h** (1h): -0.3402R, t=-16.98 — positive_expectancy: expectancy -0.3402R
- **htf_trend_pullback_4h** (4h): -0.2259R, t=-4.69 — positive_expectancy: expectancy -0.2259R
- **vwap_reversion_1h** (1h): -0.1791R, t=-26.09 — positive_expectancy: expectancy -0.1791R

## Edge analysis

### ts_momentum_1d

- direction: LONG 81 @ 0.1337R, SHORT 95 @ -0.0244R → _LONG-ONLY — indistinguishable from beta_
- edge concentration: FRAGILE — expectancy depends on <=5 trades (top decile holds 543% of total R)
- excursions: median MFE 0.57R, MAE 0.59R
- cost resilience: cost resilient (degradation 0.0101R)

### donchian_breakout_4h

- direction: LONG 154 @ 0.2080R, SHORT 115 @ -0.0475R → _LONG-ONLY — indistinguishable from beta_
- edge concentration: FRAGILE — expectancy depends on <=5 trades (top decile holds 429% of total R)
- excursions: median MFE 0.89R, MAE 0.98R
- cost resilience: cost resilient (degradation 0.0363R)

### htf_trend_pullback_4h

- direction: LONG 386 @ -0.1455R, SHORT 422 @ -0.2995R → _both sides negative_
- edge concentration: distributed (top decile holds -104% of total R)
- excursions: median MFE 0.76R, MAE 1.10R
- cost resilience: fails under higher costs (degradation 0.0715R)

### bos_continuation_4h

- direction: LONG 309 @ 0.0040R, SHORT 291 @ 0.0190R → _symmetric — genuine two-sided edge_
- edge concentration: FRAGILE — expectancy depends on <=5 trades (top decile holds 1723% of total R)
- excursions: median MFE 0.82R, MAE 0.81R
- cost resilience: cost resilient (degradation 0.0232R)

### choch_reversal_4h

- direction: LONG 374 @ -0.1344R, SHORT 401 @ -0.1105R → _both sides negative_
- edge concentration: distributed (top decile holds -195% of total R)
- excursions: median MFE 0.74R, MAE 1.05R
- cost resilience: fails under higher costs (degradation 0.0385R)

### vol_squeeze_breakout_4h

- direction: LONG 64 @ -0.1932R, SHORT 72 @ -0.0174R → _both sides negative_
- edge concentration: distributed (top decile holds -274% of total R)
- excursions: median MFE 0.77R, MAE 1.03R
- cost resilience: fails under higher costs (degradation 0.0235R)

### lowvol_trend_4h

- direction: LONG 309 @ 0.1883R, SHORT 308 @ -0.0094R → _LONG-ONLY — indistinguishable from beta_
- edge concentration: distributed (top decile holds 437% of total R)
- excursions: median MFE 0.98R, MAE 0.97R
- cost resilience: fails under higher costs (degradation 0.0344R)

### vwap_reversion_1h

- direction: LONG 6219 @ -0.1693R, SHORT 6403 @ -0.1886R → _both sides negative_
- edge concentration: distributed (top decile holds -59% of total R)
- excursions: median MFE 0.44R, MAE 0.64R
- cost resilience: fails under higher costs (degradation 0.0791R)

## Failure reasons

- **mtf_structure_align_4h**: statistical_significance: t=1.90 (bar 3.12); bootstrap_ci: 95% CI lower -0.0737R
- **donchian_breakout_4h**: statistical_significance: t=0.90 (bar 3.12); two_sided_edge: LONG-ONLY — indistinguishable from beta; edge_distributed: FRAGILE — expectancy depends on <=5 trades; bootstrap_ci: 95% CI lower -0.1366R
- **lowvol_trend_4h**: statistical_significance: t=1.31 (bar 3.12); two_sided_edge: LONG-ONLY — indistinguishable from beta; bootstrap_ci: 95% CI lower -0.1211R; cost_resilient: fails under higher costs
- **composite_trend_vol_4h**: statistical_significance: t=0.77 (bar 3.12); edge_distributed: FRAGILE — expectancy depends on <=5 trades; bootstrap_ci: 95% CI lower -0.1426R
- **ts_momentum_1d**: statistical_significance: t=0.54 (bar 3.12); two_sided_edge: LONG-ONLY — indistinguishable from beta; edge_distributed: FRAGILE — expectancy depends on <=5 trades; bootstrap_ci: 95% CI lower -0.1472R
- **bos_continuation_4h**: statistical_significance: t=0.24 (bar 3.12); edge_distributed: FRAGILE — expectancy depends on <=5 trades; cross_symbol: 1/2 symbols positive; bootstrap_ci: 95% CI lower -0.1123R
- **session_breakout_1h**: positive_expectancy: expectancy -0.0458R; profit_factor: PF 0.90; statistical_significance: t=-1.55 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.1571R; walk_forward: 40% of folds positive; cost_resilient: fails under higher costs
- **vol_squeeze_breakout_4h**: positive_expectancy: expectancy -0.1001R; profit_factor: PF 0.84; statistical_significance: t=-0.85 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.4249R; walk_forward: 20% of folds positive; cost_resilient: fails under higher costs
- **range_fade_4h**: no trades generated
- **choch_reversal_4h**: positive_expectancy: expectancy -0.1220R; profit_factor: PF 0.82; statistical_significance: t=-2.50 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.2989R; walk_forward: 20% of folds positive; cost_resilient: fails under higher costs
- **zscore_reversion_1h**: positive_expectancy: expectancy -0.1675R; profit_factor: PF 0.65; statistical_significance: t=-10.54 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.2206R; walk_forward: 0% of folds positive; cost_resilient: fails under higher costs
- **vwap_reversion_1h**: positive_expectancy: expectancy -0.1791R; profit_factor: PF 0.58; statistical_significance: t=-26.09 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.2093R; walk_forward: 0% of folds positive; cost_resilient: fails under higher costs
- **htf_trend_pullback_4h**: positive_expectancy: expectancy -0.2259R; profit_factor: PF 0.70; statistical_significance: t=-4.69 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.3699R; walk_forward: 0% of folds positive; cost_resilient: fails under higher costs
- **trend_pullback_1h**: positive_expectancy: expectancy -0.3402R; profit_factor: PF 0.55; statistical_significance: t=-16.98 (bar 3.12); two_sided_edge: both sides negative; cross_symbol: 0/2 symbols positive; bootstrap_ci: 95% CI lower -0.4107R; walk_forward: 0% of folds positive; cost_resilient: fails under higher costs

## Recommended next experiments

- Regress donchian_breakout_4h, lowvol_trend_4h, ts_momentum_1d against buy-and-hold and test residual alpha — they show positive expectancy but only on one side, which is beta, not skill.
- Run parameter-stability sweeps on mtf_structure_align_4h, lowvol_trend_4h — positive but not significant; stability would distinguish a weak real effect from noise.
- Test the INVERSE of zscore_reversion_1h, vwap_reversion_1h, htf_trend_pullback_4h, trend_pullback_1h — significantly negative expectancy is exploitable information if it survives costs in reverse.
- Add non-OHLCV features (funding rate, liquidations, order-book imbalance) — the OHLCV hypothesis space is close to exhausted at these timeframes.
- Expand to a 20+ symbol universe to enable cross-sectional (market-neutral) strategies, which structurally remove the beta contamination blocking current candidates.
