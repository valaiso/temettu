// Temettü verisi (Supabase Edge Function): tarayıcı Yahoo Finance'e doğrudan erişemediği (CORS) için
// arama ve temettü geçmişi bu fonksiyon üzerinden çekilir. Ödeme tarihleri stockanalysis.com'dan,
// bulunamazsa Yahoo'nun ex-tarihlerinden tahmin edilir.
//
//   GET ?q=coca          -> hisse / ETF / fon arama (ABD + Borsa İstanbul)
//   GET ?symbols=KO,TUPRS.IS -> her sembol için temettü geçmişi, sıradaki ex/ödeme tarihi ve USD/TRY kuru
//
// Yayınlama: Supabase → Edge Functions → Deploy a new function → adı "temettu", bu dosyayı yapıştır,
// "Verify JWT with legacy secret" kapalı olsun (fonksiyon yalnızca herkese açık piyasa verisi okur).
// ya da: npx supabase functions deploy temettu --no-verify-jwt --project-ref jqmfvinbzgqyitqquzdc
//
// Aynı dosya yerelde de çalışır: `node dev.mjs` bu dosyadaki handler'ı kullanır.

const ALLOWED_ORIGIN = "https://valaiso.github.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/;
const MAX_SYMBOLS = 40;
const DAY = 86400000;

function cors(origin) {
  const ok = origin && (origin === ALLOWED_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}

function isoDate(ms, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// quoteSummary (ödeme tarihi) çerez + crumb ister; bir kez alınıp bir süre saklanır.
let session = null;
async function yahooSession() {
  if (session && Date.now() - session.at < 30 * 60000) return session;
  const res = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_]+=)/);
  const cookie = raw.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, "Cookie": cookie } });
  const crumb = (await crumbRes.text()).trim();
  if (!crumbRes.ok || !crumb || crumb.includes("<")) throw new Error("crumb alınamadı");
  session = { cookie, crumb, at: Date.now() };
  return session;
}

async function calendar(symbol) {
  try {
    const s = await yahooSession();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(s.crumb)}`;
    const data = await getJson(url, { Cookie: s.cookie });
    const c = data?.quoteSummary?.result?.[0]?.calendarEvents || {};
    const pay = c.dividendDate?.raw, ex = c.exDividendDate?.raw;
    return {
      nextPay: Number.isFinite(pay) ? isoDate(pay * 1000) : null,
      nextEx: Number.isFinite(ex) ? isoDate(ex * 1000) : null,
    };
  } catch {
    session = null;
    return { nextPay: null, nextEx: null };
  }
}

// stockanalysis.com: ex-tarihi + gerçek ödeme tarihi (açıklanmış gelecek temettü dahil). ABD hisse/ETF ve BIST.
async function stockAnalysis(symbol, market, type) {
  const code = symbol.replace(/\.IS$/, "").toLowerCase();
  const paths = market === "TR" ? [`a/IST-${code.toUpperCase()}`] : type === "ETF" ? [`e/${code}`, `s/${code}`] : [`s/${code}`, `e/${code}`];
  for (const p of paths) {
    try {
      const j = await getJson(`https://stockanalysis.com/api/symbol/${p}/dividend`);
      const hist = j?.data?.history;
      if (!Array.isArray(hist) || !hist.length) continue;
      const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null);
      const divs = hist
        .map((h) => ({ ex: iso(h.dt), amt: Number(String(h.amt).replace(/[^0-9.]/g, "")), pay: iso(h.pay) }))
        .filter((d) => d.ex && d.amt > 0)
        .sort((a, b) => a.ex.localeCompare(b.ex));
      if (divs.length) return divs;
    } catch { /* sonraki yolu dene */ }
  }
  return null;
}

