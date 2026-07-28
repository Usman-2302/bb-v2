# BulletBrain v3.0 — Quantitative Review, Redesign Attempt & Production Hardening

**Date:** 2026-07-28
**Mandate:** `src/live/prompt2.txt` — determine whether the strategy has a genuine
statistical edge, redesign until it does, or prove none can be extracted.
**Data:** 195,294 ETH 15m + 195,294 BTC 15m candles, 2021-01-01 → 2026-07-28,
downloaded fresh from Binance via the repo's own `src/data/downloader.js`.
**Reproduce:**
```bash
node src/backtest/research_signal_alpha.js  --symbol ETHUSDT   # signal quality
node src/backtest/research_alpha_battery.js                    # redesign search
npm run backtest:replica -- --symbol ETHUSDT                   # full strategy P&L
```

---

## 1. Executive Summary

**Was the original strategy fundamentally flawed? Yes — at the signal level, not
the execution level.**

The previous audit showed the strategy loses money. It did not establish *why*,
and "PF 0.86 before costs" left open the possibility that a better stop/target
model could rescue it. That possibility is now closed.

I measured the signal directly, with no stops, no targets, no costs, and no
sizing — just the direction-signed forward return after each signal, against a
same-regime baseline, de-overlapped, with t-stats. **The liquidity-sweep signal
has negative alpha at essentially every horizon on both symbols.**

| At h=8 candles (2h) | alpha vs baseline | t-stat | hit rate |
|---|---|---|---|
| Baseline (any candle in regime) | — | — | ~50% |
| `sweep_reclaim` (best variant) | **−0.36 bps** | 1.24 | 48.2% |
| `live` (what actually traded) | **−1.34 bps** | 0.18 | 48.0% |

The signal is not weak. It is very slightly **anti-predictive** — a 48% hit rate
against a 50% baseline.

**The most damning result is the ablation ladder.** Every "confirmation" filter
the system adds makes alpha monotonically *worse*:

```
sweep_reclaim          -0.36 bps   <- rawest signal, least bad
  + RVOL >= 0.3        -0.47
  + CVD gate           -0.97
  = live config        -1.34
  + RVOL >= 2.0        -1.98
  + displacement 70%   -2.48
  + RVOL 1.2 & disp70  -3.03 bps   <- most "confirmed", most negative
```

These filters were added to improve trade quality. They do the opposite, with
perfect consistency. That is the signature of filters selecting for *exhaustion
and chase* rather than reversal: by the time volume has spiked and the candle has
closed decisively in your direction, the move is over and you are the exit
liquidity.

**Redesign attempt.** I did not stop there. I built a battery of 12 economically
distinct hypotheses — trend, momentum, breakout, pullback, mean reversion, VWAP,
failed breakout, volatility expansion/contraction, order flow, CVD divergence,
session — and tested all of them under one protocol: 3 horizons × 2 symbols ×
3 disjoint chronological windows (TRAIN → VALID → OOS), de-overlapped, with a
Bonferroni threshold of |t| > 3.19 for 36 tests.

**Survivors: zero.**

And the near-misses reveal the structural problem, which is bigger than this
strategy:

> The best cross-symbol, all-windows-positive candidate (low-volatility trend
> following, h=8) shows alpha of **0.7–3.6 bps per trade**.
> The cost floor is **7 bps** on a win and **10 bps** on a loss.

**Any alpha this feature set can detect at 15m is roughly one order of magnitude
smaller than the cost of trading it.** For scale, the unconditional 8-candle
drift in this data is 1.5 bps. You are trying to harvest single-digit-basis-point
effects while paying 7–10 bps a round trip.

That is not a tuning problem. No stop model, filter, exchange, or fee tier fixes
a 10:1 ratio between cost and signal.

**Verdict: NO — do not deploy.** See §8.

---

## 2. Bugs Found

### 2.1 Independent verification of the previous audit's findings

The mandate required confirming or rejecting each prior finding rather than
trusting it. All were re-tested against code, data, or vendor documentation.

