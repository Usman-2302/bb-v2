'use strict';

/**
 * Execution cost model.
 *
 * Rates are measured, not assumed: taker 0.050% and maker 0.020% were read off
 * this account's own /fapi/v1/userTrades fills (see AUDIT.md §1).
 *
 * The single most important asymmetry, and the one the old system ignored:
 * a STOP_MARKET can never rest on the book, so a stop-out ALWAYS pays taker on
 * the exit. Losses are structurally more expensive than wins.
 */

const DEFAULTS = {
  takerFee: 0.0005,
  makerFee: 0.0002,
  slippagePerSide: 0.0006,   // market-order slippage, per side
  fundingPer8h: 0.0001,
  latencyBars: 0,            // extra bars between signal and fill (0 = next open)
};

class CostModel {
  constructor(overrides = {}) {
    Object.assign(this, DEFAULTS, overrides);
  }

  /** Adverse price for a market fill in `dir` (+1 long, -1 short). */
  marketFill(price, dir) {
    return price * (1 + dir * this.slippagePerSide);
  }

  /** Fee on one leg. */
  fee(notional, isMaker) {
    return notional * (isMaker ? this.makerFee : this.takerFee);
  }

  /** Funding paid over a holding period. */
  funding(notional, heldMs) {
    return notional * this.fundingPer8h * (heldMs / (8 * 3600 * 1000));
  }

  /** Round-trip cost as a fraction of notional, for the two realistic paths. */
  roundTripWin() { return this.takerFee + this.makerFee; }
  roundTripLoss() { return this.takerFee + this.takerFee; }

  /**
   * The minimum move, as a fraction of price, that a trade must capture to break
   * even. Any strategy whose expected move is near this number is untradeable
   * regardless of hit rate.
   */
  breakEvenMove() { return this.roundTripWin() + 2 * this.slippagePerSide; }

  describe() {
    return `taker ${(this.takerFee * 1e4).toFixed(1)}bps / maker ${(this.makerFee * 1e4).toFixed(1)}bps` +
      ` / slip ${(this.slippagePerSide * 1e4).toFixed(1)}bps per side` +
      ` / funding ${(this.fundingPer8h * 1e4).toFixed(1)}bps per 8h` +
      ` -> break-even move ${(this.breakEvenMove() * 1e4).toFixed(1)}bps`;
  }
}

/** Zero-cost model. Diagnostics only — never use to judge deployability. */
const ZERO_COST = new CostModel({
  takerFee: 0, makerFee: 0, slippagePerSide: 0, fundingPer8h: 0,
});

module.exports = { CostModel, ZERO_COST, DEFAULTS };
