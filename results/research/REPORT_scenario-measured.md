# BulletBrain Research Report

**Generated:** 2026-07-28T08:37:14.452Z
**Cost model:** taker 5.0bps / maker 2.0bps / slip 6.0bps per side / funding 1.0bps per 8h -> break-even move 19.0bps
**Multiple-testing bar:** |t| > 3.02 (Bonferroni, family alpha 0.05)
**Splits:** TRAIN 2021-01-01..2025-06-30 | VALID 2025-07-01..2026-02-28 | OOS 2026-03-01..2026-12-31

## Verdict

**No strategy met the acceptance criteria.** No deployment is recommended.

## Ranking (by out-of-sample expectancy, pooled across symbols)

| strategy | tf | trades | WR | avgR | PF | t | Sharpe | maxDD(R) | verdict |
|---|---|---|---|---|---|---|---|---|---|
| donchian_breakout_4h | 4h | 269 | 38.3% | 0.0988 | 1.18 | 0.90 | 0.38 | 16.1 | reject |
| lowvol_trend_4h | 4h | 616 | 39.9% | 0.0915 | 1.17 | 1.34 | 0.57 | 29.4 | reject |
| ts_momentum_1d | 1d | 176 | 44.9% | 0.0484 | 1.12 | 0.54 | 0.24 | 9.7 | reject |
| bos_continuation_4h | 4h | 600 | 42.7% | 0.0113 | 1.02 | 0.24 | 0.10 | 24.3 | reject |
| vol_squeeze_breakout_4h | 4h | 136 | 32.4% | -0.1001 | 0.84 | -0.85 | -0.37 | 24.9 | reject |
| choch_reversal_4h | 4h | 775 | 31.9% | -0.1220 | 0.82 | -2.50 | -1.07 | 99.3 | reject |
| zscore_reversion_1h | 1h | 3152 | 41.3% | -0.1675 | 0.65 | -10.54 | -4.48 | 528.4 | reject |
| vwap_reversion_1h | 1h | 12622 | 52.4% | -0.1791 | 0.58 | -26.09 | -11.09 | 2261.5 | reject |
| htf_trend_pullback_4h | 4h | 807 | 28.6% | -0.2247 | 0.70 | -4.66 | -2.00 | 182.7 | reject |
| trend_pullback_1h | 1h | 3874 | 27.9% | -0.3402 | 0.55 | -16.98 | -7.21 | 1325.4 | reject |

## Rejected hypotheses and why

### donchian_breakout_4h (4h)

*Classic trend-following breakout (Donchian / Turtle lineage). Economic basis: sustained order-flow imbalance from slow institutional rebalancing means new extremes cluster. Long-horizon, low trade count, so the fee burden per unit of move is small.*

- ETHUSDT: |t|=0.728 <= 3.02 (multiple-testing bar)
- ETHUSDT: bootstrap 95% CI lower bound -0.051R <= 0
- BTCUSDT: |t|=0.548 <= 3.02 (multiple-testing bar)
- BTCUSDT/VALID: expectancy -0.055R <= 0
- BTCUSDT/OOS: expectancy -0.416R <= 0
- BTCUSDT: bootstrap 95% CI lower bound -0.137R <= 0

### lowvol_trend_4h (4h)

*The only candidate that showed consistent positive (if insignificant) alpha across both symbols and all windows in the 15m battery: trend-following conditioned on LOW realised volatility. Promoted to 4h, where the same effect has ~4x the move size against identical fixed costs. This is the single most evidence-motivated hypothesis in the registry.*

- ETHUSDT: |t|=0.168 <= 3.02 (multiple-testing bar)
- ETHUSDT/TRAIN: expectancy -0.028R <= 0
- ETHUSDT/OOS: expectancy -0.189R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.121R <= 0
- BTCUSDT: |t|=1.572 <= 3.02 (multiple-testing bar)
- BTCUSDT/OOS: expectancy -0.132R <= 0

### ts_momentum_1d (1d)

*Time-series momentum (Moskowitz, Ooi & Pedersen 2012): an assets own past excess return predicts its future return across essentially every liquid futures market, attributed to under-reaction and risk-transfer demand. The canonical 12-month/1-month lookbacks compress to weeks in crypto. Traded daily so fixed costs are negligible against the move size.*

- ETHUSDT: |t|=0.595 <= 3.02 (multiple-testing bar)
- ETHUSDT: bootstrap 95% CI lower bound -0.039R <= 0
- BTCUSDT: |t|=0.200 <= 3.02 (multiple-testing bar)
- BTCUSDT/VALID: expectancy -0.128R <= 0
- BTCUSDT: bootstrap 95% CI lower bound -0.147R <= 0

