// Thesis tracker and price watches. The idea and the vocabulary come from LangAlpha's thesis-tracker skill
// (github.com/ginlix-ai/LangAlpha, Apache-2.0): a position rests on three to five falsifiable pillars, each with
// confirm / warning / break thresholds; evidence is appended to a ledger and never rewritten; the aggregate status
// follows the core pillars by a fixed rule, so it cannot sit at "intact" while the pillars underneath it rot; and
// price triggers wake the analysis instead of waiting for someone to look. No numeric conviction score is made up.
import type { Env } from "./env";
import { client, createSession } from "./agent";
import { capBlocks, isEngine, recordSpend } from "./cost";
import { getSettings } from "./db";
import { nyNow } from "./briefs";
import { quotes } from "./market";

export const PILLAR_STATUS = ["strengthening", "intact", "watch", "impaired", "broken", "changed", "untested", "retired"] as const;
export const SIGNALS = ["strongly confirming", "confirming", "mildly confirming", "neutral", "mildly weakening", "weakening", "strongly weakening", "mixed", "invalidating", "untested"] as const;
export const CALLS = ["callable", "conditional", "re-underwrite", "inputs missing"] as const;
export const WATCH_KINDS = ["above", "below", "pct_up", "pct_down"] as const;
type Status = (typeof PILLAR_STATUS)[number];

export type Pillar = { id: string; claim: string; priority: "core" | "supporting"; expected?: string; confirm?: string; warning?: string; break?: string; status: Status; signal?: string; next_proof?: string };
export type ThesisData = {
  aggregate: Status; aggregate_reason?: string; security_call: string; call_reason?: string; action?: string; summary: string;
  pillars: Pillar[]; scenarios?: { bull?: number | null; base?: number | null; bear?: number | null }; break_price?: number | null;
  drift?: string[]; next_proof?: string; rule_note?: string;
};
type ThesisRow = { id: string; user: string; symbol: string; side: string; horizon: string; note: string | null; status: string; data: string | null; content: string | null; session_id: string | null; pending: string | null; cost: string | null; error: string | null; created_at: string; updated_at: string | null };
type Watch = { id: string; user: string; symbol: string; kind: string; level: number; note: string | null; thesis_id: string | null; action: string; status: string; fired_at: number | null; fired_price: number | null; created_at: string };

