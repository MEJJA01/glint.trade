// netlify/functions/nse-live.js
// ─────────────────────────────────────────────────────────────────────────────
// Deploys to: https://YOUR-SITE.netlify.app/.netlify/functions/nse-live
// Scrapes live NSE equity data from afx.kwayisi.org/nse
// Returns clean JSON consumed by the predictive engine frontend.
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");

const SOURCE_URL = "https://afx.kwayisi.org/nse/";

// Fetch raw HTML from source
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; GlintTradeBot/1.0)" } }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Parse the NSE equities table from HTML
// Table columns: Ticker | Name | Volume | Price | Change
function parseEquitiesTable(html) {
  const equities = [];

  // Extract table rows — afx.kwayisi uses a standard HTML table
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi);
  if (!tableMatch) return equities;

  // Find the equities table (the one with ticker/name/volume/price/change)
  for (const table of tableMatch) {
    // Skip if it doesn't look like an equities table
    if (!table.includes("Volume") && !table.includes("Price")) continue;

    const rowMatches = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

    for (const row of rowMatches) {
      // Skip header rows
      if (row.includes("<th")) continue;

      // Extract cell text content, stripping all HTML tags
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(cell => cell.replace(/<[^>]+>/g, "").trim());

      if (cells.length < 4) continue;

      const [ticker, name, volumeRaw, priceRaw, changeRaw] = cells;

      // Skip rows with no price
      if (!priceRaw || priceRaw === "") continue;

      const price  = parseFloat(priceRaw.replace(/,/g, ""));
      const volume = parseInt(volumeRaw.replace(/,/g, ""), 10) || 0;
      const change = parseFloat((changeRaw || "0").replace(/[^-\d.]/g, "")) || 0;
      const changePct = price > 0 ? parseFloat(((change / (price - change)) * 100).toFixed(2)) : 0;

      if (isNaN(price) || price <= 0) continue;

      equities.push({
        ticker:    ticker.toUpperCase(),
        name:      name,
        price:     price,
        change:    change,
        changePct: changePct,
        volume:    volume,
        direction: change > 0 ? "UP" : change < 0 ? "DOWN" : "FLAT",
      });
    }
    break; // Only parse the first matching table
  }

  return equities;
}

// Parse NASI index value from page
function parseNASI(html) {
  // NASI appears as: NASI IndexYear-to-DateMarket Cap. / 186.58 (+1.21)+63.10 (51.1%)
  const match = html.match(/NASI.*?(\d{2,3}\.\d{2})/);
  return match ? parseFloat(match[1]) : null;
}

// Parse top gainers / losers summary blocks
function parseMovers(html) {
  const gainers = [];
  const losers  = [];

  // Gainers block
  const gainerBlock = html.match(/Top Gainers.*?(?=Bottom Losers|<\/[^>]+>)/si);
  if (gainerBlock) {
    const pairs = gainerBlock[0].match(/([A-Z]{2,5})\s+([\d.]+)\s*\+([\d.]+%)/g) || [];
    pairs.forEach(p => {
      const m = p.match(/([A-Z]{2,5})\s+([\d.]+)\s*\+([\d.]+%)/);
      if (m) gainers.push({ ticker: m[1], price: parseFloat(m[2]), gain: m[3] });
    });
  }

  // Losers block
  const loserBlock = html.match(/Bottom Losers.*?(?=Monetary|<\/[^>]+>)/si);
  if (loserBlock) {
    const pairs = loserBlock[0].match(/([A-Z]{2,5})\s+([\d.]+)\s*-([\d.]+%)/g) || [];
    pairs.forEach(p => {
      const m = p.match(/([A-Z]{2,5})\s+([\d.]+)\s*-([\d.]+%)/);
      if (m) losers.push({ ticker: m[1], price: parseFloat(m[2]), loss: `-${m[3]}` });
    });
  }

  return { gainers, losers };
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",  // Allow your Glint domain
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60", // Cache for 60s — NSE updates ~every 3 min
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    const html = await fetchHTML(SOURCE_URL);

    const equities = parseEquitiesTable(html);
    const nasi     = parseNASI(html);
    const movers   = parseMovers(html);

    // Optional: filter to a specific watchlist via query param
    // e.g. /.netlify/functions/nse-live?tickers=SCOM,EQTY,KCB
    const params     = event.queryStringParameters || {};
    const watchlist  = params.tickers ? params.tickers.split(",").map(t => t.trim().toUpperCase()) : null;
    const filtered   = watchlist ? equities.filter(e => watchlist.includes(e.ticker)) : equities;

    const payload = {
      source:      "afx.kwayisi.org/nse",
      fetched_at:  new Date().toISOString(),
      market_open: isMarketOpen(),
      nasi_index:  nasi,
      movers:      movers,
      equities:    filtered,
      count:       filtered.length,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload),
    };

  } catch (err) {
    console.error("NSE scraper error:", err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error:   "Failed to fetch NSE data",
        detail:  err.message,
        source:  SOURCE_URL,
      }),
    };
  }
};

// NSE market hours: Mon–Fri 09:30–15:00 EAT (UTC+3)
function isMarketOpen() {
  const now  = new Date();
  const eat  = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Nairobi" }));
  const day  = eat.getDay(); // 0=Sun, 6=Sat
  const hour = eat.getHours();
  const min  = eat.getMinutes();
  const time = hour * 60 + min;
  return day >= 1 && day <= 5 && time >= 570 && time <= 900; // 9:30=570, 15:00=900
          }
      
