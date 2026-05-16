'use strict';

const { ema, emaSlopeDegrees }              = require('../src/indicators/ema');
const { atr, atrPct, trueRange }            = require('../src/indicators/atr');
const { rvol, getTimeSlot }                 = require('../src/indicators/rvol');
const { cvd, cvdDeltaCandle, isSweepCandle } = require('../src/indicators/cvd');
const { swingHL, getSwingHighs, getSwingLows } = require('../src/indicators/swingHL');
const { buildVolumeProfile, rollingVolumeProfile } = require('../src/indicators/volumeProfile');
const { efficiencyRatio, rollingEfficiencyRatio }  = require('../src/indicators/efficiencyRatio');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandle(close, high, low, open, volume = 1000, openTime = 0) {
  return { openTime, open: open ?? close, high, low, close, volume };
}

function flatCandles(n, price = 100, volume = 1000) {
  return Array.from({ length: n }, (_, i) =>
    makeCandle(price, price + 1, price - 1, price, volume, i * 3600000)
  );
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

describe('ema', () => {
  test('returns same length as input', () => {
    const closes = [10, 11, 12, 13, 14, 15];
    expect(ema(closes, 3)).toHaveLength(6);
  });

  test('first value equals first close', () => {
    const closes = [50000, 51000, 49000];
    expect(ema(closes, 3)[0]).toBe(50000);
  });

  test('EMA(1) equals the input', () => {
    const closes = [10, 20, 30, 40];
    const result = ema(closes, 1);
    result.forEach((v, i) => expect(v).toBeCloseTo(closes[i], 5));
  });

  test('EMA smooths values', () => {
    const closes = [10, 10, 10, 10, 20]; // spike at end
    const result = ema(closes, 3);
    // EMA should be between 10 and 20 at the end
    expect(result[4]).toBeGreaterThan(10);
    expect(result[4]).toBeLessThan(20);
  });

  test('returns empty array for empty input', () => {
    expect(ema([], 3)).toEqual([]);
  });

  test('throws for period <= 0', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow();
  });

  test('known EMA(3) calculation', () => {
    // k = 2/(3+1) = 0.5
    // EMA[0] = 10
    // EMA[1] = 20*0.5 + 10*0.5 = 15
    // EMA[2] = 30*0.5 + 15*0.5 = 22.5
    const result = ema([10, 20, 30], 3);
    expect(result[0]).toBeCloseTo(10, 5);
    expect(result[1]).toBeCloseTo(15, 5);
    expect(result[2]).toBeCloseTo(22.5, 5);
  });

  test('emaSlopeDegrees returns 0 for flat EMA', () => {
    const closes  = new Array(20).fill(100);
    const emaVals = ema(closes, 5);
    const slope   = emaSlopeDegrees(emaVals, 15, 10);
    expect(Math.abs(slope)).toBeLessThan(0.001);
  });

  test('emaSlopeDegrees positive for rising EMA', () => {
    const closes  = Array.from({ length: 30 }, (_, i) => 100 + i);
    const emaVals = ema(closes, 5);
    const slope   = emaSlopeDegrees(emaVals, 25, 10);
    expect(slope).toBeGreaterThan(0);
  });
});

// ─── ATR ─────────────────────────────────────────────────────────────────────

describe('atr', () => {
  test('returns same length as input', () => {
    const candles = flatCandles(20);
    expect(atr(candles, 14)).toHaveLength(20);
  });

  test('returns empty array for empty input', () => {
    expect(atr([], 14)).toEqual([]);
  });

  test('trueRange uses high-low when no gap', () => {
    const candle = makeCandle(100, 105, 95, 100);
    const tr = trueRange(candle, 100); // prevClose = 100 (no gap)
    expect(tr).toBe(10); // high - low = 10
  });

  test('trueRange uses gap when prevClose outside range', () => {
    const candle = makeCandle(100, 105, 95, 100);
    const tr = trueRange(candle, 80); // prevClose = 80 (gap down)
    // max(10, |105-80|, |95-80|) = max(10, 25, 15) = 25
    expect(tr).toBe(25);
  });

  test('ATR values are positive', () => {
    const candles = flatCandles(20, 100);
    const result  = atr(candles, 5);
    result.forEach(v => expect(v).toBeGreaterThan(0));
  });

  test('atrPct returns percentage of close', () => {
    const candles = flatCandles(20, 100); // high=101, low=99, close=100
    const result  = atrPct(candles, 5);
    // ATR ≈ 2 (high-low), ATR% ≈ 2%
    result.forEach(v => {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(10); // sanity check
    });
  });

  test('throws for period <= 0', () => {
    expect(() => atr(flatCandles(5), 0)).toThrow();
  });
});

// ─── RVOL ─────────────────────────────────────────────────────────────────────

