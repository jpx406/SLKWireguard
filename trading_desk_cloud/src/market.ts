// Market data from Yahoo Finance's chart endpoint (delayed, unofficial), cached at the edge.
export const INTERVALS: Record<string, { yf: string; range: string; prepost: boolean }> = {
  "1m": { yf: "1m", range: "5d", prepost: true },
  "5m": { yf: "5m", range: "1mo", prepost: true },
  "15m": { yf: "15m", range: "1mo", prepost: true },
  "60m": { yf: "60m", range: "3mo", prepost: false },
  "1d": { yf: "1d", range: "2y", prepost: false },
};
export const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,15}$/;

type ChartResult = {
  meta: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number; regularMarketVolume?: number };
  timestamp?: number[];
  indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
};

// Local tests point this at a mock server (MARKET_DATA_BASE in .dev.vars); production always uses Yahoo.
let base = "https://query1.finance.yahoo.com";
export function setMarketBase(url?: string) { if (url) base = url.replace(/\/$/, ""); }

async function yahooChart(symbol: string, interval: string, range: string, prepost: boolean, ttl: number): Promise<ChartResult> {
  const url = `${base}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=${prepost}`;
  const cache = caches.default;
  const key = new Request(url);
  let res = base.startsWith("https://query1.") ? await cache.match(key) : undefined;
  if (!res) {
    res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (TradingDesk)", Accept: "application/json" } });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    res = new Response(res.body, res);
    res.headers.set("Cache-Control", `public, max-age=${ttl}`);
    await cache.put(key, res.clone());
  }
  const body = (await res.json()) as { chart: { result: ChartResult[] | null; error: { description?: string } | null } };
  if (!body.chart.result?.length) throw new Error(body.chart.error?.description || "No data");
  return body.chart.result[0];
}

// --------------------------------------------------------------------------------------- data source
// "auto" = Alpaca IEX (real-time) when Alpaca keys are configured, else Yahoo (delayed).
export type DataSource = "auto" | "yahoo" | "alpaca_iex" | "alpaca_sip";
type Cfg = { source: DataSource; keyId?: string; secret?: string; alpacaBase: string };
let cfg: Cfg = { source: "auto", alpacaBase: "https://data.alpaca.markets" };
let lastError: { at: number; msg: string } | null = null;
let sipDenied = false; // the account's plan doesn't include real-time SIP: use IEX

export function configureMarket(c: { source?: DataSource; keyId?: string; secret?: string; alpacaBase?: string }) {
  cfg = { ...cfg, ...c, alpacaBase: (c.alpacaBase || cfg.alpacaBase).replace(/\/$/, "") };
}
function activeFeed(): "iex" | "sip" | null {
  if (!cfg.keyId || !cfg.secret) return null;
  if (cfg.source === "yahoo") return null;
  if (cfg.source === "alpaca_sip") return sipDenied ? "iex" : "sip";
  return "iex"; // auto / alpaca_iex
}
export function marketInfo() {
  const feed = activeFeed();
  return {
    source: cfg.source, alpaca_keys: !!(cfg.keyId && cfg.secret), active: feed ? `alpaca_${feed}` : "yahoo",
    label: feed === "sip" ? "Alpaca SIP (real-time, all exchanges)" : feed === "iex" ? "Alpaca IEX (real-time, IEX exchange only)" : "Yahoo Finance (delayed)",
    sip_denied: sipDenied, last_error: lastError && Date.now() - lastError.at < 10 * 60_000 ? lastError.msg : null,
  };
}
// Index/futures/FX symbols (^VIX, ES=F, EURUSD=X) only exist on Yahoo.
const alpacaSymbol = (s: string) => (/[\^=]/.test(s) ? null : s.replace(/-/g, "."));

