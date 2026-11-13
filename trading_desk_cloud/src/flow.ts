// Options flow and dealer positioning from Cboe's free delayed option chains (about 15 minutes behind).
// What this is: every contract's volume, open interest, quotes and greeks, turned into (1) a tape of where the
// premium went today, (2) the prints since the last refresh (volume differences between two snapshots), (3) call/put
// and bought/sold splits, strike concentration and unusual contracts, and (4) a gamma-exposure (GEX) map by strike.
// What it is not: an OPRA trade feed. There are no individual trades, so no sweeps or blocks; "bought" and "sold"
// are estimated from where the last trade sat between the bid and the ask.
import type { Env } from "./env";

let base = "https://cdn.cboe.com/api/global/delayed_quotes/options";
export function setFlowBase(url?: string) { if (url) base = url.replace(/\/$/, ""); }
const INDEX = new Set(["SPX", "NDX", "RUT", "VIX", "XSP", "DJX"]);
export const FLOW_SYMBOL = /^[A-Z]{1,6}$/;

type Raw = { option: string; bid: number; ask: number; iv: number; open_interest: number; volume: number; delta: number; gamma: number; last_trade_price: number; last_trade_time: string | null };
type Chain = { timestamp?: string; data: { symbol: string; current_price: number; price_change_percent?: number; iv30?: number; iv30_change?: number; options: Raw[] } };

export type Contract = {
  id: string; expiry: string; dte: number; type: "C" | "P"; strike: number; last: number; bid: number; ask: number; volume: number; oi: number; iv: number; delta: number; gamma: number;
  premium: number; vol_oi: number | null; side: "bought" | "sold" | "mid"; otm_pct: number; score: number; interest: number; tags: string[]; time: string | null; fresh?: number;
};
export type Level = { strike: number; gex: number; call_gex: number; put_gex: number; call_oi: number; put_oi: number; premium: number };
export type Flow = {
  symbol: string; spot: number; change_pct: number | null; as_of: string | null; iv30: number | null; iv30_change: number | null; range: string;
  totals: { call_premium: number; put_premium: number; bullish_premium: number; bearish_premium: number; neutral_premium: number; call_volume: number; put_volume: number; call_oi: number; put_oi: number; pc_volume: number | null; pc_oi: number | null; flow_score: number };
  tape: Contract[]; unusual: Contract[]; prints: Print[]; strikes: Level[]; expiries: { expiry: string; dte: number; call_premium: number; put_premium: number }[];
  gex: { net: number; regime: "positive" | "negative"; magnet: number | null; pit: number | null; flip: number | null; call_wall: number | null; put_wall: number | null; levels: Level[] };
  note: string;
};
export type Print = { at: number; id: string; expiry: string; dte: number; type: "C" | "P"; strike: number; contracts: number; price: number; premium: number; side: string; score: number };

const RANGES: Record<string, [number, number]> = { "0dte": [0, 0], week: [0, 7], month: [0, 45], all: [0, 9999] };
const r0 = (n: number) => Math.round(n), r2 = (n: number) => Math.round(n * 100) / 100;

