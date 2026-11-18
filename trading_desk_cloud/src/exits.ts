// Exit engine: code decides how far away a stop has to be, the AI only suggests where.
// Why it exists. Measured on 12,000 candle signals and 1,400 opening-range breakouts in 59 days of 5-minute bars on
// 30 large US stocks, and on 7,000 daily-bar entries over six years (see the README, "Exit engine"):
//   · a stop "just beyond the pattern" (about 0.4% away) was hit 57% of the time and cost 0.20R per trade; the same
//     entries with the stop at 0.35 of the daily ATR were hit 18% of the time and cost 0.05R. The entry was the
//     same; the tight stop only turned noise and trading costs into losses.
//   · moving the stop to break-even, or trailing it, did not help in any test.
//   · on daily bars, longs held about 20 sessions behind a stop 2 ATR away were positive; shorts were negative, and
//     trailing stops and early targets gave most of the gain back.
// So: every automatic entry gets a stop no closer than a multiple of the symbol's daily ATR (the position is made
// smaller to keep the dollars at risk the same), a target no closer than a multiple of that risk, swing trades get
// a time limit, and the multiples are re-fitted from the desk's own settled plans (calibrateExits), inside fixed
// bounds, only when the evidence beats sampling error on old AND recent plans.
import { candles } from "./market";
import { getSetting, setSetting } from "./db";

export type Horizon = "day" | "swing";
export type ExitPolicy = {
  day_stop_atr: number;      // day trade: stop at least this many daily ATRs from the entry
  swing_stop_atr: number;    // swing trade: same, in daily ATRs
  day_min_rr: number;        // day trade: target at least this many times the risk
  swing_min_rr: number;
  swing_hold_days: number;   // sessions a swing trade may stay open before it is closed at the market
  swing_long_only: boolean;  // automatic swing entries on the long side only
  edge_guard: boolean;       // pause automatic entries of a horizon whose own settled plans are losing beyond chance
  auto_learn: boolean;       // let calibrateExits move the two stop multiples
};
export const DEFAULT_EXIT: ExitPolicy = { day_stop_atr: 0.35, swing_stop_atr: 2, day_min_rr: 1.5, swing_min_rr: 3, swing_hold_days: 20, swing_long_only: true, edge_guard: true, auto_learn: true };
// What calibration may choose from. 0 = "as the plan said" (kept only to measure it; it is never chosen).
export const VARIANTS: Record<Horizon, number[]> = { day: [0, 0.25, 0.35, 0.5, 0.75], swing: [0, 1.5, 2, 3] };
const BOUNDS = { day_stop_atr: [0.2, 1], swing_stop_atr: [1, 4], day_min_rr: [1, 4], swing_min_rr: [1, 6], swing_hold_days: [3, 40] } as const;
const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const r2 = (n: number) => Math.round(n * 100) / 100, r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function sanitizeExit(x: unknown, base: ExitPolicy = DEFAULT_EXIT): ExitPolicy {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>, b = (k: keyof ExitPolicy) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (base[k] as boolean));
  return { day_stop_atr: r2(clamp(o.day_stop_atr, ...BOUNDS.day_stop_atr, base.day_stop_atr)), swing_stop_atr: r2(clamp(o.swing_stop_atr, ...BOUNDS.swing_stop_atr, base.swing_stop_atr)),
    day_min_rr: r2(clamp(o.day_min_rr, ...BOUNDS.day_min_rr, base.day_min_rr)), swing_min_rr: r2(clamp(o.swing_min_rr, ...BOUNDS.swing_min_rr, base.swing_min_rr)),
    swing_hold_days: Math.round(clamp(o.swing_hold_days, ...BOUNDS.swing_hold_days, base.swing_hold_days)), swing_long_only: b("swing_long_only"), edge_guard: b("edge_guard"), auto_learn: b("auto_learn") };
}
export type Learned = { at: number; day?: Fit; swing?: Fit };
export type Fit = { chosen: number | null; n: number; reason: string; table: { mult: number; n: number; stopped_pct: number; win_pct: number; avg_r: number; avg_r_recent: number | null }[] };
/** The policy in force: defaults, then what calibration learned (if allowed), then what the admin fixed by hand. */
export async function exitPolicy(db: D1Database): Promise<ExitPolicy & { source: { day: string; swing: string } }> {
  const user = await getSetting<Partial<ExitPolicy> | null>(db, "exit_policy_user", null), learned = await getSetting<Learned | null>(db, "exit_policy_learned", null);
  let p = sanitizeExit(user || {}); const source = { day: "default (measured on market data)", swing: "default (measured on market data)" };
  if (p.auto_learn && learned) {
    if (learned.day?.chosen) { p = sanitizeExit({ ...p, day_stop_atr: learned.day.chosen }, p); source.day = `learned from ${learned.day.n} of the desk's own plans`; }
    if (learned.swing?.chosen) { p = sanitizeExit({ ...p, swing_stop_atr: learned.swing.chosen }, p); source.swing = `learned from ${learned.swing.n} of the desk's own plans`; }
  }
  if (user && !p.auto_learn) { source.day = "set by hand"; source.swing = "set by hand"; }
  return { ...p, source };
}

