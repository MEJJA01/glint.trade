let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ ...cache.data, cached: true });
  }

  try {
    const response = await fetch('https://dev.kwayisi.org/apis/nse/live', {
      headers: { 'User-Agent': 'Mozilla/5.0 GlintTrade/1.0' }
    });
    const stocks = await response.json();

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
    res.json(result);

  } catch (err) {
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true });
    res.status(502).json({ error: err.message });
  }
}
