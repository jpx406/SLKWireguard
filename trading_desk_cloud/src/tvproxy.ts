// Backend routes for the TradingView modules under TV Strategies (Screener, Yield curves, Scripts).
// The browser cannot call these services itself (no CORS), so the desk fetches on its behalf, for signed-in users
// only, and caches the replies. These are UNOFFICIAL TradingView endpoints: they can change or be rate-limited
// without notice, so every route answers with the upstream status and the panels fall back to what they have.
//   POST /api/tv/:market/scan            -> scanner.tradingview.com/:market/scan          (screeners, benchmark yields)
//   GET  /api/tv/scripts?path=&...       -> www.tradingview.com/scripts/...               (community scripts listing)
//   GET  /api/tv/pine/:id/:version       -> pine-facade.tradingview.com                   (open-source Pine source)
//   GET  /api/yields/US                  -> US Treasury daily par yield curve (official)
//   GET  /api/yields/US/history?daysAgo= -> FRED (with FRED_API_KEY) or the Treasury file for that month
import type { Env } from "./env";

const UA = "Mozilla/5.0 (TradingDesk)";
const MARKETS = new Set(["america", "bond", "coin", "forex", "cfd", "global", "uk", "germany", "japan", "india", "hongkong", "ksa", "uae", "qatar", "kuwait", "france", "italy", "canada", "australia", "china", "korea", "switzerland", "crypto"]);
const TV_HEADERS = { "User-Agent": UA, Accept: "application/json, text/plain, */*", Origin: "https://www.tradingview.com", Referer: "https://www.tradingview.com/" };
const out = (body: string, status = 200, type = "application/json") => new Response(body, { status, headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" } });
const err = (status: number, error: string) => out(JSON.stringify({ error, detail: error }), status);

async function sha(s: string) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40); }
/** Fetch through the edge cache: the same question within `ttl` seconds is answered without asking upstream again. */
async function cached(key: string, ttl: number, get: () => Promise<Response>): Promise<{ status: number; body: string }> {
  const cache = caches.default, req = new Request(`https://tv-cache.local/${key}`);
  const hit = await cache.match(req); if (hit) return { status: 200, body: await hit.text() };
  const r = await get(), body = await r.text();
  if (r.status === 200 && body.length < 4_000_000) await cache.put(req, new Response(body, { headers: { "Cache-Control": `public, max-age=${ttl}` } }));
  return { status: r.status, body };
}