/** OCC symbol: ROOT + YYMMDD + C/P + strike × 1000 (8 digits). */
export function parseOcc(o: string): { expiry: string; type: "C" | "P"; strike: number } | null {
  const m = o.match(/(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/); if (!m) return null;
  return { expiry: `20${m[1]}-${m[2]}-${m[3]}`, type: m[4] as "C" | "P", strike: Number(m[5]) / 1000 };
}

/** Where the last trade sat in the quote: near the ask = someone paid up (bought), near the bid = hit the bid (sold). */
export function sideOf(last: number, bid: number, ask: number): "bought" | "sold" | "mid" {
  if (!(ask > 0) || !(last > 0) || ask < bid) return "mid";
  const w = ask - bid; if (w <= 0) return last >= ask ? "bought" : last <= bid ? "sold" : "mid";
  const pos = (last - bid) / w; return pos >= 0.7 ? "bought" : pos <= 0.3 ? "sold" : "mid";
}

/** Direction score, -100 (bearish) to +100 (bullish), and an interest score, 0 to 100, that ignores direction. A ranking aid, not a forecast. */
export function scoreOf(c: { type: "C" | "P"; side: string; premium: number; vol_oi: number | null; dte: number; otm_pct: number; volume: number }) {
  const dir = c.side === "mid" ? 0 : (c.type === "C" ? 1 : -1) * (c.side === "bought" ? 1 : -1);
  const size = Math.min(1, Math.log10(Math.max(c.premium, 1) / 25_000) / 2.6); // $25k -> 0, $10M -> 1
  const fresh = c.vol_oi == null ? 0.5 : Math.min(1, c.vol_oi / 3);
  const near = c.dte <= 7 ? 1 : c.dte <= 45 ? 0.75 : 0.5;
  const otm = c.otm_pct > 0 ? Math.min(1, 0.6 + c.otm_pct / 12) : 0.5; // out-of-the-money buying is the directional kind
  const score = r0(100 * dir * Math.max(0, size) * (0.55 + 0.25 * fresh + 0.2 * near) * otm);
  const interest = r0(100 * Math.min(1, 0.45 * Math.max(0, size) + 0.35 * fresh + 0.1 * near + 0.1 * (c.volume >= 1000 ? 1 : c.volume / 1000)));
  return { score, interest };
}

/** Turn one chain snapshot into the flow view. `prev` holds the volumes of the snapshot before it (for the prints). */
export function analyze(chain: Chain, opt: { range?: string; today?: string; prev?: Record<string, number> | null; now?: number } = {}): { flow: Flow; volumes: Record<string, number>; fresh: Print[] } {
  const d = chain.data, spot = d.current_price, range = RANGES[opt.range || "month"] ? opt.range || "month" : "month", [lo, hi] = RANGES[range];
  const today = opt.today || (chain.timestamp || new Date().toISOString()).slice(0, 10), t0 = Date.parse(today + "T00:00:00Z"), now = opt.now ?? Math.floor(Date.now() / 1000);
  const all: Contract[] = [], volumes: Record<string, number> = {}, fresh: Print[] = [];
  const byStrike = new Map<number, Level>(), byExp = new Map<string, { expiry: string; dte: number; call_premium: number; put_premium: number }>();
  const T = { call_premium: 0, put_premium: 0, bullish_premium: 0, bearish_premium: 0, neutral_premium: 0, call_volume: 0, put_volume: 0, call_oi: 0, put_oi: 0 };
  for (const o of d.options) {
    const p = parseOcc(o.option); if (!p) continue;
    const dte = Math.round((Date.parse(p.expiry + "T00:00:00Z") - t0) / 86400000); if (dte < lo || dte > hi) continue;
    const volume = o.volume || 0, oi = o.open_interest || 0, mid = o.ask > 0 ? (o.bid + o.ask) / 2 : 0, last = o.last_trade_price > 0 ? o.last_trade_price : mid;
    // Gamma exposure: dollars of stock dealers must trade per 1% move, assuming they are long calls and short puts.
    const g = (o.gamma || 0) * oi * 100 * spot * spot * 0.01;
    let L = byStrike.get(p.strike); if (!L) byStrike.set(p.strike, (L = { strike: p.strike, gex: 0, call_gex: 0, put_gex: 0, call_oi: 0, put_oi: 0, premium: 0 }));
    if (p.type === "C") { L.call_gex += g; L.gex += g; L.call_oi += oi; T.call_oi += oi; } else { L.put_gex -= g; L.gex -= g; L.put_oi += oi; T.put_oi += oi; }
    if (!(volume > 0)) continue;
    const premium = volume * last * 100, side = sideOf(last, o.bid, o.ask), vol_oi = oi > 0 ? r2(volume / oi) : null;
    const otm_pct = r2(((p.type === "C" ? p.strike - spot : spot - p.strike) / spot) * 100);
    const { score, interest } = scoreOf({ type: p.type, side, premium, vol_oi, dte, otm_pct, volume });
    const tags: string[] = [];
    if (dte === 0) tags.push("0DTE"); if (premium >= 1_000_000) tags.push("$1M+");
    if (volume >= 500 && (oi === 0 || volume > oi)) tags.push("unusual"); if (otm_pct > 5) tags.push("far OTM");
    const c: Contract = { id: o.option, expiry: p.expiry, dte, type: p.type, strike: p.strike, last: r2(last), bid: o.bid, ask: o.ask, volume, oi, iv: r2((o.iv || 0) * 100), delta: o.delta, gamma: o.gamma, premium: r0(premium), vol_oi, side, otm_pct, score, interest, tags, time: o.last_trade_time || null };
    all.push(c); volumes[o.option] = volume; L.premium += premium;
    if (p.type === "C") { T.call_premium += premium; T.call_volume += volume; } else { T.put_premium += premium; T.put_volume += volume; }
    if (score > 0) T.bullish_premium += premium; else if (score < 0) T.bearish_premium += premium; else T.neutral_premium += premium;
    let E = byExp.get(p.expiry); if (!E) byExp.set(p.expiry, (E = { expiry: p.expiry, dte, call_premium: 0, put_premium: 0 }));
    if (p.type === "C") E.call_premium += premium; else E.put_premium += premium;
    // Prints: contracts traded since the previous snapshot.
    const before = opt.prev ? opt.prev[o.option] : undefined;
    const from = before != null && volume >= before ? before : 0; // a lower count than before means the day's volume was reset
    if (opt.prev && volume > from) {
      const n = volume - from, prem = n * last * 100;
      if (prem >= 10_000) fresh.push({ at: now, id: o.option, expiry: p.expiry, dte, type: p.type, strike: p.strike, contracts: n, price: r2(last), premium: r0(prem), side, score: scoreOf({ type: p.type, side, premium: prem, vol_oi, dte, otm_pct, volume: n }).score });
      c.fresh = n;
    }
  }
  all.sort((a, b) => b.premium - a.premium);
  const dirPrem = T.bullish_premium + T.bearish_premium;
  const levels = [...byStrike.values()].filter((l) => Math.abs(l.strike - spot) / spot <= 0.15).sort((a, b) => a.strike - b.strike);
  const net = levels.reduce((s, l) => s + l.gex, 0);
  const big = (f: (l: Level) => number) => { let best: Level | null = null; for (const l of levels) if (f(l) > 0 && (!best || f(l) > f(best))) best = l; return best ? best.strike : null; };
  // Flip: the strike where the running sum of gamma exposure changes sign closest to the price.
  let flip: number | null = null, run = 0, bestD = Infinity;
  for (const l of levels) { const before = run; run += l.gex; if (before !== 0 && Math.sign(before) !== Math.sign(run) && Math.abs(l.strike - spot) < bestD) { bestD = Math.abs(l.strike - spot); flip = l.strike; } }
  const flow: Flow = {
    symbol: d.symbol, spot, change_pct: d.price_change_percent ?? null, as_of: chain.timestamp || null, iv30: d.iv30 ?? null, iv30_change: d.iv30_change ?? null, range,
    totals: { ...Object.fromEntries(Object.entries(T).map(([k, v]) => [k, r0(v)])) as typeof T, pc_volume: T.call_volume ? r2(T.put_volume / T.call_volume) : null, pc_oi: T.call_oi ? r2(T.put_oi / T.call_oi) : null,
      flow_score: dirPrem ? r0(((T.bullish_premium - T.bearish_premium) / dirPrem) * 100) : 0 },
    tape: all.slice(0, 120), unusual: all.filter((c) => c.tags.includes("unusual")).sort((a, b) => b.interest - a.interest || b.premium - a.premium).slice(0, 25),
    prints: fresh.sort((a, b) => b.premium - a.premium).slice(0, 60),
    strikes: [...byStrike.values()].filter((l) => l.premium > 0).sort((a, b) => b.premium - a.premium).slice(0, 12).map((l) => ({ ...l, premium: r0(l.premium), gex: r0(l.gex), call_gex: r0(l.call_gex), put_gex: r0(l.put_gex) })),
    expiries: [...byExp.values()].sort((a, b) => a.dte - b.dte).slice(0, 10).map((e) => ({ ...e, call_premium: r0(e.call_premium), put_premium: r0(e.put_premium) })),
    gex: { net: r0(net), regime: net >= 0 ? "positive" : "negative", magnet: big((l) => l.gex), pit: big((l) => -l.gex), flip, call_wall: big((l) => l.call_gex), put_wall: big((l) => -l.put_gex),
      levels: levels.filter((l) => Math.abs(l.strike - spot) / spot <= 0.08).map((l) => ({ ...l, premium: r0(l.premium), gex: r0(l.gex), call_gex: r0(l.call_gex), put_gex: r0(l.put_gex) })) },
    note: "Cboe delayed data (about 15 minutes). Bought/sold is estimated from the last trade against the bid and ask; there are no individual trades, sweeps or blocks. GEX assumes dealers are long calls and short puts.",
  };
  return { flow, volumes, fresh };
}

let ready = false;
async function ensure(db: D1Database) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS flow_state (symbol TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, volumes TEXT NOT NULL, summary TEXT, viewed_at INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS flow_prints (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS flow_prints_sym ON flow_prints (symbol, at)"),
  ]);
  ready = true;
}

