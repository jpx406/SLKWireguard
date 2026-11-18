// Deep Analysis scorecard: was the rating right? Every finished run keeps the price it was made at and is checked
// 5, 10 and 20 trading sessions later. The hit rate per rating type is shown on the Deep Analysis page and decides
// how much weight a Deep Analysis plan gets when the chart autopilot trades it:
//   fewer than 10 scored bullish ratings  -> half size (unproven)
//   10 or more with under 45% right       -> not traded
//   10 or more with 55% or more right     -> full size, otherwise half size
// A "hit": Buy / Overweight and the price is higher; Sell / Underweight and it is lower; Hold and it moved under 3%.
import { candles, latestPrice } from "./market";

type Bar = { time: number; close: number };
type Run = { id: string; symbol: string; day: string; rating: string | null; price_at_run: number | null; r5: number | null; r10: number | null; r20: number | null };
let ready = false;
export async function ensureDeepScore(db: D1Database) {
  if (ready) return;
  for (const c of ["price_at_run REAL", "r5 REAL", "r10 REAL", "r20 REAL", "scored_at INTEGER"]) { try { await db.prepare(`ALTER TABLE deep_runs ADD COLUMN ${c}`).run(); } catch { /* exists, or the table is not there yet */ } }
  ready = true;
}
/** Called when a run finishes: remember the price the rating was made at. */
export async function stampPrice(db: D1Database, id: string, symbol: string) {
  try { await ensureDeepScore(db); const px = await latestPrice(symbol); if (px > 0) await db.prepare("UPDATE deep_runs SET price_at_run = ? WHERE id = ? AND price_at_run IS NULL").bind(px, id).run(); } catch { /* scored from the daily close instead */ }
}
/** Returns after 5 / 10 / 20 sessions for one run, from daily closes. Pure. */
export function forwardReturns(daily: Bar[], day: string, priceAtRun: number | null): { base: number | null; r5: number | null; r10: number | null; r20: number | null } {
  const dOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10), i = daily.findIndex((b) => dOf(b.time) >= day);
  if (i < 0) return { base: priceAtRun, r5: null, r10: null, r20: null };
  const base = priceAtRun && priceAtRun > 0 ? priceAtRun : daily[i].close, at = (k: number) => (i + k < daily.length ? Math.round((daily[i + k].close / base - 1) * 1e4) / 100 : null);
  return { base, r5: at(5), r10: at(10), r20: at(20) };
}
export const isHit = (rating: string, r: number) => (/^(buy|overweight)$/i.test(rating) ? r > 0 : /^(sell|underweight)$/i.test(rating) ? r < 0 : Math.abs(r) < 3);
/** Score the runs whose horizons have passed (a few per call: each needs one daily-bars request). */
export async function scoreDeep(db: D1Database, limit = 6) {
  await ensureDeepScore(db);
  let rows: Run[] = [];
  try { rows = (await db.prepare("SELECT id, symbol, day, rating, price_at_run, r5, r10, r20 FROM deep_runs WHERE status = 'done' AND rating IS NOT NULL AND r20 IS NULL AND day <= date('now', '-6 days') AND day >= date('now', '-200 days') ORDER BY COALESCE(scored_at, 0), day LIMIT ?").bind(limit).all<Run>()).results; } catch { return 0; }
  let n = 0; const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    try {
      const age = Math.ceil((Date.now() - Date.parse(`${r.day}T00:00:00Z`)) / 86400000);
      const f = forwardReturns((await candles(r.symbol, "1d", age + 10)) as Bar[], r.day, r.price_at_run);
      await db.prepare("UPDATE deep_runs SET price_at_run = COALESCE(price_at_run, ?), r5 = ?, r10 = ?, r20 = ?, scored_at = ? WHERE id = ?").bind(f.base, f.r5, f.r10, f.r20, now, r.id).run(); n++;
    } catch { await db.prepare("UPDATE deep_runs SET scored_at = ? WHERE id = ?").bind(now, r.id).run(); }
  }
  return n;
}
export type DeepGate = { mult: number; n: number; hit_pct: number | null; text: string };
export function gateFrom(n: number, hits: number): DeepGate {
  const hp = n ? Math.round((hits / n) * 100) : null;
  if (n < 10) return { mult: 0.5, n, hit_pct: hp, text: `Only ${n} bullish ratings have been checked after 5 sessions (10 needed): Deep Analysis plans trade at half size until the record exists.` };
  if (hp! < 45) return { mult: 0, n, hit_pct: hp, text: `Bullish ratings were right ${hp}% of the time after 5 sessions (${n} checked): Deep Analysis plans are not auto-traded.` };
  if (hp! >= 55) return { mult: 1, n, hit_pct: hp, text: `Bullish ratings were right ${hp}% of the time after 5 sessions (${n} checked): full size.` };
  return { mult: 0.5, n, hit_pct: hp, text: `Bullish ratings were right ${hp}% of the time after 5 sessions (${n} checked): half size until it reaches 55%.` };
}
export async function deepScorecard(db: D1Database) {
  await ensureDeepScore(db);
  let rows: Run[] = [];
  try { rows = (await db.prepare("SELECT id, symbol, day, rating, price_at_run, r5, r10, r20 FROM deep_runs WHERE status = 'done' AND rating IS NOT NULL AND day >= date('now', '-365 days') ORDER BY day DESC LIMIT 500").all<Run>()).results; } catch { rows = []; }
  const order = ["Buy", "Overweight", "Hold", "Underweight", "Sell"], cell = (rs: Run[], k: "r5" | "r10" | "r20") => { const v = rs.filter((r) => r[k] !== null); const hits = v.filter((r) => isHit(r.rating!, r[k]!)).length;
    return { n: v.length, hit_pct: v.length ? Math.round((hits / v.length) * 100) : null, avg_pct: v.length ? Math.round((v.reduce((a, r) => a + r[k]!, 0) / v.length) * 100) / 100 : null }; };
  const by = order.map((rating) => { const rs = rows.filter((r) => r.rating === rating); return { rating, runs: rs.length, d5: cell(rs, "r5"), d10: cell(rs, "r10"), d20: cell(rs, "r20") }; }).filter((x) => x.runs);
  const bull = rows.filter((r) => /^(Buy|Overweight)$/.test(r.rating || "") && r.r5 !== null), gate = gateFrom(bull.length, bull.filter((r) => r.r5! > 0).length);
  return { runs: rows.length, scored: rows.filter((r) => r.r5 !== null).length, by, gate,
    recent: rows.slice(0, 30).map((r) => ({ symbol: r.symbol, day: r.day, rating: r.rating, price: r.price_at_run, r5: r.r5, r10: r.r10, r20: r.r20 })),
    note: "A rating counts as right when the price went the way it said: up for Buy / Overweight, down for Sell / Underweight, within 3% for Hold. Small samples say little: the hit rate is shown with how many ratings it rests on." };
}
export async function deepGate(db: D1Database): Promise<DeepGate> { try { return (await deepScorecard(db)).gate; } catch { return gateFrom(0, 0); } }
