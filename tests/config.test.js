'use strict';

const config = require('../config');

describe('config.js — Phase D0 validation', () => {

  test('all required top-level keys exist', () => {
    const required = [
      'DATA', 'EXECUTION_PARAMS', 'TICK_SIZES', 'COSTS',
      'REGIME', 'SIZING', 'FVG', 'OB', 'LSO', 'VPB',
      'DOL', 'RVOL', 'SESSIONS', 'TRADE', 'MACRO', 'ENGINE', 'MONITORING',
    ];
    required.forEach(key => {
      expect(config).toHaveProperty(key);
    });
  });

  test('DATA.coins has exactly 5 entries', () => {
    expect(config.DATA.coins).toHaveLength(5);
    expect(config.DATA.coins).toContain('BTCUSDT');
    expect(config.DATA.coins).toContain('ETHUSDT');
  });

  test('DATA.timeframes has 4 entries', () => {
    expect(config.DATA.timeframes).toHaveLength(4);
  });

  test('EXECUTION_PARAMS has entry for every coin', () => {
    config.DATA.coins.forEach(coin => {
      expect(config.EXECUTION_PARAMS).toHaveProperty(coin);
      expect(config.EXECUTION_PARAMS[coin]).toHaveProperty('baseSlippage');
      expect(config.EXECUTION_PARAMS[coin]).toHaveProperty('killzoneSlippage');
      expect(config.EXECUTION_PARAMS[coin]).toHaveProperty('crisisSlippage');
    });
  });

  test('TICK_SIZES has entry for every coin', () => {
    config.DATA.coins.forEach(coin => {
      expect(config.TICK_SIZES).toHaveProperty(coin);
      expect(config.TICK_SIZES[coin]).toBeGreaterThan(0);
    });
  });

  test('COSTS.fill_rate has entry for all strategies', () => {
    ['FVG', 'OB', 'LSO', 'VPB', 'CVD'].forEach(s => {
      expect(config.COSTS.fill_rate).toHaveProperty(s);
      const rate = config.COSTS.fill_rate[s];
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(1);
    });
  });

  test('COSTS.fill_rate values are realistic (< 85%)', () => {
    Object.values(config.COSTS.fill_rate).forEach(rate => {
      expect(rate).toBeLessThan(0.85);  // 85% flat is wrong — all should be lower
    });
  });

  test('SIZING hard caps are consistent', () => {
    expect(config.SIZING.minRisk).toBeLessThan(config.SIZING.maxRisk);
    expect(config.SIZING.maxRisk).toBeLessThan(config.SIZING.absoluteMaxRisk);
    expect(config.SIZING.absoluteMaxRisk).toBeLessThanOrEqual(0.02);
  });

  test('SIZING.maxPortfolioRisk <= 3%', () => {
    expect(config.SIZING.maxPortfolioRisk).toBeLessThanOrEqual(0.03);
  });

  test('FVG config has all required fields', () => {
    ['bodyMultiplier', 'rvolThreshold', 'validityCandles', 'stopBuffer', 'minGapSize'].forEach(f => {
      expect(config.FVG).toHaveProperty(f);
    });
    expect(config.FVG.validityCandles).toBe(288); // 72h × 4 × 15m candles (migrated from 1H)
  });

  test('OB config has all required fields', () => {
    ['moveMultiplier', 'rvolThreshold', 'validityCandles', 'stopBuffer'].forEach(f => {
      expect(config.OB).toHaveProperty(f);
    });
    expect(config.OB.validityCandles).toBe(48);
  });

  test('LSO oiFlushThreshold has all 4 regimes', () => {
    ['BULL', 'BEAR', 'RANGING', 'CRISIS'].forEach(r => {
      expect(config.LSO.oiFlushThreshold).toHaveProperty(r);
      expect(config.LSO.oiFlushThreshold[r]).toBeGreaterThan(0);
    });
    // BEAR threshold must be stricter than BULL
    expect(config.LSO.oiFlushThreshold.BEAR).toBeGreaterThan(config.LSO.oiFlushThreshold.BULL);
  });

  test('DOL config has all required fields', () => {
    expect(config.DOL.minTouches).toBeGreaterThanOrEqual(2);
    expect(config.DOL.minRR).toBeGreaterThanOrEqual(1.8);
    expect(config.DOL.lookback).toBeGreaterThanOrEqual(50);
  });

  test('SESSIONS asian hard gates include FVG and OB', () => {
    expect(config.SESSIONS.asianDisabled).toContain('FVG');
    expect(config.SESSIONS.asianDisabled).toContain('OB');
    expect(config.SESSIONS.asianAllowed).toContain('LSO');
  });

  test('REGIME crisis ATR threshold is 5%', () => {
    expect(config.REGIME.crisisATRpct).toBe(5.0);
  });

  test('ENGINE acceptance minTradesPerRegime is 30', () => {
    expect(config.ENGINE.acceptance.minTradesPerRegime).toBe(30);
  });

  test('ENGINE walkForward has 5 windows', () => {
    expect(config.ENGINE.walkForward.windows).toBe(5);
  });

  test('SIZING correlationClusters covers all 5 coins', () => {
    const allCoins = [
      ...config.SIZING.correlationClusters.A,
      ...config.SIZING.correlationClusters.B,
    ];
    config.DATA.coins.forEach(coin => {
      expect(allCoins).toContain(coin);
    });
  });

  test('no hardcoded values — all numeric params are numbers', () => {
    expect(typeof config.FVG.bodyMultiplier).toBe('number');
    expect(typeof config.OB.moveMultiplier).toBe('number');
    expect(typeof config.LSO.equalTolerance).toBe('number');
    expect(typeof config.REGIME.slopeThreshold).toBe('number');
  });
});
