'use strict';

/**
 * BulletBrain v3.0 — Volume Profile (24H Rolling)
 * Phase D2 — Step 0.3
 *
 * 50 price buckets across the 24H high-low range.
 * For each candle, distribute volume proportionally across touched buckets.
 * HVN = High Volume Node (bucket with most volume)
 * LVN = Low Volume Node (bucket with least volume)
 * POC = Point of Control = HVN price level
 *
 * Source: backtestplan.md lines 174-182
 */

function buildVolumeProfile(candles, buckets = 50) {
  if (!candles || candles.length === 0) {
    return { hvn: 0, lvn: 0, poc: 0, buckets: [] };
  }

  let priceMin = Infinity;
  let priceMax = -Infinity;

  for (const c of candles) {
    if (c.low  < priceMin) priceMin = c.low;
    if (c.high > priceMax) priceMax = c.high;
  }

  if (priceMin === priceMax) {
    return {
      hvn: priceMin,
      lvn: priceMin,
      poc: priceMin,
      buckets: [{ priceMin, priceMax, priceMid: priceMin, volume: candles.reduce((s, c) => s + c.volume, 0) }],
    };
  }

  const bucketSize = (priceMax - priceMin) / buckets;

  const profile = Array.from({ length: buckets }, (_, i) => ({
    priceMin: priceMin + i * bucketSize,
    priceMax: priceMin + (i + 1) * bucketSize,
    priceMid: priceMin + (i + 0.5) * bucketSize,
    volume: 0,
  }));

  for (const c of candles) {
    const candleRange = c.high - c.low;
    if (candleRange === 0) continue;

    for (let b = 0; b < buckets; b++) {
      const bMin = profile[b].priceMin;
      const bMax = profile[b].priceMax;

      const overlapMin = Math.max(c.low, bMin);
      const overlapMax = Math.min(c.high, bMax);

      if (overlapMax > overlapMin) {
        const overlap = overlapMax - overlapMin;
        profile[b].volume += c.volume * (overlap / candleRange);
      }
    }
  }

  let hvnIdx = 0;
  let lvnIdx = 0;
  let maxVol = -Infinity;
  let minVol = Infinity;

  for (let b = 0; b < buckets; b++) {
    if (profile[b].volume > maxVol) {
      maxVol = profile[b].volume;
      hvnIdx = b;
    }
    if (profile[b].volume > 0 && profile[b].volume < minVol) {
      minVol = profile[b].volume;
      lvnIdx = b;
    }
  }

  return {
    hvn: profile[hvnIdx].priceMid,
    lvn: profile[lvnIdx].priceMid,
    poc: profile[hvnIdx].priceMid,
    buckets: profile,
  };
}

function rollingVolumeProfile(candles, interval = '1h', windowHours = 24, buckets = 50) {
  if (!candles || candles.length === 0) return [];

  const candlesPerHour = {
    '15m': 4,
    '1h': 1,
    '4h': 0.25,
    '1d': 1 / 24,
  };

  const cph = candlesPerHour[interval] || 1;
  const windowSize = Math.round(windowHours * cph);

  return candles.map((_, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const window = candles.slice(start, i + 1);
    return buildVolumeProfile(window, buckets);
  });
}

function computeValueArea(profile) {
  if (!profile || !profile.buckets || profile.buckets.length === 0) {
    return { vah: 0, val: 0, poc: 0 };
  }

  const totalVol = profile.buckets.reduce((s, b) => s + b.volume, 0);
  if (totalVol === 0) return { vah: profile.hvn, val: profile.hvn, poc: profile.hvn };

  let pocIdx = 0;
  let maxVol = -Infinity;
  for (let i = 0; i < profile.buckets.length; i++) {
    if (profile.buckets[i].volume > maxVol) {
      maxVol = profile.buckets[i].volume;
      pocIdx = i;
    }
  }

  const targetVol = totalVol * 0.70;
  let capturedVol = profile.buckets[pocIdx].volume;
  let lower = pocIdx;
  let upper = pocIdx;

  while (capturedVol < targetVol && (lower > 0 || upper < profile.buckets.length - 1)) {
    const lowerVol = lower > 0 ? profile.buckets[lower - 1].volume : -1;
    const upperVol = upper < profile.buckets.length - 1 ? profile.buckets[upper + 1].volume : -1;

    if (lowerVol >= upperVol && lower > 0) {
      lower--;
      capturedVol += profile.buckets[lower].volume;
    } else if (upper < profile.buckets.length - 1) {
      upper++;
      capturedVol += profile.buckets[upper].volume;
    } else {
      break;
    }
  }

  return {
    vah: profile.buckets[upper].priceMax,
    val: profile.buckets[lower].priceMin,
    poc: profile.poc,
  };
}

module.exports = { buildVolumeProfile, rollingVolumeProfile, computeValueArea };
