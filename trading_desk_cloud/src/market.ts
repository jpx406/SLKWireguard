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

export async function candles(symbol: string, iv: string) {
  const cfg = INTERVALS[iv];
  const r = await yahooChart(symbol, cfg.yf, cfg.range, cfg.prepost, iv === "1d" ? 300 : 15);
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
  return Promise.all(symbols.map(async (symbol) => {
    try {
      const m = (await yahooChart(symbol, "1d", "1d", false, 10)).meta;
      const last = m.regularMarketPrice ?? null, prev = m.chartPreviousClose ?? m.previousClose ?? null;
      return { symbol, last, prev, change_pct: last != null && prev ? ((last - prev) / prev) * 100 : null, volume: m.regularMarketVolume ?? null };
    } catch (e) {
      return { symbol, error: String((e as Error).message).slice(0, 120) };
    }
  }));
}