type Bar = { time: number; open: number; high: number; low: number; close: number };
/** Wilder ATR(14) of daily bars, as known at the close of the last bar strictly before `beforeDay` (YYYY-MM-DD, UTC). */
export function atrAsOf(daily: Bar[], beforeDay?: string): number | null {
  const bars = beforeDay ? daily.filter((b) => new Date(b.time * 1000).toISOString().slice(0, 10) < beforeDay) : daily;
  if (bars.length < 16) return null; let a: number | null = null;
  for (let i = 1; i < bars.length; i++) { const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); a = a === null ? tr : (a * 13 + tr) / 14; }
  return a;
}
const atrCache = new Map<string, { at: number; atr: number | null }>();
/** Today's daily ATR for a symbol from completed days only (cached 30 minutes). null when it cannot be known. */
export async function dailyAtr(symbol: string, today?: string): Promise<number | null> {
  const hit = atrCache.get(symbol); if (hit && Date.now() - hit.at < 1800_000) return hit.atr;
  let atr: number | null = null;
  try { atr = atrAsOf((await candles(symbol, "1d", 60)) as Bar[], today ?? new Date().toISOString().slice(0, 10)); } catch { atr = null; }
  atrCache.set(symbol, { at: Date.now(), atr }); return atr;
}

export type Plan = { side: "long" | "short"; entry: number; stop: number; target: number | null; horizon: Horizon };
export type Adjusted = { stop: number; target: number | null; risk: number; widened: boolean; target_moved: boolean; stop_atr: number | null; note: string };
/** Apply the policy to one plan. The stop only ever moves AWAY from the entry; the target only ever moves away too. */
export function applyExit(p: Plan, atr: number | null, pol: ExitPolicy, mult?: number): Adjusted {
  const long = p.side === "long", sg = long ? 1 : -1, planRisk = Math.abs(p.entry - p.stop), m = mult ?? (p.horizon === "swing" ? pol.swing_stop_atr : pol.day_stop_atr), minRR = p.horizon === "swing" ? pol.swing_min_rr : pol.day_min_rr;
  // Without an ATR the plan's own stop stands, but never closer than 0.3% (day) or 2% (swing) of the price.
  const floor = atr && atr > 0 ? m * atr : p.entry * (p.horizon === "swing" ? 0.02 : 0.003) * (mult === 0 ? 0 : 1);
  const risk = Math.max(planRisk, floor), widened = risk > planRisk * 1.001, stop = p.entry - sg * risk;
  const planT = p.target === null ? 0 : sg * (p.target - p.entry), tDist = Math.max(planT, mult === 0 ? 0 : minRR * risk), target_moved = tDist > planT * 1.001 && tDist > 0;
  const target = tDist > 0 ? p.entry + sg * tDist : null, dp = p.entry >= 5 ? 2 : 4, rd = (v: number) => Math.round(v * 10 ** dp) / 10 ** dp;
  return { stop: rd(stop), target: target === null ? null : rd(target), risk, widened, target_moved, stop_atr: atr ? r2(risk / atr) : null,
    note: widened ? `stop widened from ${rd(p.stop)} to ${rd(stop)} (${atr ? `${m} × daily ATR ${rd(atr)}` : "minimum distance"})${target_moved ? `, target moved to ${rd(target!)} (${minRR}R)` : ""}` : target_moved ? `target moved to ${rd(target!)} (${minRR}R)` : "" };
}

