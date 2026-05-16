'use strict';

/**
 * BulletBrain v3.0 — Macro Event Tagger Tests
 * Phase D5
 */

const { isInBlackout, tagCandlesWithBlackout, calcBlackoutStats, loadMacroEvents } = require('../src/utils/macroTagger');

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertClose(a, b, tol = 0.001, msg) {
  if (Math.abs(a - b) > tol) throw new Error(msg || `expected ${b}, got ${a}`);
}

// ── Use inline test events (not the file) for deterministic tests ─────────────

const TEST_EVENTS = [
  {
    event: 'CPI',
    date: '2023-01-12',
    timestamp: new Date('2023-01-12T13:30:00Z').getTime(),
    blackout_before_min: 60,
    blackout_after_min: 15,
  },
  {
    event: 'FOMC',
    date: '2023-02-01',
    timestamp: new Date('2023-02-01T19:00:00Z').getTime(),
    blackout_before_min: 60,
    blackout_after_min: 90,
  },
  {
    event: 'NFP',
    date: '2023-01-06',
    timestamp: new Date('2023-01-06T13:30:00Z').getTime(),
    blackout_before_min: 60,
    blackout_after_min: 15,
  },
];

const CPI_TS   = TEST_EVENTS[0].timestamp; // 2023-01-12 13:30 UTC
const FOMC_TS  = TEST_EVENTS[1].timestamp; // 2023-02-01 19:00 UTC
const NFP_TS   = TEST_EVENTS[2].timestamp; // 2023-01-06 13:30 UTC

// ── isInBlackout tests ────────────────────────────────────────────────────────
console.log('\n── isInBlackout ──');

test('Returns inBlackout=true at exact event timestamp', () => {
  const result = isInBlackout(CPI_TS, TEST_EVENTS);
  assert(result.inBlackout === true, 'Should be in blackout at event time');
  assert(result.event === 'CPI', `Expected CPI, got ${result.event}`);
});

test('Returns inBlackout=true 30 min before event', () => {
  const ts = CPI_TS - 30 * 60 * 1000; // 30 min before — within 60 min window
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === true, 'Should be in blackout 30 min before (within 60 min window)');
});

test('Returns inBlackout=true 15 min after event', () => {
  const ts = CPI_TS + 15 * 60 * 1000; // 15 min after — within 15 min window
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === true, 'Should be in blackout 15 min after');
});

test('Returns inBlackout=false 61 min before event', () => {
  const ts = CPI_TS - 61 * 60 * 1000; // 61 min before — outside 60 min window
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === false, 'Should NOT be in blackout 61 min before');
});

test('Returns inBlackout=false 16 min after event', () => {
  const ts = CPI_TS + 16 * 60 * 1000; // 16 min after — outside 15 min window
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === false, 'Should NOT be in blackout 16 min after');
});

test('FOMC: still in blackout 60 min after (press conference window)', () => {
  const ts = FOMC_TS + 60 * 60 * 1000; // 60 min after FOMC — within 90 min window
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === true, 'FOMC should still be blacked out 60 min after (press conference)');
});

test('FOMC: not in blackout 91 min after', () => {
  const ts = FOMC_TS + 91 * 60 * 1000; // 91 min after — outside 90 min window
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === false, 'FOMC should not be blacked out 91 min after');
});

test('Returns inBlackout=false for random non-event time', () => {
  const ts = new Date('2023-01-15T10:00:00Z').getTime(); // random time
  const result = isInBlackout(ts, TEST_EVENTS);
  assert(result.inBlackout === false, 'Random time should not be in blackout');
});

test('Correctly identifies FOMC event', () => {
  const result = isInBlackout(FOMC_TS, TEST_EVENTS);
  assert(result.inBlackout === true);
  assert(result.event === 'FOMC', `Expected FOMC, got ${result.event}`);
});

test('Correctly identifies NFP event', () => {
  const result = isInBlackout(NFP_TS, TEST_EVENTS);
  assert(result.inBlackout === true);
  assert(result.event === 'NFP', `Expected NFP, got ${result.event}`);
});

// ── tagCandlesWithBlackout tests ──────────────────────────────────────────────
console.log('\n── tagCandlesWithBlackout ──');

