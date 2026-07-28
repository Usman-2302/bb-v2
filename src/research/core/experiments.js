'use strict';

/**
 * Experiment database — append-only, never lose research.
 *
 * Storage is JSONL: one experiment per line, append-only, so a corrupt or
 * partial write can never destroy prior records (the failure mode of
 * rewrite-whole-file JSON). Each record is self-describing enough to reproduce
 * the run: git commit, dataset version, config, cost scenario, results.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_DIR = () => path.join(process.cwd(), 'results', 'research', 'experiments');
const DB_FILE = () => path.join(DB_DIR(), 'experiments.jsonl');

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'no-git';   // this repo is not currently a git checkout
  }
}

function gitDirty() {
  try {
    return execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * @param {object} rec { cycle, scenario, datasetVersion, config, strategies:[{name,...}], leaderboard }
 * @returns {string} experiment id
 */
function record(rec) {
  fs.mkdirSync(DB_DIR(), { recursive: true });
  const id = 'exp_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) +
    '_' + Math.abs(hash(JSON.stringify(rec.strategies || []))).toString(36).slice(0, 6);
  const full = {
    id,
    timestamp: new Date().toISOString(),
    git: { commit: gitCommit(), dirty: gitDirty() },
    ...rec,
  };
  fs.appendFileSync(DB_FILE(), JSON.stringify(full) + '\n');
  return id;
}

function all() {
  const p = DB_FILE();
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line, keep the rest */ }
  }
  return out;
}

function latest(n = 1) {
  const a = all();
  return a.slice(Math.max(0, a.length - n));
}

/**
 * Compare a strategy's metric across the experiment history. This is how edge
 * decay becomes visible: a strategy whose expectancy trends down across cycles
 * is decaying even while each individual cycle still looks acceptable.
 */
function history(strategyName, metric = 'avgR') {
  const out = [];
  for (const exp of all()) {
    const s = (exp.strategies || []).find(x => x.name === strategyName);
    if (!s) continue;
    out.push({
      id: exp.id, timestamp: exp.timestamp,
      scenario: exp.scenario,
      datasetHash: exp.datasetVersion?.hash,
      value: s[metric], status: s.status, score: s.score,
    });
  }
  return out;
}

/** Simple linear trend of a metric over cycles: negative slope = decaying edge. */
function decayTrend(strategyName, metric = 'avgR') {
  const h = history(strategyName, metric).filter(x => Number.isFinite(x.value));
  if (h.length < 3) return { n: h.length, slope: NaN, verdict: 'insufficient history' };
  const n = h.length;
  const xs = h.map((_, i) => i);
  const ys = h.map(x => x.value);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den > 0 ? num / den : NaN;
  return {
    n, slope,
    first: ys[0], last: ys[n - 1],
    verdict: !Number.isFinite(slope) ? 'unknown'
      : slope < -1e-4 ? 'DECAYING'
      : slope > 1e-4 ? 'improving' : 'stable',
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

module.exports = { record, all, latest, history, decayTrend, gitCommit, DB_FILE };
