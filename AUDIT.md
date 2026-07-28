# BulletBrain v3.0 — Live Trading System Audit

**Date:** 2026-07-28
**Scope:** `src/live/liveRunner.js` (the code that traded real money), its exchange
integration, and whether its strategy has a measurable edge after real costs.
**Evidence:** 195,294 ETH 15m candles + 195,294 BTC 15m candles (2021-01-01 →
2026-07-28), downloaded fresh via `src/data/downloader.js`. Fee rates taken from
this account's own `/fapi/v1/userTrades` fills, not from assumptions.
**Reproduce:** `npm run backtest:replica -- --symbol ETHUSDT`

---

## 1. Executive Summary

### **NO — do not deploy this strategy with real money.**

Not "not yet". **No.** The reason is not fees, not bugs, and not tuning. It is that
the strategy has no gross edge to protect in the first place.

Run the exact live logic over 5.5 years of ETH data with **all costs set to zero**
and tie-breaks resolved in the strategy's favour:

| | Expectancy | Profit Factor | Win rate |
|---|---|---|---|
| Zero fees, zero slippage, optimistic ties | **+0.013 R** | **0.86** | 49.8% |

That is a coin flip. There is nothing there. Then reality is applied:

| Scenario | Expectancy | Profit Factor |
|---|---|---|
| Zero costs (above) | +0.013 R | 0.86 |
| + real fees (0.05% taker / 0.02% maker) | **−0.336 R** | 0.38 |
| + fees and slippage | **−0.611 R** | 0.14 |

BTC reproduces this independently: **+0.0117 R** at zero cost, **−0.673 R** with
real costs. Two symbols, ~76,000 trades, same answer.

**This matters for the MEXC plan.** Moving to a zero-fee venue cannot fix a
strategy whose zero-fee expectancy is +0.013 R and whose zero-fee profit factor is
0.86. Zero fees buys you a coin flip, not a profit. (And MEXC's API fees are not
zero — see §7.)

**The $5 loss that made you stop the bot was not an anomaly. It was the design
working as built.** Two independent flaws produced it, both now fixed (§4).

What *was* genuinely good: the exchange integration. The safety invariants at the
top of `liveRunner.js` are real engineering, the wallet-delta P&L method is
correct, and the `algoOrder` migration was diagnosed correctly. The infrastructure
was never the problem. The strategy was.

---

## 2. Architecture Review

