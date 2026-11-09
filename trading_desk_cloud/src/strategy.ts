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
import { ensureLearn, hourOf, learnSummary, paperLearn, setupKind, wilsonLow, type Outcome } from "./learn";

export type Rules = {
  min_score: number | null;          // skip picks under this score
  avoid_setups: string[];            // setup kinds (gap / ORB, breakout, pullback, reversal, vwap, earnings / news, trend, other)
  avoid_hours: string[];             // scan hours New York, "HH:00"
  avoid_slots: string[];             // scan ids
  avoid_sources: string[];           // Winners desk source types
  avoid_regimes: string[];           // risk-on / risk-off / mixed
  avoid_symbols: string[];
  max_trades_day: number | null;     // auto-trade entries per account per day
  require_kronos: boolean;           // chart autopilot: a fresh Kronos forecast must agree
};
export const EMPTY_RULES: Rules = { min_score: null, avoid_setups: [], avoid_hours: [], avoid_slots: [], avoid_sources: [], avoid_regimes: [], avoid_symbols: [], max_trades_day: null, require_kronos: false };
export type Version = {
  id: string; version: number; status: "proposed" | "thinking" | "active" | "rejected" | "retired" | "error"; rules: string; rationale: string | null; source: string;
  validation: string | null; session_id: string | null; error: string | null; created_at: string; decided_at: string | null; cost: string | null;
};
export type Failure = { type: "underperformance" | "drawdown" | "overtrading" | "slippage" | "regime" | "no_trigger"; severity: "high" | "medium" | "low"; text: string; evidence: Record<string, unknown>; rule?: Partial<Rules> };

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
  return { min_score: Number.isFinite(ms) && ms > 0 ? Math.max(0, Math.min(100, Math.round(ms))) : null, avoid_setups: list(o.avoid_setups), avoid_hours: list(o.avoid_hours).map((h) => h.slice(0, 2).padStart(2, "0") + ":00"),
    avoid_slots: list(o.avoid_slots), avoid_sources: list(o.avoid_sources), avoid_regimes: list(o.avoid_regimes), avoid_symbols: list(o.avoid_symbols, 30).map((s) => s.toUpperCase()),
    max_trades_day: Number.isFinite(Number(o.max_trades_day)) && Number(o.max_trades_day) > 0 ? Math.round(Number(o.max_trades_day)) : null, require_kronos: !!o.require_kronos };
}
export const rulesEmpty = (r: Rules) => r.min_score === null && !r.avoid_setups.length && !r.avoid_hours.length && !r.avoid_slots.length && !r.avoid_sources.length && !r.avoid_regimes.length && !r.avoid_symbols.length && r.max_trades_day === null && !r.require_kronos;

/** Why a plan breaks the rules (null = allowed). Works on outcomes and on live picks alike. */
export function ruleBlocks(r: Rules, p: { score?: number | null; setup?: string | null; slot?: string | null; symbol?: string | null; sources?: string[] | null; regime?: string | null; created_at?: number | null }): string | null {
  if (r.min_score !== null && (p.score ?? 0) < r.min_score) return `score ${p.score ?? "?"} under ${r.min_score}`;
  const kind = setupKind(p.setup ?? null);
  if (r.avoid_setups.includes(kind)) return `setup ${kind}`;
  if (p.slot && r.avoid_slots.includes(p.slot)) return `scan ${p.slot}`;
  if (p.created_at && r.avoid_hours.includes(hourOf(p.created_at))) return `hour ${hourOf(p.created_at)}`;
  if (p.symbol && r.avoid_symbols.includes(p.symbol.toUpperCase())) return `symbol ${p.symbol}`;
  if (p.regime && r.avoid_regimes.includes(p.regime)) return `regime ${p.regime}`;
  if (p.sources && p.sources.some((s) => r.avoid_sources.includes(s))) return `source ${p.sources.find((s) => r.avoid_sources.includes(s))}`;
  return null;
}