| # | Prior finding | Verdict | Evidence |
|---|---|---|---|
| 1 | Incorrect R:R geometry | **CONFIRMED** | Measured realised R:R = 0.26:1 vs nominal 2.5:1 over 38,749 trades; 0.62:1 even at zero cost |
| 2 | MARKET entry while stop/target anchored to pool level | **CONFIRMED** | Code: `stop`/`tp` derive from `pool.level`; entry is `candle.close`. For a long sweep `low < level < close` by construction, so entry is always worse than the anchor |
| 3 | Incorrect risk sizing | **CONFIRMED** | `qty = riskAmt/stopDist` ignored fees *and* used the wrong anchor. Empirically: max loss $5.16 on a $95 account for a "2%" trade → $1.90 after fix |
| 4 | Leverage governs real risk | **CONFIRMED** | At $95.69 equity: `riskQty`=1.405 vs `maxQty`=0.812 → cap binds every time. Model reproduces the 0.812 fill against your logged 0.814 |
| 5 | Paper mode inaccuracies | **CONFIRMED** | Booked flat `risk*1.8` on any TP touch, `-risk` on any SL touch, TP resolved before SL, entry at `pool.level`, zero fees |
| 6 | Incorrect algo order id | **CONFIRMED** (external) | Binance docs: `POST /fapi/v1/algoOrder` returns `algoId`; only standard orders return `orderId`. Local file had regressed upstream's `402227b` fix |
| 7 | Emergency recovery issues | **CONFIRMED** | `emergencyClose()` never resynced equity; aborted trades bypass `openTrade` booking entirely |
| 8 | Balance synchronization | **CONFIRMED** | Same root cause as #7 — in-process equity stale until restart |
| 9 | Time exit never executed | **CONFIRMED** | Live branch only `console.log`-ed `[TIMEOUT]`; no close call existed |
| 10 | `getPosition` ambiguity | **CONFIRMED as latent** | Empty array (a *successful* "no position" response) was returned as `null` = "unknown" → permanent wedge. Rare on `/fapi/v2/positionRisk`; **becomes immediate** on `/fapi/v3/positionRisk`, which omits flat positions by design |
| 11 | Buffer drift | **CONFIRMED** | `candles.shift()` at the 15,000 cap slides every index while `openTrade.idx` stays fixed → time-exit countdown corrupts after ~156 days uptime |
| 12 | Pool rounding | **CONFIRMED** | `Math.floor((v1+v2)/2)` on a price. ~0.05% of price discarded on ETH — comparable to the entire fee budget — and collapses to **0** on any sub-$1 symbol |
| 13 | Live vs paper inconsistencies | **CONFIRMED** | Different entry price, different exit accounting, different time-exit behaviour — three strategies from one config |
| 14 | Restart protection logic | **PARTIALLY CONFIRMED** | Adoption works and re-protects correctly, but recomputes the stop from *current* ATR, so an adopted position gets a different stop than it opened with. Not a bug per se — an undefined-semantics issue. Left unchanged deliberately (§6) |

**Rejected:** none. All fourteen stand, one with a qualification.

### 2.2 New bugs found in this review