async function alpacaGet(path: string, params: Record<string, string>, ttl: number): Promise<unknown> {
  const url = `${cfg.alpacaBase}${path}?${new URLSearchParams(params)}`;
  const cache = caches.default, key = new Request(url);
  const live = cfg.alpacaBase.startsWith("https://data.alpaca.markets");
  const hit = live ? await cache.match(key) : undefined;
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { "APCA-API-KEY-ID": cfg.keyId!, "APCA-API-SECRET-KEY": cfg.secret!, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    const msg = (() => { try { return JSON.parse(text).message || text; } catch { return text; } })().slice(0, 200);
    if (res.status === 403 && /sip|subscription/i.test(msg) && params.feed === "sip") { sipDenied = true; throw new Error("SIP_DENIED"); }
    throw new Error(`Alpaca ${res.status}: ${msg}`);
  }
  if (live) await cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } }));
  return JSON.parse(text);
}

const ALPACA_TF: Record<string, { tf: string; days: number; ttl: number }> = {
  "1m": { tf: "1Min", days: 5, ttl: 5 }, "5m": { tf: "5Min", days: 30, ttl: 15 }, "15m": { tf: "15Min", days: 30, ttl: 30 },
  "60m": { tf: "1Hour", days: 90, ttl: 60 }, "1d": { tf: "1Day", days: 730, ttl: 300 },
};
type ABar = { t: string; o: number; h: number; l: number; c: number; v: number };