async function symbolData(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1mo&events=div`;
  const chart = (await getJson(url))?.chart?.result?.[0];
  if (!chart) return null;
  const meta = chart.meta || {};
  const tz = meta.exchangeTimezoneName || "UTC";
  const market = symbol.endsWith(".IS") ? "TR" : "US";
  const type = String(meta.instrumentType || "EQUITY").toUpperCase();
  const base = {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || (market === "TR" ? "TRY" : "USD"),
    price: Number(meta.regularMarketPrice) || null,
    type,
    market,
  };

  const sa = await stockAnalysis(symbol, market, type);
  if (sa) return { ...base, divs: sa, nextEx: null, nextPay: null, lag: market === "TR" ? 2 : type === "ETF" ? 4 : 21, source: "stockanalysis" };

  // Yedek: Yahoo temettü geçmişi (yalnızca ex-tarihi). Ödeme günü sıradaki temettüden ya da
  // piyasaya göre tipik gecikmeden tahmin edilir.
  const cal = await calendar(symbol);
  const divs = Object.values(chart.events?.dividends || {})
    .map((d) => ({ ex: isoDate(d.date * 1000, tz), amt: Number(d.amount), pay: null }))
    .filter((d) => d.amt > 0)
    .sort((a, b) => a.ex.localeCompare(b.ex));
  let lag = market === "TR" ? 2 : type === "ETF" ? 4 : 21;
  if (cal.nextPay && cal.nextEx) {
    const diff = Math.round((Date.parse(cal.nextPay) - Date.parse(cal.nextEx)) / DAY);
    if (diff >= 0 && diff <= 75) lag = diff;
  }
  return { ...base, divs, nextEx: cal.nextEx, nextPay: cal.nextPay, lag, source: "yahoo" };
}

async function usdTry() {
  try {
    const j = await getJson("https://query1.finance.yahoo.com/v8/finance/chart/USDTRY=X?range=1d&interval=1d");
    return Number(j?.chart?.result?.[0]?.meta?.regularMarketPrice) || null;
  } catch { return null; }
}

const US_EXCHANGES = new Set(["NYQ", "NMS", "NGM", "NCM", "PCX", "ASE", "BTS", "NAS", "NYS", "PNK", "OQB", "OQX", "CBO"]);

async function search(q) {
  const run = async (term) => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=true`;
    const j = await getJson(url);
    return (j.quotes || [])
      .filter((x) => ["EQUITY", "ETF", "MUTUALFUND"].includes(x.quoteType))
      .filter((x) => x.symbol?.endsWith(".IS") || (!x.symbol?.includes(".") && (US_EXCHANGES.has(x.exchange) || x.quoteType === "MUTUALFUND")))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        type: x.quoteType,
        market: x.symbol.endsWith(".IS") ? "TR" : "US",
        exchange: x.exchDisp || x.exchange,
      }));
  };
  let results = await run(q);
  // BIST kodu yazıldıysa (ör. "TUPRS") .IS ile de dene.
  if (/^[A-Za-z0-9]{3,6}$/.test(q) && !results.some((r) => r.symbol === `${q.toUpperCase()}.IS`)) {
    try { results = [...results, ...(await run(`${q.toUpperCase()}.IS`))]; } catch { /* yok say */ }
  }
  const seen = new Set();
  return results.filter((r) => !seen.has(r.symbol) && seen.add(r.symbol)).slice(0, 10);
}

export async function handler(req) {
  const headers = { ...cors(req.headers.get("Origin")), "Content-Type": "application/json; charset=utf-8" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const url = new URL(req.url);
  const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
  try {
    const q = (url.searchParams.get("q") || "").trim();
    if (q) {
      if (q.length > 40) return json({ ok: false, error: "arama çok uzun" }, 400);
      return json({ ok: true, results: await search(q) }, 200, { "Cache-Control": "public, max-age=3600" });
    }
    const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",")
      .map((s) => s.trim().toUpperCase()).filter((s) => SYMBOL_RE.test(s)))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({ ok: false, error: "q veya symbols gerekli" }, 400);
    const [entries, fx] = await Promise.all([
      Promise.all(symbols.map(async (s) => [s, await symbolData(s).catch(() => null)])),
      usdTry(),
    ]);
    return json({ ok: true, fx: { USDTRY: fx }, data: Object.fromEntries(entries.filter(([, d]) => d)) },
      200, { "Cache-Control": "public, max-age=1800" });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 502);
  }
}

// Supabase (Deno) üzerinde sunucuyu başlat; Node'dan içe aktarıldığında yalnızca handler kullanılır.
if (typeof globalThis.Deno !== "undefined") globalThis.Deno.serve(handler);
