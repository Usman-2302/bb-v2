const axios = require('axios');
axios.get('https://fapi.binance.com/fapi/v1/klines', {
  params: { symbol: 'ETHUSDT', interval: '15m', limit: 3 }
}).then(r => {
  r.data.forEach(k => {
    console.log('open:', new Date(k[0]).toISOString(), 'vol:', k[5], 'close:', k[4]);
  });
}).catch(e => console.error(e.message));