// ------------------------------------------------------------------------------------------- failure analyzer
export async function failureReport(db: D1Database, days = 90): Promise<{ failures: Failure[]; summary: Awaited<ReturnType<typeof learnSummary>>; paper: Awaited<ReturnType<typeof paperLearn>> }> {
  await ensureStrategy(db);
  const s = await getSettings(db), minN = Math.max(5, Number(s.learn_min_n) || 10);
  const sum = await learnSummary(db, days), paper = await paperLearn(db, days);
  const f: Failure[] = [];
  const dim: Record<string, keyof Rules | null> = { setup: "avoid_setups", hour: "avoid_hours", slot: "avoid_slots", source: "avoid_sources", symbol: "avoid_symbols", regime: "avoid_regimes", score: null, horizon: null, side: null };
  for (const [name, gs] of Object.entries(sum.groups)) {
    for (const g of gs) {
      if (g.n < minN || g.avg_r === null) continue;
      const bad = g.avg_r <= -0.15 || (g.ci_low !== null && g.ci_low < 25 && (g.win_rate ?? 0) < 40);
      if (!bad) continue;
      const key = dim[name];
      f.push({ type: "underperformance", severity: g.avg_r <= -0.4 ? "high" : "medium", text: `${name} "${g.key}": ${g.n} trades, ${g.win_rate}% wins (CI low ${g.ci_low}%), ${g.avg_r}R per trade, ${g.sum_r}R total`,
        evidence: { dimension: name, key: g.key, n: g.n, win_rate: g.win_rate, ci_low: g.ci_low, avg_r: g.avg_r }, rule: key ? ({ [key]: [g.key] } as Partial<Rules>) : name === "score" && g.key !== "no score" ? { min_score: g.key === "under 60" ? 60 : g.key === "60-69" ? 70 : g.key === "70-79" ? 80 : null } : undefined });
    }
  }
  if (sum.max_drawdown_r <= -5) f.push({ type: "drawdown", severity: sum.max_drawdown_r <= -10 ? "high" : "medium", text: `Worst drawdown ${sum.max_drawdown_r}R on the walk-forward R curve (${sum.settled} settled trades)`, evidence: { max_drawdown_r: sum.max_drawdown_r } });
  // Losing streaks and overtrading days.
  const settled = sum.recent.length ? (await db.prepare("SELECT * FROM pick_outcomes WHERE symbol != '-' AND status IN ('win','loss','timed') AND created_at >= ? ORDER BY exit_at").bind(nowS() - days * 86400).all<Outcome>()).results : [];
  let streak = 0, worst = 0; for (const o of settled) { streak = (o.r_result ?? 0) <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  if (worst >= 6) f.push({ type: "drawdown", severity: worst >= 10 ? "high" : "low", text: `Longest losing streak: ${worst} trades in a row`, evidence: { streak: worst } });
  const byDay = new Map<string, Outcome[]>(); for (const o of settled) byDay.set(o.day, [...(byDay.get(o.day) || []), o]);
  const busy = [...byDay.entries()].filter(([, v]) => v.length >= 8).map(([d, v]) => ({ day: d, n: v.length, r: r2(v.reduce((a, o) => a + (o.r_result ?? 0), 0)) })).filter((x) => x.r < 0);
  if (busy.length) f.push({ type: "overtrading", severity: "medium", text: `${busy.length} day${busy.length > 1 ? "s" : ""} with 8+ triggered plans ended negative (e.g. ${busy[0].day}: ${busy[0].n} trades, ${busy[0].r}R)`, evidence: { days: busy.slice(0, 5) }, rule: { max_trades_day: 5 } });
  // Slippage proxy: fills that gapped through the entry versus the plan.
  const slips = settled.filter((o) => o.fill !== null).map((o) => ((o.fill! - o.entry) * (o.side === "long" ? 1 : -1)) / Math.abs(o.entry - o.stop));
  if (slips.length >= minN) { const avg = slips.reduce((a, b) => a + b, 0) / slips.length; if (Math.abs(avg) >= 0.1) f.push({ type: "slippage", severity: "low", text: `Fills average ${avg >= 0 ? "+" : ""}${r2(avg)}R ${avg > 0 ? "worse" : "better"} than the planned entry (gaps through the level)`, evidence: { avg_fill_vs_entry_r: r2(avg), n: slips.length } }); }
  // Regime: how the plans did in each market regime the brief reported.
  const byRegime = new Map<string, Outcome[]>(); for (const o of settled) { const k = (o as Outcome & { regime?: string | null }).regime || "unknown"; byRegime.set(k, [...(byRegime.get(k) || []), o]); }
  for (const [k, v] of byRegime) {
    if (k === "unknown" || v.length < minN) continue;
    const wins = v.filter((o) => (o.r_result ?? 0) > 0).length, avg = v.reduce((a, o) => a + (o.r_result ?? 0), 0) / v.length;
    if (avg <= -0.15) f.push({ type: "regime", severity: "medium", text: `In a ${k} tape: ${v.length} trades, ${r2((wins / v.length) * 100)}% wins, ${r2(avg)}R per trade`, evidence: { regime: k, n: v.length, avg_r: r2(avg), ci_low: r2(wilsonLow(wins, v.length) * 100) }, rule: { avoid_regimes: [k] } });
  }
  if (sum.all && sum.all.total >= minN && sum.all.no_trigger / sum.all.total > 0.6) f.push({ type: "no_trigger", severity: "low", text: `${Math.round((sum.all.no_trigger / sum.all.total) * 100)}% of plans never reached their entry: entries are set too far from the price`, evidence: { no_trigger: sum.all.no_trigger, total: sum.all.total } });
  f.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]);
  return { failures: f, summary: sum, paper };
}

