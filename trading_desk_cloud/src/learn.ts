// Learning loop: every recommendation and every paper trade is replayed against the bars that came AFTER it
// (walk-forward, no look-ahead), scored in R, grouped by what it had in common with others (scan, setup,
// source, score, hour, horizon, candle pattern), and turned into (1) a "playbook" the scans read before
// recommending, (2) pattern reliability tables the chart autopilot and the signal chips use, and (3) a
// backtester for the candle-signal rule. Conservative fills: stop before target in the same bar, entry at the
// bar's open when it gaps through the level, time exits at the session close. Paper only.
import "../public/candles.js";
import { candles, isCrypto } from "./market";
import { clockNow, nyNow, nextTradingDate, sessionTimes, isTradingDay } from "./briefs";
import { getSetting, getSettings, setSetting } from "./db";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Hit = { index: number; time: number; pattern: string; label: string; dir: "bullish" | "bearish"; bars: number; trend: string; volume: boolean; strength: number; strong: boolean };
const Candles = () => (globalThis as unknown as { TDCandles: { detect(bars: Bar[], opts?: Record<string, unknown>): Hit[]; LABELS: Record<string, string> } }).TDCandles;

export type Outcome = {
  id: string; brief_id: string; slot: string; day: string; symbol: string; side: "long" | "short"; horizon: "day" | "swing";
  setup: string | null; score: number | null; sources: string | null; entry: number; stop: number; target: number | null;
  created_at: number; status: "pending" | "open" | "no_trigger" | "win" | "loss" | "timed" | "expired";
  fill: number | null; triggered_at: number | null; exit_at: number | null; exit_price: number | null; r_result: number | null;
  mfe_r: number | null; mae_r: number | null; next_check: number; updated_at: number; regime?: string | null;
};

const nowS = () => Math.floor(clockNow().getTime() / 1000);
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const DAY_CHECK = 15 * 60, SWING_CHECK = 60 * 60, MAX_LOOKBACK_DAYS = 55; // 5-minute bars reach back 59 days at the providers

let ready = false;
export async function ensureLearn(db: D1Database) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS pick_outcomes (id TEXT PRIMARY KEY, brief_id TEXT NOT NULL, slot TEXT NOT NULL, day TEXT NOT NULL, symbol TEXT NOT NULL,
    side TEXT NOT NULL, horizon TEXT NOT NULL, setup TEXT, score REAL, sources TEXT, entry REAL NOT NULL, stop REAL NOT NULL, target REAL, created_at INTEGER NOT NULL,
    status TEXT NOT NULL, fill REAL, triggered_at INTEGER, exit_at INTEGER, exit_price REAL, r_result REAL, mfe_r REAL, mae_r REAL, next_check INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS pick_outcomes_status ON pick_outcomes (status, next_check)").run();
  try { await db.prepare("ALTER TABLE pick_outcomes ADD COLUMN regime TEXT").run(); } catch { /* exists */ }
  await db.prepare(`CREATE TABLE IF NOT EXISTS pattern_stats (symbol TEXT NOT NULL, interval TEXT NOT NULL, pattern TEXT NOT NULL, dir TEXT NOT NULL,
    n INTEGER NOT NULL, wins INTEGER NOT NULL, sum_r REAL NOT NULL, n_oos INTEGER NOT NULL, wins_oos INTEGER NOT NULL, sum_r_oos REAL NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, interval, pattern))`).run();
  ready = true;
}

