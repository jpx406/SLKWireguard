// Deep Analysis: one ticker through TradingAgents (TauricResearch, MIT) inside the agent's sandbox.
// Four analysts (market, news, fundamentals, sentiment) -> bull/bear debate -> trader -> risk desk -> portfolio
// manager, giving a 5-tier rating (Buy / Overweight / Hold / Underweight / Sell). The trader-* skills stay the
// intraday desk; this is the slower, multi-day second opinion on a name, run on demand or on the top picks of
// the full scan. The LLM calls run in the sandbox with the ANTHROPIC_API_KEY credential from the vault.
import type { Env } from "./env";
import { client, configContext, createSession, deleteFile, uploadText } from "./agent";
import { capBlocks, isEngine, recordSpend } from "./cost";
import { getSetting, getSettings, setSetting } from "./db";
import { getAccount } from "./paper";
import { nyNow } from "./briefs";

export const TA_WHEEL = "https://github.com/TauricResearch/TradingAgents/releases/download/v0.7.1/tradingagents-0.7.1-py3-none-any.whl";
export const RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"] as const;
export type Rating = (typeof RATINGS)[number];

const PORTFOLIO_MOUNT = "/workspace/ta/portfolio.json", MEMORY_IN = "/workspace/ta/memory_in.md", MEMORY_PATH = "/workspace/ta/memory/trading_memory.md";
const MEMORY_BEGIN = "=====TRADINGAGENTS_MEMORY_BEGIN=====", MEMORY_END = "=====TRADINGAGENTS_MEMORY_END=====";

/** The requester's paper account in TradingAgents' portfolio format, so the trader and risk desk size against it. */
export async function paperPortfolio(db: D1Database, user: string) {
  const a = await getAccount(db, user);
  const pos = (await db.prepare("SELECT symbol, side, qty, entry FROM paper_positions WHERE user = ? AND status = 'open'").bind(user)
    .all<{ symbol: string; side: string; qty: number; entry: number }>()).results;
  return { cash: Math.round(a.cash * 100) / 100, currency: "USD", positions: pos.map((p) => ({ ticker: p.symbol, quantity: p.side === "short" ? -p.qty : p.qty, average_price: p.entry })) };
}

export type DeepRun = {
  id: string; symbol: string; day: string; status: "starting" | "running" | "done" | "error"; session_id: string | null;
  user: string | null; brief_id: string | null; rating: string | null; data: string | null; content: string | null;
  cost: string | null; error: string | null; engine: string | null; created_at: string; finished_at: string | null; files?: string | null;
};

let ready = false;
export async function ensureDeep(db: D1Database) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS deep_runs (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL,
    session_id TEXT, user TEXT, brief_id TEXT, rating TEXT, data TEXT, content TEXT, cost TEXT, error TEXT, engine TEXT,
    created_at TEXT DEFAULT (datetime('now')), finished_at TEXT)`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS deep_runs_day ON deep_runs (day, symbol)").run();
  try { await db.prepare("ALTER TABLE deep_runs ADD COLUMN files TEXT").run(); } catch { /* exists */ }
  ready = true;
}

const DEEP_FORMAT = `
End your answer with ONE fenced \`\`\`json block (nothing after it):
{
 "rating": "Buy | Overweight | Hold | Underweight | Sell",
 "confidence": "high | medium | low",
 "summary": "3-4 sentences: the portfolio manager's decision and the reasons that carried it",
 "bull_case": "the bull researcher's strongest points, 2-3 sentences",
 "bear_case": "the bear researcher's strongest points, 2-3 sentences",
 "trader_action": "Buy | Hold | Sell",
 "entry": 131.25, "stop": 124.0, "targets": [140.0, 148.0], "horizon_days": 5,
 "risks": ["one line each"],
 "analysts_run": ["market","news","fundamentals","sentiment"],
 "report_path": "/workspace/ta/results/..../complete_report.md"
}
Numbers come from the reports (null when the reports give none; never invented).`;

