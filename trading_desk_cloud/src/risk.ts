// Hard risk layer: plain code decides, the AI only suggests. Everything here fails closed.
//   - regime classifier: CALM_TREND / SIDEWAYS / JUMPY / CRASH from trend strength, realized volatility and drawdown
//     speed of the index (SPY for stocks, BTC-USD for crypto), with a size multiplier per regime (CRASH = stay flat);
//   - kill switch (manual, or tripped by the max-drawdown guard): no automatic entries, and it flattens the account;
//   - stale-data check: no automatic entry when the latest bar is old while the market should be trading;
//   - fractional Kelly from the desk's own settled trades (quarter Kelly, capped), for sizing and for the dashboard;
//   - a decision log: every automatic entry that was blocked, with the reason.
import { candles, isCrypto } from "./market";
import { getSetting, setSetting } from "./db";

export type Regime = "CALM_TREND" | "SIDEWAYS" | "JUMPY" | "CRASH";
export const REGIME_SIZE: Record<Regime, number> = { CALM_TREND: 1, SIDEWAYS: 0.5, JUMPY: 0.5, CRASH: 0 };
export type RegimeRead = { regime: Regime; size_mult: number; trend: number; vol_ann: number; drawdown_pct: number; dd_speed: number; index: string; at: number; why: string };
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Classify from daily bars (needs about 60). Simple, explainable measures only. */
export function classifyRegime(bars: Bar[], index = "SPY"): RegimeRead {
  const at = Math.floor(Date.now() / 1000);
  if (bars.length < 30) return { regime: "SIDEWAYS", size_mult: REGIME_SIZE.SIDEWAYS, trend: 0, vol_ann: 0, drawdown_pct: 0, dd_speed: 0, index, at, why: "not enough history: treated as sideways" };
  const c = bars.map((b) => b.close), n = c.length;
  const rets = c.slice(1).map((v, i) => Math.log(v / c[i]));
  const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const vol20 = sd(rets.slice(-20)) * Math.sqrt(252) * 100, volLong = sd(rets.slice(-120)) * Math.sqrt(252) * 100 || vol20;
  // Trend strength: 20-day return divided by 20-day volatility (a t-stat-like efficiency), sign included.
  const ret20 = Math.log(c[n - 1] / c[Math.max(0, n - 21)]), trend = ret20 / ((sd(rets.slice(-20)) || 1e-9) * Math.sqrt(20));
  const peak = Math.max(...c.slice(-60)), dd = ((c[n - 1] - peak) / peak) * 100;
  const dd5 = ((c[n - 1] - Math.max(...c.slice(-6))) / Math.max(...c.slice(-6))) * 100; // drawdown speed: fall from the 5-day high
  const jumpy = vol20 > Math.max(volLong * 1.5, isCrypto(index) ? 70 : 22);
  let regime: Regime, why: string;
  if (dd5 <= (isCrypto(index) ? -15 : -6) || (dd <= (isCrypto(index) ? -30 : -12) && jumpy)) { regime = "CRASH"; why = `down ${r2(-dd5)}% from the 5-day high, ${r2(-dd)}% from the 60-day high`; }
  else if (jumpy) { regime = "JUMPY"; why = `20-day volatility ${r2(vol20)}% against ${r2(volLong)}% normal`; }
  else if (Math.abs(trend) >= 1) { regime = "CALM_TREND"; why = `20-day move is ${r2(Math.abs(trend))} sigma ${trend > 0 ? "up" : "down"} with volatility ${r2(vol20)}%`; }
  else { regime = "SIDEWAYS"; why = `20-day move only ${r2(Math.abs(trend))} sigma, volatility ${r2(vol20)}%`; }
  return { regime, size_mult: REGIME_SIZE[regime], trend: r2(trend), vol_ann: r2(vol20), drawdown_pct: r2(dd), dd_speed: r2(dd5), index, at, why };
}

/** The current regime for stocks (SPY) or crypto (BTC-USD), cached 15 minutes. Unknown data = SIDEWAYS (half size). */
export async function marketRegime(db: D1Database, crypto = false): Promise<RegimeRead> {
  const index = crypto ? "BTC-USD" : "SPY", key = `regime_${index}`;
  const cached = await getSetting<RegimeRead | null>(db, key, null);
  if (cached && Date.now() / 1000 - cached.at < 900) return cached;
  let read: RegimeRead;
  try { read = classifyRegime((await candles(index, "1d", 400)) as Bar[], index); }
  catch { read = { regime: "SIDEWAYS", size_mult: 0.5, trend: 0, vol_ann: 0, drawdown_pct: 0, dd_speed: 0, index, at: Math.floor(Date.now() / 1000), why: "index data unavailable: treated as sideways (half size)" }; }
  await setSetting(db, key, read);
  return read;
}

