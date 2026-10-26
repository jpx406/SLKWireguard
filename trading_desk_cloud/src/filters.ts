// Screening filters for the Full market scan: given to Claude as hard rules, then enforced
// again on the returned picks (violations move to "avoid"), so the list always respects them.

export const SECTORS = [
  "Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples", "Energy", "Financials",
  "Health Care", "Industrials", "Materials", "Real Estate", "Utilities",
] as const;
export const EXCHANGES = ["NYSE", "NASDAQ", "AMEX"] as const;

export type ScanFilters = {
  min_market_cap: number | null; max_market_cap: number | null;
  min_price: number | null; max_price: number | null;
  min_avg_volume: number | null; min_rel_volume: number | null;
  min_premarket_volume: number | null; min_gap_pct: number | null;
  min_atr_pct: number | null; min_float: number | null; max_float: number | null;
  max_short_float_pct: number | null;
  sectors: string[]; exchanges: string[];
  include_etfs: boolean; earnings: "any" | "only" | "exclude";
  direction: "both" | "long" | "short"; max_picks: number; notes: string;
};

export const DEFAULT_FILTERS: ScanFilters = {
  min_market_cap: 300e6, max_market_cap: null, min_price: 5, max_price: null,
  min_avg_volume: 1e6, min_rel_volume: 1.5, min_premarket_volume: null, min_gap_pct: null,
  min_atr_pct: null, min_float: null, max_float: null, max_short_float_pct: null,
  sectors: [], exchanges: [...EXCHANGES], include_etfs: false, earnings: "any",
  direction: "both", max_picks: 10, notes: "",
};

const posNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function sanitizeFilters(x: unknown): ScanFilters {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const f = { ...DEFAULT_FILTERS };
  for (const k of ["min_market_cap", "max_market_cap", "min_price", "max_price", "min_avg_volume", "min_rel_volume",
    "min_premarket_volume", "min_gap_pct", "min_atr_pct", "min_float", "max_float", "max_short_float_pct"] as const) {
    if (k in o) f[k] = posNum(o[k]);
  }
  if (Array.isArray(o.sectors)) f.sectors = o.sectors.map(String).filter((s) => (SECTORS as readonly string[]).includes(s));
  if (Array.isArray(o.exchanges)) f.exchanges = o.exchanges.map(String).filter((s) => (EXCHANGES as readonly string[]).includes(s));
  if (!f.exchanges.length) f.exchanges = [...EXCHANGES];
  if (typeof o.include_etfs === "boolean") f.include_etfs = o.include_etfs;
  if (o.earnings === "only" || o.earnings === "exclude" || o.earnings === "any") f.earnings = o.earnings;
  if (o.direction === "long" || o.direction === "short" || o.direction === "both") f.direction = o.direction;
  if ("max_picks" in o) f.max_picks = Math.min(25, Math.max(1, Math.round(Number(o.max_picks) || 10)));
  if ("notes" in o) f.notes = String(o.notes ?? "").slice(0, 1000);
  return f;
}

export const money = (n: number) =>
  n >= 1e12 ? `$${+(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `$${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : `$${n}`;
export const shares = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(0)}K` : `${n}`);

/** Plain-language list of the active filters (also used for the chips in the UI). */
export function describeFilters(f: ScanFilters): string[] {
  const out: string[] = [];
  if (f.min_market_cap != null || f.max_market_cap != null)
    out.push(`Market cap ${f.min_market_cap != null ? `≥ ${money(f.min_market_cap)}` : ""}${f.min_market_cap != null && f.max_market_cap != null ? " and " : ""}${f.max_market_cap != null ? `≤ ${money(f.max_market_cap)}` : ""}`);
  if (f.min_price != null || f.max_price != null)
    out.push(`Price ${f.min_price != null ? `≥ $${f.min_price}` : ""}${f.min_price != null && f.max_price != null ? " and " : ""}${f.max_price != null ? `≤ $${f.max_price}` : ""}`);
  if (f.min_avg_volume != null) out.push(`Avg daily volume ≥ ${shares(f.min_avg_volume)} shares`);
  if (f.min_rel_volume != null) out.push(`Relative volume ≥ ${f.min_rel_volume}x`);
  if (f.min_premarket_volume != null) out.push(`Pre-market volume ≥ ${shares(f.min_premarket_volume)} shares`);
  if (f.min_gap_pct != null) out.push(`Gap / pre-market move ≥ ${f.min_gap_pct}% (either direction)`);
  if (f.min_atr_pct != null) out.push(`ATR(14) ≥ ${f.min_atr_pct}% of price`);
  if (f.min_float != null) out.push(`Float ≥ ${shares(f.min_float)} shares`);
  if (f.max_float != null) out.push(`Float ≤ ${shares(f.max_float)} shares`);
  if (f.max_short_float_pct != null) out.push(`Short interest ≤ ${f.max_short_float_pct}% of float`);
  if (f.sectors.length) out.push(`Sectors: ${f.sectors.join(", ")}`);
  if (f.exchanges.length < EXCHANGES.length) out.push(`Exchanges: ${f.exchanges.join(", ")} (no OTC)`);
  else out.push("Exchanges: NYSE, NASDAQ, AMEX (no OTC)");
  out.push(f.include_etfs ? "ETFs allowed" : "No ETFs");
  if (f.earnings === "only") out.push("Only stocks reporting earnings today");
  if (f.earnings === "exclude") out.push("Exclude stocks reporting earnings today");
  if (f.direction !== "both") out.push(f.direction === "long" ? "Long ideas only" : "Short ideas only");
  out.push(`At most ${f.max_picks} picks`);
  return out;
}

export function filtersPrompt(f: ScanFilters): string {
  return `
