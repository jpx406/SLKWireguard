// Kronos forecasts: the open-source candlestick foundation model (shiyu-coder/Kronos, AAAI 2026) run inside the
// agent's sandbox on a symbol's recent bars. The Worker mounts setup/kronos_forecast.py, the agent makes sure the
// repo, torch and the weights are present, runs the script, and returns its JSON: a mean path with a 10-90% band
// from sampled futures, the probability the final close is above the last one, and the expected move. Forecasts
// feed the chart overlay, the Crypto desk, the scan and Deep Analysis prompts, and (optionally) the chart autopilot.
import type { Env } from "./env";
import { client, createSession, deleteFile, uploadText } from "./agent";
import { capBlocks, isEngine, recordSpend } from "./cost";
import { getSettings } from "./db";
import { nyNow } from "./briefs";
// The forecast script ships with the app (public/kronos_forecast.py) and rides into the sandbox as a mounted file.
async function forecastScript(env: Env) { return (await env.ASSETS.fetch("https://assets.local/kronos_forecast.py")).text(); }

export const KRONOS_REPO = "https://github.com/shiyu-coder/Kronos.git";
export const KRONOS_INTERVALS = ["5m", "15m", "60m", "1d"] as const;
const SCRIPT_MOUNT = "/workspace/kronos_forecast.py", REPO_DIR = "/workspace/kronos";
const DEFAULT_PRED: Record<string, number> = { "5m": 36, "15m": 32, "60m": 24, "1d": 10 };

export type KronosRun = {
  id: string; symbol: string; interval: string; pred_len: number; status: "starting" | "running" | "done" | "error"; session_id: string | null;
  user: string | null; data: string | null; cost: string | null; error: string | null; created_at: string; finished_at: string | null; files: string | null;
};
export type Forecast = {
  symbol: string; interval: string; step_sec: number; samples: number; lookback: number; pred_len: number; last_time: number; last_close: number;
  times: number[]; mean_close: number[]; p10: number[]; p90: number[]; mean_high: number[]; mean_low: number[];
  prob_up: number; exp_move_pct: number; max_up_pct: number; max_down_pct: number; band_pct: number; elapsed_s: number; model: string;
};

let ready = false;
export async function ensureKronos(db: D1Database) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS kronos_runs (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, interval TEXT NOT NULL, pred_len INTEGER NOT NULL, status TEXT NOT NULL,
    session_id TEXT, user TEXT, data TEXT, cost TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), finished_at TEXT, files TEXT)`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS kronos_runs_sym ON kronos_runs (symbol, created_at)").run();
  ready = true;
}

export function kronosPrompt(symbol: string, interval: string, pred: number, samples: number) {
  return `[Kronos forecast] Produce a probabilistic candlestick forecast for ${symbol} on ${interval} bars with the Kronos foundation model, using the script mounted at ${SCRIPT_MOUNT}. Do exactly this with bash, and print only short progress lines:
1. Repo: \`test -d ${REPO_DIR}/model || git clone --depth 1 ${KRONOS_REPO} ${REPO_DIR}\`.
2. Dependencies: \`python3 -c "import torch, einops, huggingface_hub, safetensors, pandas" 2>/dev/null || pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu einops huggingface_hub safetensors pandas numpy\` (if the CPU index is unreachable, \`pip install --quiet torch einops huggingface_hub safetensors pandas numpy\`). Allow up to 10 minutes.
3. Run: \`python3 ${SCRIPT_MOUNT} --symbol ${symbol} --interval ${interval} --pred ${pred} --samples ${samples} --kronos ${REPO_DIR} --out /workspace/kronos_fc.json\` (the weights NeoQuasar/Kronos-small and NeoQuasar/Kronos-Tokenizer-base download from Hugging Face on first use; later runs use the cache). If Yahoo returns too few bars, retry once after 20 seconds.
4. Print the result: \`cat /workspace/kronos_fc.json\`.
Then one or two sentences reading the forecast for a trader (direction, size of the move versus the band, caveats: Kronos is a statistical model of past K-lines, not news-aware). End your answer with ONE fenced \`\`\`json block containing the file's JSON exactly as printed (nothing after it). Do not place orders and do not run any other skill.`;
}

