// The self-improving loop on top of the outcome engine (learn.ts):
//   observe (pick_outcomes, paper trades)  ->  failure analyzer (classified problems with evidence)
//   -> reasoning (a statistical proposer, or Claude reading the report)  ->  validation (the proposed rules replayed
//   on the past, in-sample vs out-of-sample)  ->  strategy versions with approve / reject, one active at a time.
// Active rules are enforced: scans read them, auto-trade and the chart autopilot skip picks that break them.
import type { Env } from "./env";
import { client, createSession } from "./agent";
import { capBlocks, isEngine, recordSpend } from "./cost";
import { getSettings } from "./db";
import { nyNow } from "./briefs";
import { UNDERPERFORM_MIN_N, ensureLearn, expectancy, hourOf, paperLearn, scoreGate, setupKind, summarizeRows, type Group, type Outcome, type ScoreGate } from "./learn";
export { scoreGate } from "./learn";

export type Rules = {
  min_score: number | null;          // skip picks under this score (ignored while the score does not rank trades: see scoreGate)
  avoid_setups: string[];            // setup kinds (gap / ORB, breakout, pullback, reversal, vwap, earnings / news, trend, other)
  avoid_hours: string[];             // scan hours New York, "HH:00"
  avoid_slots: string[];             // scan ids
  avoid_sources: string[];           // Winners desk source types
  avoid_regimes: string[];           // risk-on / risk-off / mixed
  avoid_symbols: string[];
  // Allow-lists: the groups that have made money. When at least one allow-list is set, a plan must match at
  // least one of them (its hour, OR its scan, OR its setup kind); a plan that matches none is blocked.
  allow_hours: string[];             // scan hours New York, "HH:00"
  allow_slots: string[];             // scan ids
  allow_setups: string[];            // setup kinds
  max_trades_day: number | null;     // auto-trade entries per account per day
  require_kronos: boolean;           // chart autopilot: a fresh Kronos forecast must agree
};
export const EMPTY_RULES: Rules = { min_score: null, avoid_setups: [], avoid_hours: [], avoid_slots: [], avoid_sources: [], avoid_regimes: [], avoid_symbols: [], allow_hours: [], allow_slots: [], allow_setups: [], max_trades_day: null, require_kronos: false };
export type Version = {
  id: string; version: number; status: "proposed" | "thinking" | "active" | "rejected" | "retired" | "error"; rules: string; rationale: string | null; source: string;
  validation: string | null; session_id: string | null; error: string | null; created_at: string; decided_at: string | null; cost: string | null;
};
export type Failure = { type: "underperformance" | "drawdown" | "overtrading" | "slippage" | "regime" | "no_trigger"; severity: "high" | "medium" | "low"; text: string; evidence: Record<string, unknown>; rule?: Partial<Rules> };
/** A group that has made money (total R above zero). `listed` = it is on the proposed allow-list. */
export type Keep = { dimension: string; key: string; n: number; avg_r: number | null; sum_r: number; r_low: number | null; r_high: number | null; listed: boolean };
/** A proposal needs at least this many out-of-sample trades left after its rules, or it is rejected automatically. */
export const MIN_OOS_TRADES = 30;
type Row = Outcome & { regime?: string | null };

const nowS = () => Math.floor(Date.now() / 1000);
const r2 = (n: number) => Math.round(n * 100) / 100;
let ready = false;
export async function ensureStrategy(db: D1Database) {
  if (ready) return;
  await ensureLearn(db);
  await db.prepare(`CREATE TABLE IF NOT EXISTS strategy_versions (id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, rules TEXT NOT NULL, rationale TEXT, source TEXT NOT NULL,
    validation TEXT, session_id TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), decided_at TEXT, cost TEXT)`).run();
  try { await db.prepare("ALTER TABLE pick_outcomes ADD COLUMN regime TEXT").run(); } catch { /* exists */ }
  ready = true;
}
export function sanitizeRules(x: unknown): Rules {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const list = (v: unknown, max = 12) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, max) : []);
  const ms = Number(o.min_score);
  const hours = (v: unknown) => list(v).map((h) => h.slice(0, 2).padStart(2, "0") + ":00");
  return { min_score: Number.isFinite(ms) && ms > 0 ? Math.max(0, Math.min(100, Math.round(ms))) : null, avoid_setups: list(o.avoid_setups), avoid_hours: hours(o.avoid_hours),
    avoid_slots: list(o.avoid_slots), avoid_sources: list(o.avoid_sources), avoid_regimes: list(o.avoid_regimes), avoid_symbols: list(o.avoid_symbols, 30).map((s) => s.toUpperCase()),
    allow_hours: hours(o.allow_hours), allow_slots: list(o.allow_slots), allow_setups: list(o.allow_setups),
    max_trades_day: Number.isFinite(Number(o.max_trades_day)) && Number(o.max_trades_day) > 0 ? Math.round(Number(o.max_trades_day)) : null, require_kronos: !!o.require_kronos };
}
export const hasAllow = (r: Rules) => !!(r.allow_hours.length || r.allow_slots.length || r.allow_setups.length);
export const rulesEmpty = (r: Rules) => r.min_score === null && !r.avoid_setups.length && !r.avoid_hours.length && !r.avoid_slots.length && !r.avoid_sources.length && !r.avoid_regimes.length && !r.avoid_symbols.length && !hasAllow(r) && r.max_trades_day === null && !r.require_kronos;