async function fetchChain(symbol: string): Promise<Chain> {
  const url = `${base}/${INDEX.has(symbol) ? "_" : ""}${symbol}.json`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (TradingDesk)" } });
  if (res.status === 403 || res.status === 404) throw new Error(`No listed options found for ${symbol}.`);
  if (!res.ok) throw new Error(`Cboe answered ${res.status}.`);
  if (Number(res.headers.get("content-length") || 0) > 9_000_000) throw new Error(`${symbol}'s option chain is too large to read here. Use the ETF instead (SPY for SPX, QQQ for NDX).`);
  const j = (await res.json()) as Chain;
  if (!j?.data?.options?.length || !(j.data.current_price > 0)) throw new Error(`No option data for ${symbol} right now.`);
  return j;
}

const mem = new Map<string, { at: number; flow: Flow }>();
/** The flow view for one symbol. Snapshots are reused for 90 seconds; a new one records the prints since the last. */
export async function optionsFlow(env: Env, symbol: string, range = "month"): Promise<Flow> {
  await ensure(env.DB);
  symbol = symbol.trim().toUpperCase(); if (!FLOW_SYMBOL.test(symbol)) throw new Error("Options flow needs a US stock, ETF or index symbol.");
  const key = `${symbol}:${range}`, now = Math.floor(Date.now() / 1000), hit = mem.get(key);
  let flow: Flow;
  if (hit && now - hit.at < 90) flow = hit.flow;
  else {
    const chain = await fetchChain(symbol), day = (chain.timestamp || new Date().toISOString()).slice(0, 10);
    const st = await env.DB.prepare("SELECT at, day, volumes FROM flow_state WHERE symbol = ?").bind(symbol).first<{ at: number; day: string; volumes: string }>();
    let prev: Record<string, number> | null = null; if (st && st.day === day) { try { prev = JSON.parse(st.volumes); } catch { prev = null; } }
    // Prints are tracked on the whole chain, whatever range is on screen.
    const whole = analyze(chain, { range: "all", prev, now });
    flow = range === "all" ? whole.flow : analyze(chain, { range, prev, now }).flow;
    const top = whole.volumes; // every contract that traded: a missing one would be read as "new" on the next snapshot
    const sum = { at: now, spot: flow.spot, score: whole.flow.totals.flow_score, call: whole.flow.totals.call_premium, put: whole.flow.totals.put_premium, gex: whole.flow.gex };
    const stmts = [env.DB.prepare("INSERT INTO flow_state (symbol, at, day, volumes, summary, viewed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET at = excluded.at, day = excluded.day, volumes = excluded.volumes, summary = excluded.summary, viewed_at = excluded.viewed_at")
      .bind(symbol, now, day, JSON.stringify(top), JSON.stringify({ ...sum, gex: { ...sum.gex, levels: undefined } }), now)];
    if (whole.fresh.length) stmts.push(env.DB.prepare("INSERT INTO flow_prints (symbol, at, data) VALUES (?, ?, ?)").bind(symbol, now, JSON.stringify(whole.fresh.sort((a, b) => b.premium - a.premium).slice(0, 40))));
    stmts.push(env.DB.prepare("DELETE FROM flow_prints WHERE at < ?").bind(now - 2 * 86400));
    await env.DB.batch(stmts);
    mem.set(key, { at: now, flow }); if (mem.size > 40) mem.delete(mem.keys().next().value as string);
  }
  // The running tape: prints recorded today, newest first.
  const { results } = await env.DB.prepare("SELECT at, data FROM flow_prints WHERE symbol = ? AND at > ? ORDER BY at DESC LIMIT 30").bind(symbol, now - 86400).all<{ at: number; data: string }>();
  const prints: Print[] = []; for (const r of results) { try { for (const p of JSON.parse(r.data) as Print[]) prints.push({ ...p, at: r.at }); } catch { /* skip */ } }
  const [lo, hi] = RANGES[flow.range];
  return { ...flow, prints: prints.filter((p) => p.dte >= lo && p.dte <= hi).slice(0, 80) };
}