// ------------------------------------------------------------------------------------------- replay
/** Replay one plan on the bars after it was made. Returns the fields to store. */
export function replay(o: { side: "long" | "short"; horizon: "day" | "swing"; entry: number; stop: number; target: number | null; created_at: number; day: string; symbol?: string }, bars: Bar[], now = nowS()) {
  const long = o.side === "long", risk = Math.abs(o.entry - o.stop);
  if (!(risk > 0)) return { status: "expired" as const };
  // Entry window: a day plan until that session's close; a swing plan for three sessions. Trade window: the
  // session close (day) or ten sessions (swing).
  const closeOf = (date: string) => { const [y, m, d] = date.split("-").map(Number); return Date.UTC(y, m - 1, d) / 1000 + sessionTimes(date).close * 60 + nyOffset(date); };
  let entryEnd = closeOf(o.day), d = o.day;
  if (o.horizon === "swing") { for (let i = 0; i < 2; i++) d = nextTradingDate(d); entryEnd = closeOf(d); }
  let tradeEnd = closeOf(o.day); d = o.day;
  if (o.horizon === "swing") { for (let i = 0; i < 9; i++) d = nextTradingDate(d); tradeEnd = closeOf(d); }
  if (o.symbol && isCrypto(o.symbol)) { entryEnd = o.created_at + (o.horizon === "swing" ? 3 : 1) * 86400; tradeEnd = o.created_at + (o.horizon === "swing" ? 10 : 1) * 86400; } // 24/7: clock windows
  const after = bars.filter((b) => b.time >= o.created_at && b.time + 300 <= now);
  if (!after.length) return { status: (now > entryEnd ? "no_trigger" : "pending") as "no_trigger" | "pending" };
  let fill: number | null = null, triggered_at: number | null = null, i = 0;
  for (; i < after.length; i++) {
    const b = after[i];
    if (b.time > entryEnd) return { status: "no_trigger" as const };
    if (long ? b.low <= o.entry : b.high >= o.entry) { fill = long ? Math.min(o.entry, b.open) : Math.max(o.entry, b.open); triggered_at = b.time; break; }
  }
  if (fill === null) return { status: (now > entryEnd ? "no_trigger" : "pending") as "no_trigger" | "pending" };
  const R = (px: number) => ((px - fill!) * (long ? 1 : -1)) / risk;
  let mfe = 0, mae = 0, last: Bar | null = null;
  for (let j = i; j < after.length; j++) {
    const b = after[j]; last = b;
    if (b.time > tradeEnd) break;
    mfe = Math.max(mfe, R(long ? b.high : b.low)); mae = Math.min(mae, R(long ? b.low : b.high));
    // Conservative: when one bar touches both the stop and the target, the stop counts.
    if (long ? b.low <= o.stop : b.high >= o.stop) { const px = long ? Math.min(o.stop, b.open) : Math.max(o.stop, b.open); return { status: "loss" as const, fill, triggered_at, exit_at: b.time, exit_price: px, r_result: r2(R(px)), mfe_r: r2(mfe), mae_r: r2(mae) }; }
    if (o.target !== null && (long ? b.high >= o.target : b.low <= o.target)) { const px = long ? Math.max(o.target, b.open) : Math.min(o.target, b.open); return { status: "win" as const, fill, triggered_at, exit_at: b.time, exit_price: px, r_result: r2(R(px)), mfe_r: r2(mfe), mae_r: r2(mae) }; }
    // Time exit at the window's last bar (the session close for a day plan).
    if (b.time + 300 >= tradeEnd) return { status: "timed" as const, fill, triggered_at, exit_at: b.time, exit_price: b.close, r_result: r2(R(b.close)), mfe_r: r2(mfe), mae_r: r2(mae) };
  }
  if (now > tradeEnd && last) return { status: "timed" as const, fill, triggered_at, exit_at: last.time, exit_price: last.close, r_result: r2(R(last.close)), mfe_r: r2(mfe), mae_r: r2(mae) };
  return { status: "open" as const, fill, triggered_at, exit_at: null, exit_price: null, r_result: last ? r2(R(last.close)) : null, mfe_r: r2(mfe), mae_r: r2(mae) };
}
/** Seconds to add to a New York civil time to get UTC (EST 5h, EDT 4h). */
function nyOffset(date: string) {
  const probe = new Date(`${date}T12:00:00Z`);
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(probe);
  return (12 - Number(ny)) * 3600;
}