/** Why a plan breaks the rules (null = allowed). Works on outcomes and on live picks alike.
 *  Avoid-lists and the minimum score block on their own. Allow-lists work together: once any is set, the plan must
 *  be on at least one of them. A list the plan carries no value for (no hour, no scan) cannot be checked and is
 *  left out; if none can be checked the plan is not blocked by them. */
export function ruleBlocks(r: Rules, p: { score?: number | null; setup?: string | null; slot?: string | null; symbol?: string | null; sources?: string[] | null; regime?: string | null; created_at?: number | null }): string | null {
  if (r.min_score !== null && (p.score ?? 0) < r.min_score) return `score ${p.score ?? "?"} under ${r.min_score}`;
  const kind = setupKind(p.setup ?? null);
  if (r.avoid_setups.includes(kind)) return `setup ${kind}`;
  if (p.slot && r.avoid_slots.includes(p.slot)) return `scan ${p.slot}`;
  if (p.created_at && r.avoid_hours.includes(hourOf(p.created_at))) return `hour ${hourOf(p.created_at)}`;
  if (p.symbol && r.avoid_symbols.includes(p.symbol.toUpperCase())) return `symbol ${p.symbol}`;
  if (p.regime && r.avoid_regimes.includes(p.regime)) return `regime ${p.regime}`;
  if (p.sources && p.sources.some((s) => r.avoid_sources.includes(s))) return `source ${p.sources.find((s) => r.avoid_sources.includes(s))}`;
  const checks: [string, boolean][] = [];
  if (r.allow_hours?.length && p.created_at) checks.push([`hour ${hourOf(p.created_at)}`, r.allow_hours.includes(hourOf(p.created_at))]);
  if (r.allow_slots?.length && p.slot) checks.push([`scan ${p.slot}`, r.allow_slots.includes(p.slot)]);
  if (r.allow_setups?.length && p.setup !== undefined) checks.push([`setup ${kind}`, r.allow_setups.includes(kind)]);
  if (checks.length && !checks.some(([, ok]) => ok)) return `not on the allow-list (${checks.map(([k]) => k).join(", ")})`;
  return null;
}
const pickOf = (o: Row) => { let src: string[] = []; try { src = JSON.parse(o.sources || "[]"); } catch { src = []; } return { score: o.score, setup: o.setup, slot: o.slot, symbol: o.symbol, sources: src, regime: o.regime ?? null, created_at: o.created_at }; };
const isSettled = (o: Outcome) => ["win", "loss", "timed"].includes(o.status) && o.r_result !== null && o.symbol !== "-";

// ------------------------------------------------------------------------------------------- failure analyzer
const AVOID_DIM: Record<string, keyof Rules | null> = { setup: "avoid_setups", hour: "avoid_hours", slot: "avoid_slots", source: "avoid_sources", symbol: "avoid_symbols", regime: "avoid_regimes", score: null, horizon: null, side: null };
const ALLOW_DIM: Record<string, "allow_hours" | "allow_slots" | "allow_setups"> = { hour: "allow_hours", slot: "allow_slots", setup: "allow_setups" };
const DIM_NAME: Record<string, string> = { slot: "scan", horizon: "horizon", side: "side", setup: "setup", score: "score", hour: "scan hour", source: "followed source", symbol: "symbol", regime: "market" };
const sgn = (v: number | null) => (v === null ? "?" : `${v > 0 ? "+" : ""}${v}`);
/** The group part of the failure analyzer (pure). A group is a failure ONLY when it has at least 20 trades and the
 *  optimistic end of its expectancy (mean R + 1.96 × standard error) is still below zero. The win rate never
 *  decides: 34% winners at 2R make money. Groups with a positive total are "keep"; the ones with enough trades,
 *  in the hour / scan / setup dimensions, form the allow-list. */