const TENOR: Record<string, [string, number]> = { "1 MO": ["1M", 1 / 12], "1.5 MONTH": ["6W", 0.125], "2 MO": ["2M", 2 / 12], "3 MO": ["3M", 0.25], "4 MO": ["4M", 4 / 12], "6 MO": ["6M", 0.5], "1 YR": ["1Y", 1], "2 YR": ["2Y", 2], "3 YR": ["3Y", 3], "5 YR": ["5Y", 5], "7 YR": ["7Y", 7], "10 YR": ["10Y", 10], "20 YR": ["20Y", 20], "30 YR": ["30Y", 30] };
type Curve = { date: string; points: { tenor: string; years: number; yield: number }[] };
async function treasury(yyyymm: string): Promise<Curve[]> {
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yyyymm.slice(0, 4)}/all?type=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}&page&_format=csv`;
  const r = await cached(`treasury-${yyyymm}`, 600, () => fetch(url, { headers: { "User-Agent": UA, Accept: "text/csv,*/*" } }));
  if (r.status !== 200) throw new Error(`US Treasury answered ${r.status}`);
  const lines = r.body.trim().split(/\r?\n/), head = lines[0].split(",").map((s) => s.replace(/"/g, "").trim().toUpperCase());
  return lines.slice(1).map((l) => { const c = l.split(",").map((s) => s.replace(/"/g, "").trim()); const points: Curve["points"] = []; head.forEach((h, i) => { const m = TENOR[h]; if (m && c[i] !== "" && !isNaN(+c[i])) points.push({ tenor: m[0], years: m[1], yield: +c[i] }); }); return { date: c[0], points }; }).filter((d) => d.points.length);
}
const ym = (d: Date) => d.toISOString().slice(0, 7).replace("-", ""), ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Returns a Response for /tv/* and /yields/* paths, or null when the path is not one of them. */
export async function tvProxy(env: Env, req: Request, url: URL, path: string): Promise<Response | null> {
  if (!path.startsWith("/tv/") && !path.startsWith("/yields/")) return null;
  const m = req.method, dev = env.TV_DEV_BASE?.replace(/\/$/, ""); // tests only: a local stand-in for all upstreams
  try {
    let x: RegExpMatchArray | null;
    if ((x = path.match(/^\/tv\/([a-z]+)\/scan$/)) && m === "POST") {
      if (!MARKETS.has(x[1])) return err(400, "Unknown market.");
      const body = await req.text(); if (body.length > 20000) return err(413, "Request too large.");
      try { JSON.parse(body); } catch { return err(400, "Bad request."); }
      const label = encodeURIComponent((url.searchParams.get("label-product") || "trading-desk").slice(0, 40));
      const target = dev ? `${dev}/mock-scanner/${x[1]}/scan` : `https://scanner.tradingview.com/${x[1]}/scan?label-product=${label}`;
      const r = await cached(`scan-${x[1]}-${await sha(body)}`, 30, () => fetch(target, { method: "POST", headers: { ...TV_HEADERS, "Content-Type": "text/plain;charset=UTF-8" }, body }));
      return out(r.body, r.status);
    }
    if (path === "/tv/scripts" && m === "GET") {
      const p = url.searchParams.get("path") || "/scripts/"; if (!/^\/scripts\/[\w\-/%.]*$/.test(p) || p.includes("..")) return err(400, "Bad path.");
      const q = new URLSearchParams(); for (const k of ["script_type", "script_access", "sort"]) { const v = url.searchParams.get(k); if (v && /^[\w]{1,40}$/.test(v)) q.set(k, v); } q.set("component-data-only", "1");
      const target = dev ? `${dev}/api/tv/scripts?path=${encodeURIComponent(p)}&${q}` : `https://www.tradingview.com${p}?${q}`;
      const r = await cached(`scripts-${await sha(p + "?" + q)}`, 300, () => fetch(target, { headers: { ...TV_HEADERS, Accept: "application/json", "Accept-Language": "en-US,en;q=0.9" } }));
      return out(r.body, r.status);
    }
    if ((x = path.match(/^\/tv\/pine\/([^/]+)\/(\d{1,6})$/)) && m === "GET") {
      const id = decodeURIComponent(x[1]); if (!/^PUB;[0-9a-f]{8,64}$/.test(id)) return err(400, "Bad script id.");
      const target = dev ? `${dev}/api/tv/pine/${encodeURIComponent(id)}/${x[2]}` : `https://pine-facade.tradingview.com/pine-facade/get/${encodeURIComponent(id)}/${x[2]}/?no_4xx=true`;
      const r = await cached(`pine-${await sha(id)}-${x[2]}`, 3600, () => fetch(target, { headers: TV_HEADERS }));
      return out(r.body, r.status);
    }
    if ((x = path.match(/^\/yields\/([A-Z]{2})(\/history)?$/)) && m === "GET") {
      if (x[1] !== "US") return err(404, "The official source covers the US only; other curves come from the screener.");
      if (dev) { const r = await fetch(`${dev}/api${path}${url.search}`); return out(await r.text(), r.status); }
      if (!x[2]) {
        let rows = await treasury(ym(new Date())); if (!rows.length) rows = await treasury(ym(new Date(Date.now() - 31 * 864e5)));
        const latest = rows.slice().sort((a, b) => +new Date(b.date) - +new Date(a.date))[0]; if (!latest) return err(404, "No data.");
        return out(JSON.stringify({ date: latest.date, points: latest.points, source: "US Treasury par yield curve" }));
      }
      const daysAgo = Math.max(1, Math.min(3650, Number(url.searchParams.get("daysAgo")) || 30)), target = new Date(Date.now() - daysAgo * 864e5);
      if (env.FRED_API_KEY) {
        const series: Record<string, [string, number]> = { DGS1MO: ["1M", 1 / 12], DGS3MO: ["3M", 0.25], DGS6MO: ["6M", 0.5], DGS1: ["1Y", 1], DGS2: ["2Y", 2], DGS3: ["3Y", 3], DGS5: ["5Y", 5], DGS7: ["7Y", 7], DGS10: ["10Y", 10], DGS20: ["20Y", 20], DGS30: ["30Y", 30] };
        const start = ymd(new Date(target.getTime() - 7 * 864e5)), end = ymd(target), points: (Curve["points"][number] & { date: string })[] = [];
        await Promise.all(Object.entries(series).map(async ([sid, [tenor, years]]) => {
          const r = await cached(`fred-${sid}-${end}`, 21600, () => fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${sid}&api_key=${env.FRED_API_KEY}&file_type=json&observation_start=${start}&observation_end=${end}`, { headers: { "User-Agent": UA } }));
          if (r.status !== 200) return; const v = ((JSON.parse(r.body) as { observations?: { value: string; date: string }[] }).observations || []).filter((o) => o.value !== ".").pop(); if (v) points.push({ tenor, years, yield: +v.value, date: v.date });
        }));
        if (points.length) return out(JSON.stringify({ day: end, points: points.sort((a, b) => a.years - b.years), source: "FRED" }));
      }
      const rows = await treasury(ym(target)), best = rows.slice().sort((a, b) => Math.abs(+new Date(a.date) - +target) - Math.abs(+new Date(b.date) - +target))[0];
      return best ? out(JSON.stringify({ day: best.date, points: best.points, source: "US Treasury" })) : err(404, "No data.");
    }
    return err(404, "Not found.");
  } catch (e) { return err(502, String((e as Error).message || e).slice(0, 200)); }
}
