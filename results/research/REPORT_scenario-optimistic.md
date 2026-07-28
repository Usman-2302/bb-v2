# BulletBrain Research Report

**Generated:** 2026-07-28T08:39:50.728Z
**Cost model:** taker 5.0bps / maker 2.0bps / slip 2.0bps per side / funding 1.0bps per 8h -> break-even move 11.0bps
**Multiple-testing bar:** |t| > 3.02 (Bonferroni, family alpha 0.05)
**Splits:** TRAIN 2021-01-01..2025-06-30 | VALID 2025-07-01..2026-02-28 | OOS 2026-03-01..2026-12-31

## Verdict

**No strategy met the acceptance criteria.** No deployment is recommended.

## Ranking (by out-of-sample expectancy, pooled across symbols)

| strategy | tf | trades | WR | avgR | PF | t | Sharpe | maxDD(R) | verdict |
|---|---|---|---|---|---|---|---|---|---|
| lowvol_trend_4h | 4h | 615 | 41.0% | 0.1197 | 1.23 | 1.74 | 0.75 | 24.9 | reject |
| donchian_breakout_4h | 4h | 269 | 37.9% | 0.1121 | 1.21 | 1.02 | 0.44 | 15.4 | reject |
| ts_momentum_1d | 1d | 177 | 45.8% | 0.0396 | 1.10 | 0.45 | 0.21 | 9.5 | reject |
| bos_continuation_4h | 4h | 601 | 43.4% | 0.0255 | 1.05 | 0.55 | 0.24 | 22.0 | reject |
| vol_squeeze_breakout_4h | 4h | 136 | 32.4% | -0.0883 | 0.86 | -0.75 | -0.33 | 24.0 | reject |
| choch_reversal_4h | 4h | 778 | 32.4% | -0.0985 | 0.85 | -2.03 | -0.87 | 81.6 | reject |
| zscore_reversion_1h | 1h | 3153 | 43.5% | -0.1236 | 0.73 | -7.79 | -3.31 | 392.9 | reject |
| vwap_reversion_1h | 1h | 12463 | 55.6% | -0.1307 | 0.68 | -19.04 | -8.09 | 1630.6 | reject |
| htf_trend_pullback_4h | 4h | 805 | 29.9% | -0.1679 | 0.76 | -3.50 | -1.50 | 136.5 | reject |
| trend_pullback_1h | 1h | 3864 | 29.9% | -0.2410 | 0.65 | -12.14 | -5.16 | 945.1 | reject |

## Rejected hypotheses and why

### lowvol_trend_4h (4h)

*The only candidate that showed consistent positive (if insignificant) alpha across both symbols and all windows in the 15m battery: trend-following conditioned on LOW realised volatility. Promoted to 4h, where the same effect has ~4x the move size against identical fixed costs. This is the single most evidence-motivated hypothesis in the registry.*

- ETHUSDT: |t|=0.619 <= 3.02 (multiple-testing bar)
- ETHUSDT/TRAIN: expectancy -0.006R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.089R <= 0
- BTCUSDT: |t|=1.732 <= 3.02 (multiple-testing bar)
- BTCUSDT/OOS: expectancy -0.113R <= 0

### donchian_breakout_4h (4h)

*Classic trend-following breakout (Donchian / Turtle lineage). Economic basis: sustained order-flow imbalance from slow institutional rebalancing means new extremes cluster. Long-horizon, low trade count, so the fee burden per unit of move is small.*

- ETHUSDT: |t|=0.800 <= 3.02 (multiple-testing bar)
- ETHUSDT: bootstrap 95% CI lower bound -0.040R <= 0
- BTCUSDT: |t|=0.643 <= 3.02 (multiple-testing bar)
- BTCUSDT/VALID: expectancy -0.036R <= 0
- BTCUSDT/OOS: expectancy -0.404R <= 0
- BTCUSDT: bootstrap 95% CI lower bound -0.121R <= 0

### ts_momentum_1d (1d)

*Time-series momentum (Moskowitz, Ooi & Pedersen 2012): an assets own past excess return predicts its future return across essentially every liquid futures market, attributed to under-reaction and risk-transfer demand. The canonical 12-month/1-month lookbacks compress to weeks in crypto. Traded daily so fixed costs are negligible against the move size.*