export function analyzeGroups(groups: Record<string, Group[]>, o: { minN?: number; useScore?: boolean } = {}): { failures: Failure[]; keep: Keep[]; allow: Partial<Rules> } {
  const minN = o.minN ?? 10, failures: Failure[] = [], keep: Keep[] = [], allow: Partial<Rules> = {};
  for (const [name, gs] of Object.entries(groups)) {
    const listed: string[] = [];
    for (const g of gs) {
      if (!g.n || g.avg_r === null) continue;
      if (g.sum_r > 0) {
        const on = !!ALLOW_DIM[name] && g.n >= minN; if (on) listed.push(g.key);
        if (g.n >= minN) keep.push({ dimension: name, key: g.key, n: g.n, avg_r: g.avg_r, sum_r: g.sum_r, r_low: g.r_low, r_high: g.r_high, listed: on });
        continue;
      }
      if (g.n < UNDERPERFORM_MIN_N || g.r_high === null || g.r_high >= 0) continue;
      const key = AVOID_DIM[name];
      const rule = key ? ({ [key]: [g.key] } as Partial<Rules>) : name === "score" && o.useScore !== false && g.key !== "no score" && g.key !== "80-100" ? { min_score: g.key === "under 60" ? 60 : g.key === "60-69" ? 70 : 80 } : undefined;
      failures.push({ type: name === "regime" ? "regime" : "underperformance", severity: g.avg_r <= -0.4 ? "high" : "medium",
        text: `${DIM_NAME[name] ?? name} "${g.key}": ${g.n} trades averaged ${sgn(g.avg_r)}R each (${g.sum_r}R in total). Even the optimistic end of the 95% range, ${sgn(g.r_high)}R, is below zero.`,
        evidence: { dimension: name, key: g.key, n: g.n, win_rate: g.win_rate, avg_r: g.avg_r, se_r: g.se_r, r_low: g.r_low, r_high: g.r_high, sum_r: g.sum_r }, rule });
    }
    // An allow-list is worth having only when it leaves something out: if every group with enough trades is on it, it says nothing.
    const ak = ALLOW_DIM[name];
    if (ak && listed.length && gs.some((g) => g.n >= minN && !listed.includes(g.key))) (allow as Record<string, string[]>)[ak] = listed.slice(0, 12);
    else for (const k of keep) if (k.dimension === name) k.listed = false;
  }
  keep.sort((a, b) => b.sum_r - a.sum_r);
  return { failures, keep, allow };
}

type Summary = ReturnType<typeof summarizeRows>;
/** The whole failure analysis on a set of plans (pure; `rows` in time order). */
export function analyzeRows(rows: Row[], o: { minN?: number; useScore?: boolean; days?: number } = {}): { failures: Failure[]; keep: Keep[]; allow: Partial<Rules>; summary: Summary } {
  const minN = o.minN ?? 10, sum = summarizeRows(rows, o.days ?? 90), a = analyzeGroups(sum.groups, o), f: Failure[] = a.failures;
  if (sum.max_drawdown_r <= -5) f.push({ type: "drawdown", severity: sum.max_drawdown_r <= -10 ? "high" : "medium", text: `Worst drawdown ${sum.max_drawdown_r}R on the walk-forward R curve (${sum.settled} settled trades)`, evidence: { max_drawdown_r: sum.max_drawdown_r } });
  // Losing streaks and overtrading days.
  const settled = rows.filter(isSettled).sort((x, y) => (x.exit_at ?? x.created_at) - (y.exit_at ?? y.created_at));
  let streak = 0, worst = 0; for (const o of settled) { streak = (o.r_result ?? 0) <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  if (worst >= 6) f.push({ type: "drawdown", severity: worst >= 10 ? "high" : "low", text: `Longest losing streak: ${worst} trades in a row`, evidence: { streak: worst } });
  const byDay = new Map<string, Outcome[]>(); for (const o of settled) byDay.set(o.day, [...(byDay.get(o.day) || []), o]);
  const busy = [...byDay.entries()].filter(([, v]) => v.length >= 8).map(([d, v]) => ({ day: d, n: v.length, r: r2(v.reduce((a, o) => a + (o.r_result ?? 0), 0)) })).filter((x) => x.r < 0);
  if (busy.length) f.push({ type: "overtrading", severity: "medium", text: `${busy.length} day${busy.length > 1 ? "s" : ""} with 8+ triggered plans ended negative (e.g. ${busy[0].day}: ${busy[0].n} trades, ${busy[0].r}R)`, evidence: { days: busy.slice(0, 5) }, rule: { max_trades_day: 5 } });
  // Slippage proxy: fills that gapped through the entry versus the plan.
  const slips = settled.filter((o) => o.fill !== null).map((o) => ((o.fill! - o.entry) * (o.side === "long" ? 1 : -1)) / Math.abs(o.entry - o.stop));
  if (slips.length >= minN) { const avg = slips.reduce((a, b) => a + b, 0) / slips.length; if (Math.abs(avg) >= 0.1) f.push({ type: "slippage", severity: "low", text: `Fills average ${avg >= 0 ? "+" : ""}${r2(avg)}R ${avg > 0 ? "worse" : "better"} than the planned entry (gaps through the level)`, evidence: { avg_fill_vs_entry_r: r2(avg), n: slips.length } }); }
  if (sum.all && sum.all.total >= minN && sum.all.no_trigger / sum.all.total > 0.6) f.push({ type: "no_trigger", severity: "low", text: `${Math.round((sum.all.no_trigger / sum.all.total) * 100)}% of plans never reached their entry: entries are set too far from the price`, evidence: { no_trigger: sum.all.no_trigger, total: sum.all.total } });
  f.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);
  return { failures: f, keep: a.keep, allow: a.allow, summary: sum };
}
const rowsSince = async (db: D1Database, days: number) => (await db.prepare("SELECT * FROM pick_outcomes WHERE symbol != '-' AND created_at >= ? ORDER BY created_at").bind(nowS() - days * 86400).all<Row>()).results;
export async function failureReport(db: D1Database, days = 90): Promise<{ failures: Failure[]; keep: Keep[]; allow: Partial<Rules>; score_gate: ScoreGate | null; summary: Summary; paper: Awaited<ReturnType<typeof paperLearn>> }> {
  await ensureStrategy(db);
  const s = await getSettings(db), minN = Math.max(5, Number(s.learn_min_n) || 10);
  let gate: ScoreGate | null = null; try { gate = await scoreGate(db); } catch { gate = null; }
  const a = analyzeRows(await rowsSince(db, days), { minN, useScore: gate ? gate.use_score : true, days });
  return { ...a, score_gate: gate, paper: await paperLearn(db, days) };
}