| # | Severity | Bug | Fix |
|---|---|---|---|
| N1 | **CRITICAL** | **Concurrency race — safety invariant #5 does not hold.** `lastProcessed` prevents the *same* candle being processed twice, but the WS feed and the 30s REST poll can process *different* candles concurrently. Both `await`, both observe `openTrade == null`, both call `placeLiveTrade` → **two positions, double risk**. Candle boundaries are exactly when both feeds fire | Added an async serialisation chain (`serialise()`) around the whole `onNewCandle` body. The candle is still *claimed* synchronously before any await; the body is now strictly serialised |
| N2 | **HIGH** | **Price/qty quantisation is wrong for non-power-of-ten increments.** `formatPrice` derived decimal places from `tickSize`; a 0.5 tick with "1 decimal place" yields `1877.3`, which is not a multiple of 0.5 → Binance rejects with -1111/-4014. Verified: old code produced invalid ticks for 0.5 and 5; ETH (0.01) and BTC (0.1) masked it | Replaced with `roundToIncrement()` — rounds to a true multiple of the increment. Quantity now **floors** (rounding up can breach available margin / reduceOnly) |
| N3 | MEDIUM | **`cancelAllOpenOrders()` printed unconditional success**, ignoring both DELETE results. A failed algo-cancel would leave an orphaned `STOP_MARKET` live on the exchange while the log said everything was cancelled | Now reports per-endpoint outcome and returns a boolean; failure is logged as `[CANCEL] INCOMPLETE` |
| N4 | MEDIUM | **False "NAKED POSITION" alarm.** A `reduceOnly` close is *rejected* when the position is already flat (e.g. the stop filled first). The code raised the maximum-severity manual-intervention alarm on this benign race. A false alarm every time trains you to ignore the real one | `emergencyClose()` now queries position state before classifying: flat → benign, non-zero → real naked position, unknown → explicit unknown |
| N5 | MEDIUM | **Statistics undercounted the worst outcomes.** An emergency-closed entry never reached `recordTrade`, so aborted trades — which cost a full round trip in fees — were invisible to the umpire's win rate. Reported WR was better than reality by exactly the worst cases | Aborted entries now book their realised wallet delta via `recordTrade`; `recordTrade` classifies by realised P&L rather than by label |
| N6 | LOW | **EMA200 is recomputed over a growing buffer.** After the warmup trim the EMA is seeded from 500 candles and re-seeded as the buffer grows, so the same timestamp can change regime retroactively. A live/backtest divergence source | Documented, not changed — fixing it means persisting indicator state, which is a larger refactor than this review should make to a live file |
| N7 | LOW | Signed request params are not URL-encoded. Harmless for current numeric-only params; would break on any future string param containing `&` or `=` | Documented |

---

## 3. Strategy Changes

**None to the trading logic.** This requires explanation, because the mandate
asked for a redesign.

I did not change the entry/exit logic because the research says there is nothing
to change it *to*. Adding a filter, moving a stop, or switching the target model
are all rearrangements of a signal with negative alpha. §1's ablation ladder shows
that adding confirmation gates to this signal makes it monotonically worse, and
§4's battery shows no replacement signal in this feature space clears the cost
floor. Changing the strategy without a measured edge would be exactly the
parameter-hunting the mandate forbids.

The one strategy-adjacent control I added is **opt-in and off by default**:

- **`BB_MIN_EDGE=N`** — rejects setups whose target cannot clear round-trip cost
  by N×. Rationale: at 0.3×ATR stops, a large share of signals are structurally
  unable to pay for themselves. Measured effect: PF 0.17 → 0.37 at N=5, while
  discarding 88% of signals. **It improves the number without making it
  profitable**, which is exactly why it ships disabled.

Everything else I changed is a correctness or safety fix (§2), not a strategy
change.

---

## 4. Quantitative Evidence

### 4.1 Signal quality — the measurement that had never been made

ETH 15m, full sample, direction-signed forward returns, de-overlapped, no costs:

| Variant | n (h=8) | mean (bps) | alpha (bps) | t | hit% | MFE/MAE |
|---|---|---|---|---|---|---|
| sweep_reclaim | 14,968 | 1.16 | **−0.36** | 1.24 | 48.2 | 0.976 |
| reclaim_rvol03 | 14,786 | 1.06 | −0.47 | 1.12 | 48.3 | 0.974 |
| sweep_only | 16,513 | 0.91 | −0.61 | 1.02 | 48.7 | 1.008 |
| reclaim_cvd | 13,763 | 0.55 | −0.97 | 0.57 | 48.2 | 0.982 |
| **live config** | 13,583 | 0.18 | **−1.34** | 0.18 | 48.0 | 0.978 |
| reclaim_rvol20 | 4,406 | −0.45 | −1.98 | −0.24 | 48.2 | 0.962 |
| reclaim_disp70 | 11,764 | −0.95 | −2.48 | −0.89 | 47.0 | 0.962 |
| reclaim_rvol12_disp70 | 4,810 | −1.50 | −3.03 | −0.83 | 46.8 | 0.959 |