### bos_continuation_4h (4h)

*Break of structure continuation: price closing beyond the last confirmed swing in the direction of the prevailing structure. This is the institutional-flow reading of trend continuation, and unlike the old sweep signal it requires structure to AGREE rather than to be violated.*

- ETHUSDT: |t|=0.601 <= 3.02 (multiple-testing bar)
- ETHUSDT/VALID: expectancy -0.084R <= 0
- ETHUSDT/OOS: expectancy -0.055R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.094R <= 0
- BTCUSDT: expectancy -0.018R <= 0
- BTCUSDT: |t|=-0.276 <= 3.02 (multiple-testing bar)
- BTCUSDT: PF 0.963 <= 1
- BTCUSDT/VALID: expectancy -0.042R <= 0

### vol_squeeze_breakout_4h (4h)

*Volatility clustering (Engle/ARCH): low-volatility regimes are followed by high-volatility regimes. Enter on the expansion bar in its own direction. The edge is regime timing, not direction prediction.*

- ETHUSDT: expectancy -0.122R <= 0
- ETHUSDT: |t|=-0.753 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.809 <= 1
- ETHUSDT/TRAIN: expectancy -0.009R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.425R <= 0
- ETHUSDT: only 1/5 walk-forward folds positive
- BTCUSDT: expectancy -0.077R <= 0
- BTCUSDT: |t|=-0.450 <= 3.02 (multiple-testing bar)

### choch_reversal_4h (4h)

*Change of character: the first structural break AGAINST an established trend often marks distribution/accumulation completing. Counterpart hypothesis to bos_continuation — if continuation works, this should fail, and vice versa. Testing both guards against confirmation bias.*

- ETHUSDT: expectancy -0.076R <= 0
- ETHUSDT: |t|=-1.070 <= 3.02 (multiple-testing bar)
- ETHUSDT: PF 0.884 <= 1
- ETHUSDT/TRAIN: expectancy -0.153R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.212R <= 0
- ETHUSDT: only 2/5 walk-forward folds positive
- BTCUSDT: expectancy -0.167R <= 0
- BTCUSDT: |t|=-2.484 <= 3.02 (multiple-testing bar)

### zscore_reversion_1h (1h)

*Statistical overextension reversion: a single-bar move several sigma beyond recent realised volatility reflects liquidity depletion rather than information, and partially retraces as market makers rebuild inventory.*

- ETHUSDT: expectancy -0.155R <= 0
- ETHUSDT: PF 0.674 <= 1
- ETHUSDT/TRAIN: expectancy -0.153R <= 0
- ETHUSDT/VALID: expectancy -0.166R <= 0
- ETHUSDT/OOS: expectancy -0.159R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.198R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.179R <= 0

### vwap_reversion_1h (1h)

*Intraday mean reversion to session VWAP. Economic basis: VWAP is the execution benchmark for large orders, so systematic flow leans against deviations. Fades stretched moves rather than chasing them.*

- ETHUSDT: expectancy -0.166R <= 0
- ETHUSDT: PF 0.613 <= 1
- ETHUSDT/TRAIN: expectancy -0.168R <= 0
- ETHUSDT/VALID: expectancy -0.146R <= 0
- ETHUSDT/OOS: expectancy -0.171R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.184R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.192R <= 0

### htf_trend_pullback_4h (4h)

*Buy the pullback inside an established higher-timeframe uptrend. Rationale: trend persistence plus better entry location than breakout chasing, which the 15m study showed is where the old system lost (it bought decisive closes and became exit liquidity).*

- ETHUSDT: expectancy -0.245R <= 0
- ETHUSDT: PF 0.677 <= 1
- ETHUSDT/TRAIN: expectancy -0.278R <= 0
- ETHUSDT/OOS: expectancy -0.298R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.370R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.202R <= 0
- BTCUSDT: |t|=-2.896 <= 3.02 (multiple-testing bar)

### trend_pullback_1h (1h)

*The 4h pullback hypothesis at 1h. Included as an explicit timeframe-scaling control: if the SAME logic is profitable at 4h and unprofitable at 1h, that isolates the cost floor as the binding constraint rather than the signal.*

- ETHUSDT: expectancy -0.322R <= 0
- ETHUSDT: PF 0.575 <= 1
- ETHUSDT/TRAIN: expectancy -0.313R <= 0
- ETHUSDT/VALID: expectancy -0.364R <= 0
- ETHUSDT/OOS: expectancy -0.352R <= 0
- ETHUSDT: bootstrap 95% CI lower bound -0.373R <= 0
- ETHUSDT: only 0/5 walk-forward folds positive
- BTCUSDT: expectancy -0.358R <= 0