/** How often the classifier's label was followed by the behaviour it implies (a simple honesty check on past data). */
export function regimeAccuracy(bars: Bar[], index = "SPY") {
  let n = 0, wrong = 0; const counts: Record<string, number> = {};
  for (let i = 130; i < bars.length - 5; i += 5) {
    const r = classifyRegime(bars.slice(0, i + 1), index); counts[r.regime] = (counts[r.regime] || 0) + 1;
    const fwd = Math.abs(Math.log(bars[i + 5].close / bars[i].close)) * 100, limit = isCrypto(index) ? 8 : 3;
    // Wrong = a calm label followed by a big 5-day move, or a jumpy/crash label followed by a quiet week.
    const calm = r.regime === "CALM_TREND" || r.regime === "SIDEWAYS";
    if ((calm && fwd > limit) || (!calm && fwd < limit / 3)) wrong++;
    n++;
  }
  return { samples: n, wrong_pct: n ? r2((wrong / n) * 100) : null, counts };
}

/** Quarter Kelly from settled plans: f = p - (1 - p) / b, with b = average win / average loss in R. Capped at 2% of equity. */
export async function kellyRead(db: D1Database, days = 90) {
  let rows: { r_result: number }[] = [];
  try { rows = (await db.prepare("SELECT r_result FROM pick_outcomes WHERE symbol != '-' AND status IN ('win','loss','timed') AND r_result IS NOT NULL AND created_at >= ?").bind(Math.floor(Date.now() / 1000) - days * 86400).all<{ r_result: number }>()).results; } catch { rows = []; }
  const wins = rows.filter((r) => r.r_result > 0), losses = rows.filter((r) => r.r_result <= 0);
  if (rows.length < 20 || !wins.length || !losses.length) return { n: rows.length, kelly: null, quarter: null, risk_pct: null, p: null, b: null };
  const p = wins.length / rows.length, b = (wins.reduce((a, r) => a + r.r_result, 0) / wins.length) / Math.max(0.01, -losses.reduce((a, r) => a + r.r_result, 0) / losses.length);
  const f = p - (1 - p) / b;
  return { n: rows.length, kelly: r2(f * 100), quarter: r2(Math.max(0, f / 4) * 100), risk_pct: r2(Math.min(2, Math.max(0, f / 4) * 100)), p: r2(p * 100), b: r2(b) };
}

let logReady = false;
export async function riskLog(db: D1Database, user: string, symbol: string, action: string, reason: string) {
  try {
    if (!logReady) { await db.prepare("CREATE TABLE IF NOT EXISTS risk_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user TEXT NOT NULL, symbol TEXT, action TEXT NOT NULL, reason TEXT NOT NULL)").run(); logReady = true; }
    // One line per user/symbol/reason per 10 minutes is enough.
    const dup = await db.prepare("SELECT 1 FROM risk_log WHERE user = ? AND symbol = ? AND reason = ? AND at > ? LIMIT 1").bind(user, symbol, reason, Math.floor(Date.now() / 1000) - 600).first();
    if (!dup) await db.prepare("INSERT INTO risk_log (at, user, symbol, action, reason) VALUES (?, ?, ?, ?, ?)").bind(Math.floor(Date.now() / 1000), user, symbol, action, reason.slice(0, 200)).run();
  } catch { /* logging must never break trading logic */ }
}
export async function recentRiskLog(db: D1Database, user: string, limit = 30) {
  try { return (await db.prepare("SELECT at, symbol, action, reason FROM risk_log WHERE user = ? ORDER BY id DESC LIMIT ?").bind(user, limit).all()).results; } catch { return []; }
}