let ready = false;
export async function ensureThesis(db: D1Database) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS theses (id TEXT PRIMARY KEY, user TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL DEFAULT 'long', horizon TEXT NOT NULL DEFAULT 'months',
      note TEXT, status TEXT NOT NULL, data TEXT, content TEXT, session_id TEXT, pending TEXT, cost TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS thesis_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, thesis_id TEXT NOT NULL, at TEXT DEFAULT (datetime('now')), pillar TEXT, fact TEXT NOT NULL,
      signal TEXT, quality TEXT, impact TEXT, source TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, user TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, level REAL NOT NULL, note TEXT, thesis_id TEXT,
      action TEXT NOT NULL DEFAULT 'notify', status TEXT NOT NULL DEFAULT 'active', fired_at INTEGER, fired_price REAL, created_at TEXT DEFAULT (datetime('now')))`),
  ]);
  ready = true;
}
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const SYM = /^[A-Z0-9.\-^=]{1,15}$/;
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);

/** The reconciliation rule: the aggregate follows the core pillars. Returns the least benign status the rule allows. */
export function ruleAggregate(pillars: Pillar[]): Status | null {
  const core = pillars.filter((p) => p.priority === "core" && p.status !== "retired");
  if (core.some((p) => p.status === "broken")) return "broken";
  if (core.some((p) => p.status === "changed")) return "changed";
  const impaired = core.filter((p) => p.status === "impaired").length;
  if (impaired >= 2) return "impaired";
  if (impaired === 1) return "watch";
  return null;
}
const SEVERITY: Record<string, number> = { strengthening: 0, intact: 1, untested: 1, retired: 1, watch: 2, impaired: 3, changed: 4, broken: 5 };

/** Clean what the model returned and enforce the rule in code. */
export function normalizeThesis(raw: unknown): ThesisData | null {
  const o = raw as Record<string, unknown>;
  if (!o || !Array.isArray(o.pillars) || !o.pillars.length) return null;
  const pillars: Pillar[] = (o.pillars as Record<string, unknown>[]).slice(0, 5).map((p, i) => ({
    id: clip(p.id, 12).toLowerCase().replace(/[^a-z0-9]/g, "") || `p${i + 1}`, claim: clip(p.claim, 300), priority: (p.priority === "supporting" ? "supporting" : "core") as "core" | "supporting",
    expected: clip(p.expected, 200), confirm: clip(p.confirm, 160), warning: clip(p.warning, 160), break: clip(p.break, 160),
    status: (PILLAR_STATUS as readonly string[]).includes(String(p.status)) ? (p.status as Status) : "untested",
    signal: (SIGNALS as readonly string[]).includes(String(p.signal)) ? String(p.signal) : "untested", next_proof: clip(p.next_proof, 160),
  })).filter((p) => p.claim);
  if (!pillars.length) return null;
  let aggregate: Status = (PILLAR_STATUS as readonly string[]).includes(String(o.aggregate)) ? (o.aggregate as Status) : "untested";
  const rule = ruleAggregate(pillars); let rule_note: string | undefined;
  if (rule && SEVERITY[aggregate] < SEVERITY[rule]) { rule_note = `The analyst said "${aggregate}", but the core pillars require at least "${rule}".`; aggregate = rule; }
  const sc = (o.scenarios || {}) as Record<string, unknown>;
  return {
    aggregate, aggregate_reason: clip(o.aggregate_reason, 400), rule_note,
    security_call: (CALLS as readonly string[]).includes(String(o.security_call)) ? String(o.security_call) : "inputs missing", call_reason: clip(o.call_reason, 400), action: clip(o.action, 60),
    summary: clip(o.summary, 900), pillars, scenarios: { bull: num(sc.bull), base: num(sc.base), bear: num(sc.bear) }, break_price: num(o.break_price),
    drift: Array.isArray(o.drift) ? (o.drift as unknown[]).map((d) => clip(d, 200)).filter(Boolean).slice(0, 7) : [], next_proof: clip(o.next_proof, 200),
  };
}

const JSON_SHAPE = `{"aggregate": one of ${PILLAR_STATUS.join(" | ")}, "aggregate_reason": "one sentence", "security_call": one of ${CALLS.join(" | ")}, "call_reason": "one sentence", "action": "the verb, e.g. hold, add, trim, exit, wait", "summary": "three sentences a trader can act on",
 "pillars": [{"id": "p1", "claim": "one falsifiable sentence", "priority": "core" | "supporting", "expected": "what the metric does, by when", "confirm": "level", "warning": "level", "break": "level (the exit trigger)", "status": one of the eight statuses, "signal": one of ${SIGNALS.join(" | ")}, "next_proof": "dated event that tests it"}],
 "ledger": [{"pillar": "p1", "fact": "what was reported, in figures, with its date", "signal": "...", "quality": "fact | estimate | opinion", "impact": "what it changes", "source": "document or URL"}],
 "scenarios": {"bull": price, "base": price, "bear": price}, "break_price": price below (long) or above (short) which the thesis is wrong, or null,
 "watches": [{"kind": "above" | "below" | "pct_up" | "pct_down", "level": number (a price, or a percent for pct_*), "note": "why this level matters"}],
 "drift": ["each drift pattern you found, by name"], "next_proof": "the next dated proof point"}`;

function framePrompt(t: { symbol: string; side: string; horizon: string; note: string | null }, last: number | null) {
  return `[Thesis tracker] Frame an investment thesis for ${t.symbol} (${t.side}, horizon: ${t.horizon}).${last ? ` Last price about ${last}.` : ""}${t.note ? ` The trader's own reason, to be tested rather than assumed: "${t.note}".` : ""}
