'use strict';

/**
 * Research configuration — deliberately separate from production `config.js`.
 *
 * Nothing in the research pipeline may read production config, and nothing in
 * production may read this. Mixing them is how a research parameter ends up
 * trading real money.
 */

module.exports = {
  symbols: ['ETHUSDT', 'BTCUSDT'],

  // Chronological and disjoint. OOS is the most recent data and is looked at last.
  splits: {
    TRAIN: ['2021-01-01', '2025-06-30'],
    VALID: ['2025-07-01', '2026-02-28'],
    OOS:   ['2026-03-01', '2026-12-31'],
  },

  // Measured from this account's own userTrades fills — not assumed.
  costs: {
    takerFee: 0.0005,
    makerFee: 0.0002,
    slippagePerSide: 0.0006,
    fundingPer8h: 0.0001,
  },

  // Sensitivity sweep applied to the cost model to test robustness.
  costScenarios: {
    measured: {},
    optimistic: { slippagePerSide: 0.0002 },
    harsh: { slippagePerSide: 0.0012, takerFee: 0.0007 },
  },

  sizing: {
    equity: 10000,
    riskPct: 0.01,        // 1% of equity per trade, fee-inclusive
  },

  engine: {
    warmup: 250,
    minEdgeMult: 0,       // >0 rejects targets that cannot clear round-trip cost
  },

  acceptance: {
    minTrades: 50,
    familyAlpha: 0.05,    // Bonferroni family-wise error rate
    walkForwardFolds: 5,
  },

  reporting: {
    outDir: 'results/research',
    writeCSV: true,
    writeJSON: true,
    writeMarkdown: true,
  },
};