- ETHUSDT: |t|=0.527 <= 3.02 (multiple-testing bar)
- ETHUSDT: bootstrap 95% CI lower bound -0.055R <= 0
- BTCUSDT: |t|=0.128 <= 3.02 (multiple-testing bar)
- BTCUSDT/VALID: expectancy -0.121R <= 0
- BTCUSDT: bootstrap 95% CI lower bound -0.147R <= 0

### bos_continuation_4h (4h)

*Break of structure continuation: price closing beyond the last confirmed swing in the direction of the prevailing structure. This is the institutional-flow reading of trend continuation, and unlike the old sweep signal it requires structure to AGREE rather than to be violated.*

- ETHUSDT: |t|=0.829 <= 3.02 (multiple-testing bar)
- ETHUSDT/VALID: expectancy -0.062R <= 0
- ETHUSDT/OOS: expectancy -0.040R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.077R <= 0
- BTCUSDT: expectancy -0.004R <= 0
- BTCUSDT: |t|=-0.068 <= 3.02 (multiple-testing bar)
- BTCUSDT: PF 0.991 <= 1
- BTCUSDT/VALID: expectancy -0.010R <= 0

### vol_squeeze_breakout_4h (4h)

*Volatility clustering (Engle/ARCH): low-volatility regimes are followed by high-volatility regimes. Enter on the expansion bar in its own direction. The edge is regime timing, not direction prediction.*

- ETHUSDT: expectancy -0.112R <= 0
- ETHUSDT: |t|=-0.687 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.824 <= 1
- ETHUSDT: bootstrap 95% CI lower bound -0.415R <= 0
- ETHUSDT: only 1/5 walk-forward folds positive
- BTCUSDT: expectancy -0.063R <= 0
- BTCUSDT: |t|=-0.373 <= 3.02 (multiple-testing bar)
- BTCUSDT: PF 0.896 <= 1

### choch_reversal_4h (4h)

*Change of character: the first structural break AGAINST an established trend often marks distribution/accumulation completing. Counterpart hypothesis to bos_continuation — if continuation works, this should fail, and vice versa. Testing both guards against confirmation bias.*

- ETHUSDT: expectancy -0.061R <= 0
- ETHUSDT: |t|=-0.873 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.905 <= 1
- ETHUSDT/TRAIN: expectancy -0.138R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.200R <= 0
- ETHUSDT: only 2/5 walk-forward folds positive
- BTCUSDT: expectancy -0.135R <= 0
- BTCUSDT: |t|=-2.010 <= 3.02 (multiple-testing bar)

### zscore_reversion_1h (1h)

*Statistical overextension reversion: a single-bar move several sigma beyond recent realised volatility reflects liquidity depletion rather than information, and partially retraces as market makers rebuild inventory.*

- ETHUSDT: expectancy -0.116R <= 0
- ETHUSDT: PF 0.743 <= 1
- ETHUSDT/TRAIN: expectancy -0.113R <= 0
- ETHUSDT/VALID: expectancy -0.132R <= 0
- ETHUSDT/OOS: expectancy -0.124R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.160R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.131R <= 0

### vwap_reversion_1h (1h)

*Intraday mean reversion to session VWAP. Economic basis: VWAP is the execution benchmark for large orders, so systematic flow leans against deviations. Fades stretched moves rather than chasing them.*

- ETHUSDT: expectancy -0.125R <= 0
- ETHUSDT: PF 0.693 <= 1
- ETHUSDT/TRAIN: expectancy -0.128R <= 0
- ETHUSDT/VALID: expectancy -0.105R <= 0
- ETHUSDT/OOS: expectancy -0.124R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.144R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.137R <= 0

### htf_trend_pullback_4h (4h)

*Buy the pullback inside an established higher-timeframe uptrend. Rationale: trend persistence plus better entry location than breakout chasing, which the 15m study showed is where the old system lost (it bought decisive closes and became exit liquidity).*

- ETHUSDT: expectancy -0.193R <= 0
- ETHUSDT: |t|=-2.899 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.733 <= 1
- ETHUSDT/TRAIN: expectancy -0.217R <= 0
- ETHUSDT/OOS: expectancy -0.277R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.312R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.141R <= 0

### trend_pullback_1h (1h)

*The 4h pullback hypothesis at 1h. Included as an explicit timeframe-scaling control: if the SAME logic is profitable at 4h and unprofitable at 1h, that isolates the cost floor as the binding constraint rather than the signal.*

- ETHUSDT: expectancy -0.236R <= 0
- ETHUSDT: PF 0.661 <= 1
- ETHUSDT/TRAIN: expectancy -0.227R <= 0
- ETHUSDT/VALID: expectancy -0.285R <= 0
- ETHUSDT/OOS: expectancy -0.258R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.288R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.246R <= 0

