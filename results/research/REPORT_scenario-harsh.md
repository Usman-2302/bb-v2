# BulletBrain Research Report

**Generated:** 2026-07-28T08:39:52.879Z
**Cost model:** taker 7.0bps / maker 2.0bps / slip 12.0bps per side / funding 1.0bps per 8h -> break-even move 33.0bps
**Multiple-testing bar:** |t| > 3.02 (Bonferroni, family alpha 0.05)
**Splits:** TRAIN 2021-01-01..2025-06-30 | VALID 2025-07-01..2026-02-28 | OOS 2026-03-01..2026-12-31

## Verdict

**No strategy met the acceptance criteria.** No deployment is recommended.

## Ranking (by out-of-sample expectancy, pooled across symbols)

| strategy | tf | trades | WR | avgR | PF | t | Sharpe | maxDD(R) | verdict |
|---|---|---|---|---|---|---|---|---|---|
| donchian_breakout_4h | 4h | 270 | 37.4% | 0.0547 | 1.10 | 0.51 | 0.22 | 20.0 | reject |
| lowvol_trend_4h | 4h | 619 | 38.8% | 0.0469 | 1.09 | 0.70 | 0.30 | 35.3 | reject |
| ts_momentum_1d | 1d | 176 | 44.3% | 0.0368 | 1.09 | 0.41 | 0.19 | 10.1 | reject |
| bos_continuation_4h | 4h | 598 | 41.6% | -0.0173 | 0.97 | -0.37 | -0.16 | 32.9 | reject |
| vol_squeeze_breakout_4h | 4h | 136 | 31.6% | -0.1273 | 0.80 | -1.10 | -0.48 | 26.8 | reject |
| choch_reversal_4h | 4h | 770 | 31.0% | -0.1749 | 0.75 | -3.64 | -1.56 | 136.6 | reject |
| zscore_reversion_1h | 1h | 3166 | 37.1% | -0.2461 | 0.53 | -15.73 | -6.69 | 779.2 | reject |
| vwap_reversion_1h | 1h | 12912 | 46.4% | -0.2704 | 0.43 | -40.29 | -17.12 | 3492.6 | reject |
| htf_trend_pullback_4h | 4h | 813 | 27.4% | -0.3067 | 0.61 | -6.42 | -2.75 | 250.7 | reject |
| trend_pullback_1h | 1h | 3895 | 25.4% | -0.4804 | 0.43 | -24.53 | -10.42 | 1872.4 | reject |

## Rejected hypotheses and why

### donchian_breakout_4h (4h)

*Classic trend-following breakout (Donchian / Turtle lineage). Economic basis: sustained order-flow imbalance from slow institutional rebalancing means new extremes cluster. Long-horizon, low trade count, so the fee burden per unit of move is small.*

- ETHUSDT: |t|=0.488 <= 3.02 (multiple-testing bar)
- ETHUSDT: bootstrap 95% CI lower bound -0.087R <= 0
- BTCUSDT: |t|=0.238 <= 3.02 (multiple-testing bar)
- BTCUSDT/VALID: expectancy -0.126R <= 0
- BTCUSDT/OOS: expectancy -0.445R <= 0
- BTCUSDT: bootstrap 95% CI lower bound -0.185R <= 0

### lowvol_trend_4h (4h)

*The only candidate that showed consistent positive (if insignificant) alpha across both symbols and all windows in the 15m battery: trend-following conditioned on LOW realised volatility. Promoted to 4h, where the same effect has ~4x the move size against identical fixed costs. This is the single most evidence-motivated hypothesis in the registry.*

- ETHUSDT: expectancy -0.021R <= 0
- ETHUSDT: |t|=-0.257 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.963 <= 1
- ETHUSDT/TRAIN: expectancy -0.062R <= 0
- ETHUSDT/OOS: expectancy -0.215R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.156R <= 0
- ETHUSDT: only 2/5 walk-forward folds positive
- BTCUSDT: |t|=1.099 <= 3.02 (multiple-testing bar)

### ts_momentum_1d (1d)

*Time-series momentum (Moskowitz, Ooi & Pedersen 2012): an assets own past excess return predicts its future return across essentially every liquid futures market, attributed to under-reaction and risk-transfer demand. The canonical 12-month/1-month lookbacks compress to weeks in crypto. Traded daily so fixed costs are negligible against the move size.*

