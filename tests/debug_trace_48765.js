'use strict';
/**
 * Trace exactly what happens at candle 48765 in the runner.
 * Monkey-patch createTrade to log when it's called with entryCandle=48765.
 */
const engine = require('../src/backtest/engine');
const origCreateTrade = engine.createTrade;
let callCount = 0;
engine.createTrade = function(params) {
  if (params.entryCandle === 48765) {
    callCount++;
    console.log(`createTrade called for candle 48765 (call #${callCount})`);
    console.trace('Stack trace:');
  }
  return origCreateTrade(params);
};

const { runLSOBacktest, LSO_GATES } = require('../src/backtest/lso_runner');
const { loadNDJSON } = require('../src/data/loader');
const { atr } = require('../src/indicators/atr');
const { rvol } = require('../src/indicators/rvol');
const { cvd } = require('../src/indicators/cvd');
const { DATA } = require('../config');
const path = require('path');

const candles = loadNDJSON(path.join(DATA.paths.historical, 'BTCUSDT_15m_tagged.ndjson'));
const atr14 = atr(candles, 14);
const rvolVals = rvol(candles, '15m', 20);
const cvdVals = cvd(candles);

const report = runLSOBacktest({
  candles, atr14, rvolVals, cvdVals,
  oiDataStore: new Map(), fundingMap: new Map(), macroEvents: [],
  initialCapital: 10000, symbol: 'BTCUSDT', timeframe: '15m',
  cvdGateVariant: 'CVD_ZSCORE', obConfluenceEnabled: false,
  timeBreakevenEnabled: false, gates: LSO_GATES.NO_OI,
});

console.log('\nTotal createTrade calls for candle 48765:', callCount);
const at48765 = report.tradeLog.filter(t => t.entryCandle === 48765);
console.log('Trades in tradeLog with entryCandle=48765:', at48765.length);
