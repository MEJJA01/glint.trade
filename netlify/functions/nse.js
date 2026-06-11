// netlify/functions/nse.js
// Fetches live NSE data from afx.kwayisi.org

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Known NSE tickers to fetch individually
const TICKERS = [
  'scom','eqty','kcb','coop','ncba','absa','scbk','sbic','dtk','hfck',
  'kplc','kegn','kengen',
  'eabl','bamb','unga','bat','carb',
  'jub','brit','knre',
  'nmg','sgl',
  'kq','totl','ctg','scan','kapc','liner','port','eapcc','cfc',
  'arm','wpp','tbw','home','fire','icdc','kmre',
];

const SECTOR_MAP = {
  scom:'TELECOMS',
  eqty:'BANKING',kcb:'BANKING',coop:'BANKING',ncba:'BANKING',absa:'BANKING',
  scbk:'BANKING',sbic:'BANKING',dtk:'BANKING',hfck:'BANKING',cfc:'BANKING',
  kplc:'ENERGY',kegn:'ENERGY',kengen:'ENERGY',
  eabl:'MANUFACTURING',bamb:'MANUFACTURING',unga:'MANUFACTURING',
  bat:'MANUFACTURING',carb:'MANUFACTURING',arm:'MANUFACTURING',
  jub:'INSURANCE',brit:'INSURANCE',knre:'INSURANCE',
  nmg:'MEDIA',sgl:'MEDIA',
  kq:'AVIATION',totl:'ENERGY',
  ctg:'INVESTMENT',scan:'INVESTMENT',
};

async function fetchStock(ticker) {
  try {
    const res = await fetch(`https://afx.kwayisi.org/nse/${ticker}.html`, {
      headers: { 'User-Agent': 'Mozilla/5.0 GlintTrade/1.0' },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract price: looks for pattern like "28.90 KES"
    const priceMatch = html.match(/current share price[^>]*?>.*?KES\s+([\d.]+)/i) ||
                       html.match(/([\d.]+)\s*KES per share/i) ||
                       html.match(/closed.*?at\s+([\d.]+)\s*KES/i);

    // Extract change %
    const chgMatch = html.match(/recording a ([\d.]+)%\s*(gain|drop|rise|fall)/i);

    // Extract name from title
    const nameMatch = html.match(/<title>([^(]+)\(/);

    if (!priceMatch) return null;

    const price = parseFloat(priceMatch[1]);
    const pct = chgMatch ? parseFloat(chgMatch[1]) * (chgMatch[2].match(/drop|fall/i) ? -1 : 1) : 0;
    const change = parseFloat(((pct / 100) * price).toFixed(2));
    const name = nameMatch ? nameMatch[1].trim() : ticker.toUpperCase();

    return {
      ticker: ticker.toUpperCase(),
      name,
      price,
      change,
      pct,
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      sector: SECTOR_MAP[ticker] || 'OTHER',
    };
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  const now = Date.now();

  // Return cache if fresh
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ...cache.data, cached: true, age: Math.round((now - cache.timestamp) / 1000) }),
    };
  }

  try {
    // Fetch main page for NASI index
    const mainRes = await fetch('https://afx.kwayisi.org/nse/', {
      headers: { 'User-Agent': 'Mozilla/5.0 GlintTrade/1.0' },
    });
    const mainHtml = await mainRes.text();

    // Parse NASI
    const nasiMatch = mainHtml.match(/NASI[^>]*>([\d.]+)[^(]*\(([+-]?[\d.]+)%\)/i) ||
                      mainHtml.match(/([\d.]+).*?([+-][\d.]+)%/);
    const nasiIndex = nasiMatch ? parseFloat(nasiMatch[1]) : null;
    const nasiPct = nasiMatch ? parseFloat(nasiMatch[2]) : null;

    // Parse trading summary
    const summaryMatch = mainHtml.match(/total of ([\d,]+) shares in ([\d,]+) deals.*?KES ([\d,]+)/i);

    // Extract all tickers from main page links like /nse/scom.html
    const tickerMatches = [...mainHtml.matchAll(/\/nse\/([a-z0-9]+)\.html/gi)];
    const liveTickers = [...new Set(tickerMatches.map(m => m[1].toLowerCase()))]
      .filter(t => t.length >= 2 && t.length <= 6 && t !== 'nse');

    const tickersToFetch = liveTickers.length > 0 ? liveTickers.slice(0, 40) : TICKERS.slice(0, 15);

    // Fetch stocks in parallel (batches of 8 to avoid rate limits)
    const stocks = [];
    const batchSize = 8;
    for (let i = 0; i < tickersToFetch.length; i += batchSize) {
      const batch = tickersToFetch.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(t => fetchStock(t)));
      stocks.push(...results.filter(Boolean));
      if (i + batchSize < tickersToFetch.length) {
        await new Promise(r => setTimeout(r, 300)); // small delay between batches
      }
    }

    const gainers = [...stocks].sort((a, b) => b.pct - a.pct).slice(0, 5);
    const losers = [...stocks].sort((a, b) => a.pct - b.pct).slice(0, 5);

    const result = {
      source: 'afx.kwayisi.org',
      fetchedAt: new Date().toISOString(),
      cached: false,
      nasi: {
        index: nasiIndex,
        changePct: nasiPct,
      },
      stockCount: stocks.length,
      stocks,
      gainers,
      losers,
      summary: summaryMatch ? {
        totalShares: parseInt(summaryMatch[1].replace(/,/g, '')),
        totalDeals: parseInt(summaryMatch[2].replace(/,/g, '')),
        marketValue: parseInt(summaryMatch[3].replace(/,/g, '')),
      } : null,
    };

    cache = { data: result, timestamp: now };

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };

  } catch (err) {
    if (cache.data) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ ...cache.data, cached: true, stale: true, error: err.message }),
      };
    }
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Failed to fetch NSE data', details: err.message }),
    };
  }
};
