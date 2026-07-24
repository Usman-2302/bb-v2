const axios = require('axios');
axios.get('https://fapi.binance.com/fapi/v1/klines', {
  params: { symbol: 'ETHUSDT', interval: '15m', limit: 2 }
}).then(r => {
  const now = Date.now();
  r.data.forEach(k => {
    console.log('open:', new Date(k[0]).toISOString());
    console.log('close:', new Date(k[6]).toISOString());
    console.log('now:  ', new Date(now).toISOString());
    console.log('k[6] > now:', k[6] > now);
    console.log('open+15m:', new Date(k[0] + 15*60*1000).toISOString());
    console.log('---');
  });
}).catch(e => console.error(e.message));