// ------------------------------------------------------------------------------------------- validation
type VStats = { n: number; wins: number; win_rate: number | null; avg_r: number | null; total_r: number; max_drawdown_r: number; kept_pct?: number };
function vstats(rows: Outcome[]): VStats {
  const n = rows.length, wins = rows.filter((o) => (o.r_result ?? 0) > 0).length, sum = rows.reduce((a, o) => a + (o.r_result ?? 0), 0);
  let cum = 0, peak = 0, dd = 0; for (const o of rows) { cum += o.r_result ?? 0; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n, wins, win_rate: n ? r2((wins / n) * 100) : null, avg_r: n ? r2(sum / n) : null, total_r: r2(sum), max_drawdown_r: r2(dd) };
}
/** Replay the rules on the settled plans: baseline vs filtered, on the first 70% (in-sample) and the last 30% (out-of-sample). */
export async function validateRules(db: D1Database, rules: Rules, days = 90) {
  await ensureStrategy(db);
  const rows = (await db.prepare("SELECT * FROM pick_outcomes WHERE symbol != '-' AND status IN ('win','loss','timed') AND r_result IS NOT NULL AND created_at >= ? ORDER BY created_at").bind(nowS() - days * 86400).all<Outcome & { regime?: string | null }>()).results;
  const keep = (o: Outcome & { regime?: string | null }) => { let src: string[] = []; try { src = JSON.parse(o.sources || "[]"); } catch { src = []; } return !ruleBlocks(rules, { score: o.score, setup: o.setup, slot: o.slot, symbol: o.symbol, sources: src, regime: o.regime ?? null, created_at: o.created_at }); };
  const cut = Math.floor(rows.length * 0.7), is = rows.slice(0, cut), oos = rows.slice(cut);
  const part = (r: typeof rows) => { const base = vstats(r), filt = vstats(r.filter(keep)); return { baseline: base, filtered: { ...filt, kept_pct: base.n ? r2((filt.n / base.n) * 100) : null } }; };
  const all = part(rows), inS = part(is), out = part(oos);
  // Verdict: better out-of-sample expectancy without throwing away most of the trades, and no worse drawdown.
  const better = out.baseline.n >= 5 && out.filtered.n >= 3 && (out.filtered.avg_r ?? -9) > (out.baseline.avg_r ?? -9) && (out.filtered.kept_pct ?? 0) >= 30 && out.filtered.max_drawdown_r >= out.baseline.max_drawdown_r - 0.5;
  const verdict = rows.length < 10 ? "insufficient" : better ? "improves" : (out.filtered.avg_r ?? -9) >= (out.baseline.avg_r ?? -9) ? "neutral" : "worse";
  return { days, trades: rows.length, all, in_sample: inS, out_of_sample: out, verdict };
}

// ------------------------------------------------------------------------------------------- versions
export async function listVersions(db: D1Database) {
  await ensureStrategy(db);
  const { results } = await db.prepare("SELECT * FROM strategy_versions ORDER BY version DESC LIMIT 40").all<Version>();
  return results.map((v) => ({ ...v, rules: sanitizeRules(JSON.parse(v.rules)), validation: v.validation ? JSON.parse(v.validation) : null }));
}
export async function activeRules(db: D1Database): Promise<{ version: number; rules: Rules } | null> {
  try {
    await ensureStrategy(db);
    const v = await db.prepare("SELECT version, rules FROM strategy_versions WHERE status = 'active' ORDER BY version DESC LIMIT 1").first<{ version: number; rules: string }>();
    return v ? { version: v.version, rules: sanitizeRules(JSON.parse(v.rules)) } : null;
  } catch { return null; }
}
async function nextVersion(db: D1Database) { return ((await db.prepare("SELECT MAX(version) AS v FROM strategy_versions").first<{ v: number | null }>())?.v ?? 0) + 1; }
async function insertVersion(db: D1Database, rules: Rules, rationale: string | null, source: string, status: Version["status"], sessionId: string | null = null) {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16), version = await nextVersion(db);
  const validation = status === "proposed" ? await validateRules(db, rules) : null;
  await db.prepare("INSERT INTO strategy_versions (id, version, status, rules, rationale, source, validation, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, version, status, JSON.stringify(rules), rationale, source, validation ? JSON.stringify(validation) : null, sessionId).run();
  return { id, version, validation };
}