test('Tags candles correctly', () => {
  const candles = [
    { openTime: CPI_TS - 90 * 60 * 1000 },  // 90 min before — outside 60 min window
    { openTime: CPI_TS - 45 * 60 * 1000 },  // 45 min before — inside 60 min window
    { openTime: CPI_TS },                    // at event — in blackout
    { openTime: CPI_TS + 10 * 60 * 1000 },  // 10 min after — in blackout
    { openTime: CPI_TS + 20 * 60 * 1000 },  // 20 min after — outside 15 min window
  ];

  const tagged = tagCandlesWithBlackout(candles, TEST_EVENTS);

  assert(tagged[0].blackout === false, 'Candle 90min before should not be blacked out');
  assert(tagged[1].blackout === true,  'Candle 45min before should be blacked out (within 60 min)');
  assert(tagged[2].blackout === true,  'Candle at event should be blacked out');
  assert(tagged[3].blackout === true,  'Candle 10min after should be blacked out');
  assert(tagged[4].blackout === false, 'Candle 20min after should not be blacked out');
});

test('Tagged candles preserve original fields', () => {
  const candles = [{ openTime: CPI_TS, close: 50000, volume: 1000 }];
  const tagged  = tagCandlesWithBlackout(candles, TEST_EVENTS);
  assert(tagged[0].close === 50000, 'close should be preserved');
  assert(tagged[0].volume === 1000, 'volume should be preserved');
  assert(tagged[0].blackout === true, 'blackout should be added');
});

test('Returns same length as input', () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({
    openTime: CPI_TS + i * 15 * 60 * 1000,
  }));
  const tagged = tagCandlesWithBlackout(candles, TEST_EVENTS);
  assert(tagged.length === 100, 'Should return same length');
});

// ── calcBlackoutStats tests ───────────────────────────────────────────────────
console.log('\n── calcBlackoutStats ──');

test('Calculates correct blackout percentage', () => {
  const candles = [
    { blackout: true,  blackoutEvent: 'CPI' },
    { blackout: true,  blackoutEvent: 'CPI' },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
    { blackout: false, blackoutEvent: null },
  ];
  const stats = calcBlackoutStats(candles);
  assert(stats.total === 10, 'Total should be 10');
  assert(stats.blacked === 2, 'Blacked should be 2');
  assertClose(stats.pct, 20.0, 0.01, 'Pct should be 20%');
  assert(stats.byEvent.CPI === 2, 'CPI count should be 2');
});

// ── Real data validation ──────────────────────────────────────────────────────
console.log('\n── Real Data Validation ──');

test('macro_events.json loads without error', () => {
  const events = loadMacroEvents();
  assert(Array.isArray(events), 'Should be an array');
  assert(events.length > 0, 'Should have events');
});

test('macro_events.json has all 3 event types', () => {
  const events = loadMacroEvents();
  const types  = new Set(events.map(e => e.event));
  assert(types.has('CPI'),  'Should have CPI events');
  assert(types.has('FOMC'), 'Should have FOMC events');
  assert(types.has('NFP'),  'Should have NFP events');
});

test('macro_events.json covers 2021-2024', () => {
  const events = loadMacroEvents();
  const years  = new Set(events.map(e => e.date.slice(0, 4)));
  assert(years.has('2021'), 'Should have 2021 events');
  assert(years.has('2022'), 'Should have 2022 events');
  assert(years.has('2023'), 'Should have 2023 events');
  assert(years.has('2024'), 'Should have 2024 events');
});

test('macro_events.json has reasonable event count (>100)', () => {
  const events = loadMacroEvents();
  assert(events.length > 100, `Expected > 100 events, got ${events.length}`);
});

test('All events have required fields', () => {
  const events = loadMacroEvents();
  events.forEach((e, i) => {
    assert(e.event,                `Event ${i} missing event type`);
    assert(e.timestamp > 0,        `Event ${i} missing timestamp`);
    assert(e.blackout_before_min,  `Event ${i} missing blackout_before_min`);
    assert(e.blackout_after_min,   `Event ${i} missing blackout_after_min`);
  });
});

test('All timestamps are in 2021-2024 range', () => {
  const events = loadMacroEvents();
  const start  = new Date('2021-01-01').getTime();
  const end    = new Date('2024-12-31T23:59:59Z').getTime();
  events.forEach((e, i) => {
    assert(e.timestamp >= start && e.timestamp <= end,
      `Event ${i} (${e.date}) timestamp out of 2021-2024 range`);
  });
});

test('Blackout windows are correct per event type', () => {
  const events = loadMacroEvents();
  events.forEach((e, i) => {
    assert(e.blackout_before_min === 60, `Event ${i} blackout_before should be 60`);
    if (e.event === 'FOMC') {
      assert(e.blackout_after_min === 90, `FOMC event ${i} blackout_after should be 90`);
    } else {
      assert(e.blackout_after_min === 15, `${e.event} event ${i} blackout_after should be 15`);
    }
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + passed + '/' + (passed + failed) + ' macro tests passed');
if (failed > 0) {
  console.log(failed + ' FAILED');
  process.exit(1);
} else {
  console.log('Phase D5 macro tagger: ALL PASS');
}
