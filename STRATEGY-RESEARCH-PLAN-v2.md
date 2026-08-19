# BulletBrain — Strategy Research Plan v2 (Redone & Expanded)
# Purpose: Re-run the open-source research with a wider source set, fix two
#          assumption errors in v1, and give a corrected, realistic strategy plan
#          for scalping short-term futures at $80-100 capital.
# Status: RESEARCH COMPLETE → CORRECTIONS + NEW OPTIONS ADDED

---

## 0. Why v1 needed a second pass

Kiro's first plan wasn't wrong to study NFI/ClucHAnix/DirectionalScalper/Passivbot/ryu878 — those
are real, popular repos. But the source set was narrow (basically one family: freqtrade-style
spot indicator bots, plus two grid bots), and it carried two assumption errors that matter a lot
at $80-100 capital:

1. **The "maker rebate" framing is wrong at retail size.** v1's fee table implies you can earn a
   rebate by using limit orders. On standard (non-VIP) Binance/Bybit USDT-M futures in 2026, maker
   is a *lower fee* (~0.02%), not a *rebate* (negative fee, i.e. exchange pays you). Actual rebates
   only appear at high VIP tiers that require tens of millions to billions of dollars in 30-day
   volume — completely irrelevant at $80-100. The 5.5x maker-vs-taker advantage in v1's math is
   roughly right (0.02% vs 0.05-0.055%), but "rebate" and "gives ~5.5x advantage" are two different
   claims, and only the second one is true for you.

2. **The bigger miss: nothing in v1 addresses backtest realism for limit orders.** This is the
   actual reason "maker fee advantage" strategies often look great in a backtest and disappoint
   live. See Section 3 — this is the single most important addition in this revision.

On top of that, v1 only looked at ~8 repos, all from one style of project (retail indicator bots).
This pass adds market-making frameworks, realistic-fill backtesting engines, and the two other
major "real edge" families in open-source crypto trading (funding-rate carry, stat-arb) so you can
see the full landscape and where scalping at $80-100 actually sits in it.

---

## 1. Expanded Source Set

| Project | Type | New in this pass? | Why it matters here |
|---|---|---|---|
| **Hummingbot** (hummingbot/hummingbot) | Market-making framework, incl. Perpetual Market Making + V2 Controllers | **Yes — significant miss in v1** | Production-grade, ~7 years maintained, used by real market-making desks. Directly implements the "limit-entry / limit-exit on futures" mechanism v1 tried to hand-roll — except already built, tested, and shipped with proper risk handling. |
| **nkaz001/hftbacktest** + **nkaz001/algotrading-example** | Realistic-fill backtesting engine + order-book-imbalance strategy examples | **Yes — the key addition** | Purpose-built to simulate queue position and latency for limit orders on Binance/Bybit, instead of assuming a limit order fills whenever price touches it. This is what v1's backtesting approach is missing (see Section 3). |
| **Freqtrade / NostalgiaForInfinity / ClucHAnix** | Spot multi-pair indicator bots | Carried over | Still the best-documented BB+RSI+volume entry logic, but see the framework's own warning below. |
| **Passivbot** (now v8) | Contrarian market-maker on perp futures | **Updated characterization** | v1 called it "martingale grid, wipes out in trends." As of v7/v8 it has a TWEL Enforcer (total wallet exposure limit) specifically to cap trend-related blowups, and the maintainers now describe it as a contrarian market maker, not a blind grid. Still real trend risk, but the "wipes out" framing is dated. |
| **DirectionalScalper** | MFI+RSI directional, hedge mode, Bybit | Carried over | Same assessment as v1 — real mechanism, complex, better suited to $500+ capital. |
| **Funding-rate arbitrage bots** (multiple repos: kiprella, 50shadesofgwei, stephenpeters, vooi-app examples) | Delta-neutral spot+perp carry | **Yes** | The most structurally real edge in crypto trading — collect the funding payment while price risk is hedged to ~zero. Typical yield ~10-15%/year, not /month, and it needs *two* simultaneous legs (spot + perp), which roughly doubles your effective capital requirement. Not a scalping strategy, but worth knowing it exists as the honest "risk-free-ish" benchmark. |
| **Statistical arbitrage / pairs trading (cointegration)** repos | Market-neutral pairs mean-reversion | **Yes** | Real, documented edge (long history in equities, adapted to crypto). Same capital problem as funding arb — you need to hold two correlated legs at once, which is awkward at $80-100 on a single pair. |
| **Jesse** (jesse-ai/jesse) | Alternative Python backtesting/live framework | **Yes** | Cleaner futures-native syntax than freqtrade, built-in MCP server for AI-assisted strategy iteration. Framework choice, not a strategy — mentioned for completeness since you're building custom infrastructure anyway. |