SCREENING FILTERS (hard rules for the trade list; the market overview may still mention anything):
${describeFilters(f).map((s) => `- ${s}`).join("\n")}${f.notes ? `\n- Extra instructions: ${f.notes}` : ""}
Look up the values you need (market cap, average volume, float, ATR, sector, exchange, earnings date) with my skills or the web. Exclude any stock that fails a filter and list it under "avoid" with the reason. If a value cannot be found, say so in that pick's "reason". For every pick also fill: "market_cap", "avg_volume", "float_shares", "atr_pct", "exchange", "is_etf", "earnings_today".`;
}

type Pick = Record<string, unknown>;
const val = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));

/** Server-side check of the returned picks; anything that fails a known value moves to "avoid". */
export function enforceFilters<T extends { picks: unknown[]; [k: string]: unknown }>(result: T | null, f: ScanFilters): T | null {
  if (!result) return result;
  const keep: Pick[] = [], avoid: Pick[] = Array.isArray(result.avoid) ? [...(result.avoid as Pick[])] : [];
  for (const raw of result.picks as Pick[]) {
    const p = raw || {}, why: string[] = [];
    const price = val(p.last) ?? val(p.entry), cap = val(p.market_cap), vol = val(p.avg_volume), rvol = val(p.rvol);
    const gap = val(p.premarket_change_pct), atr = val(p.atr_pct), flt = val(p.float_shares);
    if (f.min_price != null && price != null && price < f.min_price) why.push(`price below $${f.min_price}`);
    if (f.max_price != null && price != null && price > f.max_price) why.push(`price above $${f.max_price}`);
    if (f.min_market_cap != null && cap != null && cap < f.min_market_cap) why.push(`market cap below ${money(f.min_market_cap)}`);
    if (f.max_market_cap != null && cap != null && cap > f.max_market_cap) why.push(`market cap above ${money(f.max_market_cap)}`);
    if (f.min_avg_volume != null && vol != null && vol < f.min_avg_volume) why.push(`avg volume below ${shares(f.min_avg_volume)}`);
    if (f.min_rel_volume != null && rvol != null && rvol < f.min_rel_volume) why.push(`relative volume below ${f.min_rel_volume}x`);
    if (f.min_gap_pct != null && gap != null && Math.abs(gap) < f.min_gap_pct) why.push(`move smaller than ${f.min_gap_pct}%`);
    if (f.min_atr_pct != null && atr != null && atr < f.min_atr_pct) why.push(`ATR below ${f.min_atr_pct}%`);
    if (f.min_float != null && flt != null && flt < f.min_float) why.push(`float below ${shares(f.min_float)}`);
    if (f.max_float != null && flt != null && flt > f.max_float) why.push(`float above ${shares(f.max_float)}`);
    if (f.sectors.length && typeof p.sector === "string" && !f.sectors.some((s) => s.toLowerCase().startsWith(String(p.sector).toLowerCase().slice(0, 6))))
      why.push(`sector ${p.sector} not selected`);
    if (typeof p.exchange === "string" && !f.exchanges.some((e) => String(p.exchange).toUpperCase().includes(e))) why.push(`exchange ${p.exchange} not allowed`);
    if (!f.include_etfs && p.is_etf === true) why.push("ETFs excluded");
    if (f.earnings === "exclude" && p.earnings_today === true) why.push("reports earnings today");
    if (f.earnings === "only" && p.earnings_today === false) why.push("no earnings today");
    if (f.direction !== "both" && typeof p.bias === "string" && !String(p.bias).toLowerCase().includes(f.direction)) why.push(`${f.direction} ideas only`);
    if (why.length) avoid.push({ symbol: p.symbol, reason: `Filtered out: ${why.join(", ")}` });
    else keep.push(p);
  }
  const extra = keep.slice(f.max_picks);
  for (const p of extra) avoid.push({ symbol: p.symbol, reason: `Below the top ${f.max_picks} cut` });
  return { ...result, picks: keep.slice(0, f.max_picks).map((p, i) => ({ ...p, rank: i + 1 })), avoid, filters: describeFilters(f) };
}
