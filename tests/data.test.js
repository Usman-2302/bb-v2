'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Use a temp directory for all file operations in tests
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-test-'));

// Patch DATA paths to use temp dir
jest.mock('../config', () => {
  const real = jest.requireActual('../config');
  return {
    ...real,
    DATA: {
      ...real.DATA,
      paths: {
        historical: path.join(TMP, 'historical'),
        oi:         path.join(TMP, 'oi'),
        funding:    path.join(TMP, 'funding'),
        results:    path.join(TMP, 'results'),
        logs:       path.join(TMP, 'logs'),
      },
    },
  };
});

const { readNDJSON, validateKlines, validateOI, validateFunding } = require('../src/data/validator');
const { streamNDJSON, loadNDJSON, loadOIMap, loadFundingMap }     = require('../src/data/loader');
const { getLastTimestamp }                                         = require('../src/data/downloader');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpFile(subdir, filename, lines) {
  const dir = path.join(TMP, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

function makeCandle(openTime, volume = 100) {
  return {
    openTime,
    open:  50000,
    high:  51000,
    low:   49000,
    close: 50500,
    volume,
    closeTime: openTime + 3599999,
    trades: 1000,
  };
}

// ─── loader.js tests ─────────────────────────────────────────────────────────

describe('loader — streamNDJSON', () => {
  test('streams candles in order', async () => {
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    const filePath = makeTmpFile('historical', 'TEST_stream.ndjson',
      candles.map(c => JSON.stringify(c)));

    const received = [];
    await streamNDJSON(filePath, c => received.push(c));

    expect(received).toHaveLength(3);
    expect(received[0].openTime).toBe(1000);
    expect(received[2].openTime).toBe(3000);
  });

  test('rejects on missing file', async () => {
    await expect(streamNDJSON('/nonexistent/file.ndjson', () => {}))
      .rejects.toThrow('File not found');
  });

  test('skips malformed lines', async () => {
    const filePath = makeTmpFile('historical', 'TEST_malformed.ndjson', [
      JSON.stringify(makeCandle(1000)),
      'NOT_VALID_JSON',
      JSON.stringify(makeCandle(2000)),
    ]);

    const received = [];
    await streamNDJSON(filePath, c => received.push(c));
    expect(received).toHaveLength(2);
  });
});

describe('loader — loadNDJSON', () => {
  test('loads all records', () => {
    const candles = [makeCandle(1000), makeCandle(2000)];
    const filePath = makeTmpFile('historical', 'TEST_load.ndjson',
      candles.map(c => JSON.stringify(c)));

    const result = loadNDJSON(filePath);
    expect(result).toHaveLength(2);
  });

  test('returns empty array for missing file', () => {
    expect(loadNDJSON('/nonexistent.ndjson')).toEqual([]);
  });
});

describe('loader — loadOIMap', () => {
  test('builds timestamp → oi map', () => {
    const records = [
      { timestamp: 1000000, oi: 500.5 },
      { timestamp: 2000000, oi: 600.0 },
    ];
    makeTmpFile('oi', 'BTCUSDT_1h.ndjson', records.map(r => JSON.stringify(r)));

    const map = loadOIMap('BTCUSDT');
    expect(map.get(1000000)).toBe(500.5);
    expect(map.get(2000000)).toBe(600.0);
    expect(map.size).toBe(2);
  });
});

describe('loader — loadFundingMap', () => {
  test('builds timestamp → rate map', () => {
    const records = [
      { timestamp: 1000000, rate: 0.0001 },
      { timestamp: 2000000, rate: 0.0003 },
    ];
    makeTmpFile('funding', 'BTCUSDT_8h.ndjson', records.map(r => JSON.stringify(r)));

    const map = loadFundingMap('BTCUSDT');
    expect(map.get(1000000)).toBeCloseTo(0.0001);
    expect(map.get(2000000)).toBeCloseTo(0.0003);
  });
});

// ─── downloader.js tests ─────────────────────────────────────────────────────

describe('downloader — getLastTimestamp', () => {
  test('returns null for missing file', () => {
    expect(getLastTimestamp('/nonexistent.ndjson')).toBeNull();
  });

  test('returns last openTime from NDJSON file', () => {
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    const filePath = makeTmpFile('historical', 'TEST_last.ndjson',
      candles.map(c => JSON.stringify(c)));

    expect(getLastTimestamp(filePath)).toBe(3000);
  });

  test('returns null for empty file', () => {
    const filePath = makeTmpFile('historical', 'TEST_empty.ndjson', []);
    expect(getLastTimestamp(filePath)).toBeNull();
  });
});

// ─── validator.js tests ───────────────────────────────────────────────────────

describe('validator — validateKlines', () => {
  test('returns MISSING for non-existent file', () => {
    const result = validateKlines('NONEXISTENT', '1h');
    expect(result.status).toBe('MISSING');
    expect(result.exists).toBe(false);
  });

  test('returns EMPTY for empty file', () => {
    makeTmpFile('historical', 'BTCUSDT_1h.ndjson', []);
    const result = validateKlines('BTCUSDT', '1h');
    expect(result.status).toBe('EMPTY');
  });

  test('detects zero-volume candles', () => {
    const candles = [
      makeCandle(1000, 100),
      makeCandle(2000, 0),    // zero volume
      makeCandle(3000, 100),
    ];
    makeTmpFile('historical', 'ETHUSDT_1h.ndjson', candles.map(c => JSON.stringify(c)));

    const result = validateKlines('ETHUSDT', '1h');
    expect(result.zeroVolume).toBe(1);
  });

  test('detects gaps > 2 candles', () => {
    const intervalMs = 60 * 60 * 1000; // 1h
    const candles = [
      makeCandle(0 * intervalMs),
      makeCandle(1 * intervalMs),
      // gap of 5 candles
      makeCandle(7 * intervalMs),
      makeCandle(8 * intervalMs),
    ];
    makeTmpFile('historical', 'SOLUSDT_1h.ndjson', candles.map(c => JSON.stringify(c)));

    const result = validateKlines('SOLUSDT', '1h');
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.maxGap).toBeGreaterThanOrEqual(5);
  });
});

describe('validator — validateOI', () => {
  test('returns MISSING for non-existent file', () => {
    const result = validateOI('NONEXISTENT');
    expect(result.status).toBe('MISSING');
  });

  test('returns WARNING for low record count', () => {
    const records = [{ timestamp: 1000, oi: 500 }];
    makeTmpFile('oi', 'BNBUSDT_1h.ndjson', records.map(r => JSON.stringify(r)));

    const result = validateOI('BNBUSDT');
    expect(result.status).toBe('WARNING');
    expect(result.records).toBe(1);
  });
});

describe('validator — validateFunding', () => {
  test('returns MISSING for non-existent file', () => {
    const result = validateFunding('NONEXISTENT');
    expect(result.status).toBe('MISSING');
  });

  test('returns WARNING for low record count', () => {
    const records = [{ timestamp: 1000, rate: 0.0001 }];
    makeTmpFile('funding', 'XRPUSDT_8h.ndjson', records.map(r => JSON.stringify(r)));

    const result = validateFunding('XRPUSDT');
    expect(result.status).toBe('WARNING');
  });
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