| Subsystem | Score | Verdict |
|---|---|---|
| Exchange integration (signing, precision, BigInt handling) | **8/10** | Solid. `transformResponse` guarding `orderId` precision is a detail most bots get wrong. Was missing clock sync (fixed). |
| Order lifecycle & protection | **8/10** | Genuinely well designed. Entry → verify → attach SL/TP → emergency-close on double failure. The `algoOrder` routing is correct per Binance's 2025-12-09 change. |
| Startup recovery / position adoption | **7/10** | Adopts and re-protects existing positions. Recomputes the stop from *current* ATR rather than the original risk, so an adopted trade gets a different stop than it was opened with. |
| Duplicate-candle prevention | **9/10** | `lastProcessed` claimed before any `await` — correct, race-free by construction. |
| P&L accounting | **9/10** | Wallet-delta (`newBalance - balanceBefore`) captures fees and funding automatically. Better than most retail bots. Leave it alone. |
| Position sizing | **3/10** | Ignored fees, and sized off the wrong distance. Leverage cap, not `RISK_PCT`, was the binding constraint. (Fixed.) |
| Regime detection | **2/10** | EMA200 slope over 10 candles with a 0.0005 threshold on 15m = a 0.05% move over 2.5 hours. Pure noise. The repo's own validated regime engine (ATR-normalised slope 0.011, anti-flapping, 4H timeframe) is ignored. `CRISIS` at ATR% > 5 is dead code on 15m — the p95 is 0.56%. |
| Liquidity pool detection | **3/10** | 1-bar swings on 15m are noise, not structure. `Math.floor` on the pool level threw away ~0.05% of price on ETH and would produce level 0 on any sub-$1 symbol. (Fixed.) |
| RVOL logic | **1/10** | `SWEEP_RVOL_MIN = 0.3` accepts candles at **30% of average volume**. This is not a filter; it is the opposite of one. The repo's validated LSO uses 1.2 and time-normalised RVOL. Upstream commit a7e362b actively *removed* the time normalisation. |
| CVD logic | **1/10** | Gate is `sign(delta[i] - delta[i-1])` — the second difference of a candle-derived proxy. `src/indicators/cvd.js`'s own header says this formula is unreliable *specifically on sweep candles* and must be validated against aggTrades first (Pearson ≥ 0.75). That validation was never run. |
| Stop placement | **1/10** | 0.3 × ATR ≈ 0.09% of price at median ETH volatility, against a 0.10% round-trip cost on a loss. **The stop is tighter than the cost of using it.** |
| TP placement | **2/10** | Fixed 2.5R with no structural reference. The repo's validated approach uses a DOL structural target. |
| Trade management / time exits | **3/10** | `TIME_EXIT_CANDLES = 50` was *logged but never executed* live, so a live position could be held indefinitely while paper exited at 50. (Fixed.) |
| Risk management | **2/10** | No daily loss limit, no consecutive-loss reduction, no drawdown brake. `config.js`'s `SIZING` block defines streak multipliers; none are used. 20x leverage on a $95 account. |
| Backtest honesty | **0/10** | The warmup "diagnostic scan" booked `risk * 1.8` on any TP touch, `-risk` on any SL touch, resolved TP before SL when one candle held both, entered at `pool.level` instead of the market fill, and charged no fees. It could not lose to any real cost. (Rewritten.) |
| Logging | **7/10** | Verbose and useful. Was missing the Binance error code on protection failure — the one line needed to diagnose the outage. (Restored.) |
| Maintainability | **5/10** | Single 585-line file, readable, but strategy constants are hardcoded in violation of the repo's own "config.js is the single source of truth" rule. |

---

## 3. Strategy Review — what was fundamentally wrong

### 3.1 The live strategy is not the strategy this repo validated

Phases D6–D13 validated **LSO-Long**: Gate VP (POC/VAL), 4H trend confirmation,
CVD z-score ≥ 2.5, RVOL ≥ 1.2, 0.1 × ATR stops, DOL structural targets, killzone
sizing, macro blackouts. Forward-tested on 2025 at PF 2.300.