- ETHUSDT: |t|=0.511 <= 3.02 (multiple-testing bar)
- ETHUSDT: bootstrap 95% CI lower bound -0.049R <= 0
- BTCUSDT: |t|=0.105 <= 3.02 (multiple-testing bar)
- BTCUSDT/VALID: expectancy -0.141R <= 0
- BTCUSDT: bootstrap 95% CI lower bound -0.159R <= 0

### bos_continuation_4h (4h)

*Break of structure continuation: price closing beyond the last confirmed swing in the direction of the prevailing structure. This is the institutional-flow reading of trend continuation, and unlike the old sweep signal it requires structure to AGREE rather than to be violated.*

- ETHUSDT: |t|=0.255 <= 3.02 (multiple-testing bar)
- ETHUSDT/VALID: expectancy -0.098R <= 0
- ETHUSDT/OOS: expectancy -0.076R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.115R <= 0
- BTCUSDT: expectancy -0.052R <= 0
- BTCUSDT: |t|=-0.809 <= 3.02 (multiple-testing bar)
- BTCUSDT: PF 0.896 <= 1
- BTCUSDT/TRAIN: expectancy -0.019R <= 0

### vol_squeeze_breakout_4h (4h)

*Volatility clustering (Engle/ARCH): low-volatility regimes are followed by high-volatility regimes. Enter on the expansion bar in its own direction. The edge is regime timing, not direction prediction.*

- ETHUSDT: expectancy -0.146R <= 0
- ETHUSDT: |t|=-0.905 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.776 <= 1
- ETHUSDT/TRAIN: expectancy -0.034R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.445R <= 0
- ETHUSDT: only 1/5 walk-forward folds positive
- BTCUSDT: expectancy -0.108R <= 0
- BTCUSDT: |t|=-0.640 <= 3.02 (multiple-testing bar)

### choch_reversal_4h (4h)

*Change of character: the first structural break AGAINST an established trend often marks distribution/accumulation completing. Counterpart hypothesis to bos_continuation — if continuation works, this should fail, and vice versa. Testing both guards against confirmation bias.*

- ETHUSDT: expectancy -0.114R <= 0
- ETHUSDT: |t|=-1.632 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.830 <= 1
- ETHUSDT/TRAIN: expectancy -0.191R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.243R <= 0
- ETHUSDT: only 2/5 walk-forward folds positive
- BTCUSDT: expectancy -0.235R <= 0
- BTCUSDT: PF 0.669 <= 1

### zscore_reversion_1h (1h)

*Statistical overextension reversion: a single-bar move several sigma beyond recent realised volatility reflects liquidity depletion rather than information, and partially retraces as market makers rebuild inventory.*

- ETHUSDT: expectancy -0.224R <= 0
- ETHUSDT: PF 0.563 <= 1
- ETHUSDT/TRAIN: expectancy -0.221R <= 0
- ETHUSDT/VALID: expectancy -0.216R <= 0
- ETHUSDT/OOS: expectancy -0.267R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.267R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.268R <= 0

### vwap_reversion_1h (1h)

*Intraday mean reversion to session VWAP. Economic basis: VWAP is the execution benchmark for large orders, so systematic flow leans against deviations. Fades stretched moves rather than chasing them.*

- ETHUSDT: expectancy -0.245R <= 0
- ETHUSDT: PF 0.476 <= 1
- ETHUSDT/TRAIN: expectancy -0.247R <= 0
- ETHUSDT/VALID: expectancy -0.228R <= 0
- ETHUSDT/OOS: expectancy -0.248R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.264R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.295R <= 0

### htf_trend_pullback_4h (4h)

*Buy the pullback inside an established higher-timeframe uptrend. Rationale: trend persistence plus better entry location than breakout chasing, which the 15m study showed is where the old system lost (it bought decisive closes and became exit liquidity).*

- ETHUSDT: expectancy -0.316R <= 0
- ETHUSDT: PF 0.606 <= 1
- ETHUSDT/TRAIN: expectancy -0.351R <= 0
- ETHUSDT/VALID: expectancy -0.069R <= 0
- ETHUSDT/OOS: expectancy -0.335R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.437R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.296R <= 0

### trend_pullback_1h (1h)

*The 4h pullback hypothesis at 1h. Included as an explicit timeframe-scaling control: if the SAME logic is profitable at 4h and unprofitable at 1h, that isolates the cost floor as the binding constraint rather than the signal.*