Method (adapted from LangAlpha's thesis-tracker): write three to five pillars. Each pillar is ONE falsifiable claim that evidence could kill; a claim nothing could disconfirm is a preference, not a pillar. Mark the two or three the position truly rests on as "core". Give each a baseline expectation, and confirm / warning / break levels in figures (a metric, a date, a price), plus the next dated proof point (earnings date, filing, product event).
Use web search and fetch for the facts: latest earnings and guidance, the filings, estimate revisions, valuation against peers, upcoming catalysts. Every figure needs a source and a date. Do not fill fields from memory; mark what you could not find as "untested".
Then: status each pillar from the eight statuses, write the opening evidence ledger (one row per data point), set bull / base / bear prices for the horizon and the break price, and rate the security call: it is "callable" only with a current price and a valuation frame in hand, otherwise say which input is missing. Propose up to four price watches at levels that would change the decision (the break price, the bear and bull values, a sharp one-day move).
The aggregate follows the core pillars: one core pillar impaired means at least "watch"; two mean "impaired"; a core pillar broken or changed sets the aggregate to the same.
Write a short report in markdown (thesis, scorecard table: Pillar | Priority | Expected path | Latest evidence | Signal | Status, scenarios, what would prove it wrong, next proof points). End with ONE fenced \`\`\`json block, nothing after it, in exactly this shape:
${JSON_SHAPE}
Do not place orders and do not run trading skills.`;
}
function updatePrompt(t: ThesisRow, d: ThesisData, ledger: { at: string; pillar: string | null; fact: string; signal: string | null }[], development: string, last: number | null) {
  return `[Thesis tracker] Update the thesis for ${t.symbol} (${t.side}, horizon: ${t.horizon}) on this development: "${development}".${last ? ` Last price about ${last}.` : ""}
The thesis as it stands (pillars and their thresholds are append-only: keep every pillar id, claim and threshold exactly as written; only status, signal and next_proof may change, and a new pillar may be added as a new id):
${JSON.stringify({ aggregate: d.aggregate, security_call: d.security_call, pillars: d.pillars, scenarios: d.scenarios, break_price: d.break_price })}
The evidence ledger so far (never rewritten):
${ledger.slice(-25).map((l) => `- ${l.at.slice(0, 10)} [${l.pillar || "-"}] ${l.fact} (${l.signal || "-"})`).join("\n") || "- empty"}
Method (adapted from LangAlpha's thesis-tracker): verify the development with web search (source and date for every figure). Decompose it before it counts as evidence: for an earnings beat, which component carried it (volume, price, mix, cost, tax, share count, one-offs) and does it recur; for a price move, how much is fundamentals, estimate revisions, multiple change, sector or macro, and say what stays unattributed. A move nobody can attribute is a question, not a confirmation.
Append NEW ledger rows only (one per data point), re-status the pillars it touches, and check the drift patterns by name: the reason changed without a re-underwrite; thresholds quietly moved; only confirming evidence was logged; the horizon stretched; price action is being read as proof. Reconcile the aggregate by the rule (one core pillar impaired: at least "watch"; two: "impaired"; a core pillar broken or changed: the same). Rate the security call again, and propose price watches only if a level changed.
Write a short update in markdown (what happened, what it means for each pillar, the scorecard table, the decision). End with ONE fenced \`\`\`json block, nothing after it, in exactly this shape (the "ledger" array holds only the new rows):
${JSON_SHAPE}
Do not place orders and do not run trading skills.`;
}

async function lastPrice(symbol: string) { try { const q = (await quotes([symbol]))[0] as { last?: number | null }; return q?.last ?? null; } catch { return null; } }

async function begin(env: Env, id: string, prompt: string, user: string | null) {
  const s = await getSettings(env.DB);
  const engine = isEngine((s.engines as Record<string, string> | undefined)?.thesis) ? (s.engines as Record<string, string>).thesis : "default";
  const sid = await createSession(env, Math.max(1.5, s.session_budget_usd * 1.5), engine as never);
  await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] });
  await env.DB.prepare("UPDATE theses SET session_id = ?, status = 'running', error = NULL WHERE id = ?").bind(sid, id).run();
  void user;
}