async function alpacaBars(sym: string, iv: string, feed: "iex" | "sip", days?: number) {
  const t = ALPACA_TF[iv];
  const start = new Date(Date.now() - (days ?? t.days) * 86400_000).toISOString();
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let token: string | undefined;
  for (let page = 0; page < 4; page++) {
    const params: Record<string, string> = { timeframe: t.tf, start, limit: "10000", feed, adjustment: "split", sort: "asc" };
    if (token) params.page_token = token;
    const r = (await alpacaGet(`/v2/stocks/${encodeURIComponent(sym)}/bars`, params, t.ttl)) as { bars?: ABar[] | null; next_page_token?: string | null };
    for (const b of r.bars ?? []) out.push({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    token = r.next_page_token ?? undefined;
    if (!token) break;
  }
  return out;
}

type Snap = { latestTrade?: { p: number; t: string }; dailyBar?: { c: number; v: number; t: string }; prevDailyBar?: { c: number; t: string } };
const nyDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

async function alpacaQuotes(symbols: string[], feed: "iex" | "sip") {
  const map = new Map(symbols.map((s) => [alpacaSymbol(s)!, s]));
  const r = (await alpacaGet("/v2/stocks/snapshots", { symbols: [...map.keys()].join(","), feed }, 3)) as Record<string, Snap | null>;
  const today = nyDay(new Date().toISOString());
  const out = new Map<string, { symbol: string; last: number | null; prev: number | null; change_pct: number | null; volume: number | null }>();
  for (const [asym, orig] of map) {
    const s = r[asym];
    if (!s) continue;
    const last = s.latestTrade?.p ?? s.dailyBar?.c ?? null;
    // Before today's session has a daily bar, "yesterday" is the latest daily bar.
    const prev = s.dailyBar && nyDay(s.dailyBar.t) !== today ? s.dailyBar.c : s.prevDailyBar?.c ?? null;
    out.set(orig, { symbol: orig, last, prev, change_pct: last != null && prev ? ((last - prev) / prev) * 100 : null, volume: s.dailyBar && nyDay(s.dailyBar.t) === today ? s.dailyBar.v : null });
  }
  return out;
}

/** Run an Alpaca call with SIP->IEX downgrade; null means "use Yahoo". */
async function viaAlpaca<T>(sym: string | null, fn: (feed: "iex" | "sip") => Promise<T>): Promise<T | null> {
  const feed = activeFeed();
  if (!feed || sym === null) return null;
  try { const r = await fn(feed); lastError = null; return r; }
  catch (e) {
    if ((e as Error).message === "SIP_DENIED") {
      try { const r = await fn("iex"); lastError = null; return r; } catch (e2) { lastError = { at: Date.now(), msg: (e2 as Error).message }; return null; }
    }
    lastError = { at: Date.now(), msg: (e as Error).message };
    return null;
  }
}

/** Freshest trade price: Alpaca's latest trade when available, else the last 1-minute bar. */
export async function latestPrice(symbol: string): Promise<number> {
  const asym = alpacaSymbol(symbol);
  const q = await viaAlpaca(asym, (feed) => alpacaQuotes([symbol], feed));
  const p = q?.get(symbol)?.last;
  if (p != null) return p;
  const bars = await candles(symbol, "1m");
  if (!bars.length) throw new Error(`No price for ${symbol}`);
  return bars.at(-1)!.close;
}

/** Admin "test connection": one live Alpaca call, no fallback. */
export async function testAlpaca(feed: "iex" | "sip") {
  if (!cfg.keyId || !cfg.secret) return { ok: false, detail: "ALPACA_KEY_ID / ALPACA_SECRET_KEY secrets are not set." };
  try {
    const q = await alpacaQuotes(["SPY"], feed);
    const spy = q.get("SPY");
    return spy?.last != null ? { ok: true, detail: `SPY ${spy.last} via ${feed.toUpperCase()}` } : { ok: false, detail: "Connected, but no SPY data returned." };
  } catch (e) {
    const m = (e as Error).message;
    return { ok: false, detail: m === "SIP_DENIED" ? "Your Alpaca plan does not include real-time SIP (the $99 Algo Trader Plus plan does). IEX works on the free plan." : m };
  }
}

/** Longest lookback (calendar days) each bar size supports at the data providers. */
export const MAX_DAYS: Record<string, number> = { "1m": 7, "5m": 59, "15m": 59, "60m": 729, "1d": 3650 };
const yahooRange = (days: number) =>
  days <= 1 ? "1d" : days <= 5 ? "5d" : days <= 30 ? "1mo" : days <= 90 ? "3mo" : days <= 180 ? "6mo" : days <= 365 ? "1y" : days <= 730 ? "2y" : days <= 1825 ? "5y" : "10y";

/** Bars for a symbol; `days` (calendar days back) overrides the default lookback for the bar size. */
export async function candles(symbol: string, iv: string, days?: number) {
  const d = days === undefined ? undefined : Math.max(1, Math.min(MAX_DAYS[iv] ?? 30, Math.round(days)));
  const asym = alpacaSymbol(symbol);
  const a = await viaAlpaca(asym, (feed) => alpacaBars(asym!, iv, feed, d));
  if (a && a.length) return a;
  return yahooCandles(symbol, iv, d);
}

async function yahooCandles(symbol: string, iv: string, days?: number) {
  const cfg = INTERVALS[iv];
  const r = await yahooChart(symbol, cfg.yf, days === undefined ? cfg.range : yahooRange(days), cfg.prepost, iv === "1d" ? 300 : 15);
  const q = r.indicators.quote[0], ts = r.timestamp ?? [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume[i] ?? 0 });
  }
  return out;
}

export async function quotes(symbols: string[]) {
  const eligible = symbols.filter((s) => alpacaSymbol(s));
  const fromAlpaca = eligible.length ? (await viaAlpaca("batch", (feed) => alpacaQuotes(eligible, feed))) ?? new Map() : new Map();
  return Promise.all(symbols.map(async (symbol) => {
    const hit = fromAlpaca.get(symbol);
    if (hit && hit.last != null) return hit;
    try {
      const m = (await yahooChart(symbol, "1d", "1d", false, 10)).meta;
      const last = m.regularMarketPrice ?? null, prev = m.chartPreviousClose ?? m.previousClose ?? null;
      return { symbol, last, prev, change_pct: last != null && prev ? ((last - prev) / prev) * 100 : null, volume: m.regularMarketVolume ?? null };
    } catch (e) {
      return { symbol, error: String((e as Error).message).slice(0, 120) };
    }
  }));
}