/** The instructions the sandbox agent follows for one deep run. */
export function deepPrompt(symbol: string, date: string, rawConfig: string, engine: { deep: string; quick: string; effort: string }, extras: { portfolio: boolean; memory: boolean }) {
  return `${configContext(rawConfig)}[Deep analysis] Run the TradingAgents multi-agent analysis for ${symbol} as of ${date} (New York date) and report its decision.

Do exactly this, in order, with bash:
1. Make sure the package is installed: \`python3 -c "import tradingagents" 2>/dev/null || pip install --quiet "${TA_WHEEL}"\`.
2. Prepare: \`mkdir -p /workspace/ta/memory\`${extras.memory ? `; the decision log from earlier runs is mounted at ${MEMORY_IN}: copy it to ${MEMORY_PATH} so this run settles past decisions and reads their lessons` : ""}.${extras.portfolio ? ` My paper account (cash and open positions) is mounted at ${PORTFOLIO_MOUNT}; pass it with --portfolio so the trader and risk desk size against it.` : ""}
3. Run the analysis with these environment variables (ANTHROPIC_API_KEY is already set in your environment; do not print it):
   export TRADINGAGENTS_NO_UPDATE_CHECK=1 TRADINGAGENTS_LLM_PROVIDER=anthropic TRADINGAGENTS_DEEP_THINK_LLM=${engine.deep} TRADINGAGENTS_QUICK_THINK_LLM=${engine.quick} TRADINGAGENTS_ANTHROPIC_EFFORT=${engine.effort} TRADINGAGENTS_MAX_DEBATE_ROUNDS=1 TRADINGAGENTS_MAX_RISK_ROUNDS=1 TRADINGAGENTS_OUTPUT_LANGUAGE=English TRADINGAGENTS_RESULTS_DIR=/workspace/ta/results TRADINGAGENTS_CACHE_DIR=/workspace/ta/cache TRADINGAGENTS_MEMORY_LOG_PATH=${MEMORY_PATH}
   tradingagents --ticker ${symbol} --date ${date} --analysts market,news,fundamentals,social${extras.portfolio ? ` --portfolio ${PORTFOLIO_MOUNT}` : ""} --save --no-show --no-html 2>&1 | tail -n 60
   If the social (sentiment) analyst fails because a source is unreachable, run again with --analysts market,news,fundamentals. Allow up to 20 minutes.
4. Print the newest complete_report.md under /workspace/ta/results in full (cat it), so the desk can show every section.
5. Print the decision log so the desk keeps it for the next run: a line ${MEMORY_BEGIN}, then \`cat ${MEMORY_PATH}\` (nothing if the file is missing), then a line ${MEMORY_END}.
6. Write your own short reading of the decision for a day trader: does it support a long or short bias for the next 1-5 sessions, and what would change it.
Do not place orders and do not run any other skill.${DEEP_FORMAT}`;
}

/** Keep the decision log TradingAgents wrote, so the next run settles these decisions and learns from them. */
export function extractMemory(text: string): string | null {
  const i = text.lastIndexOf(MEMORY_BEGIN), j = text.lastIndexOf(MEMORY_END);
  if (i < 0 || j < i) return null;
  let body = text.slice(i + MEMORY_BEGIN.length, j).trim();
  body = body.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim(); // the agent may fence it
  return body.length > 0 && body.length < 400_000 ? body : null;
}

const engineModels = (id: string) => ({
  deep: "claude-opus-5-5", quick: id === "sonnet-high" ? "claude-sonnet-5-5" : "claude-opus-5-5", effort: id === "opus-medium" ? "medium" : id === "sonnet-high" ? "high" : "high",
});