/** Start a forecast (user action, the Crypto desk, or a scan asking for one). */
export async function startKronos(env: Env, symbol: string, interval: string, pred: number | null, user: string | null): Promise<{ id?: string; error?: string }> {
  await ensureKronos(env.DB);
  symbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return { error: "Bad symbol" };
  if (!(KRONOS_INTERVALS as readonly string[]).includes(interval)) return { error: "Bar size must be 5m, 15m, 60m or 1d." };
  const n = Math.max(4, Math.min(120, Math.round(pred || DEFAULT_PRED[interval])));
  const running = await env.DB.prepare("SELECT id FROM kronos_runs WHERE symbol = ? AND interval = ? AND status IN ('starting','running')").bind(symbol, interval).first<{ id: string }>();
  if (running) return { id: running.id };
  const s = await getSettings(env.DB);
  const capped = await capBlocks(env.DB, s.daily_cap_usd, nyNow().date);
  if (capped) return { error: capped };
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const engine = isEngine(s.engines?.kronos) ? s.engines.kronos : "default";
  await env.DB.prepare("INSERT INTO kronos_runs (id, symbol, interval, pred_len, status, user) VALUES (?, ?, ?, ?, 'starting', ?)").bind(id, symbol, interval, n, user).run();
  const files: string[] = [];
  try {
    const fid = await uploadText(env, "kronos_forecast.py", await forecastScript(env), "text/x-python");
    files.push(fid);
    const sid = await createSession(env, Math.max(1, s.session_budget_usd), engine as never, { resources: [{ file_id: fid, mount_path: SCRIPT_MOUNT }] });
    await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text: kronosPrompt(symbol, interval, n, Number((s as { kronos_samples?: number }).kronos_samples) || 20) }] }] });
    await env.DB.prepare("UPDATE kronos_runs SET session_id = ?, status = 'running', files = ? WHERE id = ?").bind(sid, JSON.stringify(files), id).run();
  } catch (e) {
    for (const f of files) await deleteFile(env, f);
    await env.DB.prepare("UPDATE kronos_runs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").bind(String((e as Error).message || e).slice(0, 500), id).run();
  }
  return { id };
}

export function extractForecast(text: string): Forecast | null {
  const last = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);
  if (!last) return null;
  try {
    const o = JSON.parse(last[1]) as Forecast;
    if (!o || !Array.isArray(o.mean_close) || !o.mean_close.length || typeof o.last_close !== "number") return null;
    return o;
  } catch { return null; }
}