// ------------------------------------------------------------------------------------------- learning from the desk's own plans
let ready = false;
export async function ensureExits(db: D1Database) {
  if (ready) return;
  // One row per settled plan and stop multiple: what the same plan would have done with that stop.
  await db.prepare(`CREATE TABLE IF NOT EXISTS pick_exits (id TEXT NOT NULL, mult REAL NOT NULL, horizon TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, r REAL, PRIMARY KEY (id, mult))`).run();
  ready = true;
}
type XRow = { id: string; mult: number; horizon: Horizon; created_at: number; status: string; r: number | null };
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
const se = (v: number[]) => { const m = mean(v); return v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1) / v.length) : Infinity; };
/** Pick the stop multiple for one horizon. Pure, so it can be tested: rows = every (plan, multiple) result. */
export function fitExits(rows: XRow[], horizon: Horizon, current: number, minPlans = 40): Fit {
  const mults = VARIANTS[horizon], byId = new Map<string, Map<number, XRow>>();
  for (const r of rows) if (r.horizon === horizon && r.r !== null && ["win", "loss", "timed"].includes(r.status)) { if (!byId.has(r.id)) byId.set(r.id, new Map()); byId.get(r.id)!.set(r.mult, r); }
  // Only plans that have a result for every multiple, oldest first, so every column is the same set of trades.
  const full = [...byId.values()].filter((m) => mults.every((k) => m.has(k))).sort((a, b) => a.get(mults[0])!.created_at - b.get(mults[0])!.created_at);
  const n = full.length, cut = Math.floor(n * 0.7), col = (k: number, from = 0, to = n) => full.slice(from, to).map((m) => m.get(k)!.r as number);
  const table = mults.map((k) => { const all = full.map((m) => m.get(k)!); return { mult: k, n, stopped_pct: n ? Math.round((all.filter((x) => x.status === "loss").length / n) * 100) : 0, win_pct: n ? Math.round((all.filter((x) => (x.r as number) > 0).length / n) * 100) : 0, avg_r: n ? r4(mean(col(k))) : 0, avg_r_recent: n - cut >= 8 ? r4(mean(col(k, cut))) : null }; });
  if (n < minPlans) return { chosen: null, n, reason: `${n} settled plans with a full replay; ${minPlans} are needed before the desk changes its own stop distance.`, table };
  const cand = mults.filter((k) => k > 0), base = cand.includes(current) ? current : cand.reduce((a, k) => (Math.abs(k - current) < Math.abs(a - current) ? k : a), cand[0]);
  // Chosen on the older 70%; it must also beat the current setting on the newer 30%, and by more than twice the sampling error of the paired difference overall.
  const best = cand.reduce((a, k) => (mean(col(k, 0, cut)) > mean(col(a, 0, cut)) ? k : a), base);
  if (best === base) return { chosen: null, n, reason: `The current ${base} × ATR is already the best on the older plans.`, table };
  const diffAll = full.map((m) => (m.get(best)!.r as number) - (m.get(base)!.r as number)), dNew = mean(col(best, cut)) - mean(col(base, cut)), z = mean(diffAll) / (se(diffAll) || Infinity);
  if (dNew <= 0) return { chosen: null, n, reason: `${best} × ATR was better on the older plans but not on the most recent ones: no change.`, table };
  if (z < 2) return { chosen: null, n, reason: `${best} × ATR looks better by ${r4(mean(diffAll))}R per plan, but that is within sampling error (z ${r2(z)}): no change.`, table };
  return { chosen: best, n, reason: `${best} × ATR beat ${base} × ATR by ${r4(mean(diffAll))}R per plan on old and recent plans alike (z ${r2(z)}).`, table };
}
export async function calibrateExits(db: D1Database): Promise<Learned> {
  await ensureExits(db);
  const since = Math.floor(Date.now() / 1000) - 180 * 86400, rows = (await db.prepare("SELECT id, mult, horizon, created_at, status, r FROM pick_exits WHERE created_at >= ?").bind(since).all<XRow>()).results;
  const user = sanitizeExit((await getSetting<Partial<ExitPolicy> | null>(db, "exit_policy_user", null)) || {});
  const learned: Learned = { at: Math.floor(Date.now() / 1000), day: fitExits(rows, "day", user.day_stop_atr), swing: fitExits(rows, "swing", user.swing_stop_atr) };
  await setSetting(db, "exit_policy_learned", learned); return learned;
}

