const fs = require('fs');
let f = fs.readFileSync('src/live/liveRunner.js', 'utf8');

// 1. Add pendingOrder state
f = f.replace(
  "let openTrade = null;",
  "let openTrade = null;       // ACTIVE trade (limit filled, SL/TP placed)\nlet pendingOrder = null;    // PENDING limit order (not yet filled)"
);

// 2. Add pendingOrder check before openTrade check
const oldTradeCheck = `  if (openTrade) {`;
const newTradeCheck = `  // Check pending order — verify limit entry filled before placing SL/TP
  if (pendingOrder) {
    const po = pendingOrder;
    if (i - po.idx >= 3) {
      console.log('[ORDER] Timeout cancelling ' + po.side + ' limit @ $' + po.entry.toFixed(0));
      await cancelOrder(po.orderId);
      pendingOrder = null;
    } else {
      const filled = await checkOrderFilled(po.orderId);
      if (filled) {
        console.log('[ORDER] Filled: ' + po.side + ' @ $' + po.entry.toFixed(0));
        await placeSLTP(po.side === 'LONG' ? 'BUY' : 'SELL', po.stop, po.tp, po.risk / po.stopDist);
        openTrade = { side: po.side, entry: po.entry, stop: po.stop, tp: po.tp, risk: po.risk, idx: po.idx, regime: po.regime };
        pendingOrder = null;
        console.log('[🔥 ENTRY] LIVE ' + openTrade.side + ' @ $' + openTrade.entry.toFixed(0) + ' | Risk: $' + openTrade.risk.toFixed(2));
      }
    }
  }

  if (openTrade) {`;
f = f.replace(oldTradeCheck, newTradeCheck);

// 3. Block new signals when pendingOrder exists
f = f.replace('  if (openTrade) return;', '  if (openTrade || pendingOrder) return;');

// 4. Replace LONG order placement (3 orders → limit only)
const oldLong = `      const riskAmt = equity * RISK_PCT;
      openTrade = { side: 'LONG', entry, stop, tp, risk: riskAmt, idx: i, regime };
      if (LIVE_MODE && !isScanning) {
        const qty = riskAmt / (entry * (stopDist / entry));
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'LIMIT', price: entry.toFixed(2), quantity: qty.toFixed(4), timeInForce: 'GTC' }, true);
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'STOP_MARKET', stopPrice: stop.toFixed(2), closePosition: 'true' }, true);
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(2), closePosition: 'true' }, true);
      }
      console.log('[🔥 ENTRY] LONG @ $' + entry.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2) + ' | ' + regime);`;

const newLong = `      const riskAmt = equity * RISK_PCT;
      if (LIVE_MODE && !isScanning) {
        const qty = riskAmt / stopDist;
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'LIMIT', price: entry.toFixed(2), quantity: qty.toFixed(4), timeInForce: 'GTC' }, true);
        if (order) {
          pendingOrder = { side: 'LONG', entry, stop, tp, risk: riskAmt, stopDist, idx: i, regime, orderId: order.orderId };
          console.log('[ORDER] Placed LONG limit @ $' + entry.toFixed(0) + ' | Order #' + order.orderId + ' | Risk: $' + riskAmt.toFixed(2));
        }
      } else {
        openTrade = { side: 'LONG', entry, stop, tp, risk: riskAmt, idx: i, regime };
        console.log('[🔥 ENTRY] ' + (isScanning ? 'SCAN' : 'PAPER') + ' LONG @ $' + entry.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2) + ' | ' + regime);
      }`;
f = f.replace(oldLong, newLong);

// 5. Replace SHORT order placement
const oldShort = `      const riskAmt = equity * RISK_PCT;
      openTrade = { side: 'SHORT', entry, stop, tp, risk: riskAmt, idx: i, regime };
      if (LIVE_MODE && !isScanning) {
        const qty = riskAmt / (entry * (stopDist / entry));
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'LIMIT', price: entry.toFixed(2), quantity: qty.toFixed(4), timeInForce: 'GTC' }, true);
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'STOP_MARKET', stopPrice: stop.toFixed(2), closePosition: 'true' }, true);
        await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(2), closePosition: 'true' }, true);
      }
      console.log('[🔥 ENTRY] SHORT @ $' + entry.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2) + ' | ' + regime);`;

const newShort = `      const riskAmt = equity * RISK_PCT;
      if (LIVE_MODE && !isScanning) {
        const qty = riskAmt / stopDist;
        const order = await binanceRequest('POST', '/fapi/v1/order', { symbol: SYMBOL.toUpperCase(), side: 'SELL', type: 'LIMIT', price: entry.toFixed(2), quantity: qty.toFixed(4), timeInForce: 'GTC' }, true);
        if (order) {
          pendingOrder = { side: 'SHORT', entry, stop, tp, risk: riskAmt, stopDist, idx: i, regime, orderId: order.orderId };
          console.log('[ORDER] Placed SHORT limit @ $' + entry.toFixed(0) + ' | Order #' + order.orderId + ' | Risk: $' + riskAmt.toFixed(2));
        }
      } else {
        openTrade = { side: 'SHORT', entry, stop, tp, risk: riskAmt, idx: i, regime };
        console.log('[🔥 ENTRY] ' + (isScanning ? 'SCAN' : 'PAPER') + ' SHORT @ $' + entry.toFixed(0) + ' | Risk: $' + riskAmt.toFixed(2) + ' | ' + regime);
      }`;
f = f.replace(oldShort, newShort);

// 6. Reset pendingOrder on state reset
f = f.replace('  openTrade = null;', '  openTrade = null;\n  pendingOrder = null;');

fs.writeFileSync('src/live/liveRunner.js', f);
console.log('All 6 patches applied successfully');
