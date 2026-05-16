'use strict';

/**
 * Standalone test runner for Phase D1 data modules.
 * Runs without jest to avoid shell issues.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-d1-'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL  ' + name + ' — ' + e.message);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log('PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('FAIL  ' + name + ' — ' + e.message);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function makeDir(sub) {
  const d = path.join(TMP, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeNDJSON(dir, filename, records) {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function makeCandle(openTime, volume = 100) {
  return { openTime, open: 50000, high: 51000, low: 49000, close: 50500, volume, closeTime: openTime + 3599999, trades: 1000 };
}

// ── loader tests ──────────────────────────────────────────────────────────────

const { streamNDJSON, loadNDJSON, loadOIMap, loadFundingMap, getKlinesPath } = require('../src/data/loader');

// Patch DATA paths
const config = require('../config');
config.DATA.paths.historical = makeDir('historical');
config.DATA.paths.oi         = makeDir('oi');
config.DATA.paths.funding    = makeDir('funding');
config.DATA.paths.results    = makeDir('results');

test('loadNDJSON returns empty array for missing file', () => {
  const result = loadNDJSON('/nonexistent_file_xyz.ndjson');
  assert(Array.isArray(result) && result.length === 0, 'should be empty array');
});

test('loadNDJSON loads records correctly', () => {
  const records = [makeCandle(1000), makeCandle(2000)];
  const p = writeNDJSON(config.DATA.paths.historical, 'TEST_load.ndjson', records);
  const result = loadNDJSON(p);
  assert(result.length === 2, 'should have 2 records');
  assert(result[0].openTime === 1000, 'first openTime should be 1000');
});

test('loadOIMap builds timestamp map', () => {
  const records = [{ timestamp: 1000000, oi: 500.5 }, { timestamp: 2000000, oi: 600.0 }];
  writeNDJSON(config.DATA.paths.oi, 'BTCUSDT_1h.ndjson', records);
  const map = loadOIMap('BTCUSDT');
  assert(map.get(1000000) === 500.5, 'OI value should be 500.5');
  assert(map.size === 2, 'map should have 2 entries');
});

test('loadFundingMap builds timestamp map', () => {
  const records = [{ timestamp: 1000000, rate: 0.0001 }, { timestamp: 2000000, rate: 0.0003 }];
  writeNDJSON(config.DATA.paths.funding, 'BTCUSDT_8h.ndjson', records);
  const map = loadFundingMap('BTCUSDT');
  assert(Math.abs(map.get(1000000) - 0.0001) < 0.000001, 'rate should be 0.0001');
  assert(map.size === 2, 'map should have 2 entries');
});

// ── downloader tests ──────────────────────────────────────────────────────────

const { getLastTimestamp } = require('../src/data/downloader');

test('getLastTimestamp returns null for missing file', () => {
  const result = getLastTimestamp('/nonexistent_xyz.ndjson');
  assert(result === null, 'should be null');
});

test('getLastTimestamp returns last openTime', () => {
  const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
  const p = writeNDJSON(config.DATA.paths.historical, 'TEST_last.ndjson', candles);
  const result = getLastTimestamp(p);
  assert(result === 3000, 'should return 3000');
});

test('getLastTimestamp returns null for empty file', () => {
  const p = path.join(config.DATA.paths.historical, 'TEST_empty.ndjson');
  fs.writeFileSync(p, '');
  const result = getLastTimestamp(p);
  assert(result === null, 'should be null for empty file');
});

// ── validator tests ───────────────────────────────────────────────────────────

const { readNDJSON, validateKlines, validateOI, validateFunding } = require('../src/data/validator');

test('readNDJSON returns empty array for missing file', () => {
  const result = readNDJSON('/nonexistent_xyz.ndjson');
  assert(Array.isArray(result) && result.length === 0);
});

test('readNDJSON parses records correctly', () => {
  const records = [{ a: 1 }, { b: 2 }];
  const p = writeNDJSON(config.DATA.paths.historical, 'TEST_read.ndjson', records);
  const result = readNDJSON(p);
  assert(result.length === 2);
  assert(result[0].a === 1);
});

test('validateKlines returns MISSING for non-existent file', () => {
  const result = validateKlines('NONEXISTENT', '1h');
  assert(result.status === 'MISSING', 'status should be MISSING');
});

test('validateKlines returns EMPTY for empty file', () => {
  const p = path.join(config.DATA.paths.historical, 'BTCUSDT_1h.ndjson');
  fs.writeFileSync(p, '');
  const result = validateKlines('BTCUSDT', '1h');
  assert(result.status === 'EMPTY', 'status should be EMPTY');
});

test('validateKlines detects zero-volume candles', () => {
  const candles = [makeCandle(1000, 100), makeCandle(2000, 0), makeCandle(3000, 100)];
  writeNDJSON(config.DATA.paths.historical, 'ETHUSDT_1h.ndjson', candles);
  const result = validateKlines('ETHUSDT', '1h');
  assert(result.zeroVolume === 1, 'should detect 1 zero-volume candle');
});

test('validateKlines detects large gaps', () => {
  const ms = 60 * 60 * 1000;
  const candles = [makeCandle(0), makeCandle(ms), makeCandle(7 * ms), makeCandle(8 * ms)];
  writeNDJSON(config.DATA.paths.historical, 'SOLUSDT_1h.ndjson', candles);
  const result = validateKlines('SOLUSDT', '1h');
  assert(result.maxGap >= 5, 'should detect gap of 5+ candles');
  assert(result.gaps.length > 0, 'should have gap entries');
});

test('validateOI returns MISSING for non-existent file', () => {
  const result = validateOI('NONEXISTENT');
  assert(result.status === 'MISSING');
});

test('validateOI returns WARNING for low record count', () => {
  writeNDJSON(config.DATA.paths.oi, 'BNBUSDT_1h.ndjson', [{ timestamp: 1000, oi: 500 }]);
  const result = validateOI('BNBUSDT');
  assert(result.status === 'WARNING', 'should be WARNING for 1 record');
});

test('validateFunding returns MISSING for non-existent file', () => {
  const result = validateFunding('NONEXISTENT');
  assert(result.status === 'MISSING');
});

test('validateFunding returns WARNING for low record count', () => {
  writeNDJSON(config.DATA.paths.funding, 'XRPUSDT_8h.ndjson', [{ timestamp: 1000, rate: 0.0001 }]);
  const result = validateFunding('XRPUSDT');
  assert(result.status === 'WARNING');
});

// ── streamNDJSON async test ───────────────────────────────────────────────────

async function runAsyncTests() {
  await testAsync('streamNDJSON streams candles in order', async () => {
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    const p = writeNDJSON(config.DATA.paths.historical, 'TEST_stream.ndjson', candles);
    const received = [];
    await streamNDJSON(p, c => received.push(c));
    assert(received.length === 3, 'should receive 3 candles');
    assert(received[0].openTime === 1000, 'first should be 1000');
    assert(received[2].openTime === 3000, 'last should be 3000');
  });

  await testAsync('streamNDJSON rejects on missing file', async () => {
    let threw = false;
    try {
      await streamNDJSON('/nonexistent_xyz.ndjson', () => {});
    } catch (e) {
      threw = true;
    }
    assert(threw, 'should throw on missing file');
  });

  await testAsync('streamNDJSON skips malformed lines', async () => {
    const p = path.join(config.DATA.paths.historical, 'TEST_malformed.ndjson');
    fs.writeFileSync(p, JSON.stringify(makeCandle(1000)) + '\nNOT_JSON\n' + JSON.stringify(makeCandle(2000)) + '\n');
    const received = [];
    await streamNDJSON(p, c => received.push(c));
    assert(received.length === 2, 'should skip malformed line');
  });

  // Summary
  console.log('\n' + passed + '/' + (passed + failed) + ' tests passed');
  if (failed > 0) {
    console.log(failed + ' tests FAILED');
    process.exit(1);
  } else {
    console.log('Phase D1 tests: ALL PASS');
  }

  // Cleanup
  fs.rmSync(TMP, { recursive: true, force: true });
}

runAsyncTests().catch(e => {
  console.error('Test runner error:', e.message);
  process.exit(1);
});