// ------------------------------------------------------------------------------------------ portfolio risk
// Value at risk, expected shortfall and correlation, by historical simulation: take the last year of daily returns
// of each holding, apply today's weights, and read the bad days off the result. No distribution is assumed.
export type PortfolioRisk = {
  basis: "positions" | "watchlist"; symbols: string[]; days: number; exposure_usd: number; equity: number;
  var95_pct: number; var99_pct: number; es95_pct: number; var95_usd: number; es95_usd: number; worst_day_pct: number; vol_ann_pct: number; beta: number | null; max_dd_pct: number;
  weights: { symbol: string; weight: number; side: string }[];
  corr: { symbols: string[]; matrix: number[][]; avg_now: number | null; avg_year: number | null; together: boolean; note: string };
};
const pearson = (a: number[], b: number[]) => { const n = Math.min(a.length, b.length); if (n < 10) return NaN; let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; } const ma = sa / n, mb = sb / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va && vb ? c / Math.sqrt(va * vb) : NaN; };
/** Pure calculation, so it can be tested: holdings as signed dollar amounts, closes per symbol keyed by day. */
export function riskFrom(holdings: { symbol: string; usd: number }[], closes: Record<string, { day: string; close: number }[]>, equity: number, benchmark = "SPY", basis: "positions" | "watchlist" = "positions"): PortfolioRisk | null {
  const syms = holdings.map((h) => h.symbol).filter((s) => (closes[s] || []).length > 60); if (!syms.length) return null;
  // Days every holding traded (crypto trades at weekends; stocks do not), most recent 250 of them.
  let days = closes[syms[0]].map((c) => c.day); for (const s of syms.slice(1)) { const set = new Set(closes[s].map((c) => c.day)); days = days.filter((d) => set.has(d)); }
  days = days.slice(-251); if (days.length < 40) return null;
  const ret: Record<string, number[]> = {}; for (const s of [...syms, benchmark]) { const m = new Map((closes[s] || []).map((c) => [c.day, c.close])); ret[s] = days.slice(1).map((d, i) => { const a = m.get(days[i]), b = m.get(d); return a && b ? b / a - 1 : 0; }); }
  const gross = holdings.filter((h) => syms.includes(h.symbol)).reduce((q, h) => q + Math.abs(h.usd), 0) || 1, base = Math.max(equity, gross);
  const w = holdings.filter((h) => syms.includes(h.symbol)).map((h) => ({ symbol: h.symbol, weight: h.usd / base, side: h.usd >= 0 ? "long" : "short" }));
  const port = ret[syms[0]].map((_, i) => w.reduce((q, x) => q + x.weight * ret[x.symbol][i], 0)), sorted = port.slice().sort((a, b) => a - b), n = sorted.length;
  const q = (p: number) => sorted[Math.max(0, Math.floor(n * p) - 0)] ?? sorted[0], v95 = -q(0.05), v99 = -q(0.01), tail = sorted.slice(0, Math.max(1, Math.floor(n * 0.05))), es = -tail.reduce((a, b) => a + b, 0) / tail.length;
  const mean = port.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(port.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  let eq = 1, pk = 1, dd = 0; for (const r of port) { eq *= 1 + r; if (eq > pk) pk = eq; dd = Math.max(dd, (pk - eq) / pk); }
  const bm = ret[benchmark] || [], vb = bm.length ? bm.reduce((a, b) => a + (b - bm.reduce((x, y) => x + y, 0) / bm.length) ** 2, 0) / bm.length : 0, rho = pearson(port, bm), beta = vb && !Number.isNaN(rho) ? (rho * sd) / Math.sqrt(vb) : null;
  const r3 = (v: number) => Math.round(v * 1e3) / 1e3, pct = (v: number) => Math.round(v * 1e4) / 100;
  const cs = syms.slice(0, 10), matrix = cs.map((a) => cs.map((b) => (a === b ? 1 : r3(pearson(ret[a], ret[b]))))), avgOf = (len: number) => { const v: number[] = []; for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const c = pearson(ret[cs[i]].slice(-len), ret[cs[j]].slice(-len)); if (!Number.isNaN(c)) v.push(c); } return v.length ? r3(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const now = avgOf(20), year = avgOf(250), together = now != null && year != null && (now >= 0.7 || now - year >= 0.2);
  return { basis, symbols: syms, days: n, exposure_usd: Math.round(gross), equity: Math.round(equity), var95_pct: pct(v95), var99_pct: pct(v99), es95_pct: pct(es), var95_usd: Math.round(v95 * base), es95_usd: Math.round(es * base), worst_day_pct: pct(-sorted[0]), vol_ann_pct: pct(sd * Math.sqrt(252)), beta: beta == null ? null : r3(beta), max_dd_pct: pct(dd), weights: w.map((x) => ({ ...x, weight: r3(x.weight) })),
    corr: { symbols: cs, matrix, avg_now: now, avg_year: year, together, note: cs.length < 2 ? "One holding: nothing to correlate." : together ? `Your holdings are moving together (average correlation ${now} over the last month against ${year} over the year): diversification is not protecting you right now.` : `Average correlation ${now ?? "n/a"} over the last month, ${year ?? "n/a"} over the year: holdings are behaving normally relative to each other.` } };
}
/** Risk of the open paper positions; with none open, of an equal-weight basket of the watchlist (what it WOULD be). */
export async function portfolioRisk(positions: { symbol: string; side: string; qty: number; entry: number; last?: number | null }[], watchlist: string[], equity: number): Promise<PortfolioRisk | null> {
  const basis = positions.length ? "positions" as const : "watchlist" as const;
  const holdings = positions.length ? positions.slice(0, 15).map((p) => ({ symbol: p.symbol, usd: (p.side === "short" ? -1 : 1) * p.qty * (p.last || p.entry) })) : watchlist.slice(0, 8).map((s) => ({ symbol: s.toUpperCase(), usd: equity / Math.max(1, Math.min(8, watchlist.length)) }));
  const closes: Record<string, { day: string; close: number }[]> = {}, bench = holdings.every((h) => isCrypto(h.symbol)) ? "BTC-USD" : "SPY";
  await Promise.all([...new Set([...holdings.map((h) => h.symbol), bench])].map(async (s) => { try { closes[s] = ((await candles(s, "1d", 400)) as { time: number; close: number }[]).map((b) => ({ day: new Date(b.time * 1000).toISOString().slice(0, 10), close: b.close })); } catch { closes[s] = []; } }));
  return riskFrom(holdings, closes, equity, bench, basis);
}
