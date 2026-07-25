const fs = require('fs');
let f = fs.readFileSync('src/live/liveRunner.js', 'utf8');

// Fix 1: sign() — add _qs field, binanceRequest — use raw URL
f = f.replace(
`function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  return params;
}

async function binanceRequest(method, path, params = {}, signed = false) {
  if (signed) params = sign({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  try {
    const resp = await axios({ method, url: BASE_URL + path, params,
      headers: signed ? { 'X-MBX-APIKEY': API_KEY } : {}, timeout: 10000,`,
`function sign(params) {
  const qs = Object.keys(params).sort().map(k => k + '=' + params[k]).join('&');
  params.signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
  params._qs = qs + '&signature=' + params.signature; // raw query for URL
  return params;
}

async function binanceRequest(method, path, params = {}, signed = false) {
  if (signed) params = sign({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  try {
    const url = signed ? BASE_URL + path + '?' + params._qs : BASE_URL + path;
    const resp = await axios({ method, url, params: signed ? undefined : params,
      headers: signed ? { 'X-MBX-APIKEY': API_KEY } : {}, timeout: 10000,`
);

// Fix 2: declare found before BULL/BEAR blocks (was only in BULL, BEAR crashed on it)
f = f.replace(
`  if (regime === 'BULL') {
    const pools = detectPools('LONG');
    let found = false;`,
`  let found = false;
  if (regime === 'BULL') {
    const pools = detectPools('LONG');`
);

fs.writeFileSync('src/live/liveRunner.js', f);
console.log('Applied both fixes');