// ------------------------------------------------------------------------------------------- validation
type VStats = { n: number; wins: number; win_rate: number | null; avg_r: number | null; total_r: number; max_drawdown_r: number; kept_pct?: number };
function vstats(rows: Outcome[]): VStats {
  const n = rows.length, wins = rows.filter((o) => (o.r_result ?? 0) > 0).length, sum = rows.reduce((a, o) => a + (o.r_result ?? 0), 0);
  let cum = 0, peak = 0, dd = 0; for (const o of rows) { cum += o.r_result ?? 0; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, wins, win_rate: n ? r2((wins / n) * 100) : null, avg_r: n ? r2(sum / n) : null, total_r: r2(sum), max_drawdown_r: r2(dd) };
}
/** Replay the rules on settled plans (pure; rows in time order): baseline vs filtered, on the first 70% (in-sample)
 *  and the last 30% (out-of-sample). `reject_reason` is set when fewer than 30 out-of-sample trades are left: a
 *  proposal that removes nearly everything cannot be judged and is rejected automatically. */
export function validateRows(all_rows: Row[], rules: Rules, days = 90) {
  const rows = all_rows.filter(isSettled), keep = (o: Row) => !ruleBlocks(rules, pickOf(o));
  const cut = Math.floor(rows.length * 0.7), is = rows.slice(0, cut), oos = rows.slice(cut);
  const part = (r: typeof rows) => { const base = vstats(r), filt = vstats(r.filter(keep)); return { baseline: base, filtered: { ...filt, kept_pct: base.n ? r2((filt.n / base.n) * 100) : null } }; };
  const all = part(rows), inS = part(is), out = part(oos);
  const reject_reason = out.filtered.n >= MIN_OOS_TRADES ? null
    : `Rejected automatically: with these rules only ${out.filtered.n} of the ${out.baseline.n} most recent settled plans (the out-of-sample part) would still be taken. A proposal needs at least ${MIN_OOS_TRADES} to be judged${out.baseline.n < MIN_OOS_TRADES ? `; the desk does not have that many yet` : ""}.`;
  // Verdict: better out-of-sample expectancy without throwing away most of the trades, and no worse drawdown.
  const better = out.baseline.n >= 5 && out.filtered.n >= 3 && (out.filtered.avg_r ?? -9) > (out.baseline.avg_r ?? -9) && (out.filtered.kept_pct ?? 0) >= 30 && out.filtered.max_drawdown_r >= out.baseline.max_drawdown_r - 0.5;
  const verdict = rows.length < 10 || reject_reason ? "insufficient" : better ? "improves" : (out.filtered.avg_r ?? -9) >= (out.baseline.avg_r ?? -9) ? "neutral" : "worse";
  return { days, trades: rows.length, all, in_sample: inS, out_of_sample: out, verdict, min_oos_trades: MIN_OOS_TRADES, reject_reason };
}
export async function validateRules(db: D1Database, rules: Rules, days = 90) {
  await ensureStrategy(db);
  return validateRows(await rowsSince(db, days), rules, days);
}

/** Make an "avoid everything" rule set impossible (pure). In order: a group cannot be on an avoid-list and an
 *  allow-list at once (the avoid-list wins, it needs the stronger evidence); an avoid-list may not name every value
 *  the desk has traded in that dimension (the least bad one is let through); and while the rules would still have
 *  kept none of the settled plans, the single rule that blocks the most is dropped. */
export function guardRules(input: Rules, all_rows: Row[]): { rules: Rules; dropped: string[] } {
  const rows = all_rows.filter(isSettled), r = sanitizeRules(JSON.parse(JSON.stringify(input))), dropped: string[] = [];
  for (const [al, av] of [["allow_hours", "avoid_hours"], ["allow_slots", "avoid_slots"], ["allow_setups", "avoid_setups"]] as const) r[al] = r[al].filter((k) => !r[av].includes(k));
  const dims: [keyof Rules, (o: Row) => string | null][] = [["avoid_setups", (o) => setupKind(o.setup)], ["avoid_hours", (o) => hourOf(o.created_at)], ["avoid_slots", (o) => o.slot], ["avoid_regimes", (o) => o.regime ?? null], ["avoid_symbols", (o) => o.symbol]];
  for (const [k, of] of dims) {
    const list = r[k] as string[], seen = new Map<string, number[]>(); for (const o of rows) { const v = of(o); if (v) seen.set(v, [...(seen.get(v) || []), o.r_result!]); }
    if (!list.length || !seen.size || ![...seen.keys()].every((v) => list.includes(v))) continue;
    const best = [...seen.entries()].sort((a, b) => (expectancy(b[1]).mean ?? -9) - (expectancy(a[1]).mean ?? -9))[0][0];
    (r[k] as string[]) = list.filter((v) => v !== best); dropped.push(`${String(k).replace("_", " ")} "${best}" (the list named every value the desk trades)`);
  }
  const kept = (x: Rules) => rows.filter((o) => !ruleBlocks(x, pickOf(o))).length;
  for (let guard = 0; guard < 60 && rows.length && kept(r) === 0; guard++) {
    const trials: [string, Rules][] = [];
    for (const k of ["avoid_setups", "avoid_hours", "avoid_slots", "avoid_sources", "avoid_regimes", "avoid_symbols"] as const) for (const v of r[k]) trials.push([`${k.replace("_", " ")} "${v}"`, { ...r, [k]: r[k].filter((x) => x !== v) }]);
    for (const k of ["allow_hours", "allow_slots", "allow_setups"] as const) if (r[k].length) trials.push([`${k.replace("_", " ")} list`, { ...r, [k]: [] }]);
    if (r.min_score !== null) trials.push([`min score ${r.min_score}`, { ...r, min_score: null }]);
    if (!trials.length) break;
    const pick = trials.map(([name, x]) => ({ name, x, n: kept(x) })).sort((a, b) => b.n - a.n)[0];
    Object.assign(r, pick.x); dropped.push(`${pick.name} (with it no past plan would have been taken)`);
  }
  return { rules: r, dropped };
}