**MFE/MAE < 1 at every short horizon.** After a "bullish sweep reclaim", price
moves *against* you slightly more than it moves for you, before it does anything
else. This is the mechanical explanation for the 0.26:1 realised R:R: any stop
placed tighter than the median adverse excursion gets hit first, by construction.

One cell — `live` at h=16 — shows alpha +1.76 with t=2.32. That is 1 significant
result out of ~70 tested cells, where ~3.5 false positives are expected at
α=0.05. It does not persist at h=8 (−1.34) or h=32 (−0.42). **This is exactly the
kind of isolated cell a grid search latches onto**, and it is almost certainly
what produced the shipped configuration.

### 4.2 Redesign search — 12 hypotheses, 36 tests, zero survivors

Bonferroni bar |t| > 3.19. Criteria: TRAIN alpha>0 & significant, VALID alpha>0,
OOS alpha>0, on **both** symbols.

**Survivors: 0.**

Best near-misses (cross-symbol positive TRAIN alpha), with alpha in bps:

| Hypothesis | ETH TRAIN / VALID / OOS | BTC TRAIN / VALID / OOS | max t |
|---|---|---|---|
| `h09_lowvol_trend` h=8 | 0.74 / 1.32 / 3.60 | 1.16 / 1.28 / 2.40 | 1.59 |
| `h09_lowvol_trend` h=16 | 2.16 / 6.57 / −0.82 | 2.13 / 1.95 / 6.50 | 1.48 |
| `h05_ret_zscore_revert` h=16 | 2.44 / −6.20 / 8.51 | 1.78 / −4.14 / 10.71 | 0.78 |
| `h08_vol_expansion` h=16 | 0.97 / 9.59 / 13.84 | 1.80 / −4.03 / 11.25 | 0.55 |

`h09_lowvol_trend` (trend-following in low-volatility regimes) is the only
candidate positive on both symbols across all three windows at h=8. It is also
**statistically insignificant (t≈1.6) and economically hopeless: 0.7–3.6 bps of
alpha against a 7–10 bps cost floor.**

### 4.3 Full-strategy P&L — before vs after

ETH 15m, 2021→2026, $95.69, pessimistic intrabar, 0.06%/side slippage:

| Configuration | Trades | WR | PF | Expectancy | Sharpe | Max DD |
|---|---|---|---|---|---|---|
| Before (original sizing) | 38,749 | 28.0% | 0.139 | −0.611 R | −60.1 | ruin |
| \+ fee-aware sizing | 38,749 | 28.0% | 0.171 | −0.611 R | — | ruin |
| \+ min-edge 3× | 20,174 | 34.6% | 0.297 | −0.575 R | — | ruin |
| \+ min-edge 5× | 9,484 | 31.5% | 0.369 | −0.498 R | — | ruin |
| *zero-cost reference* | 38,749 | 49.8% | *0.858* | *+0.013 R* | — | — |

Walk-forward PF by year: **0.34 / 0.10 / 0.01 / 0.04 / 0.51** — not one profitable
year in five and a half. BTC independently: PF 0.131 with costs, 0.838 without.

Cost attribution on the unfiltered run: total costs were **106% of |gross P&L|**.

---

## 5. Risk Review — is a configured 2% actually 2%?

**Before: no.** Three separate errors compounded:

1. `qty = riskAmt / stopDist` — fees excluded from the risk budget entirely.
2. `stopDist` is measured `pool.level → stop`, but real exposure is
   `entry → stop`, and entry is the market fill at candle close (always beyond
   the anchor).
3. The leverage cap `equity × 0.8 × 20 / price` was the binding constraint at
   your equity, so `RISK_PCT` was not governing size at all.

Measured outcome: a "2% risk" trade lost **2.76% of equity** — $2.64 of which
$1.53 was fees. Fees were **1.38× the price-risk component**.

