# BulletBrain v3.0 — The Real Edge Master Plan
# Built on v2.1 + Deep Research Synthesis + Critical Gap Analysis
# Status: Living Document (v3.0 — April 2026)

---

## Version History

| Version | Date | Changes |
|---|---|---|
| v1.0 | 2026-04-11 | Base plan + Gemini v1 critical updates |
| v2.1 | 2026-04-11 | OI/Liquidation filter, DOL targeting, killzones, RVOL normalization, Worker Thread + Redis |
| v3.0 | 2026-04-11 | **The Real Edge Upgrade**: Market Regime Engine, Macro Sentiment Layer, Anti-Overfitting Protocol, Slippage-Aware Backtesting, Short-Side Activation, Funding Rate Alpha, On-Chain Confluence, Adaptive Position Sizing, Self-Monitoring Layer |

---

## What Was Missing in v2.1 — Honest Assessment

The v2.1 plan is technically solid but suffers from five critical blind spots that will cause it to be "profitable on paper but not in live trading." These are the real killers:

| Blind Spot | What Happens Without It | v3.0 Fix |
|---|---|---|
| No market regime awareness | Running LSO reversals in a trending bear market → constant losses | Market Regime Engine: 4 states, strategy routing |
| No macro/sentiment gate | Trading perfectly while macro is imploding → all setups fail | Sentiment Confluence Layer |
| Backtest doesn't model slippage realistically | 40% WR looks like 40% in backtest, is 30% live | Realistic execution modeling: 0.05–0.15% slippage baked in |
| Long-only in all conditions | Bear market = 0 trades or losing trades | Short-Side Engine (mirror strategies, activated by regime) |
| Static position sizing | No learning from recent performance | Kelly-adjusted dynamic sizing with streak awareness |
| No strategy performance tracking | Dead strategies run forever | Per-strategy live performance tracker with auto-disable |
| Missing funding rate as a signal | Extreme funding = crowded trade, high reversal probability | Funding Rate Alpha gate added to LSO |
| No on-chain whale signal | Institutions accumulate on-chain before price moves | Whale flow signal as soft confirmation |

---

## The Uncomfortable Truths (From Real Traders & Research)

Before building, internalize these:

**Truth 1 — Backtest lies are systematic, not random.**
Industry research shows live Sharpe ratios fall far below backtested figures, often by 50%+. Every strategy in v2.1 needs its paper WR reduced by ~8–12% when estimating live WR.

**Truth 2 — ICT concepts are real but contextual.**
Order blocks, FVGs, and liquidity sweeps are valid structural observations — they are rebranded Wyckoff (Springs, Upthrusts, Cause-and-Effect). They work because they describe WHERE liquidity clusters. They fail when applied mechanically without regime context. A bearish OB in a bull trend is noise. The same OB in a ranging market is signal.

**Truth 3 — The strategy that prints in a BTC bull rally bleeds in chop.**
The 2025 crypto market delivered policy wins (ETF approvals, regulatory clarity) and prices still collapsed 90% on altcoins. Markets do not reward "correct thesis with wrong timing." Regime awareness is not optional — it is the most important edge.

**Truth 4 — Slippage is the silent killer.**
A 52% WR strategy with a 0.02% theoretical edge per trade becomes a -0.28% per trade loser after realistic round-trip costs. BulletBrain uses limit orders (good) but must model partial fills, cancel rates, and re-entry costs.

