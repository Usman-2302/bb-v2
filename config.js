/**
 * BulletBrain v3.0 — Master Configuration
 *
 * ALL parameters live here. Never hardcode values in strategy or engine files.
 * Source: backtestplan.md — Steps 0.1, 0.4, 1.1, 2.1, 3.1, 5.1, 6.1
 *
 * RULE: If you change a parameter here, re-run the full backtest cycle.
 * Changing parameters mid-cycle invalidates all prior results.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────────────────────────────────────

const DATA = {
  coins:      ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
  timeframes: ['15m', '1h', '4h', '1d'],
  startDate:  '2021-01-01',
  endDate:    '2024-12-31',   // 2025 reserved for forward test — never touch until Phase D13
  paths: {
    historical: 'data/historical',
    oi:         'data/oi',
    funding:    'data/funding',
    results:    'results',
    logs:       'logs',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION COSTS
// Source: backtestplan.md lines 211-295 (Step 0.4)
// ─────────────────────────────────────────────────────────────────────────────

// Per-symbol slippage — altcoins are 3-8× worse than BTC
const EXECUTION_PARAMS = {
  BTCUSDT: { baseSlippage: 0.0004, killzoneSlippage: 0.0002, crisisSlippage: 0.0015 },
  ETHUSDT: { baseSlippage: 0.0006, killzoneSlippage: 0.0003, crisisSlippage: 0.0020 },
  SOLUSDT: { baseSlippage: 0.0012, killzoneSlippage: 0.0006, crisisSlippage: 0.0040 },
  BNBUSDT: { baseSlippage: 0.0008, killzoneSlippage: 0.0004, crisisSlippage: 0.0025 },
  XRPUSDT: { baseSlippage: 0.0015, killzoneSlippage: 0.0008, crisisSlippage: 0.0050 },
};

// Tick sizes per symbol (for adverse selection fill model)
const TICK_SIZES = {
  BTCUSDT: 0.10,
  ETHUSDT: 0.01,
  SOLUSDT: 0.001,
  BNBUSDT: 0.01,
  XRPUSDT: 0.0001,
};

const COSTS = {
  fee_round_trip: 0.0004,   // 0.04% maker fee × 2 sides (Binance Futures maker)
  reentry_cost:   0.0004,   // extra cost when cancelled limit re-enters at market

  // FUNDING: DO NOT use flat rate in P&L. Use applyFundingCost() with actual data.
  // This baseline is only for validation comparison.
  funding_per_8h_BASELINE_ONLY: 0.0001,

  funding_ev_check: {
    threshold_reduce: 0.20,  // projected funding > 20% of target R → halve size
    threshold_skip:   0.40,  // projected funding > 40% of target R → skip trade
  },

  // Signal-to-execution latency cost (systematic bias, not random)
  signal_delay_cost: {
    '15m': 0.0003,   // ~500ms × 15m volatility ≈ 0.03% adverse move
    '1h':  0.0001,
    '4h':  0.00005,
    '1d':  0.00001,
  },

  // Per-strategy fill rates (SMC levels are crowded — 85% flat is wrong)
  fill_rate: {
    FVG: 0.65,
    OB:  0.70,
    LSO: 0.75,
    VPB: 0.72,
    CVD: 0.70,
  },

  // Crisis stop-loss fill realism
  crisis_stop_slippage: 0.005,  // 0.5% adverse on emergency exits
};

// ─────────────────────────────────────────────────────────────────────────────
// REGIME DETECTION
// Source: backtestplan.md lines 409-598 (Steps 0.5, 0.7)
// ─────────────────────────────────────────────────────────────────────────────

const REGIME = {
  // EMA slope threshold — ATR-normalized, empirically derived from BTC 4H 2021-2024
  // Formula: emaAtrSlope = emaChange / (atr14 * lookback) — self-calibrating
  // 0.011 = 30th percentile of bull months (weakest valid bull trend)
  // Geometric meaning: EMA200 moved 0.22 ATRs over 20 candles
  // Monthly accuracy: 64.6% (higher within regimes, lower at transitions)
  // Known limitation: 3-4 week lag on sharp reversals (EMA200 property, not fixable)
  // Evidence: results/regime_calibration.json, tests/slope_distribution.js
  // LOCKED — never change without re-running calibration
  slopeThreshold:    0.011,
  slopeLookback:     20,    // 20 × 4H candles = 5 days of EMA trend measurement

  // Price above EMA200 count thresholds — REMOVED (replaced by ATR-slope)
  // Kept for backward compatibility but not used in detectRegimeRaw
  bullPriceAboveEMA: 20,
  bearPriceAboveEMA: 10,

  // ATR% thresholds
  crisisATRpct:      5.0,  // ATR% > 5% → CRISIS (overrides everything)

  // Vol-switch: immediate CRISIS override (bypasses 4H anti-flapping)
  volSwitchMultiple: 3.0,  // 15m ATR > 3× 4H baseline → force CRISIS

  // Anti-flapping: require N consecutive 4H closes to switch regime
  antiFlappingCandles: 2,

  // Zombie state (sub-state of RANGING)
  // CALIBRATED: 0.15 threshold reduces zombie from 44% to ~15% of candles
  // At 0.30 (original): 44% zombie — too aggressive, misclassifies real ranging
  zombieERthreshold:    0.15,  // ER < 0.15 → RANGING_ZOMBIE (was 0.30)
  zombieATRmultiple:    0.50,  // ATR < 0.50× RANGING avg → ZOMBIE
  zombieCooldown:       3,     // N consecutive candles before zombie activates/deactivates
                               // Prevents state flickering when ER hovers near threshold
                               // 3 × 4H = 12 hours minimum hold

  // Pre-zone (transition into zombie)
  prezoneERthreshold:   0.45,  // ER < 0.45 (softer than zombie)
  prezoneATRmultiple:   0.70,  // ATR < 0.70× RANGING avg → PREZONE
  prezoneDeclineCandles: 3,    // ATR must decline for N consecutive checks

  // Efficiency Ratio period
  erPeriod: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// POSITION SIZING
// Source: backtestplan.md lines 1331-1411 (Step 6.1)
// ─────────────────────────────────────────────────────────────────────────────

const SIZING = {
  baseRisk: 0.01,   // 1% of capital per trade

  regimeMultiplier: {
    BULL:         1.0,
    RANGING:      0.7,
    RANGING_PREZONE: 0.5,  // 50% size during zombie transition
    BEAR_SHORT:   1.0,
    BEAR_LONG:    0.5,
    CRISIS:       0.5,
    RANGING_ZOMBIE: 0.0,   // no FVG/OB in zombie (LSO only at full size)
  },

  streakMultiplier: {
    0: 1.00,
    1: 1.00,
    2: 1.00,
    3: 0.75,
    4: 0.50,
    5: 0.25,   // 5+ consecutive losses → 0.25× AND Telegram alert
  },

  confidenceMultiplier: {
    standard:         1.0,
    high_confluence:  1.3,   // all gates + F&G + funding + OI >= 2.5%
    crowded_reversal: 1.2,   // extreme funding + LSO
    weak:             0.7,   // outside killzone or Gate T relaxed
    ultra_confluence: 1.5,   // LSO + extreme funding + CVD + OI >= 3% (gated by OI z-score)
  },

  // Hard caps
  minRisk: 0.0025,   // 0.25% minimum
  maxRisk: 0.015,    // 1.5% maximum (Phase 1 live)
  absoluteMaxRisk: 0.020,  // 2.0% absolute cap (Phase 2 live — never exceed)

  // Ultra-confluence gates (all must be true to allow 1.5× multiplier)
  ultraConfluenceGates: {
    maxOIzscore:       1.5,   // OI z-score < 1.5 (market not overheated)
    maxATRratio:       1.5,   // current ATR / 30-day avg ATR < 1.5
    maxProjectedHoldDays: 1,  // intraday only — no overnight at max size
  },

  // ATR-inverse volatility multiplier
  atrVolMultiplier: {
    above2x: 0.5,   // ATR > 2× 30-day avg → half size
    above1_5x: 0.7, // ATR > 1.5× 30-day avg → 70% size
    below0_5x: 1.2, // ATR very low → slight increase
    normal: 1.0,
  },

  // Portfolio heat
  maxConcurrentTrades: 3,
  maxPortfolioRisk:    0.03,  // 3% total risk across all open positions

  // Correlation clusters (max 1 open position per cluster)
  correlationClusters: {
    A: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    B: ['XRPUSDT'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL-STRENGTH RISK SCALING (SMART / LEVERAGE account)
// Scores every trade on 3 pillars (0-2 pts each, max 6).
// Higher score → higher risk allocation. Score 0-1 → SKIP entirely.
// Source: feat/conviction-correlation — mathematical proof of +106% P&L
// ─────────────────────────────────────────────────────────────────────────────

const LEVERAGE = {
  // RVOL thresholds for scoring
  rvolHigh: 2.0,     // RVOL ≥ 2.0 → +2 pts (institutional sweep)
  rvolMid:  1.5,     // RVOL ≥ 1.5 → +1 pt (moderate sweep)

  // Pool depth thresholds (ratio vs median pool volume)
  poolDeep:    2.0,  // poolVol ≥ 2× median → +2 pts (deep liquidity magnet)
  poolStandard: 1.0, // poolVol ≥ 1× median → +1 pt (standard pool)

  // Minimum score to take a trade (0-1 → SKIP)
  minTradeScore: 2,

  // Score → Risk Multiplier mapping
  // Score 0-1: SKIP (below minimum)
  // Score 2: 0.5x (15 trades, WR 35%, loss reduced by 50%)
  // Score 3: 0.75x (below-average quality)
  // Score 4: 1.0x (standard — baseline risk)
  // Score 5: 1.5x (high conviction — Phase D9 strong setups)
  // Score 6: 2.0x (ultra conviction — z≥2.5, BULL, deep pool, high RVOL)
  scoreMap: {
    2: 0.5,
    3: 0.75,
    4: 1.0,
    5: 1.5,
    6: 2.0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY: FVG
// Source: backtestplan.md lines 607-707 (Step 1.1)
// ─────────────────────────────────────────────────────────────────────────────

const FVG = {
  bodyMultiplier:  1.2,     // impulse candle body > N × ATR14
  rvolThreshold:   1.8,     // impulse candle volume > N × RVOL
  validityCandles: 288,     // FVG expires after N candles
                            // 15m: 288 × 15m = 72 hours (3 days) — matches 1H plan
                            // 1H:  72 × 1H  = 72 hours (3 days)
  entryAtMid:      true,    // enter at 50% of FVG zone
  entryOffset:     0.25,    // entry depth into FVG zone (0.25 = 25% in from top)
                            // Baseline 2.0: 0.25 (closer to edge, lower toxic fill risk)
                            // Sensitivity test: compare 0.25 vs 0.50 in Step 1.7
                            // 0.25 = more conservative, higher fill rate, lower R:R
                            // 0.50 = midpoint, lower fill rate, higher R:R
  stopBuffer:      0.1,     // stop = FVG bottom - (N × ATR)
  minGapSize:      0.0005,  // minimum gap size as % of price (0.05%)
  maxContested:    2,       // skip FVG if touched >= N times without filling
};

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY: OB
// Source: backtestplan.md lines 898-931 (Step 2.1)
// ─────────────────────────────────────────────────────────────────────────────

const OB = {
  moveMultiplier:  1.5,   // "significant move" candle body > N × ATR14_1H
  rvolThreshold:   2.0,   // move candle volume > N × RVOL
  validityCandles: 48,    // OB expires after N candles (1H = 2 days)
  stopBuffer:      0.1,   // stop = OB low - (N × ATR)
};

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY: LSO
// Source: backtestplan.md lines 966-1111 (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

const LSO = {
  // Equal highs/lows detection
  equalTolerance:  0.003,  // highs/lows within 0.3% of each other
  equalLookback:   200,    // pool expiry in candles (extended from 50 — higher quality sweeps)
  equalMinGap:     5,      // minimum candles apart between the two levels

  // Swing low strictness — controls how selective the pool detector is
  // 1 = 1-bar lookback each side (low[i] < low[i±1]) — catches more pools
  // 2 = 2-bar lookback each side (low[i] < low[i±1,i±2]) — original, too strict
  // D8 finding: 2-bar produced only 14 trades over 4 years (1 per 104 days)
  // 1-bar is the correct balance: structural without being overly restrictive
  swingLookback:   1,

  // Session high/low pools (Gemini D8 suggestion)
  // Previous day's high/low and London session open high/low are massive
  // liquidity magnets — stops cluster there regardless of swing pivot structure.
  // OFF by default to preserve baseline comparability.
  // Enable in sensitivity test to measure impact on trade frequency and WR.
  useSessionPools: false,

  // Sweep detection
  maxBodyWickRatio: 0.4,   // body/wick ratio < 0.4 (wick-dominated candle)

  // OI flush thresholds (interpolated 15m, not raw 1H bucket)
  // Regime-specific: CRISIS requires stronger confirmation (more noise in volatile markets)
  oiFlushThreshold: {
    BULL:    0.030,   // 3.0%
    BEAR:    0.040,   // 4.0%
    RANGING: 0.030,   // 3.0%
    CRISIS:  0.045,   // 4.5%
  },

  // OI data availability fallback
  // When OI data is absent (historical gap), use this gate variant instead of blocking
  // 'OI_VELOCITY': use OI velocity proxy (already built in checkOIVelocityGate)
  // 'CVD': use candle CVD (less reliable on sweep candles — see Step 4.1)
  // 'CVD_ZSCORE': Synthetic Liquidation Gate (Gemini D8 Round 3)
  //   Uses CVD velocity z-score > 2.5 SD above 24h mean as synthetic OI flush proxy.
  //   Captures the "Volume/CVD decoupling" signature of institutional sweeps.
  //   Does not require OI data — pure tape-reading logic.
  // 'NONE': skip Gate 7 entirely (lower WR expected, use only as last resort)
  oiDataFallback: 'CVD_ZSCORE',  // Synthetic gate — best available without OI data

  // Synthetic Liquidation Gate parameters (CVD_ZSCORE mode)
  // cvdVelocityZscoreThreshold: minimum z-score of CVD velocity to confirm sweep
  // Higher = more selective (fewer trades, higher WR)
  // Lower = more permissive (more trades, lower WR)
  // 2.5 = ~1.2% of candles pass (statistically significant spike)
  cvdVelocityZscoreThreshold: 2.5,
  cvdVelocityLookback: 96,  // 24H of 15m candles for baseline calculation

  // Tier 2 CVD gate fallback (when z-score < 2.5, try lower bar with RVOL)
  // Used by both SNIPER and SCALPER. SCALPER overrides via extra._scalperRanging*
  cvdTier2ZscoreMin: 1.5,         // minimum z-score for Tier 2 pass (Tier 1 = 2.5)
  cvdTier2RvolRanging: 2.2,       // RVOL threshold for Tier 2 in RANGING/ZOMBIE
  cvdTier2RvolTrending: 3.0,      // RVOL threshold for Tier 2 in BULL/BEAR

  // SCALPER RANGING relaxations (Phase feat/conviction-correlation)
  // 6-day live data: 100% sweeps blocked by CVD_ZSCORE in low-vol RANGING.
  // Relaxed thresholds let SCALPER capture 3-5 quality trades/week in ranges.
  // SNIPER is NOT affected — keeps strict thresholds for trend-following.
  scalperRangingZscoreMin: 1.0,   // relaxed from 1.5
  scalperRangingRvolMin: 1.5,     // relaxed from 2.2

  // Sweep candle RVOL filter (Gemini D8 Round 3 — toxic fill floor fix)
  // Require minimum RVOL on the sweep candle itself.
  // A genuine institutional sweep has above-average volume.
  // Noise sweeps (random wicks) have low volume.
  // 0 = disabled (no RVOL filter on sweep candle)
  // 1.5 = require 1.5× average volume on sweep candle
  sweepRvolMin: 1.2,  // Quality RVOL filter — backtest proven (skip noise sweeps)

  stopBuffer:      0.1,   // stop = sweep low - (N × ATR14_15m)
  shortStopBuffer: 0.07,  // tighter stop for short LSO (squeeze risk)
};

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY: VPB
// Source: backtestplan.md lines 1230-1281 (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

const VPB = {
  rvolThreshold:       2.0,  // breakout candle volume > N × RVOL
  minCandlesBelowHVN:  3,    // price must be below HVN for N candles before breakout
  volumeProfileBuckets: 50,  // number of price buckets for 24H rolling profile
  volumeProfileWindow:  24,  // hours for rolling volume profile
  stopBuffer:           0.1, // stop = HVN - (N × ATR14_15m)
};

// ─────────────────────────────────────────────────────────────────────────────
// DOL (Draw on Liquidity) TARGET FINDER
// Source: backtestplan.md lines 644-707 (Step 1.2)
// ─────────────────────────────────────────────────────────────────────────────

const DOL = {
  lookback:    100,    // candles to scan for equal highs/lows clusters
  tolerance:   0.003,  // 0.3% — highs within this range form a cluster
  minTouches:  2,      // minimum touches to qualify as a liquidity cluster
  maxDistance: 0.05,   // 5% — reject if no DOL within 5% of entry
  minRR:       1.8,    // minimum R:R to accept a DOL target
};

// ─────────────────────────────────────────────────────────────────────────────
// RVOL THRESHOLDS BY SESSION
// Source: backtestplan.md lines 2005-2015 (Gate 3)
// ─────────────────────────────────────────────────────────────────────────────

const RVOL = {
  lookbackDays:    20,   // 20-day same-slot average
  killzone:        1.5,  // inside London/NY open
  nyPM:            1.8,  // NY afternoon session
  asian:           2.5,  // Asian session (stricter)
  outsideKillzone: 2.0,  // between sessions
};

// ─────────────────────────────────────────────────────────────────────────────
// KILLZONES / SESSION TIMES (UTC)
// Source: backtestplan.md lines 2015-2030 (Gate T)
// ─────────────────────────────────────────────────────────────────────────────

const SESSIONS = {
  londonOpen: { start: 7,  end: 9  },   // 07:00-09:00 UTC
  nyOpen:     { start: 13, end: 15 },   // 13:00-15:00 UTC
  asian:      { start: 22, end: 7  },   // 22:00-07:00 UTC (next day)

  // Asian session hard gates (no exceptions regardless of RVOL)
  asianDisabled: ['FVG', 'OB', 'VPB'],
  asianAllowed:  ['LSO'],               // sweeps valid in Asian session
};

// ─────────────────────────────────────────────────────────────────────────────
// TRADE MANAGEMENT
// Source: backtestplan.md lines 1469-1606 (Step 6.3)
// ─────────────────────────────────────────────────────────────────────────────

const TRADE = {
  // TP1: partial close at 1:1 R:R, move stop to breakeven
  tp1RR: 1.0,
  tp1CloseFraction: 0.5,   // close 50% at TP1

  // Time-based exit (max candles per regime)
  maxDurationCandles: {
    BULL:    48,   // 12 hours at 15m
    RANGING: 32,   // 8 hours
    BEAR:    64,   // 16 hours
    CRISIS:  16,   // 4 hours
  },

  // Momentum exit (only when trade is in profit > 0.5× R:R)
  momentumExit: {
    rvolDropThreshold:    0.8,   // current RVOL < 0.8 AND prior RVOL > 1.5
    cvdFlattenThreshold:  0.1,   // |cvdDelta| < 0.1 × |prior cvdDelta|
    rejectionWickRatio:   0.6,   // upper wick > 60% of candle range
    rejectionTPproximity: 0.95,  // within 5% of TP1
    closeFraction:        0.5,   // close 50% on momentum deterioration
  },

  // Z-score exit (blow-off top capture)
  zscoreExit: {
    threshold1: { zscore: 3.5, pctToTP2: 0.80 },  // full exit
    threshold2: { zscore: 2.5, pctToTP2: 0.90 },  // full exit near TP2
  },

  // Position scaling (pyramiding after TP1)
  pyramiding: {
    enabled:         true,
    addOnFraction:   0.50,   // add 25-50% of original size
    maxAddOnRisk:    0.005,  // 0.5% max risk on add-on
    rvolConfirm:     1.5,    // RVOL > 1.5× on continuation candle
    maxCandlesAfterTP1: 2,   // add-on signal must fire within 2 candles of TP1
  },

  // Daily loss limit
  dailyLossLimit: 0.03,   // pause all trading if daily loss > 3%
};

// ─────────────────────────────────────────────────────────────────────────────
// MACRO GATES
// Source: backtestplan.md lines 2040-2055 (Gate 8)
// ─────────────────────────────────────────────────────────────────────────────

const MACRO = {
  // Fear & Greed thresholds per regime
  fng: {
    BULL:    { min: 35, max: 85 },   // skip if F&G < 35 or > 85
    BEAR:    { min: 0,  max: 60 },   // skip shorts if F&G > 60
    RANGING: { min: 30, max: 70 },
  },

  // Funding rate thresholds
  funding: {
    extremePositive:  0.001,   // > +0.1% per 8H → skip new longs
    extremeNegative: -0.001,   // < -0.1% per 8H → skip new shorts
    reduceSizeAt:     0.0005,  // > ±0.05% → reduce size 50%
  },

  // Macro event blackout (minutes before + after)
  blackoutBefore: 30,
  blackoutAfter:  15,
};

// ─────────────────────────────────────────────────────────────────────────────
// GATE ADAPTIVE THRESHOLDS
// Regime-adaptive scaling for entry gates.
// Source: Phase feat/conviction-correlation — 10-day live data analysis
// ─────────────────────────────────────────────────────────────────────────────

const GATES = {
  // Gate 7 (CVD Velocity) regime-adaptive scaling
  // In RANGING markets, CVD delta and std compress simultaneously,
  // keeping z-scores flat regardless of sweep quality. A static 2.5σ
  // threshold becomes unreachable, blocking 100% of sweeps.
  //
  // The multiplier reduces the Tier 1 z-score threshold in RANGING.
  // The floor prevents the threshold from dropping below statistical significance.
  gate7_range_multiplier: 0.5,    // 50% reduction in RANGING (2.5 → 1.25)
  gate7_range_zscore_floor: 1.0,  // never drop below z=1.0 (still 1σ above mean)
};

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST ENGINE
// Source: backtestplan.md lines 194-408 (Step 0.4)
// ─────────────────────────────────────────────────────────────────────────────

const ENGINE = {
  // Acceptance criteria per strategy (isolated backtest)
  acceptance: {
    minPF:          1.5,
    maxDD:          0.08,   // 8%
    minWR:          0.42,
    minRegimes:     2,      // positive PF in at least 2 regimes
    minTradesPerRegime: 30, // below this → INSUFFICIENT_DATA
    minYearsPositive: 3,    // PF >= 1.2 in at least 3 of 4 years
  },

  // Combined system acceptance
  combinedAcceptance: {
    minPF:          1.6,
    minAnnualReturn: 0.35,
    maxDD:          0.15,
    minSharpe:      1.5,
  },

  // Sensitivity test
  sensitivityTest: {
    range:          0.20,   // test ±20% of each parameter
    maxWRvariation: 0.15,   // WR variation > 15pp → parameter is fragile
  },

  // Walk-forward (rolling 18-month windows)
  walkForward: {
    trainMonths: 18,
    testMonths:  6,
    windows:     5,
    maxDegradation: 0.20,  // PF degrades > 20% → fail
  },

  // Monte Carlo
  monteCarlo: {
    simulations:    1000,
    blockWeeks:     4,      // shuffle 4-week blocks (not individual trades)
    fillNoise:      0.0005, // ±0.05% noise on fill prices
    tradeRemoval:   0.05,   // remove 5% of trades randomly
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SELF-MONITORING (Phase D14)
// Source: backtestplan.md lines 2028-2070 (Step 9.2)
// ─────────────────────────────────────────────────────────────────────────────

const MONITORING = {
  watch: {
    rollingTrades:      25,
    minWR:              0.35,
    minPF:              1.2,
    maxConsecutiveLoss: 4,
  },
  pause: {
    rollingTrades: 50,
    minWR:         0.30,
    minPF:         1.0,
  },
  resume: {
    minPauseDays:    7,
    paperTradesRequired: 5,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SYMBOL STRATEGY POLICY MAP (Phase D11)
// Source: Phase D6 backtest findings — FVG REJECT on BTC is BTC-specific.
//
// FVG on BTC: 70%+ toxic fill rate, entryOffset FRAGILE at 39pp.
//   BTC microstructure is momentum-driven — FVG midpoints are slippage traps.
// FVG on ETH/SOL: untested. ETH has more institutional absorption behavior.
//   Leave door open — verify in Phase D11 combined runner.
//
// Policy values:
//   'LEAD_STRATEGY'    — strategy fires independently, full position sizing
//   'CONFLUENCE_ONLY'  — strategy used as boolean zone check only, no standalone entry
//   'DISABLED'         — strategy not used for this symbol
//   'PENDING'          — not yet tested, default to LEAD_STRATEGY in Phase D11
//
// entryOffset note (Issue 1 / Phase D11):
//   When FVG is CONFLUENCE_ONLY, entryOffset is IGNORED.
//   The entry trigger comes from the lead strategy (LSO/OB).
//   FVG zone check is boolean: is price inside an active FVG zone? yes/no.
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_STRATEGY_POLICY = {
  BTCUSDT: {
    FVG: 'CONFLUENCE_ONLY',  // D6 REJECT — toxic fill rate 70%+, entryOffset FRAGILE
    OB:  'CONFLUENCE_ONLY',  // D7 REJECT — PF 0.488, DD 8.62%, 0/4 positive years
    LSO: 'PENDING',          // D8 — not yet tested
    VPB: 'PENDING',          // D9 — not yet tested
  },
  ETHUSDT: {
    FVG: 'PENDING',          // D6 result is BTC-specific — test in D11
    OB:  'PENDING',
    LSO: 'PENDING',
    VPB: 'PENDING',
  },
  SOLUSDT: {
    FVG: 'PENDING',          // higher mean-reversion tendency — may differ from BTC
    OB:  'PENDING',
    LSO: 'PENDING',
    VPB: 'PENDING',
  },
  BNBUSDT: {
    FVG: 'PENDING',
    OB:  'PENDING',
    LSO: 'PENDING',
    VPB: 'PENDING',
  },
  XRPUSDT: {
    FVG: 'PENDING',
    OB:  'PENDING',
    LSO: 'PENDING',
    VPB: 'PENDING',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  DATA,
  EXECUTION_PARAMS,
  TICK_SIZES,
  COSTS,
  REGIME,
  SIZING,
  LEVERAGE,
  FVG,
  OB,
  LSO,
  VPB,
  DOL,
  RVOL,
  SESSIONS,
  TRADE,
  MACRO,
  GATES,
  ENGINE,
  MONITORING,
  SYMBOL_STRATEGY_POLICY,
};