## Per-strategy detail

### lowvol_trend_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 316 | 40.8% | 0.0510 | 1.10 | 0.62 |
| ETHUSDT | TRAIN | 258 | 39.1% | -0.0060 | 0.99 | -0.07 |
| ETHUSDT | VALID | 34 | 47.1% | 0.4928 | 2.19 | 1.58 |
| ETHUSDT | OOS | 24 | 50.0% | 0.0377 | 1.08 | 0.15 |
| BTCUSDT | ALL | 299 | 41.1% | 0.1922 | 1.38 | 1.73 |
| BTCUSDT | TRAIN | 241 | 42.3% | 0.2398 | 1.48 | 1.85 |
| BTCUSDT | VALID | 35 | 37.1% | 0.0650 | 1.13 | 0.25 |
| BTCUSDT | OOS | 23 | 34.8% | -0.1125 | 0.81 | -0.39 |

### donchian_breakout_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 135 | 37.8% | 0.1189 | 1.23 | 0.80 |
| ETHUSDT | TRAIN | 107 | 38.3% | 0.1059 | 1.21 | 0.67 |
| ETHUSDT | VALID | 19 | 36.8% | 0.1882 | 1.32 | 0.35 |
| ETHUSDT | OOS | 9 | 33.3% | 0.1274 | 1.25 | 0.24 |
| BTCUSDT | ALL | 134 | 38.1% | 0.1052 | 1.19 | 0.64 |
| BTCUSDT | TRAIN | 103 | 40.8% | 0.1942 | 1.37 | 0.97 |
| BTCUSDT | VALID | 18 | 38.9% | -0.0362 | 0.93 | -0.12 |
| BTCUSDT | OOS | 13 | 15.4% | -0.4035 | 0.46 | -0.98 |

### ts_momentum_1d [1d]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 89 | 43.8% | 0.0624 | 1.16 | 0.53 |
| ETHUSDT | TRAIN | 71 | 45.1% | 0.0146 | 1.04 | 0.11 |
| ETHUSDT | VALID | 12 | 41.7% | 0.3109 | 1.94 | 0.82 |
| ETHUSDT | OOS | 6 | 33.3% | 0.1315 | 1.50 | 0.37 |
| BTCUSDT | ALL | 88 | 47.7% | 0.0166 | 1.04 | 0.13 |
| BTCUSDT | TRAIN | 68 | 47.1% | 0.0477 | 1.12 | 0.31 |
| BTCUSDT | VALID | 13 | 53.8% | -0.1211 | 0.75 | -0.42 |
| BTCUSDT | OOS | 7 | 42.9% | -0.0300 | 0.93 | -0.08 |

### bos_continuation_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 302 | 43.7% | 0.0551 | 1.12 | 0.83 |
| ETHUSDT | TRAIN | 241 | 45.2% | 0.0827 | 1.18 | 1.11 |
| ETHUSDT | VALID | 38 | 34.2% | -0.0622 | 0.88 | -0.33 |
| ETHUSDT | OOS | 23 | 43.5% | -0.0397 | 0.92 | -0.16 |
| BTCUSDT | ALL | 299 | 43.1% | -0.0044 | 0.99 | -0.07 |
| BTCUSDT | TRAIN | 235 | 43.8% | 0.0162 | 1.03 | 0.22 |
| BTCUSDT | VALID | 48 | 39.6% | -0.0103 | 0.98 | -0.06 |
| BTCUSDT | OOS | 16 | 43.8% | -0.2890 | 0.36 | -1.74 |

### vol_squeeze_breakout_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 70 | 32.9% | -0.1117 | 0.82 | -0.69 |
| ETHUSDT | TRAIN | 54 | 38.9% | 0.0016 | 1.00 | 0.01 |
| ETHUSDT | VALID | 9 | 11.1% | -0.6705 | 0.26 | -1.91 |
| ETHUSDT | OOS | 7 | 14.3% | -0.2669 | 0.61 | -0.49 |
| BTCUSDT | ALL | 66 | 31.8% | -0.0634 | 0.90 | -0.37 |
| BTCUSDT | TRAIN | 50 | 32.0% | -0.1664 | 0.73 | -0.96 |
| BTCUSDT | VALID | 12 | 41.7% | 0.5650 | 1.94 | 0.99 |
| BTCUSDT | OOS | 4 | 0.0% | -0.6612 | 0.00 | -3.01 |