`liveRunner.js` uses **none of it**. Upstream commit `0411276` ("Phase 2+3: New
strategy + liveRunner") started a parallel strategy, and `d530a48`
("optimize: grid-search best config — RVOL 0.3, STOP 0.3ATR, RR 2.5") tuned it by
grid search. The commit history shows the same parameters being refit repeatedly
(`dc251a2`, `2aeeba1`, `52a4236`, `9f1de75`, `a7e362b`) — each refit on the same
recent data. That is overfitting by iteration, and the grid searched a window of
2026 data only.

**So the PF 2.3 evidence in this repo does not apply to what was trading.** The
live bot had never been backtested at all.

### 3.2 The nominal 2.5 : 1 reward:risk does not exist

Stop and target are both anchored to `pool.level`. The entry is a **MARKET order
filled at the signal candle's close**. For a long sweep, by definition:

```
candle.low < pool.level < candle.close
                          ^^^^^^^^^^^^ you enter here
```

So real risk is `|close − stop|`, which is strictly larger than the `stopDist` the
2.5R was measured from — and real reward is `|tp − close|`, strictly smaller.
Measured over 38,749 ETH trades:

| | Planned | Realised |
|---|---|---|
| Reward:risk | 2.50 : 1 | **0.26 : 1** (0.62 : 1 even at zero cost) |
| Break-even win rate | 28.6% | **79.4%** (61.7% at zero cost) |
| Actual win rate | — | 28.0% |

This flaw is independent of fees. It is a geometry error.

### 3.3 The stop is tighter than the cost of using it

At median ETH 15m volatility (ATR = 0.302% of price):

| | % of price |
|---|---|
| Stop distance (0.3 × ATR) | 0.0906% |
| Target (2.5R) | 0.2266% |
| Round-trip cost, win (taker in, maker out) | 0.0700% |
| Round-trip cost, loss (taker in, **taker** out) | 0.1000% |

A loss costs 0.10% in fees to realise a 0.09% price move. **Fees exceed the
price-risk component by 1.38×.** Losses are structurally ~43% more expensive than
wins because a `STOP_MARKET` can never rest as a maker order.

Below the 25th percentile of volatility the break-even win rate exceeds 61%; in
the bottom 5% it exceeds 80%. The bot has no volatility floor, so it trades those
candles enthusiastically.

### 3.4 Size was governed by the leverage cap, not by RISK_PCT

```
qty = min(riskAmt / stopDist, equity × 0.8 × LEVERAGE / price)
```

At $95.69 equity: `riskQty` = 1.405, `maxQty` = 0.812 → **the cap binds every
time**. Verified against your own logs, which show 0.814 on consecutive trades;
the model reproduces 0.812. So "2% risk" was never in control of position size —
20x leverage was. Notional was 16× equity on a $95 account.

Combined with fees being excluded from sizing, a "2% risk" trade actually lost
**2.76% of equity**. That is your $5 loss.

---

## 4. Every Code Change

All changes are in `src/live/liveRunner.js` unless noted.

| # | Change | Why | Impact |
|---|---|---|---|
| 1 | `slResult.algoId` instead of `slResult.orderId`; restored Binance error code/msg in SL and TP failure logs | **Regression.** Upstream fixed this on 2026-07-28 07:47 (commit `402227b`); the local rewrite at 12:15 silently reverted both. `/fapi/v1/algoOrder` returns `algoId`, so `slOrderId` was being stored as `undefined` | Stop order IDs are now real. This is also why you were told "it's fixed" while still seeing it broken — both were true, on different copies |
| 2 | `TIME_EXIT_CANDLES` now market-closes the position instead of only printing `[TIMEOUT]` | Live could hold a position forever while paper and backtest exited at 50 candles — three different strategies from one config | Live behaviour now matches the intended strategy |
| 3 | Equity resynced from `/fapi/v2/account` inside `emergencyClose()` | An emergency close bypasses the `openTrade` booking path, so in-process `equity` stayed stale until the next restart, and every later position was sized off a balance that no longer existed | No more sizing on phantom capital after an incident |
| 4 | `getPosition()` returns `{positionAmt:'0'}` (flat) instead of `null` (unknown) on an empty array | An empty array is a *successful* "no position" response. Returning `null` meant "unknown → keep monitoring", so `openTrade` would never book and no new signal could ever fire. Latent today; **activates immediately** if you migrate to `/fapi/v3/positionRisk`, which omits flat positions by design | Removes a permanent-wedge failure mode |
| 5 | Pool level rounds to `tickSize` instead of `Math.floor` | `Math.floor` discarded up to ~$1 on ETH (~0.05% — comparable to the entire fee budget) and collapses to **0** on any sub-$1 symbol, producing a zero pool level and nonsensical stop/TP | Correct levels; the bot is no longer silently broken for XRP/DOGE-class symbols |
| 6 | `openTrade.entryOpenTime` replaces `openTrade.idx` | `candles.shift()` at the 15,000-candle cap slides every index, corrupting the time-exit countdown after ~156 days of uptime | Time exit survives buffer rotation |
| 7 | `FEE_RATE = 0.0004` → `TAKER_FEE 0.0005` / `MAKER_FEE 0.0002`, applied to **notional** | The old constant was the wrong rate *and* multiplied by `riskAmt` instead of notional, understating true cost by ~3 orders of magnitude ($0.0008 vs $1.53) | Fee accounting is real |
| 8 | `sizePosition()` — single sizing path for paper and live; sizes off `\|entry − stop\| + fees` | Old formula used `stopDist` and ignored fees, so `RISK_PCT` capped only the price component measured from the wrong anchor | **Verified: max loss dropped from $5.16 to $1.90 — a true 2% of equity.** Also logs which constraint binds (`[SIZE]`) |
| 9 | Paper/scan mode rewritten: real MARKET entry, real taker/maker fees, SL resolved before TP on ambiguous candles | Old scan booked `risk*1.8` on any TP touch and entered at `pool.level`. It was structurally incapable of showing a loss to fees, slippage, or intrabar sequence — the three things that decide this strategy | The scan now reproduces reality, including the $5-class losses |
| 10 | `syncServerTime()` — offsets all signed timestamps by the Binance server delta | `recvWindow: 5000` against an unsynced VPS clock rejects every signed request with `-1021`, which surfaces as "protection failed" rather than as a clock problem | Removes a whole class of phantom outage |
| 11 | `detectPools()` computed once per candle instead of twice | The `[CHECK-PASS]` log line called this O(n²) function purely to print a count | ~2× less CPU per candle |
| 12 | Optional `BB_MIN_EDGE` filter — rejects setups whose target cannot clear round-trip cost by N× | Directly targets §3.3 | Improves PF 0.17 → 0.37, but see §5: still unprofitable |
| 13 | **New:** `src/backtest/run_live_replica.js` + `npm run backtest:replica` | The live strategy had no backtest. This one replicates its logic exactly and prices it honestly | Produced every number in this document |

Deliberate non-changes:
- **The wallet-delta P&L method is correct — untouched.**
- **`STOP_MARKET` kept for the stop.** A limit stop could fill as maker and save
  ~0.03%, but can fail to fill entirely in a fast move, leaving an unprotected
  position. Not worth it. Never change this.

---

## 5. Backtest Results — before vs after

ETHUSDT 15m, 2021-01-01 → 2026-07-28, 195,294 candles, $95.69 starting capital,
pessimistic intrabar resolution, 0.06%/side slippage.

| Configuration | Trades | Win rate | Profit factor | Expectancy |
|---|---|---|---|---|
| **Before** (original sizing, no filters) | 38,749 | 28.0% | 0.139 | −0.611 R |
| \+ corrected fee-aware sizing (#8) | 38,749 | 28.0% | 0.171 | −0.611 R |
| \+ min-edge filter 3× cost | 20,174 | 34.6% | 0.297 | −0.575 R |
| \+ min-edge filter 5× cost | 9,484 | 31.5% | 0.369 | −0.498 R |
| *Reference: zero costs, optimistic ties* | 38,749 | 49.8% | *0.858* | *+0.013 R* |

**Every fix improves the number. None comes close to breaking even.** The
min-edge filter discards 88% of all signals and the remainder still loses 0.50 R
per trade. This is the expected outcome when gross edge is zero: correctness fixes
protect an edge, they cannot create one.

Cost attribution on the unfiltered run: total costs were **106% of |gross P&L|** —
the strategy paid more in costs than it moved in price.

Walk-forward by year (out-of-sample by construction — the grid search only ever
saw 2026 data). Profit factor by year: **0.34 / 0.10 / 0.01 / 0.04 / 0.51**.
Not one profitable year in five and a half.

BTCUSDT independent check: PF 0.131, −0.673 R with real costs; PF 0.838,
+0.0117 R at zero cost.

---

## 6. Remaining Risks / What Is Still Unproven

1. **Intrabar sequencing is a bound, not a measurement.** 5.8% of trades had SL and
   TP inside the same 15m candle. I report both bounds; the truth needs tick data.
   It does not change the conclusion — both bounds are deeply negative.
2. **Slippage is modelled, not measured.** I used the repo's own 0.06%/side for ETH.
   The zero-slippage run is included precisely so this assumption can't be blamed.
3. **The validated LSO strategy has not been re-verified by me.** Its PF 2.300
   forward test is a claim in `phase_d13_log.md`, and D13's own log notes a 28% PF
   degradation against a 25% threshold. Treat it as promising, not proven.
4. **The fixed `liveRunner.js` has not been run in live mode.** It is verified in
   paper mode against real Binance data (syntax, clock sync, sizing, fills, exits).
   No signed order path has been exercised since the fixes.
5. **`adoptExistingPosition()` still recomputes the stop from current ATR**, so an
   adopted position gets a different stop than it opened with. Left as-is:
   changing it needs a decision about what "the original risk" means after a restart.
6. **MEXC integration does not exist.** §7 is research, not code.

---

## 7. MEXC — the zero-fee question, answered

You asked whether moving to MEXC's zero-fee pairs would rescue this. **It would
not**, for two independent reasons.

**Reason 1 — MEXC's API fees are not zero.** Per MEXC's own announcement
("Introducing API Futures Trading on Mar 31, 2026"): **API futures fees are maker
0.01%, taker 0.05%**, and "API trades follow a separate fee structure, which takes
precedence over web and app rates." Their example is explicit: BTC futures shows
maker 0% / taker 0.01% in the app, but **via API you pay maker 0.01% / taker
0.05%**. The advertised 0% applies to manual trading, not to bots.

Against Binance:

| | Binance USD-M (API) | MEXC futures (API) |
|---|---|---|
| Taker | 0.050% | **0.050%** |
| Maker | 0.020% | 0.010% |

This bot is **taker on entry and taker on the stop**. The dominant cost is
identical. You would save 0.01% on the take-profit leg only — round-trip win cost
0.070% → 0.060%, and **nothing at all on the loss side**.

**Reason 2 — even genuinely zero fees do not make this profitable.** The
zero-cost run is PF 0.86, +0.013 R. There is no edge for a fee discount to
uncover.

**If you migrate anyway**, the API shape is workable and in one respect better:

- `POST /api/v1/private/order/create` — `symbol`, `vol`, `side` (1=open long,
  3=open short), `type` (5=market, 1=limit), `leverage`, `openType` (1=isolated),
  and critically **`stopLossPrice` / `takeProfitPrice` inline on the entry order**.
- That is architecturally **safer than Binance for this bot**: protection attaches
  atomically with the entry, which structurally eliminates the entire
  "filled but unprotected → emergency close" failure mode that caused most of your
  operational pain. No separate `attachProtection()` round trip to fail twice.
- Auth differs: headers `ApiKey`, `Request-Time`, `Signature`, HMAC-SHA256 over
  `accessKey + timestamp + paramString` (raw JSON body for POST) — not Binance's
  query-string signing. `binanceRequest()` would need a sibling, not a tweak.
- Rate limit 4 requests / 2 seconds on order placement — tighter than Binance.
- **Futures API requires completed KYC**, and API keys expire every 90 days unless
  IP-bound.

---

## 8. Future Roadmap — ranked by return on effort

1. **Stop trading this strategy.** Zero effort, saves the account. Already done —
   keep it done.
2. **Trade the strategy this repo actually validated.** `src/live/shadowRunner.js`
   already wires the real LSO descriptor (Gate VP, 4H trend, tiered CVD/RVOL) to
   live Binance data with two virtual accounts. It has never been run to
   completion. Run it, in shadow mode, until the SNIPER-vs-SCALPER question in
   `phase_d14_log.md` resolves. This is the highest-value action available.
3. **Impose a cost floor on any future strategy.** Require target distance ≥ 4–5×
   round-trip cost and stop distance ≥ 2× round-trip cost, at signal time. This
   single rule would have prevented every problem in this audit. `BB_MIN_EDGE`
   implements the target half.
4. **Raise the timeframe.** Fees are a fixed percentage per trade; edge scales with
   move size. At 0.09% stops the cost ratio is unwinnable. Structurally, 1H/4H
   stops of 0.5–1.5% make the same fee schedule nearly irrelevant.
5. **Cut leverage to where `RISK_PCT` actually binds.** At $95 equity, 20x means the
   cap governs sizing. Either fund the account properly or drop to 3–5x so your
   stated risk model is the one in control.
6. **Validate the CVD proxy before relying on it again** (backtestplan Step 4.1:
   30 days of BTC aggTrades, Pearson ≥ 0.75). Every strategy here gates on a
   candle-derived CVD that the repo's own code comments flag as unreliable on
   exactly the candles it is used for.
7. **Enable the BNB fee discount** (~25% off) if you keep trading Binance. Free,
   but note it cannot rescue a zero-edge strategy either.
8. **Do not migrate to MEXC for fee reasons.** Revisit only if you have a validated
   edge *and* need maker-side savings.

---

*Every number here is reproducible: `npm run backtest:replica -- --symbol ETHUSDT`
(add `--nofees --slippage 0 --optimistic` for the zero-cost reference, `--oldsizing`
for the pre-fix baseline, `--minedge 5` for the filtered run).*