/** One line per symbol for the scan prompts, from snapshots someone looked at in the last 30 minutes (no fetch here). */
export async function flowContext(db: D1Database, symbols: string[]): Promise<string> {
  try {
    await ensure(db);
    const { results } = await db.prepare("SELECT symbol, at, summary FROM flow_state WHERE at > ? AND summary IS NOT NULL").bind(Math.floor(Date.now() / 1000) - 1800).all<{ symbol: string; at: number; summary: string }>();
    const want = new Set(symbols.map((s) => s.toUpperCase())), lines: string[] = [];
    for (const r of results) {
      if (!want.has(r.symbol) && r.symbol !== "SPY" && r.symbol !== "QQQ") continue;
      try {
        const s = JSON.parse(r.summary) as { spot: number; score: number; call: number; put: number; gex: Flow["gex"] };
        lines.push(`- ${r.symbol}: options flow score ${s.score > 0 ? "+" : ""}${s.score} (call premium $${(s.call / 1e6).toFixed(1)}M, put $${(s.put / 1e6).toFixed(1)}M); dealer gamma ${s.gex.regime}${s.gex.magnet ? `, largest positive strike ${s.gex.magnet}` : ""}${s.gex.pit ? `, largest negative strike ${s.gex.pit}` : ""}${s.gex.flip ? `, flips near ${s.gex.flip}` : ""}`);
      } catch { /* skip */ }
    }
    return lines.length ? `Options positioning (Cboe delayed 15 min; positive gamma tends to dampen moves and pin price near the largest strike, negative gamma tends to amplify them):\n${lines.join("\n")}\n\n` : "";
  } catch { return ""; }
}