// ------------------------------------------------------------------------------------------- versions
export async function listVersions(db: D1Database) {
  await ensureStrategy(db);
  const { results } = await db.prepare("SELECT * FROM strategy_versions ORDER BY version DESC LIMIT 40").all<Version>();
  return results.map((v) => ({ ...v, rules: sanitizeRules(JSON.parse(v.rules)), validation: v.validation ? JSON.parse(v.validation) : null }));
}
/** The rules in force. `rules` is what the callers enforce (ruleBlocks). When the plan score does not rank trades
 *  (scoreGate: rank correlation under 0.1 over the last 100 scored plans) the minimum score is taken out and the
 *  analyzer's allow-list takes its place, unless the approved version already has an allow-list of its own.
 *  `auto` marks an allow-list that came from the analyzer rather than from an approved version (version 0 = no
 *  approved version at all). */
export async function activeRules(db: D1Database): Promise<{ version: number; rules: Rules; auto?: boolean; note?: string } | null> {
  try {
    await ensureStrategy(db);
    const v = await db.prepare("SELECT version, rules FROM strategy_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").first<{ version: number; rules: string }>();
    const approved = v ? sanitizeRules(JSON.parse(v.rules)) : null;
    let gate: ScoreGate | null = null; try { gate = await scoreGate(db); } catch { gate = null; }
    if (!gate || gate.use_score) return v ? { version: v.version, rules: approved! } : null;
    const eff = applyScoreGate(approved, gate, approved && hasAllow(approved) ? {} : await analyzerAllow(db));
    if (!v && rulesEmpty(eff.rules)) return null;
    return { version: v?.version ?? 0, rules: eff.rules, auto: eff.auto, note: gate.text };
  } catch { return null; }
}
/** The effect of the score gate on a rule set (pure). */
export function applyScoreGate(approved: Rules | null, gate: { use_score: boolean }, analyzer: Partial<Rules>): { rules: Rules; auto: boolean } {
  const base = sanitizeRules(approved ?? EMPTY_RULES); if (gate.use_score) return { rules: base, auto: false };
  const rules: Rules = { ...base, min_score: null }; if (hasAllow(rules)) return { rules, auto: false };
  const a = sanitizeRules(analyzer);
  for (const [al, av] of [["allow_hours", "avoid_hours"], ["allow_slots", "avoid_slots"], ["allow_setups", "avoid_setups"]] as const) rules[al] = a[al].filter((k) => !rules[av].includes(k));
  return { rules, auto: hasAllow(rules) };
}
let allowCache: { at: number; allow: Partial<Rules> } | null = null;
/** The analyzer's current allow-list (groups that made money over the last 90 days), cached ten minutes. Empty when it would have kept no past plan. */
async function analyzerAllow(db: D1Database): Promise<Partial<Rules>> {
  if (allowCache && Date.now() - allowCache.at < 600_000) return allowCache.allow;
  const s = await getSettings(db), rows = await rowsSince(db, 90), a = analyzeRows(rows, { minN: Math.max(5, Number(s.learn_min_n) || 10), useScore: false });
  const g = guardRules(sanitizeRules(a.allow), rows).rules, allow = { allow_hours: g.allow_hours, allow_slots: g.allow_slots, allow_setups: g.allow_setups };
  allowCache = { at: Date.now(), allow }; return allow;
}
async function nextVersion(db: D1Database) { return ((await db.prepare("SELECT MAX(version) AS v FROM strategy_versions").first<{ v: number | null }>())?.v ?? 0) + 1; }
async function insertVersion(db: D1Database, rules: Rules, rationale: string | null, source: string, status: Version["status"], sessionId: string | null = null) {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16), version = await nextVersion(db);
  const validation = status === "proposed" ? await validateRules(db, rules) : null;
  // Fewer than 30 out-of-sample trades left: the proposal is stored as rejected, with the reason, and never waits for approval.
  const reject = validation?.reject_reason ?? null, st: Version["status"] = reject ? "rejected" : status;
  await db.prepare("INSERT INTO strategy_versions (id, version, status, rules, rationale, source, validation, session_id, error, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, version, st, JSON.stringify(rules), rationale, source, validation ? JSON.stringify(validation) : null, sessionId, reject, reject ? new Date().toISOString().slice(0, 19).replace("T", " ") : null).run();
  return { id, version, validation, status: st, reject_reason: reject };
}