## Per-strategy detail

### donchian_breakout_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 135 | 37.8% | 0.1080 | 1.20 | 0.73 |
| ETHUSDT | TRAIN | 107 | 38.3% | 0.0951 | 1.18 | 0.61 |
| ETHUSDT | VALID | 19 | 36.8% | 0.1773 | 1.30 | 0.33 |
| ETHUSDT | OOS | 9 | 33.3% | 0.1148 | 1.22 | 0.21 |
| BTCUSDT | ALL | 134 | 38.8% | 0.0895 | 1.16 | 0.55 |
| BTCUSDT | TRAIN | 103 | 41.7% | 0.1785 | 1.33 | 0.89 |
| BTCUSDT | VALID | 18 | 38.9% | -0.0550 | 0.90 | -0.19 |
| BTCUSDT | OOS | 13 | 15.4% | -0.4160 | 0.44 | -1.02 |

### lowvol_trend_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 318 | 39.3% | 0.0137 | 1.02 | 0.17 |
| ETHUSDT | TRAIN | 259 | 38.2% | -0.0275 | 0.95 | -0.31 |
| ETHUSDT | VALID | 34 | 47.1% | 0.4772 | 2.13 | 1.53 |
| ETHUSDT | OOS | 25 | 40.0% | -0.1890 | 0.67 | -0.81 |
| BTCUSDT | ALL | 298 | 40.6% | 0.1745 | 1.34 | 1.57 |
| BTCUSDT | TRAIN | 240 | 41.7% | 0.2234 | 1.44 | 1.72 |
| BTCUSDT | VALID | 35 | 37.1% | 0.0405 | 1.08 | 0.15 |
| BTCUSDT | OOS | 23 | 34.8% | -0.1316 | 0.78 | -0.45 |

### ts_momentum_1d [1d]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 88 | 42.0% | 0.0694 | 1.18 | 0.59 |
| ETHUSDT | TRAIN | 70 | 42.9% | 0.0239 | 1.06 | 0.19 |
| ETHUSDT | VALID | 12 | 41.7% | 0.3063 | 1.92 | 0.81 |
| ETHUSDT | OOS | 6 | 33.3% | 0.1260 | 1.48 | 0.35 |
| BTCUSDT | ALL | 88 | 47.7% | 0.0273 | 1.07 | 0.20 |
| BTCUSDT | TRAIN | 68 | 47.1% | 0.0636 | 1.16 | 0.39 |
| BTCUSDT | VALID | 13 | 53.8% | -0.1277 | 0.74 | -0.44 |
| BTCUSDT | OOS | 7 | 42.9% | -0.0370 | 0.91 | -0.10 |

### bos_continuation_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 301 | 42.9% | 0.0402 | 1.08 | 0.60 |
| ETHUSDT | TRAIN | 241 | 44.4% | 0.0686 | 1.15 | 0.92 |
| ETHUSDT | VALID | 38 | 34.2% | -0.0840 | 0.85 | -0.44 |
| ETHUSDT | OOS | 22 | 40.9% | -0.0555 | 0.90 | -0.21 |
| BTCUSDT | ALL | 299 | 42.5% | -0.0179 | 0.96 | -0.28 |
| BTCUSDT | TRAIN | 235 | 43.4% | 0.0065 | 1.01 | 0.09 |
| BTCUSDT | VALID | 48 | 37.5% | -0.0418 | 0.92 | -0.25 |
| BTCUSDT | OOS | 16 | 43.8% | -0.3039 | 0.34 | -1.84 |

### vol_squeeze_breakout_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 70 | 32.9% | -0.1224 | 0.81 | -0.75 |
| ETHUSDT | TRAIN | 54 | 38.9% | -0.0092 | 0.98 | -0.05 |
| ETHUSDT | VALID | 9 | 11.1% | -0.6808 | 0.26 | -1.95 |
| ETHUSDT | OOS | 7 | 14.3% | -0.2769 | 0.60 | -0.51 |
| BTCUSDT | ALL | 66 | 31.8% | -0.0765 | 0.88 | -0.45 |
| BTCUSDT | TRAIN | 50 | 32.0% | -0.1803 | 0.71 | -1.04 |
| BTCUSDT | VALID | 12 | 41.7% | 0.5565 | 1.91 | 0.97 |
| BTCUSDT | OOS | 4 | 0.0% | -0.6783 | 0.00 | -3.13 |