**One thing worth taking at face value:** Freqtrade's own documentation states plainly that most
public strategies are not good performers, and that backtests of shared strategies are often not
a reliable way to judge real profitability — largely because results depend heavily on the market
regime and pairs used at the time they were published. That's not a knock on NFI/ClucHAnix
specifically, it's the project's own honest disclaimer, and it applies to every "here's a working
strategy" repo you find on GitHub, including the ones in this document.

---

## 2. The real bottleneck: backtest realism, not strategy creativity

This is the most important correction to v1.

v1's "Mechanism 1" (maker-only limit entry) assumes: place a limit order below price → it fills →
you paid 0.02% instead of 0.05%. In a candle-based (OHLCV) backtest, this is usually modeled as
"if the candle's low touched my limit price, count it as filled." That is optimistic in a specific,
well-documented way:

- **Adverse selection**: a resting limit buy order fills *because* the market traded down through
  it. By definition, the moment you get filled, the last thing that happened was price moving
  against your entry. A taker (market) order doesn't have this bias — you choose to enter when you
  want to, not when the market drags itself to your price.
- **Queue position**: on a real order book, your limit order sits behind everyone else's resting
  orders at that price level. Touching the price doesn't guarantee you were filled — you needed
  enough volume to trade through the entire queue in front of you, which candle data can't tell you.
- **Net effect**: candle-based backtests tend to *overstate* how often maker orders fill, and to
  *understate* how much the market has already moved against you by the time they do. This is
  exactly the kind of thing that makes a strategy look good on paper and lose money live — which
  matches the "profit after fees" problem you already ran into.

This is why **nkaz001/hftbacktest** is the standout new find in this pass: it's specifically built
to simulate limit-order queue position and latency using real L2 order book / tick data for Binance
and Bybit, with worked market-making examples. Hummingbot's V2 Controller backtester also accounts
for this more realistically than a plain OHLCV backtest. Neither is plug-and-play with your existing
liveRunner.js, but the concept they force you to confront is the one that matters: **before trusting
any "maker fee advantage" number, ask what fill assumption produced it.**

Practical fix for BulletBrain's own backtester, short of adopting a new engine:
1. Only count a limit fill if price traded *through* your level by a small buffer (e.g. 1-2 ticks
   beyond your price), not merely touched it.
2. Add a fill-delay of 1-3 bars after the touch, to roughly approximate queue time.
3. Run every strategy twice — once with optimistic (touch = fill) and once with conservative
   (through + delay) assumptions — and only trust results that survive the conservative version.
4. If a strategy's edge disappears under the conservative assumption, that's not the strategy
   failing, that's the backtest telling you the real one wouldn't have worked either.

---

## 3. Corrected fee reference table (retail tier, no VIP, no rebates)

| Metric | Value | Note |
|---|---|---|
| Binance USDT-M taker | ~0.05% | Standard tier, no BNB discount |
| Binance USDT-M maker | ~0.02% | Standard tier |
| Bybit USDT perp taker | ~0.055% | Standard tier |
| Bybit USDT perp maker | ~0.02% | Standard tier |
| Negative maker fee / true rebate | Only at VIP tiers requiring $10M-$5B+ 30-day volume | Not reachable at $80-100 capital |
| Round-trip taker+slip | ~0.22% | Reasonable estimate |
| Round-trip maker-both-sides | ~0.04-0.10% | Only if fills materialize as modeled |