/** The statistical proposal for a set of plans (pure; rows in time order). Avoid-lists come only from groups whose
 *  expectancy is below zero even at the optimistic end of its range; groups that made money become allow-lists.
 *  Rules that do not help out-of-sample are dropped, and guardRules makes a rule set that keeps nothing impossible. */
export function buildProposal(rows: Row[], o: { minN?: number; useScore?: boolean } = {}): { rules: Rules; rationale: string; validation: ReturnType<typeof validateRows>; dropped: string[] } | { error: string } {
  const a = analyzeRows(rows, o), cands = a.failures.filter((f) => f.rule), listed = a.keep.filter((k) => k.listed);
  if (!cands.length && !listed.length) return { error: "Nothing to propose yet: no group has lost money beyond doubt (20 or more trades with even the optimistic end of its range below zero), and no group with enough trades stands out as a winner." };
  const merged = cands.reduce((acc, f) => { for (const [k, v] of Object.entries(f.rule!)) (acc as Record<string, unknown>)[k] = Array.isArray(v) ? [...((acc as Record<string, unknown>)[k] as string[] || []), ...v] : v; return acc; }, { ...a.allow } as Record<string, unknown>);
  const g0 = guardRules(sanitizeRules(merged), rows), dropped = g0.dropped;
  let rules = g0.rules, best = validateRows(rows, rules);
  // Drop what does not help out-of-sample: each avoid rule in turn, then each allow-list.
  const drops: ((r: Rules) => Rules)[] = [...cands.map((f) => (r: Rules) => sanitizeRules({ ...r, ...Object.fromEntries(Object.entries(f.rule!).map(([k, v]) => [k, Array.isArray(v) ? (r[k as keyof Rules] as string[]).filter((x) => !v.includes(x)) : null])) })),
    ...(["allow_hours", "allow_slots", "allow_setups"] as const).map((k) => (r: Rules) => ({ ...r, [k]: [] }))];
  for (const drop of drops) {
    const trial = drop(rules);
    if (rulesEmpty(trial) || JSON.stringify(trial) === JSON.stringify(rules)) continue;
    const t = validateRows(rows, trial);
    if ((t.out_of_sample.filtered.avg_r ?? -9) > (best.out_of_sample.filtered.avg_r ?? -9) && (t.out_of_sample.filtered.kept_pct ?? 0) >= (best.out_of_sample.filtered.kept_pct ?? 0)) { rules = trial; best = t; }
  }
  if (rulesEmpty(rules)) return { error: "Nothing to propose: every candidate rule would have blocked all past plans." };
  const rationale = [`Statistical proposal, judged by average result per trade (never by win rate alone).`,
    cands.length ? `Losing beyond doubt: ${cands.map((f) => f.text).join(" ")}` : "No group has lost money beyond doubt.",
    listed.length ? `Making money (allow-list candidates): ${listed.map((k) => `${DIM_NAME[k.dimension] ?? k.dimension} "${k.key}" ${k.n} trades, ${sgn(k.avg_r)}R each, ${sgn(k.sum_r)}R total`).join("; ")}.` : "",
    dropped.length ? `Left out so the rules cannot block everything: ${dropped.join("; ")}.` : "", "Kept the subset of rules with the best out-of-sample result."].filter(Boolean).join(" ");
  return { rules, rationale, validation: best, dropped };
}

/** Statistical proposer: the failure analyzer's avoid rules and allow-lists, validated; rejected automatically when too few out-of-sample trades are left. */
export async function proposeFromStats(db: D1Database) {
  await ensureStrategy(db);
  const s = await getSettings(db); let gate: ScoreGate | null = null; try { gate = await scoreGate(db); } catch { gate = null; }
  const p = buildProposal(await rowsSince(db, 90), { minN: Math.max(5, Number(s.learn_min_n) || 10), useScore: gate ? gate.use_score : true });
  if ("error" in p) return { error: p.error };
  // The same rules, already rejected: do not store them again every night.
  const last = await db.prepare("SELECT rules, status, error FROM strategy_versions WHERE source = 'stats' ORDER BY version DESC LIMIT 1").first<{ rules: string; status: string; error: string | null }>();
  if (last && last.status === "rejected" && JSON.stringify(sanitizeRules(JSON.parse(last.rules))) === JSON.stringify(p.rules)) return { error: `The statistics still point to the same rules as the last proposal, which was rejected${last.error ? `. ${last.error}` : "."}` };
  const v = await insertVersion(db, p.rules, p.rationale, "stats", "proposed");
  return { id: v.id, version: v.version, validation: v.validation, status: v.status, reject_reason: v.reject_reason };
}

