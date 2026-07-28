'use strict';

/**
 * Statistical testing utilities.
 *
 * The failure mode this file exists to prevent: running many hypotheses, picking
 * the best-looking one, and reporting its naive t-stat. With 36 tests at
 * alpha=0.05 you expect ~1.8 false positives; the previous system's shipped
 * configuration was almost certainly one of them (QUANT-REVIEW.md §4.1).
 */

const { mean, sd } = require('./metrics');

/** Abramowitz-Stegun inverse error function (~4e-4 accurate). */
function inverseErf(x) {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  return Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
}

/** Two-sided normal quantile. */
function zQuantile(p) { return Math.sqrt(2) * inverseErf(2 * p - 1); }

/** Two-sided p-value for a z/t statistic under a normal approximation. */
function pValue(t) {
  if (!Number.isFinite(t)) return NaN;
  // erf-based normal CDF
  const z = Math.abs(t) / Math.SQRT2;
  const erf = 1 - 1 / Math.pow(1 + 0.278393 * z + 0.230389 * z * z +
    0.000972 * z * z * z + 0.078108 * z * z * z * z, 4);
  return 1 - erf;
}

/** Bonferroni-corrected |t| threshold for a family of `nTests` at `familyAlpha`. */
function bonferroniThreshold(nTests, familyAlpha = 0.05) {
  const per = familyAlpha / Math.max(1, nTests);
  return Math.abs(zQuantile(per / 2));
}

/**
 * Benjamini-Hochberg FDR. Less brutal than Bonferroni and more appropriate when
 * screening many hypotheses. Returns the indices deemed significant.
 */
function benjaminiHochberg(pvals, q = 0.10) {
  const idx = pvals.map((p, i) => ({ p, i })).filter(o => Number.isFinite(o.p))
    .sort((a, b) => a.p - b.p);
  const m = idx.length;
  let kMax = -1;
  for (let k = 0; k < m; k++) if (idx[k].p <= ((k + 1) / m) * q) kMax = k;
  return kMax < 0 ? [] : idx.slice(0, kMax + 1).map(o => o.i);
}

/**
 * Stationary block bootstrap of a return series. Preserves local autocorrelation
 * and clustering, which an IID bootstrap destroys — important because trade
 * outcomes cluster by regime.
 */
function blockBootstrap(rs, { iterations = 2000, blockSize = 20, rng } = {}) {
  const rand = rng || mulberry32(12345);
  const n = rs.length;
  if (n < 2) return { meanCI: [NaN, NaN], pPositive: NaN, samples: [] };
  const samples = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let s = 0, c = 0;
    while (c < n) {
      const start = Math.floor(rand() * n);
      const len = Math.min(blockSize, n - c);
      for (let k = 0; k < len; k++) { s += rs[(start + k) % n]; c++; }
    }
    samples[it] = s / c;
  }
  samples.sort((a, b) => a - b);
  const q = p => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * (samples.length - 1))))];
  return {
    meanCI: [q(0.025), q(0.975)],
    pPositive: samples.filter(x => x > 0).length / samples.length,
    samples,
  };
}

/**
 * Monte Carlo on trade ORDER (and optional dropout). Answers: "how bad could the
 * drawdown have been with the same trades in a different sequence?"
 */
function monteCarlo(rs, { iterations = 2000, dropout = 0.05, rng } = {}) {
  const rand = rng || mulberry32(987654);
  const dds = [], finals = [];
  for (let it = 0; it < iterations; it++) {
    const shuffled = rs.filter(() => rand() > dropout);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let cum = 0, peak = 0, maxDD = 0;
    for (const r of shuffled) {
      cum += r;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDD) maxDD = peak - cum;
    }
    dds.push(maxDD); finals.push(cum);
  }
  dds.sort((a, b) => a - b); finals.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];
  return {
    ddP50: q(dds, 0.5), ddP95: q(dds, 0.95), ddMax: dds[dds.length - 1],
    finalP5: q(finals, 0.05), finalP50: q(finals, 0.5),
    pRuinAt10R: dds.filter(d => d >= 10).length / dds.length,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  inverseErf, zQuantile, pValue, bonferroniThreshold, benjaminiHochberg,
  blockBootstrap, monteCarlo, mulberry32,
};