**After:** `sizePosition()` sizes off `|entry − stop| + entry × (taker + taker)`,
so `riskAmt` caps *total* loss including both fee legs. Verified in paper mode
against live Binance data: **max loss went from $5.16 to $1.90 = a true 2.0% of a
$95.69 account.** The runner now also logs `[SIZE] riskQty-capped=LEVERAGE|RISK_PCT`
on every entry so the binding constraint is never invisible again.

**Remaining risk caveat:** `STOP_MARKET` guarantees *trigger*, not *fill price*.
In a gap or fast move the realised loss can exceed the sized risk. This is
inherent to stop-market orders and is the correct trade-off (see §6).

---

## 6. Production Review — remaining weaknesses

1. **Production log investigation is incomplete.** SSH to `ubuntu@54.249.145.15`
   fails at banner exchange (`kex_exchange_identification: Connection reset`) from
   this machine while TCP/22 is open — the signature of a source-IP block
   (fail2ban / `hosts.deny`). Your Windows host's IP is allowed; this one
   (`104.28.244.129`) is not. I stopped after two attempts rather than deepen a
   ban. Commands to collect what I need are in §9. **Every runtime conclusion in
   this document therefore comes from code, market data, or your pasted logs — not
   from the production host.**
2. **Live order path unexercised since the fixes.** Validation was paper mode
   against real Binance market data (WS + REST, 200s, indicators, sizing, exits,
   scan over 1,500 candles): **zero runtime errors**. No signed order call has
   been made — correctly, since the account should not be trading this strategy.
3. **`adoptExistingPosition` stop semantics** remain undefined after a restart
   (recomputes from current ATR). Deliberately unchanged: the right behaviour
   depends on whether "original risk" should survive a restart, which is your call.
4. **EMA200 buffer re-seeding** (N6) — a real live/backtest divergence source,
   left documented rather than fixed.
5. **`STOP_MARKET` retained deliberately.** A stop-limit could fill as maker and
   save ~3 bps, but can fail to fill entirely in a fast move, leaving an
   unprotected position — the exact failure mode the safety invariants exist to
   prevent. **Never change this to save fees.**
6. **No daily-loss brake, no consecutive-loss scaling, no drawdown halt.**
   `config.js`'s `SIZING` block defines streak multipliers that nothing uses. Not
   added here — adding risk controls to a strategy that should not trade would be
   misplaced effort.

---

## 7. Code Changes

| File | Change | Reason |
|---|---|---|
| `src/live/liveRunner.js` | `serialise()` async chain around `onNewCandle` | **N1** — prevents concurrent WS/REST candle processing opening two positions |
| | `roundToIncrement()`; `formatPrice`/`formatQty` rewritten | **N2** — correct tick/step quantisation; qty floors |
| | `cancelAllOpenOrders()` reports real outcome | **N3** — no more false success hiding orphaned stops |
| | `emergencyClose()` verifies position before alarming; resyncs equity | **N4**, prior #7/#8 |
| | Aborted entries booked via `recordTrade`; `recordTrade` classifies by P&L | **N5** — stats no longer hide the worst outcomes |
| | `slResult.algoId`; Binance error code/msg on SL/TP failure | prior #6 — confirmed against Binance docs |
| | Time exit market-closes instead of logging | prior #9 |
| | `getPosition` returns flat (not null) on empty array | prior #10 |
| | `entryOpenTime` replaces buffer index | prior #11 |
| | Pool level rounds to tick, not `Math.floor` | prior #12 |
| | `TAKER_FEE`/`MAKER_FEE` on notional; `sizePosition()` shared by paper+live | prior #3/#5/#13 |
| | Paper mode: real fills, real fees, SL-before-TP | prior #5 |
| | `syncServerTime()` offsets signed timestamps | prevents -1021 from clock drift |
| | `detectPools` computed once per candle | was called twice, O(n²) each |
| | Header documents measured strategy status | stops the next reader re-deriving this |
| `src/backtest/run_live_replica.js` | **new** — honest replica of live logic | live strategy had no backtest at all |
| `src/backtest/research_signal_alpha.js` | **new** — signal alpha / MFE / MAE | isolates signal quality from strategy P&L |
| `src/backtest/research_alpha_battery.js` | **new** — 12-hypothesis redesign search | evidence for "no edge available", not an assertion |
| `package.json` | `backtest:replica`, `live` scripts | reproducibility |
| `CLAUDE.md`, `AUDIT.md` | status and findings | institutional memory |

