require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BASE_URL = 'https://fapi.binance.com';

function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  return qs + '&signature=' + signature;
}

async function signedRequest(path, params) {
  const qs = sign({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const resp = await axios.get(BASE_URL + path + '?' + qs, {
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  return resp.data;
}

async function main() {
  // Get user trades for TP order
  console.log('=== TP ORDER TRADES (orderId: 8389766243693620000) ===');
  const tpTrades = await signedRequest('/fapi/v1/userTrades', { symbol: 'ETHUSDT', orderId: '8389766243693620000' });
  tpTrades.forEach(t => console.log(JSON.stringify(t, null, 2)));

  // Get recent trades
  console.log('\n=== RECENT TRADES (last 10) ===');
  const recent = await signedRequest('/fapi/v1/userTrades', { symbol: 'ETHUSDT', limit: 10 });
  recent.forEach(t => console.log(JSON.stringify(t, null, 2)));

  // Get funding fees in last 2 hours
  console.log('\n=== FUNDING FEES (last 2 hours) ===');
  const startTime = Date.now() - 2 * 60 * 60 * 1000;
  const funding = await signedRequest('/fapi/v1/income', { symbol: 'ETHUSDT', incomeType: 'FUNDING_FEE', startTime, limit: 100 });
  funding.forEach(f => console.log(JSON.stringify(f, null, 2)));
}

main().catch(e => console.error(e.response?.data || e.message));