describe('rvol', () => {
  test('returns same length as input', () => {
    const candles = flatCandles(50);
    expect(rvol(candles, '1h', 20)).toHaveLength(50);
  });

  test('returns 1.0 for candles with no baseline', () => {
    const candles = flatCandles(5);
    const result  = rvol(candles, '1h', 20);
    expect(result[0]).toBe(1.0);
  });

  test('returns empty array for empty input', () => {
    expect(rvol([], '1h')).toEqual([]);
  });

  test('getTimeSlot returns correct slot for 1h', () => {
    const ts = new Date('2023-01-01T09:00:00Z').getTime();
    expect(getTimeSlot(ts, '1h')).toBe(9); // 9th hour
  });

  test('getTimeSlot returns correct slot for 15m', () => {
    const ts = new Date('2023-01-01T09:15:00Z').getTime();
    expect(getTimeSlot(ts, '15m')).toBe(37); // (9*60+15)/15 = 37
  });

  test('high volume candle gets RVOL > 1', () => {
    // Build 30 days of 1H candles with volume=100, then one with volume=500
    const candles = [];
    const baseTime = new Date('2023-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 30 * 24; i++) {
      candles.push(makeCandle(100, 101, 99, 100, 100, baseTime + i * 3600000));
    }
    // Add a high-volume candle at the same hour slot as candle[0] (00:00)
    candles.push(makeCandle(100, 101, 99, 100, 500, baseTime + 30 * 24 * 3600000));

    const result = rvol(candles, '1h', 20);
    expect(result[result.length - 1]).toBeGreaterThan(1);
  });
});

// ─── CVD ─────────────────────────────────────────────────────────────────────

describe('cvd', () => {
  test('returns same length as input', () => {
    const candles = flatCandles(10);
    const result  = cvd(candles);
    expect(result.delta).toHaveLength(10);
    expect(result.cumulative).toHaveLength(10);
  });

  test('returns empty arrays for empty input', () => {
    const result = cvd([]);
    expect(result.delta).toEqual([]);
    expect(result.cumulative).toEqual([]);
  });

  test('bullish candle (close=high) has positive delta', () => {
    const c = makeCandle(105, 105, 95, 95, 1000); // close=high → all buy
    expect(cvdDeltaCandle(c)).toBeGreaterThan(0);
  });

  test('bearish candle (close=low) has negative delta', () => {
    const c = makeCandle(95, 105, 95, 105, 1000); // close=low → all sell
    expect(cvdDeltaCandle(c)).toBeLessThan(0);
  });

  test('doji (high=low) has zero delta', () => {
    const c = makeCandle(100, 100, 100, 100, 1000);
    expect(cvdDeltaCandle(c)).toBe(0);
  });

  test('cumulative CVD resets at new UTC day', () => {
    const day1 = new Date('2023-01-01T23:00:00Z').getTime();
    const day2 = new Date('2023-01-02T00:00:00Z').getTime();

    const candles = [
      makeCandle(105, 105, 95, 95, 1000, day1), // bullish → positive delta
      makeCandle(95, 105, 95, 105, 1000, day2),  // bearish → negative delta, new day
    ];

    const result = cvd(candles);
    // Day 2 candle should reset cumulative to just its own delta
    expect(result.cumulative[1]).toBeCloseTo(result.delta[1], 5);
  });

  test('isSweepCandle detects wick-dominated candles', () => {
    // Wick-dominated: body < 40% of range
    const sweep = makeCandle(104, 110, 95, 103); // body=1, range=15 → 6.7%
    expect(isSweepCandle(sweep)).toBe(true);

    // Body-dominated: body > 40% of range
    const normal = makeCandle(105, 110, 95, 95); // body=10, range=15 → 66.7%
    expect(isSweepCandle(normal)).toBe(false);
  });
});

// ─── SwingHL ─────────────────────────────────────────────────────────────────

describe('swingHL', () => {
  test('returns same length as input', () => {
    const candles = flatCandles(10);
    const result  = swingHL(candles, 2);
    expect(result.swingHighs).toHaveLength(10);
    expect(result.swingLows).toHaveLength(10);
  });

  test('detects a clear swing high', () => {
    const candles = [
      makeCandle(100, 100, 98, 100),
      makeCandle(101, 101, 99, 101),
      makeCandle(105, 110, 103, 105), // swing high
      makeCandle(102, 103, 100, 102),
      makeCandle(100, 101, 98, 100),
    ];
    const { swingHighs } = swingHL(candles, 2);
    expect(swingHighs[2]).toBe(true);
  });

  test('detects a clear swing low', () => {
    const candles = [
      makeCandle(100, 102, 98, 100),
      makeCandle(99, 101, 97, 99),
      makeCandle(95, 97, 90, 95),  // swing low
      makeCandle(98, 100, 96, 98),
      makeCandle(100, 102, 98, 100),
    ];
    const { swingLows } = swingHL(candles, 2);
    expect(swingLows[2]).toBe(true);
  });

  test('first and last lookback candles are never swing points', () => {
    const candles = flatCandles(10);
    const { swingHighs, swingLows } = swingHL(candles, 2);
    expect(swingHighs[0]).toBe(false);
    expect(swingHighs[1]).toBe(false);
    expect(swingHighs[9]).toBe(false);
    expect(swingLows[0]).toBe(false);
  });

  test('getSwingHighs returns correct price levels', () => {
    const candles = [
      makeCandle(100, 100, 98, 100),
      makeCandle(101, 101, 99, 101),
      makeCandle(105, 110, 103, 105),
      makeCandle(102, 103, 100, 102),
      makeCandle(100, 101, 98, 100),
    ];
    const highs = getSwingHighs(candles, 2);
    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(110);
    expect(highs[0].index).toBe(2);
  });

  test('returns empty arrays for empty input', () => {
    const result = swingHL([], 2);
    expect(result.swingHighs).toEqual([]);
    expect(result.swingLows).toEqual([]);
  });
});