/** Statistical proposer: merge the rules the failure analyzer suggests, keep only the combination that validates best. */
export async function proposeFromStats(db: D1Database) {
  const rep = await failureReport(db);
  const cands = rep.failures.filter((f) => f.rule);
  if (!cands.length) return { error: "The failure analyzer found nothing with enough trades to act on yet." };
  // Start from the combination of every suggested rule, then drop the ones that do not help out-of-sample.
  let rules = sanitizeRules(cands.reduce((acc, f) => { for (const [k, v] of Object.entries(f.rule!)) (acc as Record<string, unknown>)[k] = Array.isArray(v) ? [...((acc as Record<string, unknown>)[k] as string[] || []), ...v] : v; return acc; }, {} as Record<string, unknown>));
  let best = await validateRules(db, rules);
  for (const f of cands) {
    const trial = sanitizeRules({ ...rules, ...Object.fromEntries(Object.entries(f.rule!).map(([k, v]) => [k, Array.isArray(v) ? (rules[k as keyof Rules] as string[]).filter((x) => !v.includes(x)) : null])) });
    if (rulesEmpty(trial)) continue;
    const t = await validateRules(db, trial);
    if ((t.out_of_sample.filtered.avg_r ?? -9) > (best.out_of_sample.filtered.avg_r ?? -9) && (t.out_of_sample.filtered.kept_pct ?? 0) >= (best.out_of_sample.filtered.kept_pct ?? 0)) { rules = trial; best = t; }
  }
  const rationale = `Statistical proposal from the failure analyzer: ${cands.map((f) => f.text).join("; ")}. Kept the subset of rules with the best out-of-sample expectancy.`;
  const v = await insertVersion(db, rules, rationale, "stats", "proposed");
  return { id: v.id, version: v.version, validation: v.validation };
}

const PROPOSAL_FORMAT = `End your answer with ONE fenced \`\`\`json block (nothing after it):
{"rationale": "3-5 sentences: the patterns you found in the failures and why these rules should help",
 "rules": {"min_score": 70, "avoid_setups": ["reversal"], "avoid_hours": ["12:00"], "avoid_slots": [], "avoid_sources": [], "avoid_regimes": ["risk-off"], "avoid_symbols": [], "max_trades_day": 5, "require_kronos": false},
 "expected_effect": "one sentence"}
Setup kinds are exactly: gap / ORB, breakout, pullback, reversal, vwap, earnings / news, trend, other. Hours are New York "HH:00". Use null or [] for anything you do not want to change. Propose only what the evidence supports; fewer rules are better than many.`;

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
    groups: Object.fromEntries(Object.entries(rep.summary.groups).map(([k, gs]) => [k, gs.filter((g) => g.n >= 5).map((g) => ({ key: g.key, n: g.n, win_rate: g.win_rate, ci_low: g.ci_low, avg_r: g.avg_r, total_r: g.sum_r }))])),
    failures: rep.failures.map((f) => ({ type: f.type, severity: f.severity, text: f.text })),
    paper_by_signal: rep.paper.by_signal.slice(0, 12), paper_by_source: rep.paper.by_source,
    active_rules: (await activeRules(env.DB))?.rules ?? null,
  };
  const prompt = `[Strategy review] You are reviewing the track record of my trading desk (an agent that recommends day and swing trades; outcomes are replayed walk-forward on the bars after each plan, in R). Find the patterns in the failures and propose rule changes that the evidence supports. Do not run skills or tools; reason from the data below.

${JSON.stringify(brief)}

Think about: which setups, hours, scans, sources, regimes or symbols lose money with enough trades to matter; whether a higher minimum score would have helped; overtrading; whether a Kronos forecast gate is justified. Avoid rules that would remove most of the trades.
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
      const rules = sanitizeRules(parsed.rules), validation = await validateRules(env.DB, rules);
      await env.DB.prepare("UPDATE strategy_versions SET status = 'proposed', rules = ?, rationale = ?, validation = ?, cost = ? WHERE id = ?")
        .bind(JSON.stringify(rules), `${parsed.rationale || ""}${parsed.expected_effect ? ` Expected: ${parsed.expected_effect}` : ""}`.trim().slice(0, 2000), JSON.stringify(validation), cost, v.id).run();
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
  if (r.max_trades_day !== null) parts.push(`at most ${r.max_trades_day} trades a day`);
  return `[Active strategy rules v${a.version}, approved from my own track record] ${parts.join("; ")}.\n\n`;
}
