// netlify/functions/nse.js
// Fetches live NSE data from dev.kwayisi.org

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async () => {
  const now = Date.now();

  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ...cache.data, cached: true }) };
  }

  try {
    const res = await fetch('https://dev.kwayisi.org/apis/nse/live', {
      headers: { 'User-Agent': 'Mozilla/5.0 GlintTrade/1.0' }
    });
    const stocks = await res.json();

    const result = {
      fetchedAt: new Date().toISOString(),
      cached: false,
      stocks: stocks.map(s => ({
        ticker: s.name,
        name: s.name,
        price: s.price,
        change: s.change,
        pct: s.price ? parseFloat(((s.change / (s.price - s.change)) * 100).toFixed(2)) : 0,
        volume: s.volume,
        direction: s.change > 0 ? 'up' : s.change < 0 ? 'down' : 'flat',
      })),
      stockCount: stocks.length,
    };

    cache = { data: result, timestamp: now };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };

  } catch (err) {
    if (cache.data) return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ...cache.data, cached: true, stale: true }) };
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