const PROPOSAL_FORMAT = `End your answer with ONE fenced \`\`\`json block (nothing after it):
{"rationale": "3-5 sentences: the patterns you found in the failures and why these rules should help",
 "rules": {"min_score": null, "avoid_setups": ["reversal"], "avoid_hours": ["12:00"], "avoid_slots": [], "avoid_sources": [], "avoid_regimes": ["risk-off"], "avoid_symbols": [], "allow_hours": [], "allow_slots": [], "allow_setups": [], "max_trades_day": 5, "require_kronos": false},
 "expected_effect": "one sentence"}
Setup kinds are exactly: gap / ORB, breakout, pullback, reversal, vwap, earnings / news, trend, other. Hours are New York "HH:00". Use null or [] for anything you do not want to change. Propose only what the evidence supports; fewer rules are better than many.
Judge every group by its average R per trade and the 95% range given (r_low to r_high), never by win rate alone: a group with a low win rate and a positive total R is making money and must NOT be avoided. Avoid a group only when it has 20 or more trades and r_high is below zero. allow_hours / allow_slots / allow_setups are allow-lists of groups with a positive total R: once any is set, a plan must be on at least one of them. Use min_score only if score_check.use_score is true. A proposal that leaves fewer than ${MIN_OOS_TRADES} of the most recent 30% of trades is rejected automatically.`;

/** Reasoning engine: Claude reads the failure report and the statistics and proposes rules (asynchronous, like a brief). */
export async function proposeWithClaude(env: Env, user: string | null) {
  await ensureStrategy(env.DB);
  const s = await getSettings(env.DB), ny = nyNow();
  const capped = await capBlocks(env.DB, s.daily_cap_usd, ny.date);
  if (capped) return { error: capped };
  const thinking = await env.DB.prepare("SELECT id FROM strategy_versions WHERE status = 'thinking'").first<{ id: string }>();
  if (thinking) return { id: thinking.id };
  const rep = await failureReport(env.DB);
  const engine = isEngine(s.engines?.strategy) ? s.engines.strategy : "default";
  const brief = {
    track_record: { plans: rep.summary.picks, settled: rep.summary.settled, win_rate: rep.summary.all?.win_rate, avg_r: rep.summary.all?.avg_r, total_r: rep.summary.total_r, max_drawdown_r: rep.summary.max_drawdown_r },
    groups: Object.fromEntries(Object.entries(rep.summary.groups).map(([k, gs]) => [k, gs.filter((g) => g.n >= 5).map((g) => ({ key: g.key, n: g.n, win_rate: g.win_rate, avg_r: g.avg_r, r_low: g.r_low, r_high: g.r_high, total_r: g.sum_r }))])),
    failures: rep.failures.map((f) => ({ type: f.type, severity: f.severity, text: f.text })),
    making_money: rep.keep.map((k) => ({ dimension: k.dimension, key: k.key, n: k.n, avg_r: k.avg_r, total_r: k.sum_r })),
    score_check: rep.score_gate ? { use_score: rep.score_gate.use_score, rank_correlation: rep.score_gate.spearman, plans: rep.score_gate.n } : null,
    paper_by_signal: rep.paper.by_signal.slice(0, 12), paper_by_source: rep.paper.by_source,
    active_rules: (await activeRules(env.DB))?.rules ?? null,
  };
  const prompt = `[Strategy review] You are reviewing the track record of my trading desk (an agent that recommends day and swing trades; outcomes are replayed walk-forward on the bars after each plan, in R). Find the patterns in the failures and propose rule changes that the evidence supports. Do not run skills or tools; reason from the data below.

${JSON.stringify(brief)}

Think about: which setups, hours, scans, sources, regimes or symbols lose money beyond doubt (20+ trades, r_high below zero); which groups make money and belong on an allow-list; overtrading; whether a Kronos forecast gate is justified. Avoid rules that would remove most of the trades.
${PROPOSAL_FORMAT}`;
  const v = await insertVersion(env.DB, EMPTY_RULES, null, "claude", "thinking");
  try {
    const sid = await createSession(env, Math.max(0.5, s.session_budget_usd / 2), engine as never);
    await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] });
    await env.DB.prepare("UPDATE strategy_versions SET session_id = ? WHERE id = ?").bind(sid, v.id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE strategy_versions SET status = 'error', error = ? WHERE id = ?").bind(String((e as Error).message || e).slice(0, 500), v.id).run();
  }
  void user;
  return { id: v.id, version: v.version };
}