/** Collect finished sessions: parse the forecast, record the spend, delete the mounted file. */
export async function finalizeKronos(env: Env) {
  await ensureKronos(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM kronos_runs WHERE status = 'running'").all<KronosRun>();
  const anthropic = client(env);
  for (const r of results) {
    if (!r.session_id) continue;
    try {
      const s = await anthropic.beta.sessions.retrieve(r.session_id);
      const ageMin = (Date.now() - Date.parse(r.created_at.replace(" ", "T") + "Z")) / 60000;
      const texts: string[] = [], errors: string[] = [], asks = new Set<string>(), answered = new Set<string>();
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
      const content = texts.join("\n\n"), fc = extractForecast(content);
      const finish = async (status: "done" | "error", error: string | null) => {
        await recordSpend(env.DB, { session_id: r.session_id!, kind: "brief", slot: "kronos", day: nyNow().date, cost, engine: null, user: r.user });
        for (const f of (() => { try { return JSON.parse(r.files || "[]") as string[]; } catch { return []; } })()) await deleteFile(env, f);
        await env.DB.prepare("UPDATE kronos_runs SET status = ?, data = ?, cost = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
          .bind(status, fc ? JSON.stringify(fc) : null, cost, error, r.id).run();
      };
      if (idleReason === "requires_action") {
        const pending = [...asks].filter((x) => !answered.has(x));
        if (pending.length) await anthropic.beta.sessions.events.send(r.session_id, { events: pending.map((tool_use_id) => ({ type: "user.tool_confirmation" as const, tool_use_id, result: "deny" as const })) });
        continue;
      }
      if (idleReason) {
        const why: Record<string, string> = { budget_reached: "Stopped at the session budget.", refusal: "Claude declined this request.", retries_exhausted: "Failed after retries." };
        const err = idleReason === "end_turn" ? null : why[idleReason] ?? idleReason;
        if (fc) await finish("done", err);
        else await finish("error", [err, ...errors, content ? "No forecast JSON in the answer (the model may have failed to download; see the agent's notes)." : "Claude finished without writing an answer."].filter(Boolean).join(" · "));
      } else if (ageMin > 40) await finish("error", "Timed out after 40 minutes.");
    } catch (e) { console.error("kronos", r.id, e); }
  }
}

export async function listKronos(db: D1Database, limit = 40) {
  await ensureKronos(db);
  const { results } = await db.prepare("SELECT id, symbol, interval, pred_len, status, user, data, cost, error, created_at, finished_at FROM kronos_runs ORDER BY created_at DESC LIMIT ?").bind(limit).all<KronosRun>();
  return results.map((r) => ({ ...r, data: r.data ? (JSON.parse(r.data) as Forecast) : null }));
}

/** Freshest finished forecast per symbol (any bar size) within `hours`. */
export async function latestForecasts(db: D1Database, symbols?: string[], hours = 24) {
  await ensureKronos(db);
  const { results } = await db.prepare(`SELECT id, symbol, interval, data, created_at FROM kronos_runs WHERE status = 'done' AND data IS NOT NULL AND created_at >= datetime('now', ?) ORDER BY created_at DESC`)
    .bind(`-${hours} hours`).all<{ id: string; symbol: string; interval: string; data: string; created_at: string }>();
  const out: Record<string, { id: string; interval: string; created_at: string; prob_up: number; exp_move_pct: number; band_pct: number; max_up_pct: number; max_down_pct: number; pred_len: number; step_sec: number }> = {};
  for (const r of results) {
    if (out[r.symbol] || (symbols && !symbols.includes(r.symbol))) continue;
    try { const d = JSON.parse(r.data) as Forecast; out[r.symbol] = { id: r.id, interval: r.interval, created_at: r.created_at, prob_up: d.prob_up, exp_move_pct: d.exp_move_pct, band_pct: d.band_pct, max_up_pct: d.max_up_pct, max_down_pct: d.max_down_pct, pred_len: d.pred_len, step_sec: d.step_sec }; } catch { /* skip */ }
  }
  return out;
}

/** A short block for scan / Deep Analysis prompts: what Kronos expects for these symbols right now. */
export async function kronosContext(db: D1Database, symbols: string[]) {
  const fc = await latestForecasts(db, symbols, 24);
  const rows = Object.entries(fc);
  if (!rows.length) return "";
  const horizon = (f: { pred_len: number; step_sec: number }) => { const h = (f.pred_len * f.step_sec) / 3600; return h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)}h`; };
  return `[Kronos forecasts] A candlestick foundation model (statistical, not news-aware) sampled ${rows.length} symbol${rows.length > 1 ? "s" : ""} within the last 24 hours: ` +
    rows.map(([s, f]) => `${s} (${f.interval}, next ${horizon(f)}): ${Math.round(f.prob_up * 100)}% chance of closing higher, expected ${f.exp_move_pct >= 0 ? "+" : ""}${f.exp_move_pct}%, 10-90% band ${f.band_pct}% wide`).join("; ") +
    `. Treat it as one more opinion on direction and the size of the move; it does not know about news or levels.\n\n`;
}

/** Does a fresh Kronos forecast disagree with this side? (null = no forecast). */
export async function kronosAgrees(db: D1Database, symbol: string, side: "long" | "short"): Promise<boolean | null> {
  const f = (await latestForecasts(db, [symbol], 12))[symbol];
  if (!f) return null;
  return side === "long" ? f.prob_up >= 0.45 : f.prob_up <= 0.55;
}
