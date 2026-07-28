# BulletBrain Research Journal

Append-only record of every research cycle. Written automatically by the
orchestrator so failed ideas are never silently re-tested.

---

## Cycle 1 — 2026-07-28T08:56:27.649Z

- experiment: `exp_20260728085627_b7w08b`
- cost scenario: measured
- dataset: `d7fc1bbe90fdb723` (ETHUSDT 195300 to 2026-07-28T08:45, BTCUSDT 195300 to 2026-07-28T08:45)

### What was tested

14 strategies across 3 timeframes.

### What improved

- nothing materially

### What regressed

- nothing materially

### What failed, and why

- **donchian_breakout_4h** (RESEARCH) — statistical_significance: t=0.90 (bar 3.12)
- **lowvol_trend_4h** (RESEARCH) — statistical_significance: t=1.31 (bar 3.12)
- **composite_trend_vol_4h** (RESEARCH) — statistical_significance: t=0.77 (bar 3.12)
- **ts_momentum_1d** (RESEARCH) — statistical_significance: t=0.54 (bar 3.12)
- **bos_continuation_4h** (RESEARCH) — statistical_significance: t=0.24 (bar 3.12)
- **vol_squeeze_breakout_4h** (RESEARCH) — positive_expectancy: expectancy -0.1001R
- **range_fade_4h** (RESEARCH) — sample_size: 0 trades (need >= 50)
- **mtf_structure_align_4h** (RESEARCH) — statistical_significance: t=1.90 (bar 3.12)
- **session_breakout_1h** (RESEARCH) — positive_expectancy: expectancy -0.0458R
- **choch_reversal_4h** (REJECTED) — positive_expectancy: expectancy -0.1220R
- **zscore_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1675R
- **vwap_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1791R

### Edge decay watch

- insufficient cycle history for trend detection (need >= 3 cycles)

### What should be tested next

- Regress donchian_breakout_4h, lowvol_trend_4h, ts_momentum_1d against buy-and-hold and test residual alpha — they show positive expectancy but only on one side, which is beta, not skill.
- Run parameter-stability sweeps on lowvol_trend_4h, mtf_structure_align_4h — positive but not significant; stability would distinguish a weak real effect from noise.
- Test the INVERSE of zscore_reversion_1h, vwap_reversion_1h, htf_trend_pullback_4h, trend_pullback_1h — significantly negative expectancy is exploitable information if it survives costs in reverse.
- Add non-OHLCV features (funding rate, liquidations, order-book imbalance) — the OHLCV hypothesis space is close to exhausted at these timeframes.
- Expand to a 20+ symbol universe to enable cross-sectional (market-neutral) strategies, which structurally remove the beta contamination blocking current candidates.

---

## Cycle 2 — 2026-07-28T08:57:46.683Z

- experiment: `exp_20260728085746_pog0ex`
- cost scenario: measured
- dataset: `d7fc1bbe90fdb723` (ETHUSDT 195300 to 2026-07-28T08:45, BTCUSDT 195300 to 2026-07-28T08:45)

### What was tested

14 strategies across 3 timeframes.

### What improved

- nothing materially

### What regressed

- nothing materially

### Status changes

- range_fade_4h: RESEARCH → NO_SIGNALS

### What failed, and why

- **mtf_structure_align_4h** (RESEARCH) — statistical_significance: t=1.90 (bar 3.12)
- **donchian_breakout_4h** (RESEARCH) — statistical_significance: t=0.90 (bar 3.12)
- **lowvol_trend_4h** (RESEARCH) — statistical_significance: t=1.31 (bar 3.12)
- **composite_trend_vol_4h** (RESEARCH) — statistical_significance: t=0.77 (bar 3.12)
- **ts_momentum_1d** (RESEARCH) — statistical_significance: t=0.54 (bar 3.12)
- **bos_continuation_4h** (RESEARCH) — statistical_significance: t=0.24 (bar 3.12)
- **session_breakout_1h** (RESEARCH) — positive_expectancy: expectancy -0.0458R
- **vol_squeeze_breakout_4h** (RESEARCH) — positive_expectancy: expectancy -0.1001R
- **choch_reversal_4h** (REJECTED) — positive_expectancy: expectancy -0.1220R
- **zscore_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1675R
- **vwap_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1791R
- **htf_trend_pullback_4h** (REJECTED) — positive_expectancy: expectancy -0.2259R