/** Collect Claude's proposal when its session finishes; validate it and mark it proposed. */
export async function finalizeStrategy(env: Env) {
  await ensureStrategy(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM strategy_versions WHERE status = 'thinking' AND session_id IS NOT NULL").all<Version>();
  const anthropic = client(env);
  for (const v of results) {
    try {
      const s = await anthropic.beta.sessions.retrieve(v.session_id!);
      const texts: string[] = []; let sawPrompt = false, idle: string | null = null;
      for await (const ev of anthropic.beta.sessions.events.list(v.session_id!, { order: "asc" })) {
        if (ev.type === "user.message") { sawPrompt = true; idle = null; }
        if (ev.type === "agent.message") for (const c of ev.content) { if (c.type === "text") texts.push(c.text); }
        if (ev.type === "session.status_idle" && sawPrompt) idle = ev.stop_reason.type;
      }
      const ageMin = (Date.now() - Date.parse(v.created_at.replace(" ", "T") + "Z")) / 60000;
      if (!idle && ageMin < 20) continue;
      const cost = s.usage?.list_cost ? `${s.usage.list_cost.amount} ${s.usage.list_cost.currency}` : null;
      await recordSpend(env.DB, { session_id: v.session_id!, kind: "brief", slot: "strategy", day: nyNow().date, cost, engine: null, user: null });
      const last = [...texts.join("\n").matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);
      let parsed: { rationale?: string; rules?: unknown; expected_effect?: string } | null = null;
      try { parsed = last ? JSON.parse(last[1]) : null; } catch { parsed = null; }
      if (!parsed || !parsed.rules) { await env.DB.prepare("UPDATE strategy_versions SET status = 'error', error = ?, cost = ? WHERE id = ?").bind(idle ? "Claude answered without a rules JSON block." : "Timed out.", cost, v.id).run(); continue; }
      // The same guard and the same automatic rejection as the statistical proposer: no rule set that blocks everything.
      const past = await rowsSince(env.DB, 90), g = guardRules(sanitizeRules(parsed.rules), past), rules = g.rules, validation = validateRows(past, rules);
      const why = `${parsed.rationale || ""}${parsed.expected_effect ? ` Expected: ${parsed.expected_effect}` : ""}${g.dropped.length ? ` Left out so the rules cannot block everything: ${g.dropped.join("; ")}.` : ""}`.trim().slice(0, 2000);
      await env.DB.prepare("UPDATE strategy_versions SET status = ?, rules = ?, rationale = ?, validation = ?, cost = ?, error = ?, decided_at = ? WHERE id = ?")
        .bind(validation.reject_reason ? "rejected" : "proposed", JSON.stringify(rules), why, JSON.stringify(validation), cost, validation.reject_reason, validation.reject_reason ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, v.id).run();
    } catch (e) { console.error("strategy", v.id, e); }
  }
}

export async function decideVersion(db: D1Database, id: string, decision: "approve" | "reject") {
  await ensureStrategy(db);
  const v = await db.prepare("SELECT * FROM strategy_versions WHERE id = ?").bind(id).first<Version>();
  if (!v) return { error: "Version not found." };
  if (decision === "reject") { await db.prepare("UPDATE strategy_versions SET status = 'rejected', decided_at = datetime('now') WHERE id = ?").bind(id).run(); return { ok: true }; }
  if (v.status !== "proposed" && v.status !== "retired") return { error: `Only a proposed version can be approved (this one is ${v.status}).` };
  await db.batch([
    db.prepare("UPDATE strategy_versions SET status = 'retired', decided_at = datetime('now') WHERE status = 'active'"),
    db.prepare("UPDATE strategy_versions SET status = 'active', decided_at = datetime('now') WHERE id = ?").bind(id),
  ]);
  return { ok: true };
}
/** Turn the active rules off (back to no rules) without deleting history. */
export async function retireActive(db: D1Database) {
  await ensureStrategy(db);
  await db.prepare("UPDATE strategy_versions SET status = 'retired', decided_at = datetime('now') WHERE status = 'active'").run();
  return { ok: true };
}

/** Prompt block for the scans: the active rules in words. */
export async function rulesPrompt(db: D1Database) {
  const a = await activeRules(db);
  if (!a || rulesEmpty(a.rules)) return "";
  const r = a.rules, parts: string[] = [];
  if (r.min_score !== null) parts.push(`only recommend setups you would score ${r.min_score} or more`);
  if (r.avoid_setups.length) parts.push(`do not recommend ${r.avoid_setups.join(", ")} setups`);
  if (r.avoid_hours.length) parts.push(`plans made at ${r.avoid_hours.join(", ")} New York have lost money: be stricter now if this is one of those hours`);
  if (r.avoid_regimes.length) parts.push(`in a ${r.avoid_regimes.join(" or ")} tape recommend fewer, higher-conviction names`);
  if (r.avoid_symbols.length) parts.push(`skip ${r.avoid_symbols.join(", ")}`);
  if (r.avoid_sources.length) parts.push(`give no weight to ${r.avoid_sources.join(", ")} sources`);
  if (hasAllow(r)) parts.push(`what has made money so far, so prefer it: ${[r.allow_hours.length ? `plans made at ${r.allow_hours.join(", ")} New York` : "", r.allow_slots.length ? `the ${r.allow_slots.join(", ")} scan${r.allow_slots.length > 1 ? "s" : ""}` : "", r.allow_setups.length ? `${r.allow_setups.join(", ")} setups` : ""].filter(Boolean).join("; or ")} (automatic entries take only plans that match at least one of these)`);
  if (r.max_trades_day !== null) parts.push(`at most ${r.max_trades_day} trades a day`);
  if (!parts.length) return "";
  return `[Active strategy rules${a.version ? ` v${a.version}, approved from my own track record` : ""}${a.auto ? `${a.version ? ";" : ","} the allow-list is set automatically because the plan score has not ranked my trades` : ""}] ${parts.join("; ")}.\n\n`;
}