export type Edge = { horizon: Horizon; n: number; avg_r: number | null; se: number | null; recent_n: number; recent_avg_r: number | null; paused: boolean; text: string };
/** Is this horizon losing beyond chance? Pure. rs = settled results in R, oldest first (last 60 days). */
export function edgeOf(horizon: Horizon, rs: number[]): Edge {
  const n = rs.length, avg = n ? mean(rs) : null, s = n > 1 ? se(rs) : null, rec = rs.slice(-20), ra = rec.length ? mean(rec) : null;
  // Paused only on real evidence: 30+ plans, the average below zero by more than two standard errors, and the last 20 still negative.
  const paused = n >= 30 && avg !== null && s !== null && avg + 2 * s < 0 && ra !== null && ra < 0;
  const what = horizon === "day" ? "Day-trade" : "Swing";
  return { horizon, n, avg_r: avg === null ? null : r4(avg), se: s === null || !Number.isFinite(s) ? null : r4(s), recent_n: rec.length, recent_avg_r: ra === null ? null : r4(ra), paused,
    text: n < 30 ? `${what} plans: ${n} settled in 60 days, too few to judge (30 needed). Trading normally.` : paused ? `${what} plans are losing beyond chance (${r2(avg!)}R per plan over ${n}, last 20: ${r2(ra!)}R). Automatic ${horizon} entries are paused; plans are still scored, and entries resume when the last 20 turn positive.`
      : `${what} plans: ${r2(avg!)}R per plan over ${n} (last 20: ${r2(ra!)}R). Trading normally.` };
}
/** The guard for both horizons, from the plans as the desk would have traded them (policy stop), else as recommended. */
export async function edgeStatus(db: D1Database): Promise<Record<Horizon, Edge>> {
  await ensureExits(db);
  const since = Math.floor(Date.now() / 1000) - 60 * 86400, pol = await exitPolicy(db), out = {} as Record<Horizon, Edge>;
  for (const h of ["day", "swing"] as Horizon[]) {
    let rs: number[] = [];
    try {
      rs = (await db.prepare(`SELECT COALESCE((SELECT x.r FROM pick_exits x WHERE x.id = o.id AND x.mult = ? AND x.status IN ('win','loss','timed')), o.r_result) AS r FROM pick_outcomes o
        WHERE o.horizon = ? AND o.symbol != '-' AND o.status IN ('win','loss','timed') AND o.r_result IS NOT NULL AND o.created_at >= ? ORDER BY o.created_at`).bind(h === "day" ? pol.day_stop_atr : pol.swing_stop_atr, h, since).all<{ r: number }>()).results.map((x) => x.r);
    } catch { rs = []; }
    out[h] = edgeOf(h, rs);
  }
  return out;
}
export async function exitsView(db: D1Database) {
  const policy = await exitPolicy(db);
  return { policy, defaults: DEFAULT_EXIT, bounds: BOUNDS, learned: await getSetting<Learned | null>(db, "exit_policy_learned", null), edge: await edgeStatus(db) };
}
/** Text for the scans: the stop rule the desk will enforce, so the plans are written to it instead of being rewritten. */
export async function exitPrompt(db: D1Database): Promise<string> {
  const p = await exitPolicy(db);
  return `STOP AND TARGET RULES (enforced by the desk's code on every automatic entry; write your plans to them):
- Day trade: the stop is at least ${p.day_stop_atr} × the stock's DAILY ATR(14) from the entry, placed beyond the structure (not just beyond the last candle). A stop closer than that is noise: on this desk's measurements such stops were hit more than half the time. Target at least ${p.day_min_rr}R. Give "atr_pct" for every pick.
- Swing trade: the stop is at least ${p.swing_stop_atr} × the daily ATR from the entry; first target at least ${p.swing_min_rr}R; the trade is closed after ${p.swing_hold_days} sessions if neither is hit.${p.swing_long_only ? " Swing shorts are not auto-traded: prefer long setups in up-trends (price above a rising 50-day average)." : ""}
- Do not plan to move the stop to break-even or trail it tightly: in testing that reduced results. Size from the stop distance, never the other way round.
- If the stop the chart needs is closer than the minimum, the setup is too tight for the stock's volatility: use the minimum and a smaller size, or skip it.`;
}