- ETHUSDT: expectancy -0.453R <= 0
- ETHUSDT: PF 0.456 <= 1
- ETHUSDT/TRAIN: expectancy -0.448R <= 0
- ETHUSDT/VALID: expectancy -0.479R <= 0
- ETHUSDT/OOS: expectancy -0.457R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.506R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.507R <= 0

## Per-strategy detail

### donchian_breakout_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 135 | 37.8% | 0.0717 | 1.13 | 0.49 |
| ETHUSDT | TRAIN | 107 | 38.3% | 0.0563 | 1.10 | 0.36 |
| ETHUSDT | VALID | 19 | 36.8% | 0.1513 | 1.25 | 0.29 |
| ETHUSDT | OOS | 9 | 33.3% | 0.0868 | 1.16 | 0.16 |
| BTCUSDT | ALL | 135 | 37.0% | 0.0376 | 1.07 | 0.24 |
| BTCUSDT | TRAIN | 104 | 40.4% | 0.1262 | 1.23 | 0.65 |
| BTCUSDT | VALID | 18 | 38.9% | -0.1257 | 0.78 | -0.46 |
| BTCUSDT | OOS | 13 | 7.7% | -0.4454 | 0.42 | -1.11 |

### lowvol_trend_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 319 | 39.2% | -0.0206 | 0.96 | -0.26 |
| ETHUSDT | TRAIN | 260 | 38.1% | -0.0622 | 0.89 | -0.72 |
| ETHUSDT | VALID | 34 | 47.1% | 0.4402 | 2.01 | 1.43 |
| ETHUSDT | OOS | 25 | 40.0% | -0.2150 | 0.63 | -0.94 |
| BTCUSDT | ALL | 300 | 38.3% | 0.1187 | 1.22 | 1.10 |
| BTCUSDT | TRAIN | 242 | 39.7% | 0.1616 | 1.30 | 1.28 |
| BTCUSDT | VALID | 35 | 34.3% | -0.0108 | 0.98 | -0.04 |
| BTCUSDT | OOS | 23 | 30.4% | -0.1365 | 0.77 | -0.49 |

### ts_momentum_1d [1d]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 88 | 42.0% | 0.0593 | 1.15 | 0.51 |
| ETHUSDT | TRAIN | 70 | 42.9% | 0.0141 | 1.03 | 0.11 |
| ETHUSDT | VALID | 12 | 41.7% | 0.2959 | 1.88 | 0.79 |
| ETHUSDT | OOS | 6 | 33.3% | 0.1142 | 1.42 | 0.32 |
| BTCUSDT | ALL | 88 | 46.6% | 0.0142 | 1.03 | 0.10 |
| BTCUSDT | TRAIN | 68 | 45.6% | 0.0506 | 1.13 | 0.31 |
| BTCUSDT | VALID | 13 | 53.8% | -0.1409 | 0.71 | -0.49 |
| BTCUSDT | OOS | 7 | 42.9% | -0.0515 | 0.88 | -0.13 |

### bos_continuation_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 301 | 41.9% | 0.0170 | 1.03 | 0.25 |
| ETHUSDT | TRAIN | 241 | 44.0% | 0.0437 | 1.09 | 0.59 |
| ETHUSDT | VALID | 38 | 34.2% | -0.0985 | 0.83 | -0.52 |
| ETHUSDT | OOS | 22 | 31.8% | -0.0763 | 0.86 | -0.30 |
| BTCUSDT | ALL | 297 | 41.4% | -0.0521 | 0.90 | -0.81 |
| BTCUSDT | TRAIN | 234 | 43.2% | -0.0189 | 0.96 | -0.26 |
| BTCUSDT | VALID | 47 | 31.9% | -0.1224 | 0.78 | -0.73 |
| BTCUSDT | OOS | 16 | 43.8% | -0.3305 | 0.30 | -2.02 |

### vol_squeeze_breakout_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 70 | 31.4% | -0.1458 | 0.78 | -0.90 |
| ETHUSDT | TRAIN | 54 | 37.0% | -0.0339 | 0.94 | -0.18 |
| ETHUSDT | VALID | 9 | 11.1% | -0.6994 | 0.25 | -2.03 |
| ETHUSDT | OOS | 7 | 14.3% | -0.2978 | 0.58 | -0.55 |
| BTCUSDT | ALL | 66 | 31.8% | -0.1077 | 0.83 | -0.64 |
| BTCUSDT | TRAIN | 50 | 32.0% | -0.2105 | 0.67 | -1.23 |
| BTCUSDT | VALID | 12 | 41.7% | 0.5208 | 1.84 | 0.92 |
| BTCUSDT | OOS | 4 | 0.0% | -0.7083 | 0.00 | -3.36 |