### choch_reversal_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 383 | 32.4% | -0.0757 | 0.88 | -1.07 |
| ETHUSDT | TRAIN | 316 | 29.7% | -0.1533 | 0.78 | -2.02 |
| ETHUSDT | VALID | 42 | 42.9% | 0.2983 | 1.56 | 1.24 |
| ETHUSDT | OOS | 25 | 48.0% | 0.2780 | 1.57 | 0.97 |
| BTCUSDT | ALL | 392 | 31.4% | -0.1673 | 0.76 | -2.48 |
| BTCUSDT | TRAIN | 315 | 30.5% | -0.1949 | 0.72 | -2.62 |
| BTCUSDT | VALID | 51 | 37.3% | 0.0646 | 1.10 | 0.31 |
| BTCUSDT | OOS | 26 | 30.8% | -0.2869 | 0.58 | -1.22 |

### zscore_reversion_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 1551 | 42.1% | -0.1553 | 0.67 | -6.85 |
| ETHUSDT | TRAIN | 1234 | 42.0% | -0.1533 | 0.68 | -6.00 |
| ETHUSDT | VALID | 198 | 41.9% | -0.1658 | 0.65 | -2.65 |
| ETHUSDT | OOS | 119 | 43.7% | -0.1586 | 0.66 | -1.98 |
| BTCUSDT | ALL | 1601 | 40.6% | -0.1794 | 0.63 | -8.04 |
| BTCUSDT | TRAIN | 1290 | 40.5% | -0.1774 | 0.64 | -7.12 |
| BTCUSDT | VALID | 193 | 40.4% | -0.1954 | 0.61 | -3.04 |
| BTCUSDT | OOS | 118 | 41.5% | -0.1759 | 0.63 | -2.16 |

### vwap_reversion_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 6204 | 53.4% | -0.1656 | 0.61 | -16.71 |
| ETHUSDT | TRAIN | 4949 | 53.0% | -0.1681 | 0.61 | -15.12 |
| ETHUSDT | VALID | 768 | 55.5% | -0.1462 | 0.66 | -5.11 |
| ETHUSDT | OOS | 487 | 53.6% | -0.1714 | 0.58 | -5.05 |
| BTCUSDT | ALL | 6418 | 51.5% | -0.1920 | 0.55 | -20.20 |
| BTCUSDT | TRAIN | 5125 | 51.9% | -0.1842 | 0.57 | -17.27 |
| BTCUSDT | VALID | 815 | 50.8% | -0.2214 | 0.50 | -8.40 |
| BTCUSDT | OOS | 478 | 48.7% | -0.2259 | 0.49 | -6.56 |

### htf_trend_pullback_4h [4h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 424 | 27.1% | -0.2448 | 0.68 | -3.67 |
| ETHUSDT | TRAIN | 342 | 26.0% | -0.2775 | 0.64 | -3.78 |
| ETHUSDT | VALID | 51 | 35.3% | 0.0066 | 1.01 | 0.03 |
| ETHUSDT | OOS | 31 | 25.8% | -0.2981 | 0.60 | -1.26 |
| BTCUSDT | ALL | 383 | 30.3% | -0.2025 | 0.72 | -2.90 |
| BTCUSDT | TRAIN | 299 | 31.8% | -0.1622 | 0.77 | -2.03 |
| BTCUSDT | VALID | 50 | 28.0% | -0.2898 | 0.63 | -1.49 |
| BTCUSDT | OOS | 34 | 20.6% | -0.4282 | 0.47 | -2.02 |

### trend_pullback_1h [1h]

| symbol | window | n | WR | avgR | PF | t |
|---|---|---|---|---|---|---|
| ETHUSDT | ALL | 1909 | 28.2% | -0.3221 | 0.57 | -11.17 |
| ETHUSDT | TRAIN | 1544 | 28.4% | -0.3133 | 0.58 | -9.75 |
| ETHUSDT | VALID | 223 | 26.5% | -0.3642 | 0.53 | -4.36 |
| ETHUSDT | OOS | 142 | 28.2% | -0.3518 | 0.55 | -3.32 |
| BTCUSDT | ALL | 1965 | 27.6% | -0.3577 | 0.53 | -12.85 |
| BTCUSDT | TRAIN | 1607 | 28.2% | -0.3456 | 0.54 | -11.23 |
| BTCUSDT | VALID | 218 | 26.1% | -0.3981 | 0.50 | -4.79 |
| BTCUSDT | OOS | 140 | 22.9% | -0.4342 | 0.48 | -4.07 |