### Edge decay watch

- insufficient cycle history for trend detection (need >= 3 cycles)

### What should be tested next

- Regress donchian_breakout_4h, lowvol_trend_4h, ts_momentum_1d against buy-and-hold and test residual alpha — they show positive expectancy but only on one side, which is beta, not skill.
- Run parameter-stability sweeps on mtf_structure_align_4h, lowvol_trend_4h — positive but not significant; stability would distinguish a weak real effect from noise.
- Test the INVERSE of zscore_reversion_1h, vwap_reversion_1h, htf_trend_pullback_4h, trend_pullback_1h — significantly negative expectancy is exploitable information if it survives costs in reverse.
- Add non-OHLCV features (funding rate, liquidations, order-book imbalance) — the OHLCV hypothesis space is close to exhausted at these timeframes.
- Expand to a 20+ symbol universe to enable cross-sectional (market-neutral) strategies, which structurally remove the beta contamination blocking current candidates.

---

## Cycle 3 — 2026-07-28T08:59:13.315Z

- experiment: `exp_20260728085913_pog0ex`
- cost scenario: measured
- dataset: `d7fc1bbe90fdb723` (ETHUSDT 195300 to 2026-07-28T08:45, BTCUSDT 195300 to 2026-07-28T08:45)

### What was tested

14 strategies across 3 timeframes.

### What improved

- nothing materially

### What regressed

- nothing materially

### What failed, and why

- **mtf_structure_align_4h** (RESEARCH) — statistical_significance: t=1.90 (bar 3.12)
- **donchian_breakout_4h** (RESEARCH) — statistical_significance: t=0.90 (bar 3.12)
- **lowvol_trend_4h** (RESEARCH) — statistical_significance: t=1.31 (bar 3.12)
- **composite_trend_vol_4h** (RESEARCH) — statistical_significance: t=0.77 (bar 3.12)
- **ts_momentum_1d** (RESEARCH) — statistical_significance: t=0.54 (bar 3.12)
- **bos_continuation_4h** (RESEARCH) — statistical_significance: t=0.24 (bar 3.12)
- **session_breakout_1h** (RESEARCH) — positive_expectancy: expectancy -0.0458R
- **vol_squeeze_breakout_4h** (RESEARCH) — positive_expectancy: expectancy -0.1001R
- **choch_reversal_4h** (REJECTED) — positive_expectancy: expectancy -0.1220R
- **zscore_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1675R
- **vwap_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1791R
- **htf_trend_pullback_4h** (REJECTED) — positive_expectancy: expectancy -0.2259R

### Edge decay watch

- mtf_structure_align_4h: stable (0.1080R → 0.1080R over 3 cycles)
- donchian_breakout_4h: stable (0.0988R → 0.0988R over 3 cycles)
- lowvol_trend_4h: stable (0.0896R → 0.0896R over 3 cycles)
- composite_trend_vol_4h: stable (0.0524R → 0.0524R over 3 cycles)
- ts_momentum_1d: stable (0.0484R → 0.0484R over 3 cycles)
- bos_continuation_4h: stable (0.0113R → 0.0113R over 3 cycles)
- session_breakout_1h: stable (-0.0458R → -0.0458R over 3 cycles)
- vol_squeeze_breakout_4h: stable (-0.1001R → -0.1001R over 3 cycles)

### What should be tested next