// ------------------------------------------------------------------------------------------- picks -> outcomes
/** Register every pick of every finished brief (once), then evaluate the ones that are due. */
export async function evaluatePicks(db: D1Database, limit = 12) {
  await ensureLearn(db);
  const t = nowS();
  // 1. New picks.
  let briefs: { id: string; slot: string; day: string; data: string | null; finished_at: string | null; created_at: string }[] = [];
  try {
    briefs = (await db.prepare(`SELECT id, slot, day, data, finished_at, created_at FROM briefs WHERE status = 'done' AND data IS NOT NULL AND slot != 'review'
      AND id NOT IN (SELECT DISTINCT brief_id FROM pick_outcomes) ORDER BY created_at DESC LIMIT 20`).all<{ id: string; slot: string; day: string; data: string | null; finished_at: string | null; created_at: string }>()).results;
  } catch { briefs = []; }
  for (const b of briefs) {
    let picks: Record<string, unknown>[] = [], regime: string | null = null;
    try { const d = JSON.parse(b.data || "{}"); picks = d?.picks ?? []; regime = typeof d?.market?.regime === "string" ? d.market.regime.toLowerCase().slice(0, 20) : null; } catch { picks = []; }
    const at = Math.floor(Date.parse(((b.finished_at || b.created_at) as string).replace(" ", "T") + "Z") / 1000);
    let n = 0;
    for (const p of picks) {
      const symbol = String(p.symbol || "").toUpperCase(), entry = num(p.entry), stop = num(p.stop);
      if (!symbol || entry === null || stop === null || entry === stop) continue;
      const targets = (Array.isArray(p.targets) ? p.targets : []).map(num).filter((x): x is number => x !== null);
      const id = `${b.id}-${symbol}`.slice(0, 40);
      await db.prepare(`INSERT OR IGNORE INTO pick_outcomes (id, brief_id, slot, day, symbol, side, horizon, setup, score, sources, entry, stop, target, created_at, status, next_check, updated_at, regime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .bind(id, b.id, b.slot, b.day, symbol, /short/i.test(String(p.bias || "")) ? "short" : "long", p.horizon === "swing" ? "swing" : "day", String(p.setup || "").slice(0, 120) || null,
          num(p.score), Array.isArray(p.sources) ? JSON.stringify((p.sources as { type?: string }[]).map((s) => s.type).filter(Boolean)) : null, entry, stop, targets[0] ?? null, at, t, t, regime).run();
      n++;
    }
    if (!n) await db.prepare("INSERT OR IGNORE INTO pick_outcomes (id, brief_id, slot, day, symbol, side, horizon, entry, stop, created_at, status, next_check, updated_at) VALUES (?, ?, ?, ?, '-', 'long', 'day', 0, 0, ?, 'expired', ?, ?)").bind(`${b.id}-none`, b.id, b.slot, b.day, at, t, t).run();
  }
  // 2. Due evaluations (the market must have moved since the last check).
  const due = (await db.prepare("SELECT * FROM pick_outcomes WHERE status IN ('pending', 'open') AND next_check <= ? AND symbol != '-' ORDER BY next_check LIMIT ?").bind(t, limit).all<Outcome>()).results;
  const cache = new Map<string, Bar[]>();
  let evaluated = 0;
  for (const o of due) {
    const ageDays = (t - o.created_at) / 86400;
    if (ageDays > MAX_LOOKBACK_DAYS) { await db.prepare("UPDATE pick_outcomes SET status = 'expired', updated_at = ? WHERE id = ?").bind(t, o.id).run(); continue; }
    try {
      if (!cache.has(o.symbol)) cache.set(o.symbol, (await candles(o.symbol, "5m", Math.min(59, Math.ceil(ageDays) + 2))) as Bar[]);
      const r = replay(o, cache.get(o.symbol)!, t);
      const next = t + (o.horizon === "day" ? DAY_CHECK : SWING_CHECK);
      if (r.status === "pending" || r.status === "open") {
        await db.prepare("UPDATE pick_outcomes SET status = ?, fill = ?, triggered_at = ?, r_result = ?, mfe_r = ?, mae_r = ?, next_check = ?, updated_at = ? WHERE id = ?")
          .bind(r.status, (r as { fill?: number | null }).fill ?? null, (r as { triggered_at?: number | null }).triggered_at ?? null, (r as { r_result?: number | null }).r_result ?? null, (r as { mfe_r?: number | null }).mfe_r ?? null, (r as { mae_r?: number | null }).mae_r ?? null, next, t, o.id).run();
      } else {
        const x = r as { status: string; fill?: number | null; triggered_at?: number | null; exit_at?: number | null; exit_price?: number | null; r_result?: number | null; mfe_r?: number | null; mae_r?: number | null };
        await db.prepare("UPDATE pick_outcomes SET status = ?, fill = ?, triggered_at = ?, exit_at = ?, exit_price = ?, r_result = ?, mfe_r = ?, mae_r = ?, updated_at = ? WHERE id = ?")
          .bind(x.status, x.fill ?? null, x.triggered_at ?? null, x.exit_at ?? null, x.exit_price ?? null, x.r_result ?? null, x.mfe_r ?? null, x.mae_r ?? null, t, o.id).run();
      }
      evaluated++;
    } catch { await db.prepare("UPDATE pick_outcomes SET next_check = ?, updated_at = ? WHERE id = ?").bind(t + 1800, t, o.id).run(); }
  }
  return { registered: briefs.length, evaluated };
}

// ------------------------------------------------------------------------------------------- statistics
/** Wilson 95% lower bound of a win rate: a small sample cannot claim a high rate. */
export function wilsonLow(wins: number, n: number) {
  if (!n) return 0;
  const z = 1.96, p = wins / n, d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / d);
}
type Group = { key: string; n: number; wins: number; win_rate: number | null; ci_low: number | null; avg_r: number | null; profit_factor: number | null; sum_r: number; no_trigger: number; total: number };
function groupBy(rows: Outcome[], keyOf: (o: Outcome) => string | null): Group[] {
  const m = new Map<string, Group>();
  for (const o of rows) {
    const k = keyOf(o); if (!k) continue;
    const g = m.get(k) ?? { key: k, n: 0, wins: 0, win_rate: null, ci_low: null, avg_r: null, profit_factor: null, sum_r: 0, no_trigger: 0, total: 0, _gp: 0, _gl: 0 } as Group & { _gp: number; _gl: number };
    g.total++;
    if (o.status === "no_trigger") g.no_trigger++;
    else if (o.r_result !== null && ["win", "loss", "timed"].includes(o.status)) {
      g.n++; g.sum_r += o.r_result; if (o.r_result > 0) g.wins++;
      if (o.r_result > 0) (g as Group & { _gp: number }). _gp += o.r_result; else (g as Group & { _gl: number })._gl += -o.r_result;
    }
    m.set(k, g);
  }
  return [...m.values()].map((g) => {
    const gg = g as Group & { _gp: number; _gl: number };
    const out: Group = { key: g.key, n: g.n, wins: g.wins, total: g.total, no_trigger: g.no_trigger, sum_r: r2(g.sum_r),
      win_rate: g.n ? r2((g.wins / g.n) * 100) : null, ci_low: g.n ? r2(wilsonLow(g.wins, g.n) * 100) : null, avg_r: g.n ? r2(g.sum_r / g.n) : null,
      profit_factor: gg._gl > 0 ? r2(gg._gp / gg._gl) : g.n && gg._gp > 0 ? 99 : null };
    return out;
  }).sort((a, b) => (b.avg_r ?? -9) - (a.avg_r ?? -9));
}
const SETUP_KINDS: [string, RegExp][] = [["gap / ORB", /gap|opening range|orb/i], ["breakout", /break ?out|base|flag|range break|new high/i], ["pullback", /pull ?back|ema|support|dip|retest/i],
  ["reversal", /revers|hammer|engulf|exhaust|bounce|fade|capitul/i], ["vwap", /vwap/i], ["earnings / news", /earnings|news|catalyst|guidance|contract/i], ["trend", /trend|continuation|momentum/i]];
export const setupKind = (s: string | null) => { if (!s) return "other"; for (const [k, re] of SETUP_KINDS) if (re.test(s)) return k; return "other"; };
export const scoreBucket = (s: number | null) => (s === null ? "no score" : s >= 80 ? "80-100" : s >= 70 ? "70-79" : s >= 60 ? "60-69" : "under 60");
export const hourOf = (ts: number) => { const ny = nyNow(new Date(ts * 1000)); const h = Math.floor(ny.minutes / 60); return `${String(h).padStart(2, "0")}:00`; };

export async function learnSummary(db: D1Database, days = 90) {
  await ensureLearn(db);
  const since = nowS() - days * 86400;
  const rows = (await db.prepare("SELECT * FROM pick_outcomes WHERE symbol != '-' AND created_at >= ? ORDER BY created_at").bind(since).all<Outcome>()).results;
  const settled = rows.filter((o) => ["win", "loss", "timed"].includes(o.status) && o.r_result !== null);
  const all = groupBy(rows, () => "all")[0] ?? null;
  // Walk-forward equity in R (1R risked per triggered plan, in time order) and its drawdown.
  let cum = 0, peak = 0, dd = 0; const curve: { t: number; day: string; r: number }[] = [];
  for (const o of settled) { cum = r2(cum + o.r_result!); peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); curve.push({ t: o.exit_at ?? o.created_at, day: o.day, r: cum }); }
  const rs = settled.map((o) => o.r_result!), mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1)) : 0;
  const groups = {
    slot: groupBy(rows, (o) => o.slot), horizon: groupBy(rows, (o) => o.horizon), side: groupBy(rows, (o) => o.side),
    setup: groupBy(rows, (o) => setupKind(o.setup)), score: groupBy(rows, (o) => scoreBucket(o.score)), hour: groupBy(rows, (o) => hourOf(o.created_at)),
    source: groupBy(rows.flatMap((o) => { let s: string[] = []; try { s = JSON.parse(o.sources || "[]"); } catch { s = []; } return s.length ? s.map((x) => ({ ...o, _src: x })) : []; }), (o) => (o as Outcome & { _src: string })._src),
    symbol: groupBy(rows, (o) => o.symbol).filter((g) => g.n >= 3).slice(0, 15),
    regime: groupBy(rows, (o) => o.regime || null),
  };
  const calibration = ["under 60", "60-69", "70-79", "80-100"].map((k) => groups.score.find((g) => g.key === k) ?? { key: k, n: 0, wins: 0, win_rate: null, ci_low: null, avg_r: null, profit_factor: null, sum_r: 0, no_trigger: 0, total: 0 });
  return {
    days, picks: rows.length, settled: settled.length, open: rows.filter((o) => o.status === "open").length, pending: rows.filter((o) => o.status === "pending").length,
    no_trigger: rows.filter((o) => o.status === "no_trigger").length, all, curve, max_drawdown_r: r2(dd), total_r: r2(cum),
    sharpe_per_trade: sd > 0 ? r2(mean / sd) : null, groups, calibration, tests: Object.values(groups).reduce((n, g) => n + g.length, 0),
    recent: rows.slice(-40).reverse(),
  };
}

/** Closed paper trades by source and, for chart-signal entries, by candle pattern. */
export async function paperLearn(db: D1Database, days = 90) {
  const since = nowS() - days * 86400;
  let trades: { source: string; note: string | null; pnl: number; entry: number; stop: number | null; qty: number; side: string; exit_reason: string | null }[] = [];
  try { trades = (await db.prepare("SELECT source, note, pnl, entry, stop, qty, side, exit_reason FROM paper_positions WHERE status = 'closed' AND closed_at >= ?").bind(since).all<typeof trades[number]>()).results; } catch { trades = []; }
  const rOf = (t: typeof trades[number]) => (t.stop !== null && t.qty > 0 && Math.abs(t.entry - t.stop) > 0 ? t.pnl / (Math.abs(t.entry - t.stop) * t.qty) : null);
  const agg = (keyOf: (t: typeof trades[number]) => string | null) => {
    const m = new Map<string, { key: string; n: number; wins: number; pnl: number; sum_r: number; nr: number }>();
    for (const t of trades) { const k = keyOf(t); if (!k) continue; const g = m.get(k) ?? { key: k, n: 0, wins: 0, pnl: 0, sum_r: 0, nr: 0 }; g.n++; if (t.pnl > 0) g.wins++; g.pnl += t.pnl; const r = rOf(t); if (r !== null) { g.sum_r += r; g.nr++; } m.set(k, g); }
    return [...m.values()].map((g) => ({ key: g.key, n: g.n, wins: g.wins, win_rate: r2((g.wins / g.n) * 100), ci_low: r2(wilsonLow(g.wins, g.n) * 100), pnl: r2(g.pnl), avg_r: g.nr ? r2(g.sum_r / g.nr) : null })).sort((a, b) => b.pnl - a.pnl);
  };
  return { trades: trades.length, by_source: agg((t) => t.source), by_exit: agg((t) => t.exit_reason || "?"),
    by_signal: agg((t) => { const m = /Chart auto \(signal\): ([^·]+)/.exec(t.note || ""); return m ? m[1].trim().replace(/ after a .*$/, "") : null; }) };
}

// ------------------------------------------------------------------------------------------- playbook
type Playbook = { at: number; text: string; min_score: number | null; works: string[]; avoid: string[]; n: number };
/** Turn the statistics into a few lines the scans read before recommending. Only groups with enough samples speak. */
export async function buildPlaybook(db: D1Database): Promise<Playbook> {
  const s = await getSettings(db);
  const minN = Math.max(5, Number((s as { learn_min_n?: number }).learn_min_n) || 10);
  const sum = await learnSummary(db, 90), paper = await paperLearn(db, 90);
  const works: string[] = [], avoid: string[] = [];
  const name: Record<string, string> = { slot: "scan", horizon: "horizon", side: "side", setup: "setup", score: "score", hour: "scan hour (NY)", source: "followed source", symbol: "symbol", regime: "market regime" };
  for (const [dim, gs] of Object.entries(sum.groups)) {
    for (const g of gs) {
      if (g.n < minN) continue;
      const line = `${name[dim]} ${g.key}: ${g.n} trades, ${g.win_rate}% wins (95% CI low ${g.ci_low}%), ${g.avg_r! >= 0 ? "+" : ""}${g.avg_r}R per trade`;
      if (g.avg_r! >= 0.25 && g.ci_low! >= 35) works.push(line);
      else if (g.avg_r! <= -0.15 || (g.ci_low! < 25 && g.win_rate! < 40)) avoid.push(line);
    }
  }
  for (const g of paper.by_signal) { if (g.n >= minN) (g.avg_r !== null && g.avg_r >= 0.25 ? works : g.avg_r !== null && g.avg_r <= -0.15 ? avoid : []).push(`chart-autopilot signal ${g.key}: ${g.n} trades, ${g.win_rate}% wins, ${g.avg_r! >= 0 ? "+" : ""}${g.avg_r}R`); }
  // Lowest score bucket that still pays, with enough samples.
  let minScore: number | null = null;
  for (const [k, v] of [["under 60", 0], ["60-69", 60], ["70-79", 70], ["80-100", 80]] as [string, number][]) {
    const g = sum.calibration.find((x) => x.key === k); if (g && g.n >= minN && (g.avg_r ?? -1) > 0) { minScore = v; break; }
  }
  const trig = sum.all && sum.all.total ? Math.round(((sum.all.total - sum.all.no_trigger) / sum.all.total) * 100) : null;
  const lines = [
    `Track record, last 90 days (walk-forward replay of my own recommendations on the bars that followed, stop before target when a bar touches both, 1R risked per plan): ${sum.picks} plans, ${sum.settled} settled, ${trig === null ? "" : `${trig}% triggered, `}${sum.all?.win_rate ?? "—"}% wins, ${sum.all?.avg_r ?? "—"}R per trade, ${sum.total_r}R total, worst drawdown ${sum.max_drawdown_r}R.`,
    works.length ? `WHAT WORKS (keep doing, size normally): ${works.join("; ")}.` : "WHAT WORKS: not enough settled trades yet to single anything out.",
    avoid.length ? `WHAT DOES NOT (skip or cut the score): ${avoid.join("; ")}.` : "",
    minScore !== null ? `Scores of ${minScore}+ have paid so far; be stricter below that.` : "",
    `Every group above has at least ${minN} trades; ${sum.tests} groups were examined, so treat a single group's edge as provisional (multiple comparisons).`,
  ].filter(Boolean);
  const pb: Playbook = { at: nowS(), text: lines.join("\n"), min_score: minScore, works, avoid, n: sum.settled };
  await setSetting(db, "learn_playbook", pb);
  return pb;
}
export async function playbookPrompt(db: D1Database): Promise<string> {
  const s = await getSettings(db) as { learn_apply?: boolean };
  if (s.learn_apply === false) return "";
  const pb = await getSetting<Playbook | null>(db, "learn_playbook", null);
  if (!pb || !pb.n || pb.n < 5) return "";
  return `[Lessons from my own track record]\n${pb.text}\nUse this to prefer the setups, scans, hours and sources that have worked and to be stricter with the ones that have not. Say in one line how it changed today's list.\n\n`;
}

// ------------------------------------------------------------------------------------------- pattern reliability
const HOLD_BARS: Record<string, number> = { "5m": 24, "15m": 16, "60m": 12, "1d": 10 };
const LOOKBACK: Record<string, number> = { "5m": 30, "15m": 59, "60m": 240, "1d": 730 };
export type SignalTrade = { time: number; pattern: string; label: string; dir: string; strength: number; entry: number; stop: number; target: number; exit: number; exit_time: number; r: number; reason: "stop" | "target" | "time"; oos: boolean };

/** Backtest the chart-autopilot signal rule on completed bars: enter at the pattern bar's close, stop just beyond the
 *  pattern's extreme, target 2R, out after `holdBars`. The last 30% of the bars are the out-of-sample part. */
export function backtestSignals(bars: Bar[], opts: { minStrength?: number; holdBars?: number; only?: string[]; trendGate?: boolean; costBps?: number } = {}) {
  const C = Candles(); const minS = opts.minStrength ?? 2, hold = opts.holdBars ?? 24;
  const costBps = opts.costBps ?? 4; // round-trip slippage + spread + fees, in basis points of the price, charged on every trade
  const hits = C.detect(bars, { only: opts.only, trendGate: opts.trendGate !== false }).filter((h) => h.strength >= minS);
  const oosFrom = Math.floor(bars.length * 0.7);
  const trades: SignalTrade[] = []; let busyUntil = -1;
  for (const h of hits) {
    if (h.index <= busyUntil || h.index + 1 >= bars.length) continue;
    const patt = bars.slice(h.index - h.bars + 1, h.index + 1), long = h.dir === "bullish", entry = bars[h.index].close;
    const lo = Math.min(...patt.map((b) => b.low)), hi = Math.max(...patt.map((b) => b.high)), pad = (hi - lo) * 0.1;
    const stop = long ? lo - pad : hi + pad, risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk / entry > 0.05) continue;
    const target = long ? entry + 2 * risk : entry - 2 * risk;
    let exit = entry, reason: SignalTrade["reason"] = "time", exitT = bars[h.index].time, j = h.index + 1;
    for (; j < Math.min(bars.length, h.index + 1 + hold); j++) {
      const b = bars[j];
      if (long ? b.low <= stop : b.high >= stop) { exit = long ? Math.min(stop, b.open) : Math.max(stop, b.open); reason = "stop"; exitT = b.time; break; }
      if (long ? b.high >= target : b.low <= target) { exit = long ? Math.max(target, b.open) : Math.min(target, b.open); reason = "target"; exitT = b.time; break; }
      exit = b.close; exitT = b.time;
    }
    busyUntil = Math.min(j, bars.length - 1);
    trades.push({ time: h.time, pattern: h.pattern, label: h.label, dir: h.dir, strength: h.strength, entry: r2(entry), stop: r2(stop), target: r2(target), exit: r2(exit), exit_time: exitT, r: r2(((exit - entry) * (long ? 1 : -1) - entry * costBps / 10000) / risk), reason, oos: h.index >= oosFrom });
  }
  const stats = (ts: SignalTrade[]) => {
    const n = ts.length, wins = ts.filter((t) => t.r > 0).length, sum = ts.reduce((a, t) => a + t.r, 0), gp = ts.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), gl = -ts.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0);
    let cum = 0, peak = 0, dd = 0; for (const t of ts) { cum += t.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
    return { n, wins, win_rate: n ? r2((wins / n) * 100) : null, ci_low: n ? r2(wilsonLow(wins, n) * 100) : null, avg_r: n ? r2(sum / n) : null, total_r: r2(sum), profit_factor: gl > 0 ? r2(gp / gl) : n ? 99 : null, max_drawdown_r: r2(dd) };
  };
  const byPattern = new Map<string, SignalTrade[]>();
  for (const t of trades) byPattern.set(t.pattern, [...(byPattern.get(t.pattern) || []), t]);
  return { trades, all: stats(trades), in_sample: stats(trades.filter((t) => !t.oos)), out_of_sample: stats(trades.filter((t) => t.oos)),
    by_pattern: [...byPattern.entries()].map(([p, ts]) => ({ pattern: p, label: ts[0].label, dir: ts[0].dir, ...stats(ts), oos: stats(ts.filter((t) => t.oos)) })).sort((a, b) => (b.avg_r ?? -9) - (a.avg_r ?? -9)),
    bars: bars.length, oos_from: bars[oosFrom]?.time ?? null, cost_bps: costBps,
    // Buy and hold over the same bars, for the benchmark test: a rule that cannot beat it after costs should not be traded.
    buy_hold_pct: bars.length > 1 ? r2(((bars[bars.length - 1].close - bars[0].close) / bars[0].close) * 100) : null,
    strategy_pct: r2(trades.reduce((a, t) => a + t.r * (Math.abs(t.entry - t.stop) / t.entry) * 100, 0)) };
}