/** Start a deep run for one symbol (user action or the autopilot after a full scan). */
export async function startDeep(env: Env, symbol: string, user: string | null, briefId: string | null = null): Promise<{ id?: string; error?: string }> {
  await ensureDeep(env.DB);
  symbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) return { error: "Bad symbol" };
  if (!env.VAULT_ID) return { error: "Deep analysis needs the ANTHROPIC_API_KEY credential in the sandbox: run setup/setup-agent.mjs again (it creates the vault and sets VAULT_ID)." };
  const ny = nyNow();
  const running = await env.DB.prepare("SELECT id FROM deep_runs WHERE symbol = ? AND day = ? AND status IN ('starting','running')").bind(symbol, ny.date).first<{ id: string }>();
  if (running) return { id: running.id };
  const s = await getSettings(env.DB);
  const capped = await capBlocks(env.DB, s.daily_cap_usd, ny.date);
  if (capped) return { error: capped };
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const engine = isEngine(s.engines?.deep) ? s.engines.deep : "default";
  await env.DB.prepare("INSERT INTO deep_runs (id, symbol, day, status, user, brief_id, engine) VALUES (?, ?, ?, 'starting', ?, ?, ?)").bind(id, symbol, ny.date, user, briefId, engine).run();
  const files: string[] = [];
  try {
    // The requester's paper account (the admin's for autopilot runs) and the decision log of earlier runs ride along as files.
    const resources: { file_id: string; mount_path: string }[] = [];
    const book = await paperPortfolio(env.DB, user || "admin");
    resources.push({ file_id: await uploadText(env, "portfolio.json", JSON.stringify(book), "application/json"), mount_path: PORTFOLIO_MOUNT });
    const memory = await getSetting<string>(env.DB, "deep_memory_md", "");
    if (memory) resources.push({ file_id: await uploadText(env, "trading_memory.md", memory, "text/markdown"), mount_path: MEMORY_IN });
    files.push(...resources.map((r) => r.file_id));
    // ~15 model calls plus the sandbox: three times a normal session's budget, at least $3.
    const sid = await createSession(env, Math.max(3, s.session_budget_usd * 3), engine as never, { vaultIds: [env.VAULT_ID], resources });
    const text = deepPrompt(symbol, ny.date, s.trader_config, engineModels(engine), { portfolio: true, memory: !!memory });
    await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    await env.DB.prepare("UPDATE deep_runs SET session_id = ?, status = 'running', files = ? WHERE id = ?").bind(sid, JSON.stringify(files), id).run();
  } catch (e) {
    for (const f of files) await deleteFile(env, f);
    await env.DB.prepare("UPDATE deep_runs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").bind(String((e as Error).message || e).slice(0, 500), id).run();
  }
  return { id };
}

/** The last fenced json block of the answer, validated. */
export function extractDeep(text: string): Record<string, unknown> | null {
  const last = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);
  if (!last) return null;
  try {
    const o = JSON.parse(last[1]);
    if (!o || typeof o !== "object") return null;
    const rating = RATINGS.find((r) => r.toLowerCase() === String(o.rating ?? "").trim().toLowerCase()) ?? null;
    return { ...o, rating };
  } catch { return null; }
}