---

## 8. Final Verdict

**Would I deploy this with my own capital? No.**

Not because of bugs — those are fixed, and the execution layer is genuinely good.
Because of arithmetic:

- The signal's measured alpha is **negative** (−1.34 bps at h=8, hit rate 48% vs
  a 50% baseline). Every added filter makes it worse.
- The best replacement signal I could find across 12 hypotheses and 36 tests is
  **statistically insignificant** (t≈1.6) and worth **1–3 bps**.
- The cost floor is **7–10 bps per round trip**.
- Therefore the gap is roughly **an order of magnitude**, in the wrong direction.

**What would change my answer** — concretely, in priority order:

1. **Move up the timeframe.** Costs are fixed per trade; edge scales with move
   size. At 0.09% stops, fees are 1.38× the price risk. At 4H, stops of 1–2% make
   the same fee schedule nearly irrelevant. This is the single highest-leverage
   change available and it requires no new alpha.
2. **Run the strategy this repo actually validated.** `src/live/shadowRunner.js`
   already wires the real LSO descriptor (Gate VP, 4H trend, tiered CVD/RVOL) to
   live data with two virtual accounts, and per `phase_d14_log.md` has never been
   run to completion. Zero risk, and it settles the open SNIPER-vs-SCALPER
   question. **Do this next.**
3. **Find alpha outside this feature set.** Everything tested here is derived from
   OHLCV. The effects that survive costs in crypto microstructure generally need
   data this codebase does not have: order book depth/imbalance, liquidation
   feeds, funding dislocation, cross-exchange basis. Adding another OHLCV
   indicator will not work — twelve of them already failed.
4. **Validate the CVD proxy before reusing it** (backtestplan Step 4.1, Pearson
   ≥ 0.75 vs aggTrades). `cvd.js`'s own header warns the formula is unreliable on
   sweep candles; the data now shows the CVD gate *subtracts* 0.6 bps of alpha,
   which is consistent with that warning.

**Do not** re-enable `BB_LIVE=true` on the current parameters, and do not migrate
exchanges to fix this — at zero fees the strategy still has PF 0.86.

---

## 9. Outstanding: production log collection

Run from your Windows box (the IP the server accepts) and paste the output:

```bash
ssh -i "C:\Users\usman\Downloads\bbv2-key.pem" ubuntu@54.249.145.15 \
  "cd ~/bulletbrain && \
   echo '=== PM2 ==='        && pm2 list && pm2 describe bb-live | head -40 && \
   echo '=== ERR TAIL ==='   && tail -400 ~/.pm2/logs/*error*.log && \
   echo '=== OUT TAIL ==='   && tail -400 ~/.pm2/logs/*out*.log && \
   echo '=== BINANCE ERRS ===' && grep -h 'BINANCE\|SAFETY\|EMERGENCY\|CANCEL\|-1021\|-4120\|-2022\|-1111' ~/.pm2/logs/*.log | tail -100 && \
   echo '=== TRADES ==='     && grep -h 'TRADE\|ENTRY\|SIZE' ~/.pm2/logs/*.log | tail -80 && \
   echo '=== CLOCK ==='      && timedatectl && \
   echo '=== GIT ==='        && git log --oneline -5 && git status --short"
```

Specifically wanted: whether any `[SAFETY] Protection incomplete` carries a
`-1021` (clock) or `-4120` (algo routing) code, whether two entries ever appear
within one candle (the N1 race), and whether the deployed commit predates the
`algoId` fix.