/** Pattern reliability for a symbol and bar size, cached six hours. */
export async function patternStats(db: D1Database, symbol: string, interval = "5m", force = false) {
  await ensureLearn(db);
  const t = nowS();
  const cached = (await db.prepare("SELECT * FROM pattern_stats WHERE symbol = ? AND interval = ?").bind(symbol, interval).all<{ pattern: string; dir: string; n: number; wins: number; sum_r: number; n_oos: number; wins_oos: number; sum_r_oos: number; updated_at: number }>()).results;
  if (cached.length && !force && t - cached[0].updated_at < 6 * 3600) return { symbol, interval, cached: true, rows: cached.map(fmtRow) };
  const bars = (await candles(symbol, interval, LOOKBACK[interval] ?? 30)) as Bar[];
  const done = bars.filter((b) => b.time + (interval === "1d" ? 86400 : 300) <= t);
  const bt = backtestSignals(done, { minStrength: 1, holdBars: HOLD_BARS[interval] ?? 24 });
  await db.prepare("DELETE FROM pattern_stats WHERE symbol = ? AND interval = ?").bind(symbol, interval).run();
  const rows = bt.by_pattern.map((p) => ({ pattern: p.pattern, dir: p.dir, n: p.n, wins: p.wins, sum_r: p.total_r, n_oos: p.oos.n, wins_oos: p.oos.wins, sum_r_oos: p.oos.total_r, updated_at: t }));
  for (const r of rows) await db.prepare("INSERT INTO pattern_stats (symbol, interval, pattern, dir, n, wins, sum_r, n_oos, wins_oos, sum_r_oos, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(symbol, interval, r.pattern, r.dir, r.n, r.wins, r.sum_r, r.n_oos, r.wins_oos, r.sum_r_oos, t).run();
  return { symbol, interval, cached: false, rows: rows.map(fmtRow), bars: done.length };
}
function fmtRow(r: { pattern: string; dir: string; n: number; wins: number; sum_r: number; n_oos: number; wins_oos: number; sum_r_oos: number }) {
  const label = Candles().LABELS[r.pattern] || r.pattern;
  const verdict = r.n < 15 ? "few" : r.sum_r / r.n >= 0.15 && wilsonLow(r.wins, r.n) >= 0.3 && (!r.n_oos || r.sum_r_oos >= 0) ? "good" : r.sum_r / r.n <= -0.1 ? "bad" : "flat";
  return { pattern: r.pattern, label, dir: r.dir, n: r.n, win_rate: r.n ? r2((r.wins / r.n) * 100) : null, ci_low: r.n ? r2(wilsonLow(r.wins, r.n) * 100) : null, avg_r: r.n ? r2(r.sum_r / r.n) : null,
    n_oos: r.n_oos, win_rate_oos: r.n_oos ? r2((r.wins_oos / r.n_oos) * 100) : null, avg_r_oos: r.n_oos ? r2(r.sum_r_oos / r.n_oos) : null, verdict };
}
/** Should the chart autopilot act on this pattern for this symbol? Unknown patterns are allowed; proven bad ones are not. */
export async function patternAllowed(db: D1Database, symbol: string, pattern: string, interval = "5m") {
  try {
    const st = await patternStats(db, symbol, interval);
    const r = st.rows.find((x) => x.pattern === pattern);
    return !r || r.verdict !== "bad" ? { ok: true, row: r ?? null } : { ok: false, row: r };
  } catch { return { ok: true, row: null }; }
}

/** Cron hook: evaluate due picks every few minutes, rebuild the playbook after the close once a day. */
export async function learnTick(db: D1Database) {
  const ny = nyNow();
  if (!isTradingDay(ny)) return;
  if (ny.minutes % 5 === 0 || ny.minutes % 5 === 1) await evaluatePicks(db, 10);
  const st = sessionTimes(ny.date);
  if (ny.minutes >= st.close + 30 && ny.minutes < st.close + 60) {
    const pb = await getSetting<Playbook | null>(db, "learn_playbook", null);
    if (!pb || nowS() - pb.at > 12 * 3600) {
      await buildPlaybook(db);
      // Night review: a proposal from today's failure report waits for approval; nothing is applied by itself.
      try { const { proposeFromStats } = await import("./strategy"); const open = await db.prepare("SELECT 1 FROM strategy_versions WHERE status IN ('proposed','thinking') LIMIT 1").first(); if (!open) await proposeFromStats(db); } catch { /* not enough data yet */ }
    }
  }
}