### choch_reversal_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 383 | 31.9% | -0.1141 | 0.83 | -1.63 |
| ETHUSDT | TRAIN | 316 | 29.4% | -0.1910 | 0.73 | -2.55 |
| ETHUSDT | VALID | 42 | 40.5% | 0.2525 | 1.46 | 1.07 |
| ETHUSDT | OOS | 25 | 48.0% | 0.2418 | 1.48 | 0.84 |
| BTCUSDT | ALL | 387 | 30.2% | -0.2351 | 0.67 | -3.56 |
| BTCUSDT | TRAIN | 312 | 30.1% | -0.2404 | 0.66 | -3.26 |
| BTCUSDT | VALID | 49 | 36.7% | -0.0406 | 0.94 | -0.20 |
| BTCUSDT | OOS | 26 | 19.2% | -0.5381 | 0.29 | -2.83 |

### zscore_reversion_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 1554 | 38.2% | -0.2237 | 0.56 | -10.02 |
| ETHUSDT | TRAIN | 1235 | 38.1% | -0.2206 | 0.57 | -8.76 |
| ETHUSDT | VALID | 198 | 38.9% | -0.2162 | 0.57 | -3.50 |
| ETHUSDT | OOS | 121 | 38.0% | -0.2672 | 0.49 | -3.42 |
| BTCUSDT | ALL | 1612 | 36.0% | -0.2677 | 0.50 | -12.21 |
| BTCUSDT | TRAIN | 1292 | 35.9% | -0.2608 | 0.51 | -10.67 |
| BTCUSDT | VALID | 197 | 37.6% | -0.3004 | 0.47 | -4.72 |
| BTCUSDT | OOS | 123 | 35.0% | -0.2869 | 0.47 | -3.65 |

### vwap_reversion_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 6319 | 48.2% | -0.2447 | 0.48 | -25.20 |
| ETHUSDT | TRAIN | 5044 | 48.0% | -0.2470 | 0.47 | -22.68 |
| ETHUSDT | VALID | 782 | 51.3% | -0.2275 | 0.51 | -8.14 |
| ETHUSDT | OOS | 493 | 46.0% | -0.2481 | 0.44 | -7.44 |
| BTCUSDT | ALL | 6593 | 44.7% | -0.2950 | 0.39 | -31.82 |
| BTCUSDT | TRAIN | 5250 | 45.3% | -0.2841 | 0.41 | -27.26 |
| BTCUSDT | VALID | 843 | 43.8% | -0.3324 | 0.34 | -12.97 |
| BTCUSDT | OOS | 500 | 39.4% | -0.3472 | 0.32 | -10.47 |

### htf_trend_pullback_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 425 | 25.9% | -0.3163 | 0.61 | -4.77 |
| ETHUSDT | TRAIN | 343 | 24.5% | -0.3514 | 0.57 | -4.84 |
| ETHUSDT | VALID | 51 | 35.3% | -0.0688 | 0.91 | -0.32 |
| ETHUSDT | OOS | 31 | 25.8% | -0.3352 | 0.56 | -1.43 |
| BTCUSDT | ALL | 388 | 29.1% | -0.2961 | 0.62 | -4.29 |
| BTCUSDT | TRAIN | 303 | 30.7% | -0.2550 | 0.67 | -3.24 |
| BTCUSDT | VALID | 51 | 25.5% | -0.4066 | 0.54 | -2.05 |
| BTCUSDT | OOS | 34 | 20.6% | -0.4966 | 0.41 | -2.45 |

### trend_pullback_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 1916 | 25.8% | -0.4526 | 0.46 | -16.07 |
| ETHUSDT | TRAIN | 1550 | 26.1% | -0.4483 | 0.46 | -14.30 |
| ETHUSDT | VALID | 226 | 23.5% | -0.4793 | 0.43 | -5.89 |
| ETHUSDT | OOS | 140 | 26.4% | -0.4570 | 0.46 | -4.35 |
| BTCUSDT | ALL | 1979 | 25.0% | -0.5074 | 0.41 | -18.63 |
| BTCUSDT | TRAIN | 1616 | 25.5% | -0.4925 | 0.42 | -16.28 |
| BTCUSDT | VALID | 221 | 23.5% | -0.5555 | 0.37 | -7.12 |
| BTCUSDT | OOS | 142 | 21.1% | -0.6011 | 0.36 | -5.77 |