### choch_reversal_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 386 | 32.9% | -0.0613 | 0.90 | -0.87 |
| ETHUSDT | TRAIN | 319 | 30.4% | -0.1381 | 0.79 | -1.84 |
| ETHUSDT | VALID | 42 | 42.9% | 0.3122 | 1.59 | 1.31 |
| ETHUSDT | OOS | 25 | 48.0% | 0.2916 | 1.61 | 1.02 |
| BTCUSDT | ALL | 392 | 31.9% | -0.1352 | 0.80 | -2.01 |
| BTCUSDT | TRAIN | 315 | 31.1% | -0.1593 | 0.76 | -2.14 |
| BTCUSDT | VALID | 51 | 37.3% | 0.0819 | 1.13 | 0.40 |
| BTCUSDT | OOS | 26 | 30.8% | -0.2685 | 0.59 | -1.15 |

### zscore_reversion_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 1552 | 44.2% | -0.1165 | 0.74 | -5.14 |
| ETHUSDT | TRAIN | 1235 | 44.0% | -0.1133 | 0.75 | -4.44 |
| ETHUSDT | VALID | 198 | 44.4% | -0.1317 | 0.71 | -2.10 |
| ETHUSDT | OOS | 119 | 45.4% | -0.1241 | 0.72 | -1.54 |
| BTCUSDT | ALL | 1601 | 42.9% | -0.1306 | 0.72 | -5.88 |
| BTCUSDT | TRAIN | 1289 | 42.8% | -0.1324 | 0.71 | -5.34 |
| BTCUSDT | VALID | 195 | 42.6% | -0.1456 | 0.69 | -2.30 |
| BTCUSDT | OOS | 117 | 44.4% | -0.0853 | 0.80 | -1.04 |

### vwap_reversion_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 6139 | 55.8% | -0.1246 | 0.69 | -12.57 |
| ETHUSDT | TRAIN | 4894 | 55.4% | -0.1277 | 0.69 | -11.48 |
| ETHUSDT | VALID | 760 | 57.2% | -0.1049 | 0.74 | -3.66 |
| ETHUSDT | OOS | 485 | 56.7% | -0.1241 | 0.68 | -3.67 |
| BTCUSDT | ALL | 6324 | 55.4% | -0.1367 | 0.66 | -14.37 |
| BTCUSDT | TRAIN | 5049 | 55.7% | -0.1324 | 0.67 | -12.40 |
| BTCUSDT | VALID | 807 | 55.3% | -0.1510 | 0.63 | -5.73 |
| BTCUSDT | OOS | 468 | 52.6% | -0.1577 | 0.61 | -4.56 |

### htf_trend_pullback_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 421 | 28.5% | -0.1927 | 0.73 | -2.90 |
| ETHUSDT | TRAIN | 339 | 27.7% | -0.2171 | 0.70 | -2.96 |
| ETHUSDT | VALID | 51 | 35.3% | 0.0205 | 1.03 | 0.10 |
| ETHUSDT | OOS | 31 | 25.8% | -0.2767 | 0.61 | -1.19 |
| BTCUSDT | ALL | 384 | 31.5% | -0.1407 | 0.80 | -2.03 |
| BTCUSDT | TRAIN | 300 | 33.0% | -0.1018 | 0.85 | -1.29 |
| BTCUSDT | VALID | 50 | 30.0% | -0.1965 | 0.73 | -0.99 |
| BTCUSDT | OOS | 34 | 20.6% | -0.4016 | 0.49 | -1.93 |

### trend_pullback_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 1906 | 29.9% | -0.2361 | 0.66 | -8.27 |
| ETHUSDT | TRAIN | 1541 | 30.2% | -0.2270 | 0.67 | -7.13 |
| ETHUSDT | VALID | 222 | 27.9% | -0.2851 | 0.60 | -3.44 |
| ETHUSDT | OOS | 143 | 30.1% | -0.2582 | 0.64 | -2.47 |
| BTCUSDT | ALL | 1958 | 29.9% | -0.2457 | 0.64 | -8.91 |
| BTCUSDT | TRAIN | 1599 | 30.5% | -0.2376 | 0.65 | -7.78 |
| BTCUSDT | VALID | 222 | 28.8% | -0.2518 | 0.64 | -3.06 |
| BTCUSDT | OOS | 137 | 24.8% | -0.3294 | 0.55 | -3.18 |