/** Collect finished runs (called from the cron and when the Deep Analysis page loads). */
export async function finalizeDeep(env: Env) {
  await ensureDeep(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM deep_runs WHERE status = 'running'").all<DeepRun>();
  const anthropic = client(env);
  for (const r of results) {
    if (!r.session_id) continue;
    try {
      const s = await anthropic.beta.sessions.retrieve(r.session_id);
      const ageMin = (Date.now() - Date.parse(r.created_at.replace(" ", "T") + "Z")) / 60000;
      const texts: string[] = [], errors: string[] = [];
      const asks = new Set<string>(), answered = new Set<string>();
      let sawPrompt = false, idleReason: string | null = null;
      for await (const ev of anthropic.beta.sessions.events.list(r.session_id, { order: "asc" })) {
        if (ev.type === "user.message") { sawPrompt = true; idleReason = null; }
        if (ev.type === "agent.message") for (const c of ev.content) { if (c.type === "text") texts.push(c.text); }
        if ((ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use") && ev.evaluated_permission === "ask") asks.add(ev.id);
        if (ev.type === "user.tool_confirmation") answered.add(ev.tool_use_id);
        if (ev.type === "session.error") errors.push(`${ev.error.type}${"message" in ev.error && ev.error.message ? `: ${ev.error.message}` : ""}`);
        if (ev.type === "session.status_idle" && sawPrompt) idleReason = ev.stop_reason.type;
      }
      const cost = s.usage?.list_cost ? `${s.usage.list_cost.amount} ${s.usage.list_cost.currency}` : null;
      const content = texts.join("\n\n");
      const data = extractDeep(content);
      const finish = async (status: "done" | "error", error: string | null) => {
        await recordSpend(env.DB, { session_id: r.session_id!, kind: "brief", slot: "deep", day: r.day, cost, engine: r.engine, user: r.user });
        const memory = extractMemory(content);
        if (memory) await setSetting(env.DB, "deep_memory_md", memory);
        for (const f of (() => { try { return JSON.parse(r.files || "[]") as string[]; } catch { return []; } })()) await deleteFile(env, f);
        await env.DB.prepare("UPDATE deep_runs SET status = ?, content = ?, data = ?, rating = ?, cost = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
          .bind(status, content, data ? JSON.stringify(data) : null, (data?.rating as string | null) ?? null, cost, error, r.id).run();
      };
      if (idleReason === "requires_action") {
        const pending = [...asks].filter((x) => !answered.has(x));
        if (pending.length) await anthropic.beta.sessions.events.send(r.session_id, { events: pending.map((tool_use_id) => ({ type: "user.tool_confirmation" as const, tool_use_id, result: "deny" as const })) });
        continue;
      }
      if (idleReason) {
        const why: Record<string, string> = { budget_reached: "Stopped at the session budget. Raise it in Admin Settings.", refusal: "Claude declined this request.", retries_exhausted: "Failed after retries." };
        const err = idleReason === "end_turn" ? null : why[idleReason] ?? idleReason;
        if (content) await finish(data?.rating ? "done" : "done", err ?? (data?.rating ? null : "The run finished without a readable rating (see the report)."));
        else await finish("error", [err, ...errors].filter(Boolean).join(" · ") || "Claude finished without writing an answer.");
      } else if (s.status === "terminated") {
        await finish(content ? "done" : "error", content ? null : errors.join(" · ") || "The session ended before answering.");
      } else if (ageMin > 45) {
        await finish("error", ["Timed out after 45 minutes", ...errors].join(" · "));
      }
    } catch (e) {
      const err = e as { status?: number };
      if (err.status === 404) await env.DB.prepare("UPDATE deep_runs SET status = 'error', error = 'Session not found', finished_at = datetime('now') WHERE id = ?").bind(r.id).run();
    }
  }
}

/** After a finished full scan: deep-analyze its top N picks (once per brief). */
export async function deepTopPicks(env: Env) {
  await ensureDeep(env.DB);
  const s = await getSettings(env.DB);
  const n = Math.max(0, Math.min(10, Number(s.deep_top_n) || 0));
  if (!n || !env.VAULT_ID) return;
  const ny = nyNow();
  let briefs: { id: string; data: string | null }[] = [];
  try { briefs = (await env.DB.prepare("SELECT id, data FROM briefs WHERE status = 'done' AND slot = 'fullscan' AND day = ? AND (deep_done IS NULL OR deep_done = 0)").bind(ny.date).all<{ id: string; data: string | null }>()).results; }
  catch { return; }
  for (const b of briefs) {
    await env.DB.prepare("UPDATE briefs SET deep_done = 1 WHERE id = ?").bind(b.id).run();
    let picks: { symbol?: string; score?: number }[] = [];
    try { picks = JSON.parse(b.data || "{}")?.picks ?? []; } catch { continue; }
    const top = [...picks].sort((x, y) => (Number(y.score) || 0) - (Number(x.score) || 0)).slice(0, n);
    for (const p of top) {
      const sym = String(p.symbol || "").toUpperCase(); if (!sym) continue;
      const today = await env.DB.prepare("SELECT id FROM deep_runs WHERE symbol = ? AND day = ? AND status != 'error'").bind(sym, ny.date).first();
      if (!today) await startDeep(env, sym, null, b.id);
    }
  }
}

export async function listDeep(db: D1Database, limit = 40) {
  await ensureDeep(db);
  const { results } = await db.prepare("SELECT id, symbol, day, status, user, brief_id, rating, data, cost, error, engine, created_at, finished_at FROM deep_runs ORDER BY created_at DESC LIMIT ?").bind(limit).all<Omit<DeepRun, "content">>();
  return results.map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
}

/** Latest rating per symbol from the last `days` days, for badges on the board and the watchlist. */
export async function latestRatings(db: D1Database, days = 5) {
  await ensureDeep(db);
  const { results } = await db.prepare(`SELECT symbol, rating, day, id FROM deep_runs WHERE status = 'done' AND rating IS NOT NULL AND day >= date('now', ?)
    ORDER BY created_at DESC`).bind(`-${days} days`).all<{ symbol: string; rating: string; day: string; id: string }>();
  const out: Record<string, { rating: string; day: string; id: string }> = {};
  for (const r of results) if (!out[r.symbol]) out[r.symbol] = { rating: r.rating, day: r.day, id: r.id };
  return out;
}