/** Start a new thesis (frame mode). One per user and symbol; starting again on the same symbol replaces nothing, it errors. */
export async function startThesis(env: Env, b: { symbol?: unknown; side?: unknown; horizon?: unknown; note?: unknown }, user: string): Promise<{ id?: string; error?: string }> {
  await ensureThesis(env.DB);
  const symbol = clip(b.symbol, 15).toUpperCase(); if (!SYM.test(symbol)) return { error: "Bad symbol" };
  const side = b.side === "short" ? "short" : "long", horizon = ["weeks", "months", "a year or more"].includes(String(b.horizon)) ? String(b.horizon) : "months", note = clip(b.note, 400) || null;
  if (await env.DB.prepare("SELECT 1 FROM theses WHERE user = ? AND symbol = ?").bind(user, symbol).first()) return { error: `You already track a thesis for ${symbol}. Open it and add a development instead.` };
  const s = await getSettings(env.DB); const capped = await capBlocks(env.DB, s.daily_cap_usd, nyNow().date); if (capped) return { error: capped };
  const id = newId();
  await env.DB.prepare("INSERT INTO theses (id, user, symbol, side, horizon, note, status) VALUES (?, ?, ?, ?, ?, ?, 'starting')").bind(id, user, symbol, side, horizon, note).run();
  try { await begin(env, id, framePrompt({ symbol, side, horizon, note }, await lastPrice(symbol)), user); }
  catch (e) { await env.DB.prepare("UPDATE theses SET status = 'error', error = ? WHERE id = ?").bind(clip((e as Error).message || e, 500), id).run(); }
  return { id };
}

/** Feed a development into an existing thesis (update mode). */
export async function updateThesis(env: Env, id: string, development: string, user: string | null): Promise<{ id?: string; error?: string }> {
  await ensureThesis(env.DB);
  const t = await env.DB.prepare("SELECT * FROM theses WHERE id = ?").bind(id).first<ThesisRow>();
  if (!t || (user && t.user !== user)) return { error: "No such thesis." };
  if (t.status === "running" || t.status === "starting") return { error: "This thesis is already being worked on." };
  development = clip(development, 600); if (development.length < 8) return { error: "Describe the development in a sentence." };
  const s = await getSettings(env.DB); const capped = await capBlocks(env.DB, s.daily_cap_usd, nyNow().date); if (capped) return { error: capped };
  let d: ThesisData | null = null; try { d = t.data ? (JSON.parse(t.data) as ThesisData) : null; } catch { d = null; }
  const { results: ledger } = await env.DB.prepare("SELECT at, pillar, fact, signal FROM thesis_ledger WHERE thesis_id = ? ORDER BY id").bind(id).all<{ at: string; pillar: string | null; fact: string; signal: string | null }>();
  const prompt = d ? updatePrompt(t, d, ledger, development, await lastPrice(t.symbol)) : framePrompt({ ...t, note: [t.note, development].filter(Boolean).join(" / ") }, await lastPrice(t.symbol));
  await env.DB.prepare("UPDATE theses SET status = 'starting', pending = ? WHERE id = ?").bind(development, id).run();
  try { await begin(env, id, prompt, user); }
  catch (e) { await env.DB.prepare("UPDATE theses SET status = ?, error = ?, pending = NULL WHERE id = ?").bind(d ? "ready" : "error", clip((e as Error).message || e, 500), id).run(); return { error: clip((e as Error).message || e, 200) }; }
  return { id };
}

function lastJson(content: string): unknown {
  const all = [...content.matchAll(/```json\s*([\s\S]*?)```/g)]; if (!all.length) return null;
  try { return JSON.parse(all[all.length - 1][1]); } catch { return null; }
}