// ─── Volume Profile ───────────────────────────────────────────────────────────

describe('volumeProfile', () => {
  test('buildVolumeProfile returns correct structure', () => {
    const candles = flatCandles(24, 100);
    const result  = buildVolumeProfile(candles, 50);
    expect(result).toHaveProperty('hvn');
    expect(result).toHaveProperty('lvn');
    expect(result).toHaveProperty('poc');
    expect(result).toHaveProperty('buckets');
    expect(result.buckets).toHaveLength(50);
  });

  test('POC equals HVN', () => {
    const candles = flatCandles(24, 100);
    const result  = buildVolumeProfile(candles, 50);
    expect(result.poc).toBe(result.hvn);
  });

  test('total volume in buckets equals total candle volume', () => {
    const candles = flatCandles(10, 100, 500);
    const result  = buildVolumeProfile(candles, 10);
    const totalBucketVol = result.buckets.reduce((s, b) => s + b.volume, 0);
    const totalCandleVol = candles.reduce((s, c) => s + c.volume, 0);
    expect(totalBucketVol).toBeCloseTo(totalCandleVol, 1);
  });

  test('HVN is within price range', () => {
    const candles = flatCandles(24, 100);
    const result  = buildVolumeProfile(candles, 50);
    const allHighs = candles.map(c => c.high);
    const allLows  = candles.map(c => c.low);
    expect(result.hvn).toBeGreaterThanOrEqual(Math.min(...allLows));
    expect(result.hvn).toBeLessThanOrEqual(Math.max(...allHighs));
  });

  test('rollingVolumeProfile returns same length as input', () => {
    const candles = flatCandles(48, 100);
    const result  = rollingVolumeProfile(candles, '1h', 24, 50);
    expect(result).toHaveLength(48);
  });

  test('handles empty input', () => {
    const result = buildVolumeProfile([], 50);
    expect(result.hvn).toBe(0);
    expect(result.buckets).toHaveLength(0);
  });
});

// ─── Efficiency Ratio ─────────────────────────────────────────────────────────

describe('efficiencyRatio', () => {
  test('returns 0 for insufficient data', () => {
    const candles = flatCandles(5);
    expect(efficiencyRatio(candles, 10)).toBe(0);
  });

  test('trending market has high ER', () => {
    // Perfectly trending: each close 1 higher than previous
    const candles = Array.from({ length: 15 }, (_, i) =>
      makeCandle(100 + i, 101 + i, 99 + i, 100 + i)
    );
    const er = efficiencyRatio(candles, 10);
    expect(er).toBeGreaterThan(0.9); // near 1.0 for perfect trend
  });

  test('choppy market has low ER', () => {
    // Alternating up/down: net movement is small, total path is large
    const candles = Array.from({ length: 15 }, (_, i) =>
      makeCandle(100 + (i % 2 === 0 ? 1 : -1), 102, 98, 100)
    );
    const er = efficiencyRatio(candles, 10);
    expect(er).toBeLessThan(0.3);
  });

  test('flat market has ER = 0', () => {
    const candles = flatCandles(15, 100);
    const er = efficiencyRatio(candles, 10);
    expect(er).toBe(0); // no directional move, no path
  });

  test('rollingEfficiencyRatio returns same length as input', () => {
    const candles = flatCandles(20);
    const result  = rollingEfficiencyRatio(candles, 10);
    expect(result).toHaveLength(20);
  });

  test('rollingEfficiencyRatio first period values are 0', () => {
    const candles = flatCandles(20);
    const result  = rollingEfficiencyRatio(candles, 10);
    for (let i = 0; i < 10; i++) {
      expect(result[i]).toBe(0);
    }
  });

  test('ER is between 0 and 1', () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + Math.sin(i) * 5, 106, 94, 100)
    );
    const result = rollingEfficiencyRatio(candles, 10);
    result.forEach(v => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });
});