- Regress donchian_breakout_4h, lowvol_trend_4h, ts_momentum_1d against buy-and-hold and test residual alpha — they show positive expectancy but only on one side, which is beta, not skill.
- Run parameter-stability sweeps on mtf_structure_align_4h, lowvol_trend_4h — positive but not significant; stability would distinguish a weak real effect from noise.
- Test the INVERSE of zscore_reversion_1h, vwap_reversion_1h, htf_trend_pullback_4h, trend_pullback_1h — significantly negative expectancy is exploitable information if it survives costs in reverse.
- Add non-OHLCV features (funding rate, liquidations, order-book imbalance) — the OHLCV hypothesis space is close to exhausted at these timeframes.
- Expand to a 20+ symbol universe to enable cross-sectional (market-neutral) strategies, which structurally remove the beta contamination blocking current candidates.

---

## Cycle 4 — 2026-07-28T09:00:19.980Z

- experiment: `exp_20260728090019_pog0ex`
- cost scenario: measured
- dataset: `8af5b6cca1337e68` (ETHUSDT 195301 to 2026-07-28T09:00, BTCUSDT 195301 to 2026-07-28T09:00)

### What was tested

14 strategies across 3 timeframes.

### What improved

- nothing materially

### What regressed

- nothing materially

### What failed, and why

- **mtf_structure_align_4h** (RESEARCH) — statistical_significance: t=1.90 (bar 3.12)
- **donchian_breakout_4h** (RESEARCH) — statistical_significance: t=0.90 (bar 3.12)
- **lowvol_trend_4h** (RESEARCH) — statistical_significance: t=1.31 (bar 3.12)
- **composite_trend_vol_4h** (RESEARCH) — statistical_significance: t=0.77 (bar 3.12)
- **ts_momentum_1d** (RESEARCH) — statistical_significance: t=0.54 (bar 3.12)
- **bos_continuation_4h** (RESEARCH) — statistical_significance: t=0.24 (bar 3.12)
- **session_breakout_1h** (RESEARCH) — positive_expectancy: expectancy -0.0458R
- **vol_squeeze_breakout_4h** (RESEARCH) — positive_expectancy: expectancy -0.1001R
- **choch_reversal_4h** (REJECTED) — positive_expectancy: expectancy -0.1220R
- **zscore_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1675R
- **vwap_reversion_1h** (REJECTED) — positive_expectancy: expectancy -0.1791R
- **htf_trend_pullback_4h** (REJECTED) — positive_expectancy: expectancy -0.2259R

### Edge decay watch

- mtf_structure_align_4h: stable (0.1080R → 0.1080R over 4 cycles)
- donchian_breakout_4h: stable (0.0988R → 0.0988R over 4 cycles)
- lowvol_trend_4h: stable (0.0896R → 0.0896R over 4 cycles)
- composite_trend_vol_4h: stable (0.0524R → 0.0524R over 4 cycles)
- ts_momentum_1d: stable (0.0484R → 0.0484R over 4 cycles)
- bos_continuation_4h: stable (0.0113R → 0.0113R over 4 cycles)
- session_breakout_1h: stable (-0.0458R → -0.0458R over 4 cycles)
- vol_squeeze_breakout_4h: stable (-0.1001R → -0.1001R over 4 cycles)

### What should be tested next

- Regress donchian_breakout_4h, lowvol_trend_4h, ts_momentum_1d against buy-and-hold and test residual alpha — they show positive expectancy but only on one side, which is beta, not skill.
- Run parameter-stability sweeps on mtf_structure_align_4h, lowvol_trend_4h — positive but not significant; stability would distinguish a weak real effect from noise.
- Test the INVERSE of zscore_reversion_1h, vwap_reversion_1h, htf_trend_pullback_4h, trend_pullback_1h — significantly negative expectancy is exploitable information if it survives costs in reverse.
- Add non-OHLCV features (funding rate, liquidations, order-book imbalance) — the OHLCV hypothesis space is close to exhausted at these timeframes.
- Expand to a 20+ symbol universe to enable cross-sectional (market-neutral) strategies, which structurally remove the beta contamination blocking current candidates.