/** Collect finished sessions: store the thesis, append the ledger, create the proposed watches. */
export async function finalizeTheses(env: Env) {
  await ensureThesis(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM theses WHERE status = 'running'").all<ThesisRow>();
  const anthropic = client(env);
  for (const r of results) {
    if (!r.session_id) continue;
    try {
      const s = await anthropic.beta.sessions.retrieve(r.session_id);
      const texts: string[] = [], asks = new Set<string>(), answered = new Set<string>(); let sawPrompt = false, idle: string | null = null;
      for await (const ev of anthropic.beta.sessions.events.list(r.session_id, { order: "asc" })) {
        if (ev.type === "user.message") { sawPrompt = true; idle = null; }
        if (ev.type === "agent.message") for (const c of ev.content) { if (c.type === "text") texts.push(c.text); }
        if ((ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use") && ev.evaluated_permission === "ask") asks.add(ev.id);
        if (ev.type === "user.tool_confirmation") answered.add(ev.tool_use_id);
        if (ev.type === "session.status_idle" && sawPrompt) idle = ev.stop_reason.type;
      }
      if (idle === "requires_action") { // the app never approves a tool that asks (an order, for example)
        const pending = [...asks].filter((x) => !answered.has(x));
        if (pending.length) await anthropic.beta.sessions.events.send(r.session_id, { events: pending.map((tool_use_id) => ({ type: "user.tool_confirmation" as const, tool_use_id, result: "deny" as const })) });
        continue;
      }
      const ageMin = (Date.now() - Date.parse((r.updated_at || r.created_at).replace(" ", "T") + "Z")) / 60000;
      if (!idle) { if (ageMin > 60 && !r.data) await env.DB.prepare("UPDATE theses SET status = 'error', error = 'Timed out after an hour.' WHERE id = ?").bind(r.id).run(); continue; }
      const cost = s.usage?.list_cost ? `${s.usage.list_cost.amount} ${s.usage.list_cost.currency}` : null;
      await recordSpend(env.DB, { session_id: r.session_id, kind: "brief", slot: "thesis", day: nyNow().date, cost, engine: null, user: r.user });
      const content = texts.join("\n\n"), raw = lastJson(content) as Record<string, unknown> | null, d = normalizeThesis(raw);
      const report = content.replace(/```json[\s\S]*?```/g, "").trim().slice(0, 12000) || null;
      if (!d) {
        const why = idle === "end_turn" ? "The analyst finished without a usable thesis. Try again, or add a clearer development." : `Stopped early (${idle}).`;
        await env.DB.prepare("UPDATE theses SET status = ?, error = ?, pending = NULL, cost = ?, session_id = NULL WHERE id = ?").bind(r.data ? "ready" : "error", why, cost, r.id).run();
        continue;
      }
      const stmts = [env.DB.prepare("UPDATE theses SET status = 'ready', data = ?, content = ?, cost = ?, error = NULL, pending = NULL, session_id = NULL, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(d), report, cost, r.id)];
      if (r.pending) stmts.push(env.DB.prepare("INSERT INTO thesis_ledger (thesis_id, pillar, fact, signal, quality, impact, source) VALUES (?, NULL, ?, NULL, 'note', ?, 'you')").bind(r.id, `Development: ${r.pending}`, `Thesis now ${d.aggregate}; call ${d.security_call}.`));
      for (const l of (Array.isArray(raw?.ledger) ? (raw!.ledger as Record<string, unknown>[]) : []).slice(0, 12)) {
        const fact = clip(l.fact, 400); if (!fact) continue;
        stmts.push(env.DB.prepare("INSERT INTO thesis_ledger (thesis_id, pillar, fact, signal, quality, impact, source) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(r.id, clip(l.pillar, 12) || null, fact, (SIGNALS as readonly string[]).includes(String(l.signal)) ? String(l.signal) : null, clip(l.quality, 20) || null, clip(l.impact, 300) || null, clip(l.source, 300) || null));
      }
      await env.DB.batch(stmts);
      for (const w of (Array.isArray(raw?.watches) ? (raw!.watches as Record<string, unknown>[]) : []).slice(0, 4))
        await addWatch(env.DB, r.user, { symbol: r.symbol, kind: w.kind, level: w.level, note: w.note, thesis_id: r.id, action: "update" });
    } catch (e) { console.error("thesis", r.id, e); }
  }
}

export async function addWatch(db: D1Database, user: string, b: { symbol?: unknown; kind?: unknown; level?: unknown; note?: unknown; thesis_id?: unknown; action?: unknown }): Promise<string | null> {
  await ensureThesis(db);
  const symbol = clip(b.symbol, 15).toUpperCase(), kind = String(b.kind), level = Number(b.level);
  if (!SYM.test(symbol)) return "Bad symbol";
  if (!(WATCH_KINDS as readonly string[]).includes(kind)) return "Choose: above, below, up by %, or down by %.";
  if (!(level > 0) || (kind.startsWith("pct") && level > 90)) return "Enter a positive level (a price, or a percent up to 90).";
  const n = await db.prepare("SELECT COUNT(*) AS n FROM watches WHERE user = ? AND status = 'active'").bind(user).first<{ n: number }>();
  if ((n?.n ?? 0) >= 40) return "You have 40 active watches. Remove some first.";
  const tid = typeof b.thesis_id === "string" && b.thesis_id ? b.thesis_id : (await db.prepare("SELECT id FROM theses WHERE user = ? AND symbol = ?").bind(user, symbol).first<{ id: string }>())?.id ?? null;
  if (await db.prepare("SELECT 1 FROM watches WHERE user = ? AND symbol = ? AND kind = ? AND status = 'active' AND ABS(level - ?) < ?").bind(user, symbol, kind, level, Math.max(0.005, level * 0.002)).first()) return null; // already there
  await db.prepare("INSERT INTO watches (id, user, symbol, kind, level, note, thesis_id, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(newId(), user, symbol, kind, level, clip(b.note, 200) || null, tid, b.action === "update" && tid ? "update" : "notify").run();
  return null;
}
export async function deleteWatch(db: D1Database, user: string, id: string) { await ensureThesis(db); await db.prepare("DELETE FROM watches WHERE id = ? AND user = ?").bind(id, user).run(); }

export const watchHit = (w: { kind: string; level: number }, q: { last?: number | null; change_pct?: number | null }) =>
  q.last == null ? false : w.kind === "above" ? q.last >= w.level : w.kind === "below" ? q.last <= w.level : q.change_pct == null ? false : w.kind === "pct_up" ? q.change_pct >= w.level : q.change_pct <= -w.level;

/** Every minute: fire the watches whose level was crossed. A fired watch is logged on its thesis and, when set to, wakes an update. */
export async function checkWatches(env: Env) {
  await ensureThesis(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM watches WHERE status = 'active'").all<Watch>();
  if (!results.length) return 0;
  const qs = new Map<string, { last?: number | null; change_pct?: number | null }>();
  for (const q of (await quotes([...new Set(results.map((w) => w.symbol))])) as { symbol: string; last?: number | null; change_pct?: number | null }[]) qs.set(q.symbol, q);
  let fired = 0; const woke = new Set<string>();
  for (const w of results) {
    const q = qs.get(w.symbol); if (!q || !watchHit(w, q)) continue;
    fired++;
    const what = w.kind === "above" ? `rose to ${q.last} (watch: above ${w.level})` : w.kind === "below" ? `fell to ${q.last} (watch: below ${w.level})` : `moved ${q.change_pct?.toFixed(2)}% today to ${q.last} (watch: ${w.kind === "pct_up" ? "up" : "down"} ${w.level}%)`;
    await env.DB.prepare("UPDATE watches SET status = 'fired', fired_at = ?, fired_price = ? WHERE id = ? AND status = 'active'").bind(Math.floor(Date.now() / 1000), q.last ?? null, w.id).run();
    if (!w.thesis_id) continue;
    await env.DB.prepare("INSERT INTO thesis_ledger (thesis_id, pillar, fact, signal, quality, impact, source) VALUES (?, NULL, ?, NULL, 'fact', ?, 'price watch')").bind(w.thesis_id, `${w.symbol} ${what}.`, w.note || null).run();
    if (w.action === "update" && !woke.has(w.thesis_id)) { // one wake per thesis per minute, however many levels were crossed
      woke.add(w.thesis_id);
      try { await updateThesis(env, w.thesis_id, `Price watch fired: ${w.symbol} ${what}.${w.note ? ` Why the level matters: ${w.note}` : ""}`, null); } catch (e) { console.error("watch wake", w.id, e); }
    }
  }
  return fired;
}

export async function listTheses(db: D1Database, user: string) {
  await ensureThesis(db);
  const { results } = await db.prepare("SELECT id, symbol, side, horizon, note, status, data, cost, error, pending, created_at, updated_at FROM theses WHERE user = ? ORDER BY COALESCE(updated_at, created_at) DESC").bind(user).all<ThesisRow>();
  const { results: watches } = await db.prepare("SELECT * FROM watches WHERE user = ? ORDER BY status = 'active' DESC, COALESCE(fired_at, 0) DESC, created_at DESC LIMIT 80").bind(user).all<Watch>();
  const syms = [...new Set([...results.map((t) => t.symbol), ...watches.filter((w) => w.status === "active").map((w) => w.symbol)])];
  const qs: Record<string, { last?: number | null; change_pct?: number | null }> = {};
  try { for (const q of (await quotes(syms)) as { symbol: string; last?: number | null; change_pct?: number | null }[]) qs[q.symbol] = { last: q.last ?? null, change_pct: q.change_pct ?? null }; } catch { /* prices are optional */ }
  return {
    theses: results.map((t) => { let d: ThesisData | null = null; try { d = t.data ? JSON.parse(t.data) : null; } catch { d = null; } return { id: t.id, symbol: t.symbol, side: t.side, horizon: t.horizon, note: t.note, status: t.status, error: t.error, pending: t.pending, cost: t.cost, created_at: t.created_at, updated_at: t.updated_at, data: d, quote: qs[t.symbol] || null }; }),
    watches: watches.map((w) => ({ ...w, quote: qs[w.symbol] || null })),
  };
}
export async function getThesis(db: D1Database, user: string, id: string) {
  await ensureThesis(db);
  const t = await db.prepare("SELECT * FROM theses WHERE id = ? AND user = ?").bind(id, user).first<ThesisRow>(); if (!t) return null;
  const { results: ledger } = await db.prepare("SELECT * FROM thesis_ledger WHERE thesis_id = ? ORDER BY id DESC LIMIT 200").bind(id).all();
  let d: ThesisData | null = null; try { d = t.data ? JSON.parse(t.data) : null; } catch { d = null; }
  return { id: t.id, symbol: t.symbol, side: t.side, horizon: t.horizon, note: t.note, status: t.status, error: t.error, pending: t.pending, cost: t.cost, created_at: t.created_at, updated_at: t.updated_at, data: d, content: t.content, ledger };
}
export async function deleteThesis(db: D1Database, user: string, id: string) {
  await ensureThesis(db);
  if (!(await db.prepare("SELECT 1 FROM theses WHERE id = ? AND user = ?").bind(id, user).first())) return;
  await db.batch([db.prepare("DELETE FROM thesis_ledger WHERE thesis_id = ?").bind(id), db.prepare("DELETE FROM watches WHERE thesis_id = ?").bind(id), db.prepare("DELETE FROM theses WHERE id = ?").bind(id)]);
}

/** One line per symbol for the scan and Deep Analysis prompts: what the trader already believes and where it breaks. */
export async function thesisContext(db: D1Database, user = "admin"): Promise<string> {
  try {
    await ensureThesis(db);
    const { results } = await db.prepare("SELECT symbol, side, data FROM theses WHERE user = ? AND status = 'ready' AND data IS NOT NULL LIMIT 12").bind(user).all<{ symbol: string; side: string; data: string }>();
    const lines = results.map((t) => { try { const d = JSON.parse(t.data) as ThesisData; return `- ${t.symbol} (${t.side}): thesis ${d.aggregate}, call ${d.security_call}${d.break_price ? `, wrong ${t.side === "short" ? "above" : "below"} ${d.break_price}` : ""}${d.next_proof ? `; next proof: ${d.next_proof}` : ""}`; } catch { return ""; } }).filter(Boolean);
    return lines.length ? `Tracked theses (the trader's longer-horizon views; a plan against a thesis marked impaired or broken needs a reason):\n${lines.join("\n")}\n\n` : "";
  } catch { return ""; }
}