---

## 4. Revised strategy options, ranked for $80-100 futures scalping

### Option A (recommended starting point): HYBRID_MFI_BB_TRAIL with corrected fill assumptions

The entry logic (BB compression + RSI + MFI + reversal bar + EMA200 filter) is a reasonable
synthesis of what works in NFI/ClucHAnix adapted for single-pair futures. The ATR trailing stop
matches the best-performing exit from the scalper backtests (S7/S9 avgR +1.55-1.63R positive).

**Before wiring into liveRunner.js:**
1. Re-run with conservative fill logic (through + 1-bar delay for limit entries)
2. Compare optimistic vs conservative results side by side
3. Only proceed if edge survives conservative fills

### Option B: Test 15m timeframe as explicit alternative

Same entry logic, 15m instead of 5m. Fee-to-ATR ratio improves 2-3x.
1-3 trades/day instead of 3-10. Lower frequency but meaningfully better fee math.

### Option C: Funding-rate carry (future portfolio addition)

Delta-neutral, ~10-15%/year, requires spot+perp legs simultaneously.
Not suitable at $80-100 (capital doubles requirement). Note for when capital grows.

### What not to pursue at $80-100

| Approach | Why |
|---|---|
| DirectionalScalper hedge mode | Needs two simultaneous positions, margin suffers below ~$500 |
| Passivbot grid (even v8) | Still real trend risk, $80-100 gives no room for adverse grid levels |
| Stat arb / pairs trading | Needs two correlated legs, same capital-doubling problem |
| Any strategy only tested with touch-to-fill fills | Fix the backtest first |

---

## 5. Honest calibration on the 20%/month target

Nothing found in either research pass demonstrates a strategy clearing 20%/month consistently,
net of real fees, at small size. The funding-rate carry literature tops out around 10-15% annually
when done properly. A target in the 5-10%/month range, net of real fees, would already put a
strategy in rare company relative to what's documented. 20%/month in a good month is possible;
as a routine repeatable monthly target it's not supported by the open-source evidence.

---

## 6. Revised implementation plan

**Phase 0: Fix backtest fill assumptions**
Add conservative fill modeling to backtest engine before touching strategy logic.
Run any "profitable" result through both optimistic and conservative — only trust what survives both.

**Phase 1: Backtest HYBRID_MFI_BB_TRAIL**
12-month run (Aug 2025 → Aug 2026), both fill assumptions.
Success criteria: zero-cost avg monthly >+10%, real-cost >+5%, ≥7/12 profitable months,
AND result survives conservative fills.

**Phase 2: Test 15m variant side by side**
Same entry logic, 15m bars. Compare fee-adjusted monthly return directly vs 5m version.

**Phase 3: Optimize exits**
Test: fixed 2R TP, BB midline TP, ATR trail (2.5×, activates at 0.5R), time-only exit.
Pick the variant that survives both fill assumptions.

**Phase 4: Wire winner into liveRunner.js**
Only after Phase 1 passes under conservative fills.

**Phase 5: 90-day local backtest, then live**
avg R > 0, PF > 1.3, ≥2/3 profitable months.

---

## 7. Sources

- freqtrade/freqtrade — https://github.com/freqtrade/freqtrade
- hummingbot/hummingbot — https://github.com/hummingbot/hummingbot
- nkaz001/hftbacktest — https://github.com/nkaz001/hftbacktest
- nkaz001/algotrading-example — https://github.com/nkaz001/algotrading-example
- enarjord/passivbot — https://github.com/enarjord/passivbot
- kiprella/Funding-rate-arbitrage-bot — https://github.com/kiprella/Funding-rate-arbitrage-bot
- jesse-ai/jesse — https://github.com/jesse-ai/jesse
- Carried over from v1: NostalgiaForInfinity, ClucHAnix, BB_RPB_TSL, DirectionalScalper,
  nikita-doronin hedge bot, ryu878 grid bot, francisx1999 postmortem

*Research completed: 2026-08-19*