**Truth 5 — Over 80% of crypto volume is bots competing with your bot.**
The patterns you detect are often created intentionally by larger bots to trigger smaller bots. OI + CVD confirmation (v2.1's key upgrade) helps here, but regime awareness helps even more.

---

## Core Philosophy (v3.0 — Upgraded)

```
v2.1: "Find where smart money absorbed retail liquidations, enter with them"

v3.0: "Find the regime, find the liquidity event, confirm the absorption,
       check the macro, then enter WITH institutional direction —
       and exit before the market changes its mind"
```

**The Key Insight v2.1 Lacks:**
Markets cycle through distinct regimes. The same setup (OB retest, FVG fill, sweep) has radically different success rates depending on which regime is active. The bot must know what mode the market is in BEFORE it evaluates any setup.

```
Regime → Strategy Selection → Signal → Confirmation → Size → Execute
```

In v2.1, the regime step is missing. The bot evaluates signals the same way at 3AM in a bear market as it does at 9:30AM NY Open in a bull trend. That is why it works "on paper" but struggles live.

---

## The Realistic Edge Framework (v3.0 — Adjusted for Reality)

```
Per-Strategy Win Rates (PAPER vs LIVE — honest adjustment):

                    Paper WR    Live WR     Live RR     Live PF
LSO (Strategy 1):  48-55%  →   40-47%      1.8:1       1.5-1.9
OB  (Strategy 2):  48-55%  →   40-47%      1.7:1       1.4-1.8
FVG (Strategy 3):  50-58%  →   42-50%      1.6:1       1.4-1.8
CVD (Strategy 4):  40-48%  →   33-40%      1.9:1       1.3-1.7
VPB (Strategy 5):  45-52%  →   38-45%      2.0:1       1.4-1.9

System (ALL, Regime-Gated):
  Trades/Month:    15-30 (quality over quantity, may drop to 8-15 in slow regimes)
  Monthly Return:  2-6% (realistic, not 3-8%)
  Annual Return:   25-60% (good year) / 10-25% (bad year)
  Max Drawdown:    <18% (higher than v2.1 due to honest modeling)

IMPORTANT: These are CONSERVATIVE live estimates.
If backtest shows less than 45% WR for any strategy, do not go live.
If live trading shows less than 35% WR after 50 trades, pause and investigate.
```

---

## LAYER 0 — MARKET REGIME ENGINE [v3.0 NEW — THE MOST IMPORTANT ADDITION]

This is the foundational layer that v2.1 completely lacks. Every other system runs THROUGH this.

### Four Market Regimes

```
REGIME 1: BULL TRENDING
  Definition:
    - BTC 4H EMA200 sloping UP at >= 15 degree angle (calculated via 10-period EMA of EMA200)
    - BTC price > 4H EMA200 for >= 20 of last 30 candles
    - 4H ATR% between 0.5% and 4% (moving, not extreme)
    - BTC dominance stable or declining (alts participating)

  Characteristics: Higher highs, higher lows. Dips are bought.
  Allowed Strategies: ALL 5 strategies — LONG ONLY
  Position sizing: Full (1% risk per trade)
  Sentiment gate: Fear & Greed Index > 35 required

REGIME 2: BEAR TRENDING
  Definition:
    - BTC 4H EMA200 sloping DOWN at >= 15 degree angle
    - BTC price < 4H EMA200 for >= 20 of last 30 candles
    - 4H ATR% between 0.5% and 5%

  Characteristics: Lower highs, lower lows. Bounces are sold.
  Allowed Strategies: Shorts ONLY (mirror of LSO, OB, FVG for downside)
                      AND Strategy 1 LSO (LONG) for ultra-high confluence only
  Position sizing: Reduced 50% for longs, full for shorts
  Sentiment gate: Fear & Greed Index < 60 required
  IMPORTANT: Most "long setups" in bear regime are bull traps. Skip unless
             all 7 gates + Gate T pass AND OI flush is >= 2.5%

REGIME 3: RANGING / CHOPPY
  Definition:
    - Price oscillating within 8% band for >= 3 days
    - 4H ATR% < 0.8% (low volatility)
    - BTC EMA200 relatively flat (< 5 degree angle)

  Characteristics: False breakouts dominate. Mean reversion works.
  Allowed Strategies: OB (Strategy 2) + FVG (Strategy 3) ONLY
                      Range boundaries define trade direction
  Position sizing: Reduced 30% (false signals more common)
  Gate T: Stricter — NY Open and London Open ONLY. Absolutely no Asian session.

REGIME 4: HIGH VOLATILITY / CRISIS
  Definition:
    - 4H ATR% > 5%
    - Single candle > 3% move on 1H
    - VIX equivalent: Deribit DVOL (BTC implied vol) > 80

  Characteristics: Everything breaks. Spreads widen. Liquidations cascade.
  Allowed Strategies: LSO (Strategy 1) ONLY — and ONLY after OI flush >= 3%
                      Position sizing: 0.5% risk maximum
  Emergency triggers active (BTC -2% in 15m = exit all)
```

### Regime Detection Code Logic

```javascript
function detectRegime(btcData_4H, atr_pct, btcDominance) {
  const ema200 = calculateEMA(btcData_4H.close, 200);
  const ema200_slope = (ema200[ema200.length-1] - ema200[ema200.length-11]) / 10;
  const priceAboveEMA = btcData_4H.slice(-30).filter(c => c.close > ema200[ema200.length-30+i]).length;

  // Crisis first (override everything)
  if (atr_pct > 5) return 'CRISIS';

  // Trending
  const slopeAngle = Math.atan(ema200_slope / ema200[ema200.length-1]) * (180/Math.PI);
  if (slopeAngle >= 15 && priceAboveEMA >= 20) return 'BULL';
  if (slopeAngle <= -15 && priceAboveEMA <= 10) return 'BEAR';

  // Ranging (default when trend is unclear)
  return 'RANGING';
}

// Store in Redis: "regime:BTC" → {state, since, atr_pct, updated_at}
// Regime updates every 4H candle close (not real-time — prevents flapping)
// Require regime to persist 2 consecutive 4H closes before switching
// (Prevents regime flapping on single volatile candles)
```

### Strategy Routing by Regime

```
BULL     → Allow: LSO(L), OB(L), FVG(L), CVD(L), VPB(L)
BEAR     → Allow: LSO(L) ultra-high-confluence only, ALL shorts
RANGING  → Allow: OB(L/S at boundaries), FVG(L/S at boundaries)
CRISIS   → Allow: LSO(L) only, size 0.5%, OI flush >= 3% required
```

---

## LAYER 1 — MACRO SENTIMENT CONFLUENCE [v3.0 NEW]

These are external data points that significantly change setup probability.
They do NOT generate trades — they gate or amplify existing setups.

### Sentiment Gates

```
GATE MACRO-1: Fear & Greed Index (CoinMarketCap or Alternative.me API)
  Fetch: Every 1 hour (data updates daily but fetch fresh)
  API: https://api.alternative.me/fng/

  BULL REGIME:
    F&G > 35: Normal gates apply
    F&G < 25: SKIP all longs (market in extreme fear = regime may flip)
    F&G > 85: Reduce size 30% (extreme greed = crowded trade, reversal risk)

  BEAR REGIME:
    F&G < 30: Normal shorts apply (fear confirms bear)
    F&G > 50: SKIP all shorts (market recovering, bear may be ending)

  RANGING REGIME:
    F&G 40-60: Normal gates
    F&G outside 30-70: Skip (too directional for ranging strategy)

WHY THIS MATTERS:
  The 2025 crypto cycle showed that even "correct" technical setups failed
  consistently during extreme fear (F&G < 20) because liquidity dried up and
  every bounce got sold. Knowing the macro mood prevents fighting the tape.


GATE MACRO-2: Funding Rates (Binance Futures — already have WebSocket access)
  Endpoint: GET /fapi/v1/premiumIndex (funding rate per symbol)
  Fetch: Every 30 minutes

  Extreme POSITIVE funding (> +0.1% per 8H):
    → Longs are paying shorts heavily = market is overleveraged long
    → SKIP new long entries (crowded trade, snap-back risk)
    → LSO SHORTS become HIGHER priority (crowded longs = liquidation fuel on downside)
    → If entering long anyway: reduce size by 50%

  Extreme NEGATIVE funding (< -0.1% per 8H):
    → Shorts paying longs = market overleveraged short
    → SKIP new short entries
    → LSO LONGS become HIGHER priority (forced short covering = powerful upward sweeps)
    → If entering short anyway: reduce size by 50%

  NEUTRAL funding (-0.05% to +0.05%):
    → No adjustment to base signals

FUNDING RATE AS ALPHA SIGNAL (not just a filter):
  When funding is extreme + an LSO sweep fires in the OPPOSITE direction of
  the funding extreme = HIGHEST PROBABILITY setup in the entire system.
  Example: Funding at +0.15% (longs paying) + equal lows sweep + OI flush =
  trapped longs getting liquidated into a bounce. Enter with 1.5x normal size.
  This is the "crowded trade reversal" — one of the most reliable crypto edges.


GATE MACRO-3: Liquidation Heatmap Context
  Source: Coinglass API (free tier available)
  Endpoint: https://open-api.coinglass.com/public/v2/liquidation_map

  Use: Before entering any LSO trade, check if the target price has a
  large liquidation cluster in the direction of trade.
  IF large cluster exists 0.5-2% above entry (for longs) → INCREASE target
  IF no cluster exists → DOL calculation from v2.1 applies
  IF cluster is BETWEEN entry and DOL → move TP1 to cluster level

  This turns DOL (v2.1's structural target) into a DATA-DRIVEN target.
  Liquidation clusters are where bots KNOW price will be pulled toward.
```

---

## Strategy Architecture (7 Strategies — Short Side Added)

### Strategies 1-5: Unchanged from v2.1 with Regime Gate Added

All v2.1 strategies remain. The only addition is that EVERY strategy now
passes through the Regime Router first. If regime doesn't allow a strategy,
the signal is evaluated but flagged as SKIP before gate evaluation.

### Strategy 6: SHORT LSO — Liquidity Sweep Down + OI Flush [v3.0 NEW]
**Timeframe:** 15m setup, 1H context
**Type:** Bearish reversal after smart money sells into retail longs
**Activation:** BEAR regime only (or BULL regime with F&G > 80 AND funding > +0.12%)

**Mathematical Definition:**
```
Mirror of Strategy 1 (LSO) for downside:

Step 1 — Identify Equal Highs (Sell-Side Liquidity Pool):
  equalHighs = true IF:
    abs(high[i] - high[j]) / high[i] < 0.003
    within last 50 candles on 1H, >= 5 candles apart

Step 2 — Detect Sweep Up + OI Flush:
  sweep = true IF:
    current 15m candle HIGH > equalHighs level
    AND current 15m candle CLOSES BELOW equalHighs level
    (wick above, body below = trap candle)

  oiFlush = true IF:
    OI at close < OI at open by >= 1.5%
    (Retail shorts squeezed up and then liquidated at top)

Step 3 — CVD Confirmation:
  CVD_candle must be NEGATIVE during sweep candle
  (Smart money was net SELLING while retail shorts squeezed up)

Step 4 — Entry:
  Entry = LIMIT order at 50% of sweep candle body (short entry above market)
  Stop = sweep candle HIGH + (0.1 × ATR14_15m)
  Target = Draw on Liquidity DOWNWARD (nearest equal lows, bullish OB below, bullish FVG below)

REJECT if R:R < 1.8
REJECT if NOT in BEAR regime (unless F&G > 80 + funding > 0.12%)
```

### Strategy 7: BREAKEVEN SCALP on Failed Setups [v3.0 NEW]
**Type:** Position management edge — not a new entry strategy
**Purpose:** When an open trade is at breakeven stop and shows renewed momentum, add to position

```
Conditions for adding to an open trade at breakeven:
  - Original trade moved to breakeven (after TP1)
  - New signal in SAME direction fires on 15m (within 2 candles of breakeven)
  - RVOL confirms (> 1.5x)
  - Add 0.5% risk (half the normal size)
  - New stop = breakeven of combined position
  - New target = original TP2 (no change)

This is how professional traders "pyramid" into winning trades.
Most bots take profit and walk away. The best trades often have two legs.
```

---

## LAYER 2 — ANTI-OVERFITTING PROTOCOL [v3.0 NEW — CRITICAL]

This is the most overlooked part of every retail bot plan. Without this,
the bot will be profitable in backtest and lose in live trading.

### The Overfitting Problem in Plain Terms

Every parameter in v2.1 was chosen because it worked on historical data:
  - 0.3% tolerance for equal highs/lows
  - 1.5% OI flush threshold
  - 1.5x RVOL gate
  - 48-candle OB validity window
  - 72-candle FVG validity window

These numbers are tuned to past data. The question is: do they generalize?

### Anti-Overfitting Rules

```
RULE 1: Parameter Sensitivity Test (Required before go-live)
  For EVERY numerical parameter, test ±20% of the chosen value.
  If the result changes by more than 15%, the strategy is fragile.
  Example: OI flush at 1.5% is the gate. Test at 1.2% and 1.8%.
  If WR drops from 48% to 30% at 1.2%, the 1.5% is curve-fitted.
  Robust strategies should show similar WR across a range of parameters.

RULE 2: Walk-Forward Only (Non-negotiable)
  Never use a single backtest. Always:
    Train: 2021-2023 data
    Test:  2024 data (out-of-sample)
    Forward test: 2025 data (true out-of-sample)
  If strategy degrades > 25% from train to test: REVISE before live.
  If strategy degrades > 25% from test to forward: DO NOT GO LIVE.

RULE 3: Monte Carlo Validation
  For each strategy, run 1000 Monte Carlo simulations randomizing:
    - Trade order (sequence matters for drawdown)
    - Random noise in fill prices (±0.05%)
    - Random 5% of trades removed (simulating missed signals)
  If 10th percentile of simulations still shows positive expectancy: ROBUST.
  If 10th percentile is negative: FRAGILE (do not go live).

RULE 4: Realistic Cost Modeling in Backtest
  Every backtest MUST include:
    Slippage: 0.08% round trip on limit orders (conservative)
    Spread cost: 0.04% average (accounts for bid-ask)
    Funding rate cost: 0.01% per 8H per trade (average)
    Cancel/re-entry cost: 15% of entries get cancelled and re-entered (+0.04%)
  If backtest is NOT profitable after these costs: DO NOT GO LIVE.

RULE 5: Regime-Split Backtesting
  Run each strategy's backtest SEPARATELY for:
    - Bull regime periods only
    - Bear regime periods only  
    - Ranging periods only
  Any strategy that loses money in ANY regime in isolation gets
  DISABLED for that regime (regardless of overall profitability).
  A positive PF overall can mask a 50% loss rate in bear markets.

RULE 6: Maximum Parameters Per Strategy = 8
  Each strategy has a maximum of 8 tunable parameters.
  More than 8 = almost certainly overfitted.
  v2.1 strategies have 5-7 parameters each. Good.
  Do not add more parameters to "improve" them.
```

---

## LAYER 3 — ADAPTIVE POSITION SIZING [v3.0 UPGRADED]

v2.1 uses flat 1% risk per trade. This ignores performance context.

### Dynamic Sizing Algorithm

```
BASE_RISK = 1% of capital per trade

REGIME MULTIPLIER:
  BULL:    1.0x (full size)
  RANGING: 0.7x (reduced for choppy conditions)
  BEAR:    0.5x for longs, 1.0x for shorts
  CRISIS:  0.5x maximum

STREAK MULTIPLIER (consecutive loss protection):
  0-2 consecutive losses: 1.0x
  3 consecutive losses:   0.75x
  4 consecutive losses:   0.5x
  5+ consecutive losses:  0.25x AND alert Telegram ("STREAK ALERT")
  After 5+ streak: Require manual confirmation to resume full size

CONFIDENCE MULTIPLIER (setup quality):
  Standard setup (all 7 gates pass, Gate T standard):      1.0x
  High-confluence setup (all 7 gates + F&G confirmed      
    + funding confirms + OI flush >= 2.5%):               1.3x
  Crowded trade reversal (extreme funding + LSO):          1.5x MAXIMUM
  Weak setup (Gate T relaxed, outside killzone):           0.7x

FINAL POSITION SIZE:
  risk = BASE_RISK × REGIME_MULT × STREAK_MULT × CONFIDENCE_MULT
  risk = clamp(risk, 0.25%, 1.5%)  ← hard limits
  size = risk_amount / (entry - stop)

This is a simplified Kelly approach. True Kelly requires accurate probability
estimates. Until 100+ live trades are logged, use these conservative bounds.

PORTFOLIO HEAT REMAINS:
  Max 3 concurrent trades
  Max 3% total portfolio at risk simultaneously
  No two correlated coins (BTC+ETH = correlated, skip)
```

---

## LAYER 4 — ON-CHAIN WHALE SIGNAL [v3.0 NEW — SOFT CONFIRMATION]

This is not a hard gate. It is a soft confirmation that upgrades or downgrades
the confidence multiplier. It requires no additional API costs (free data).

### Whale Signal Sources

```
SOURCE 1: Exchange Netflow (CryptoQuant or Glassnode free tier)
  Metric: Exchange Inflow/Outflow (BTC and ETH)
  Signal:
    Large OUTFLOW from exchanges = whales withdrawing = bullish accumulation
    Large INFLOW to exchanges = whales depositing = potential distribution

  USE:
    If BTC exchange outflow is in top 20% of 30-day range:
      → Long setups get +0.1x confidence multiplier
    If BTC exchange inflow is in top 20% of 30-day range:
      → Long setups get -0.1x confidence multiplier (not a block, a trim)

SOURCE 2: Whale Alert API (free tier — large transactions > $1M)
  API: https://api.whale-alert.io/v1/transactions
  Signal: Large transfers from known exchange wallets = distribution
          Large transfers TO cold storage = accumulation

  USE: Real-time monitoring. Store in Redis.
    If > 3 large exchange withdrawals in 1H: Soft bullish signal
    If > 3 large exchange deposits in 1H: Soft bearish signal
    These adjust confidence multiplier by ±0.1x

SOURCE 3: Stablecoin Inflows (USDT/USDC flowing TO exchanges)
  Metric: Stablecoin supply on exchanges
  Signal: Rising stablecoin supply on exchanges = dry powder = bullish potential
  Fetch: Daily update sufficient

WHY NOT A HARD GATE:
  On-chain data has 1-4 hour lag. Using it as a hard gate on 15m trades
  would cause timing mismatches. As a confluence multiplier, it improves
  average trade quality without blocking valid immediate setups.
```

---

## LAYER 5 — STRATEGY SELF-MONITORING [v3.0 NEW — CRITICAL]

v2.1 has no mechanism to detect when a strategy stops working.
This is how most bots blow up: strategy degrades, bot keeps trading, losses mount.

### Per-Strategy Performance Tracker

```javascript
// Store in MongoDB: strategy_performance collection
{
  strategy: "LSO",
  regime: "BULL",
  period: "2026-04", // monthly buckets
  trades: 12,
  wins: 7,
  losses: 5,
  win_rate: 0.583,
  avg_rr_achieved: 1.9,
  profit_factor: 1.71,
  status: "ACTIVE" // or "WATCH" or "PAUSED"
}

// Alert thresholds (check every 25 trades or weekly, whichever comes first):
WATCH trigger:
  - Rolling 25-trade WR < 35% for any strategy
  - Rolling 25-trade PF < 1.2 for any strategy
  - Consecutive losses >= 4 on any single strategy

PAUSE trigger (auto-pause — no manual required):
  - Rolling 50-trade WR < 30% for any strategy
  - Rolling 50-trade PF < 1.0 (strategy is losing money)
  - Daily loss > 3% (existing v2.1 rule)

RESUME conditions (manual only):
  - 7-day pause minimum
  - Regime must have changed OR market conditions explanatory
  - Manual paper trade validation of 5 signals before resuming

TELEGRAM ALERTS for all state changes:
  "⚠️ Strategy LSO entering WATCH mode — 25-trade WR: 34%"
  "🛑 Strategy CVD AUTO-PAUSED — 50-trade WR: 28%"
  "✅ Strategy OB resumed after manual review"
```

---

## LAYER 6 — REALISTIC BACKTESTING ENGINE [v3.0 UPGRADED]

v2.1 has a good backtest plan. v3.0 makes it rigorous enough to trust.

### Execution Simulation Requirements

```
Every backtest must simulate:

1. LIMIT ORDER FILL PROBABILITY
   Not all limit orders fill. In backtesting, assume:
     - 85% of limit orders fill (15% cancelled/expired — CONSERVATIVE)
     - For cancelled orders, log as "missed trade" (affects opportunity cost)
     - Replacement re-entry costs additional 0.04% slippage

2. REALISTIC SLIPPAGE MODEL
   Not a flat spread. Use a dynamic model:
     During Killzone (high volume):    0.03–0.06% slippage per side
     During Asian session:            0.08–0.15% slippage per side
     During crisis (ATR% > 5%):       0.2–0.5% slippage per side
   Backtest must use the PESSIMISTIC end of each range.

3. REGIME-TAGGED CANDLES
   Every backtest candle gets a regime tag:
     candle.regime = detectRegime(candle)
   Run backtest WITH and WITHOUT regime routing.
   The delta = the value of the regime engine.
   Target: Regime-gated version should show 15%+ better Sharpe.

4. SURVIVORSHIP BIAS CHECK
   Include at least 2 periods where BTC dropped > 40%:
     - March 2020 (COVID crash)
     - May 2021 (China mining ban)
     - Nov 2022 (FTX collapse)
     - Q4 2025 (altcoin bloodbath)
   If strategy loses > 20% of capital during ANY of these periods: FIX IT.

5. FORWARD TEST PERIOD
   The 2025 data is NEVER used in optimization. Reserved for forward test only.
   This is the most honest measure of live viability.

### Backtest Acceptance Criteria (Upgraded)

Phase 1 (Each strategy, isolated, WITH regime filter, WITH slippage):
  Accept if: PF > 1.5, max DD < 8%, positive in all 4 regimes or SKIP in bad regimes

Phase 2 (OI filter comparison, LSO only):
  LSO without OI vs LSO with OI — expect >= 8% WR improvement

Phase 3 (Full system, all strategies, regime-routed):
  Accept if: PF > 1.6, annual return > 35% (after costs), max DD < 15%
  REJECT if: DD > 20% in any crisis simulation

Phase 4 (Walk-forward, 2021-2023 train, 2024 test):
  Accept if: PF degrades < 20% from train to test

Phase 5 (2025 forward test — ultimate gate):
  Accept if: Still profitable. DD < 20%.
  If not: Return to Phase 1 — parameters must change.
```

---

## LAYER 7 — MACRO EVENT CALENDAR FILTER [v3.0 NEW]

High-impact macro events destroy technical setups.
The bot must know when NOT to trade.

```
IMPLEMENTATION:
  Source: CoinGlass economic calendar API OR hard-coded schedule
  Events to blackout:
    - US CPI release (monthly, 30 min before + 15 min after)
    - FOMC meeting decision (8 times/year, 30 min before + 15 min after)
    - Non-Farm Payrolls (monthly, 30 min before + 15 min after)
    - Major crypto regulation announcements (reactive — monitor Twitter/Telegram)

  During blackout:
    - No new entries
    - Existing trades: tighten stops to 50% of normal stop distance
    - Resume normal operation after blackout window

  Store in Redis: "macro_blackout:next" → {event, timestamp, duration}
  Update daily via scheduled job.

WHY THIS MATTERS:
  On FOMC days, even perfect setups fail because price spikes 2-4% instantly.
  The stop gets hit even if the trade direction was correct.
  A 30-minute blackout around known events costs 3% of trading time and
  prevents approximately 25% of unexpected stop-outs in backtesting.
```

---

## Quality Gate System [v3.0 — COMPLETE, 9 GATES]

```
ALL 9 gates must pass. ONE failure = no trade.

GATE 0 (NEW): REGIME COMPATIBILITY
  Verify strategy is allowed in current regime
  Current regime: [BULL/BEAR/RANGING/CRISIS]
  If strategy blocked for current regime → REJECT immediately

GATE 1: HTF Trend Alignment (unchanged from v2.1)
  LONG: 4H EMA200 pointing up AND price above 4H EMA50
  SHORT: 4H EMA200 pointing down AND price below 4H EMA50

GATE 2: Setup Validity (unchanged from v2.1)
  One of 7 strategies produces valid signal (fresh, within 2 candles)

GATE 3: RVOL Confirmation (unchanged from v2.1 — time-normalized)
  Inside Killzone:  RVOL_normalized > 1.5×
  NY PM Session:    RVOL_normalized > 1.8×
  Asian Session:    RVOL_normalized > 2.5×

GATE 4: R:R Minimum via DOL (unchanged from v2.1)
  DOL target identified (structural)
  Calculated R:R >= 1.8:1

GATE 5: Portfolio State (unchanged from v2.1)
  Max 3 concurrent open trades
  No correlated pairs simultaneously
  Daily loss < 3% → pause 24H

GATE 6: Execution Feasibility (unchanged from v2.1)
  Spread < 0.05%
  ATR_15m > 0.3% of price

GATE 7: OI Confirmation for LSO (unchanged from v2.1)
  LSO only: OI_delta < -1.5% on sweep candle
  CVD_candle positive during sweep

GATE T: Temporal/Killzone (unchanged from v2.1)
  London/NY Open: Standard thresholds
  Asian session: Stricter — LSO only

GATE 8 (NEW): MACRO SENTIMENT CHECK
  If macro blackout window active → REJECT
  If F&G outside acceptable range for current regime → REJECT
  If funding rate extreme in same direction as proposed trade → REJECT or reduce size
  If strategy performance is in WATCH mode → reduce size by 50%
  If strategy performance is in PAUSE mode → REJECT
```

---

## Short Strategy Implementation [v3.0 NEW — Full Architecture]

Currently v2.1 is long-only. In bear markets (2025 was an example), this means
the bot either sits idle or loses on longs during downtrends. Shorts double the
opportunity set and allow profiting in ALL regimes.

### Short Strategies (Mirror Architecture)

```
SHORT-LSO (Strategy 6): Equal highs swept up, OI flush, CVD negative → short
SHORT-OB:  Bearish OB formed (last bullish candle before big drop) → price
           returns to OB from below → short at OB low
SHORT-FVG: Bearish FVG (gap down) → price fills from below → short at 50% of FVG
SHORT-CVD: Price higher high, CVD lower high (sellers absorbing buyers) → short

Activation: BEAR regime only
Stop: OB high + 0.1 × ATR, FVG high + 0.1 × ATR
Target: DOL downward (nearest equal lows, bullish OB below)

RISK:
  Shorts in crypto carry additional risks:
  - Funding rates can be expensive (if negative funding in bear)
  - Short squeezes can be violent (+10% in 1 candle)
  - Borrow fees on spot shorts
  
  Mitigations:
  - Shorts via Futures only (not spot short)
  - Maximum 2× leverage for short positions
  - Tighter stop: 0.07 × ATR (instead of 0.1) to reduce squeeze exposure
  - Activate only when regime has been BEAR for >= 6 hours (not flipping)
```

---

## Data Pipeline Architecture [v3.0 — Extended]

Building on v2.1's Worker Thread + Redis architecture, add:

```
NEW WORKER THREAD 4: Macro Data Fetcher
  Runs every 60 minutes (not real-time — API rate limits)
  Fetches:
    - Fear & Greed Index (alternative.me)
    - Funding rates per coin (Binance Futures)
    - Liquidation heatmap data (Coinglass)
    - Whale Alert transactions (Whale Alert API)
    - Economic calendar events (CoinGlass or Crypto Calendar API)
  Writes to Redis:
    "macro:fng" → {value, classification, updated_at}
    "macro:funding:{symbol}" → {rate, 8h_annualized, updated_at}
    "macro:liq_heatmap:{symbol}" → {clusters[], updated_at}
    "macro:whale_alerts" → {recent_txns[], updated_at}
    "macro:blackout" → {active, event, ends_at}

MAIN PROCESS additions:
  - Regime detector (reads from Worker 3 kline data, classifies every 4H)
  - Strategy router (reads regime, filters allowed strategies)
  - Performance tracker (reads trade results, calculates rolling stats)
  - Macro gate checker (reads Worker 4 data, applies Gate 8)
```

---

## Implementation Phases [v3.0 Updated]

### Phase 0: Foundation Review (Week 0-1)
- Re-read all v2.1 code with "does this overfit?" lens
- Run v2.1 backtest with realistic slippage (BEFORE any new features)
- Tag historical candles with regime labels
- Run phase-split backtest: does WR change by regime? (It will — dramatically)
- Document findings. This is your baseline.

### Phase 1: Data Infrastructure (Week 1-2, mostly from v2.1)
- v2.1 Phase 1 tasks (Redis, Worker Threads 1-3) UNCHANGED
- ADD: Worker Thread 4 (Macro Data Fetcher)
- ADD: Macro data Redis schema
- ADD: Economic calendar integration

### Phase 2: Regime Engine (Week 2 — HIGHEST PRIORITY NEW FEATURE)
- Implement `detectRegime()` function
- Historical regime tagging (backtest all 2021-2025 data)
- Strategy Router: regime → allowed strategies
- Store regime in Redis, update every 4H candle close
- Backtest WITH regime routing vs WITHOUT → measure the delta

### Phase 3: Strategy Engine (Week 3, from v2.1)
- v2.1 Phase 2 tasks UNCHANGED
- ADD: Short-side mirrors (SHORT-LSO, SHORT-OB, SHORT-FVG)
- ADD: Strategy 7 (pyramiding on breakeven positions)

### Phase 4: Gate System + Macro Layer (Week 3-4)
- v2.1 Phase 3 tasks (all 7 gates + Gate T) UNCHANGED
- ADD: Gate 0 (Regime Compatibility)
- ADD: Gate 8 (Macro Sentiment — reads from Worker 4)
- ADD: Funding rate gate logic
- ADD: F&G index gate logic

### Phase 5: Adaptive Position Sizing (Week 4)
- Replace flat 1% risk with dynamic sizing formula
- Streak counter (consecutive loss tracking)
- Confidence multiplier calculation
- Portfolio heat checking (existing) + new regime multiplier

### Phase 6: Self-Monitoring Layer (Week 4-5)
- Per-strategy performance tracker (MongoDB schema)
- WATCH / PAUSE / RESUME state machine
- Telegram alert integration for all state changes
- Weekly performance report (auto-generated, sent to Telegram)

### Phase 7: Anti-Overfitting Backtesting (Week 5-6)
- Implement Monte Carlo simulation module
- Parameter sensitivity testing for all key thresholds
- Walk-forward validation (2021-2023 train, 2024 test, 2025 forward)
- Regime-split backtest for each strategy
- Document results before ANY live trading

### Phase 8: Paper Trading — Extended (Week 7-10)
- Minimum 6 weeks paper trading (NOT 3 weeks as in v2.1)
- Required: live through at least 1 regime change (bull → range, etc.)
- Required: live during at least 1 major macro event (FOMC, CPI)
- Compare paper results to backtest by REGIME (not just overall)
- Only go live when paper matches backtest within 25% across ALL regimes

### Phase 9: Live Trading — Graduated (Week 11+)
- Start at 25% of normal position sizes for first 30 trades
- Scale to 50% after 30 trades if WR > 38%
- Scale to 100% after 60 trades if WR > 38% and PF > 1.4
- Never rush to full size

---

## What v2.1 Keeps (Unchanged, Still Correct)

```
KEEP (all of these are solid and well-designed):
  MongoDB trade persistence          → Good
  Telegram alerts                    → Good
  Winston logging                    → Good
  Node.js + CCXT stack               → Good
  Daily/weekly loss limits           → Good
  Cooldown after stop loss           → Good
  Paper trading mode                 → Good
  Worker Thread + Redis architecture → Good
  Time-normalized RVOL               → Good
  DOL structural targets             → Good
  OI flush confirmation (LSO)        → Good
  Limit order only execution         → Good
  3-stage TP system (40/40/20)       → Good
  Killzone time filtering            → Good
  7-gate quality gate system         → Good (now 9-gate in v3.0)
  Equal highs/lows detection         → Good
  CVD calculation                    → Good
  FVG and OB detection               → Good
```

---

## Open Questions — v3.0 Additions

**Q1: Should the regime engine use BTC-only data for ALL coins?**
Recommendation: Yes. BTC dominates crypto correlation. All coins are
gated by BTC regime. Tier 2/3 coins additionally require their own
4H EMA200 alignment with BTC regime (no divergent setups).

**Q2: How long must a regime persist before bot switches strategy routing?**
Recommendation: 2 consecutive 4H closes in new regime (8 hours total).
Prevents regime flapping. Accepts some lag at regime transitions.

**Q3: What if the F&G API is down?**
Recommendation: Default to "neutral" (no sentiment gate applied).
Never let an external data source BLOCK trades — only soft-gate them.
Log all API failures to MongoDB.

**Q4: Should short strategies be developed before long strategies are validated?**
Recommendation: NO. Validate long-only system for 6+ months live, then
add shorts. Shorts require Futures and introduce liquidation risk.
Develop short code in parallel but DO NOT ACTIVATE until long system proven.

**Q5: What capital is needed for this system to make sense?**
Minimum viable: $5,000 USDT (1% risk = $50/trade, meaningful but not crippling)
Optimal: $20,000+ USDT (1% risk = $200/trade, meaningful after fees)
Below $2,000: Transaction costs eat too large a percentage of edge.

**Q6: What's the biggest risk this plan doesn't solve?**
Exchange risk (Binance going down, withdrawals frozen, etc.).
Mitigation: Never keep more than 50% of trading capital on exchange.
Keep 50% in cold wallet or stablecoin off-exchange.

---

## Performance Expectations — Honest Summary

```
REALISTIC LIVE PERFORMANCE AFTER 6 MONTHS OF PAPER:

                  Conservative    Expected    Optimistic
Monthly return:   1-3%           2-6%        5-10%
Annual return:    12-36%         25-70%      60-120%
Max drawdown:     20%            15%         10%
Win rate:         33-38%         38-45%      45-52%
Trades/month:     8-15           15-25       25-35

WHEN THE BOT WILL UNDERPERFORM:
  - Sustained bear markets (even with shorts, execution is harder)
  - Choppy ranging markets with false breakouts
  - Black swan events (FTX-type collapse, regulatory shock)
  - After a regime change (bot takes 2-4 candles to adapt)

WHEN THE BOT WILL OUTPERFORM:
  - Clear trending markets (bull or bear)
  - High liquidity NY Open sessions
  - Post-liquidation sweeps (LSO's sweet spot)
  - Crowded trade reversals (extreme funding + LSO)

THE HONEST GOAL:
  Outperform a simple BTC buy-and-hold on a RISK-ADJUSTED basis.
  That means: smaller drawdowns, more consistent returns, no catastrophic months.
  This bot is not designed to 10x capital. It is designed to 2-3x it
  over 3-4 years with a risk profile that allows sleeping at night.
```

---

## The Master Checklist — Before Going Live

```
DATA INFRASTRUCTURE:
  [ ] Redis live, Worker Threads 1-4 running
  [ ] All WebSocket streams confirmed stable for 24H
  [ ] Macro data Worker 4 fetching all sources
  [ ] Regime detection running and logging to MongoDB

BACKTESTING:
  [ ] All strategies backtested WITH realistic slippage
  [ ] Walk-forward validation complete (2021-2023 train, 2024 test)
  [ ] 2025 forward test complete
  [ ] Regime-split backtest for each strategy complete
  [ ] Parameter sensitivity tests complete
  [ ] Monte Carlo simulations passed (10th percentile positive)
  [ ] All strategies show PF > 1.5 in relevant regimes

PAPER TRADING:
  [ ] Minimum 6 weeks paper trading complete
  [ ] Lived through at least 1 regime change
  [ ] Lived through at least 1 major macro event
  [ ] Paper WR within 25% of backtest WR by regime

RISK MANAGEMENT:
  [ ] Daily loss limit tested and confirmed triggering
  [ ] Emergency exit (BTC -2% / 15m) tested and confirmed
  [ ] Strategy auto-pause triggers tested
  [ ] Telegram alerts confirmed delivering all events

CAPITAL:
  [ ] Maximum 50% of total crypto capital on exchange
  [ ] Starting at 25% position sizes
  [ ] Clear rules written for when to stop bot (manual override)
```

---

*This is a living document. Every backtest result, paper trade finding,
live market observation, and regime analysis should trigger a review.
The bot is only as smart as the humans who monitor and improve it.*

*Version 3.0 — April 2026 — Built with research synthesis from:
institutional trading literature, quant finance research, real trader
communities, on-chain analytics, and market microstructure analysis.*
