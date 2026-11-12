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
import { candles } from "./market";
// The forecast script ships with the app (public/kronos_forecast.py) and rides into the sandbox as a mounted file.
async function forecastScript(env: Env) { return (await env.ASSETS.fetch("https://assets.local/kronos_forecast.py")).text(); }

export const KRONOS_REPO = "https://github.com/shiyu-coder/Kronos.git";
// Kronos' model code (MIT) ships vendored under public/kronos_model and is mounted into the sandbox, so a run needs
// no git clone: only torch (preinstalled by setup, else pip) and the weights from Hugging Face.
const MODEL_FILES = ["__init__.py", "kronos.py", "module.py"];
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
  for (const c of ["content TEXT", "actual_move_pct REAL", "hit INTEGER", "evaluated_at INTEGER"]) { try { await db.prepare(`ALTER TABLE kronos_runs ADD COLUMN ${c}`).run(); } catch { /* exists */ } }
  ready = true;
}

export function kronosPrompt(symbol: string, interval: string, pred: number, samples: number) {
  return `[Kronos forecast] Produce a probabilistic candlestick forecast for ${symbol} on ${interval} bars with the Kronos foundation model. The model code is already mounted at ${REPO_DIR}/model/ and the forecast script at ${SCRIPT_MOUNT}; nothing needs to be cloned. Do exactly this with bash, printing only short progress lines:
1. Dependencies: \`python3 -c "import torch, einops, huggingface_hub, safetensors, pandas, tqdm" 2>/dev/null || pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu einops huggingface_hub safetensors pandas numpy tqdm\`; if that index is unreachable, \`pip install --quiet torch einops huggingface_hub safetensors pandas numpy tqdm\`. Allow up to 10 minutes; do not give up before the install finishes.
2. Run: \`cd ${REPO_DIR} && python3 ${SCRIPT_MOUNT} --symbol ${symbol} --interval ${interval} --pred ${pred} --samples ${samples} --kronos ${REPO_DIR} --out /workspace/kronos_fc.json 2>&1 | tail -n 15\`. The weights NeoQuasar/Kronos-small and NeoQuasar/Kronos-Tokenizer-base download from huggingface.co on first use (about 115 MB; later runs use the cache). If Yahoo returned too few bars, wait 20 seconds and run once more.
3. Print the result: \`cat /workspace/kronos_fc.json\`.
If a step fails, print the last 30 lines of its output and say which host or package was the problem (for example "huggingface.co not allowed" or "torch not installed"), so the desk can show it.
Then one or two sentences reading the forecast for a trader (direction, size of the move versus the band; Kronos is a statistical model of past K-lines, not news-aware). End your answer with ONE fenced \`\`\`json block containing the file's JSON exactly as printed (nothing after it). Do not place orders and do not run any other skill.`;
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
    const resources = [{ file_id: fid, mount_path: SCRIPT_MOUNT }];
    for (const f of MODEL_FILES) { const t = await (await env.ASSETS.fetch(`https://assets.local/kronos_model/${f}`)).text(); const id = await uploadText(env, f, t, "text/x-python"); files.push(id); resources.push({ file_id: id, mount_path: `${REPO_DIR}/model/${f}` }); }
    // A first run installs torch and downloads the weights: give it twice the normal budget (at least $2).
    const sid = await createSession(env, Math.max(2, s.session_budget_usd * 2), engine as never, { resources });
    await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text: kronosPrompt(symbol, interval, n, Number((s as { kronos_samples?: number }).kronos_samples) || 20) }] }] });
    await env.DB.prepare("UPDATE kronos_runs SET session_id = ?, status = 'running', files = ? WHERE id = ?").bind(sid, JSON.stringify(files), id).run();
  } catch (e) {
    for (const f of files) await deleteFile(env, f);
    await env.DB.prepare("UPDATE kronos_runs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").bind(String((e as Error).message || e).slice(0, 500), id).run();
  }
  return { id };
}

/** Built-in baseline: block bootstrap of the symbol's own log returns (no model, no cost). Same shape as a Kronos forecast. */
export function bootstrapForecast(symbol: string, interval: string, bars: { time: number; high: number; low: number; close: number }[], pred: number, samples = 400): Forecast | null {
  const b = bars.slice(-401); if (b.length < 60) return null;
  const step = interval === "1d" ? 86400 : interval === "60m" ? 3600 : interval === "15m" ? 900 : 300;
  const rets = b.slice(1).map((x, i) => Math.log(x.close / b[i].close)), rng = b.slice(1).map((x) => Math.log(x.high / x.low) / 2);
  let seed = (b[b.length - 1].time % 2147483647) || 1; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const block = Math.max(2, Math.min(12, Math.floor(pred / 4))), last = b[b.length - 1].close, paths: number[][] = [], his: number[][] = [], los: number[][] = [];
  for (let s = 0; s < samples; s++) {
    const p: number[] = [], h: number[] = [], l: number[] = []; let px = last;
    while (p.length < pred) { const st = Math.floor(rnd() * (rets.length - block)); for (let k = 0; k < block && p.length < pred; k++) { px *= Math.exp(rets[st + k]); p.push(px); h.push(px * Math.exp(rng[st + k])); l.push(px * Math.exp(-rng[st + k])); } }
    paths.push(p); his.push(h); los.push(l);
  }
  const col = (m: number[][], i: number) => m.map((r) => r[i]).sort((x, y) => x - y), q = (v: number[], f: number) => v[Math.floor(f * (v.length - 1))], avg = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6, r3 = (n: number) => Math.round(n * 1000) / 1000;
  const idx = Array.from({ length: pred }, (_, i) => i), fin = col(paths, pred - 1);
  const times: number[] = []; let t = b[b.length - 1].time; while (times.length < pred) { t += step; if (interval === "1d" && !/-(USD|USDT|USDC|EUR|BTC|ETH)$/.test(symbol) && [0, 6].includes(new Date(t * 1000).getUTCDay())) continue; times.push(t); }
  return { symbol, interval, step_sec: step, model: "built-in bootstrap", samples, lookback: b.length, pred_len: pred, last_time: b[b.length - 1].time, last_close: r6(last), times,
    mean_close: idx.map((i) => r6(avg(col(paths, i)))), p10: idx.map((i) => r6(q(col(paths, i), 0.1))), p90: idx.map((i) => r6(q(col(paths, i), 0.9))),
    mean_high: idx.map((i) => r6(avg(col(his, i)))), mean_low: idx.map((i) => r6(avg(col(los, i)))),
    prob_up: r3(fin.filter((v) => v > last).length / fin.length), exp_move_pct: r3(((avg(fin) - last) / last) * 100),
    max_up_pct: r3(((avg(his.map((h) => Math.max(...h))) - last) / last) * 100), max_down_pct: r3(((avg(los.map((l) => Math.min(...l))) - last) / last) * 100),
    band_pct: r3(((q(fin, 0.9) - q(fin, 0.1)) / last) * 100), elapsed_s: 0 };
}
/** Run the built-in forecast now and store it as a finished run. */
export async function runBuiltin(db: D1Database, symbol: string, interval: string, pred: number | null, user: string | null, note: string | null = null, id: string | null = null) {
  await ensureKronos(db);
  symbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return { error: "Bad symbol" };
  if (!(KRONOS_INTERVALS as readonly string[]).includes(interval)) return { error: "Bar size must be 5m, 15m, 60m or 1d." };
  const n = Math.max(4, Math.min(120, Math.round(pred || DEFAULT_PRED[interval])));
  let fc: Forecast | null = null;
  try { fc = bootstrapForecast(symbol, interval, (await candles(symbol, interval, interval === "1d" ? 730 : interval === "60m" ? 90 : 30)) as never, n); } catch (e) { return { error: String((e as Error).message || e).slice(0, 200) }; }
  if (!fc) return { error: `Not enough ${interval} bars for ${symbol}.` };
  if (id) { await db.prepare("UPDATE kronos_runs SET status = 'done', data = ?, error = ?, finished_at = datetime('now') WHERE id = ?").bind(JSON.stringify(fc), note, id).run(); return { id }; }
  const nid = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await db.prepare("INSERT INTO kronos_runs (id, symbol, interval, pred_len, status, user, data, error, finished_at) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, datetime('now'))").bind(nid, symbol, interval, n, user, JSON.stringify(fc), note).run();
  return { id: nid };
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
        await env.DB.prepare("UPDATE kronos_runs SET status = ?, data = ?, cost = ?, error = ?, content = ?, finished_at = datetime('now') WHERE id = ?")
          .bind(status, fc ? JSON.stringify(fc) : null, cost, error, content.replace(/```json[\s\S]*?```/g, "").trim().slice(0, 3000) || null, r.id).run();
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
        else {
          const why2 = [err, ...errors, content ? "Kronos did not return a forecast: see the agent's notes below (usually a host the sandbox may not reach, or torch not installed; run setup/setup-agent.mjs again)." : "Claude finished without writing an answer."].filter(Boolean).join(" · ");
          await finish("error", why2);
          // Fall back to the built-in forecast so the chart still gets a band; the row keeps the reason.
          try { await runBuiltin(env.DB, r.symbol, r.interval, r.pred_len, r.user, `${why2} Showing the built-in forecast instead.`, r.id); } catch { /* keep the error */ }
        }
      } else if (ageMin > 40) await finish("error", "Timed out after 40 minutes.");
    } catch (e) { console.error("kronos", r.id, e); }
  }
}

export async function listKronos(db: D1Database, limit = 40) {
  await ensureKronos(db);
  const { results } = await db.prepare("SELECT id, symbol, interval, pred_len, status, user, data, cost, error, content, actual_move_pct, hit, evaluated_at, created_at, finished_at FROM kronos_runs ORDER BY created_at DESC LIMIT ?").bind(limit)
    .all<KronosRun & { content: string | null; actual_move_pct: number | null; hit: number | null; evaluated_at: number | null }>();
  return results.map((r) => ({ ...r, data: r.data ? (JSON.parse(r.data) as Forecast) : null }));
}

/** Score finished forecasts once their horizon has passed: did the market close above or below the last close as the
 *  forecast said (hit), how big was the actual move, and how well calibrated the probability was (Brier). */
export async function evaluateForecasts(db: D1Database, limit = 10) {
  await ensureKronos(db);
  const now = Math.floor(Date.now() / 1000);
  // Only forecasts whose horizon has passed (last bar + horizon + one more bar), oldest first.
  const { results } = await db.prepare(`SELECT id, symbol, interval, data FROM kronos_runs WHERE status = 'done' AND data IS NOT NULL AND evaluated_at IS NULL
    AND json_extract(data, '$.last_time') + (json_extract(data, '$.pred_len') + 1) * json_extract(data, '$.step_sec') <= ? ORDER BY created_at LIMIT ?`).bind(now, limit).all<{ id: string; symbol: string; interval: string; data: string }>();
  let n = 0;
  for (const r of results) {
    try {
      const fc = JSON.parse(r.data) as Forecast;
      const end = fc.last_time + fc.pred_len * fc.step_sec;
      if (now < end + fc.step_sec) continue;
      const bars = (await candles(r.symbol, r.interval === "1h" ? "60m" : r.interval, Math.min(59, Math.ceil((now - fc.last_time) / 86400) + 2))) as { time: number; close: number }[];
      const at = [...bars].reverse().find((b) => b.time <= end) ?? bars.find((b) => b.time > end); // the bar at the horizon, else the first after it
      if (!at) continue;
      const move = ((at.close - fc.last_close) / fc.last_close) * 100;
      const hit = (move > 0) === (fc.prob_up > 0.5) ? 1 : 0;
      await db.prepare("UPDATE kronos_runs SET actual_move_pct = ?, hit = ?, evaluated_at = ? WHERE id = ?").bind(Math.round(move * 100) / 100, hit, now, r.id).run();
      n++;
    } catch { /* data hiccup: next time */ }
  }
  return n;
}
/** Track record of the forecasts: hit rate, Brier score (0 = perfect, 0.25 = coin flip), average absolute error of the expected move. */
export async function forecastScore(db: D1Database) {
  await ensureKronos(db);
  const { results } = await db.prepare("SELECT data, actual_move_pct, hit FROM kronos_runs WHERE evaluated_at IS NOT NULL").all<{ data: string; actual_move_pct: number; hit: number }>();
  if (!results.length) return { n: 0, hit_rate: null, brier: null, avg_abs_error_pct: null };
  let brier = 0, err = 0, hits = 0;
  for (const r of results) { const fc = JSON.parse(r.data) as Forecast; const y = r.actual_move_pct > 0 ? 1 : 0; brier += (fc.prob_up - y) ** 2; err += Math.abs(fc.exp_move_pct - r.actual_move_pct); hits += r.hit; }
  const n = results.length;
  const by: Record<string, { n: number; hits: number; brier: number }> = {};
  for (const r of results) { const fc = JSON.parse(r.data) as Forecast, k = /bootstrap/.test(fc.model || "") ? "Built-in" : "Kronos", y = r.actual_move_pct > 0 ? 1 : 0; const g = (by[k] ??= { n: 0, hits: 0, brier: 0 }); g.n++; g.hits += r.hit; g.brier += (fc.prob_up - y) ** 2; }
  const by_model = Object.fromEntries(Object.entries(by).map(([k, g]) => [k, { n: g.n, hit_rate: Math.round((g.hits / g.n) * 1000) / 10, brier: Math.round((g.brier / g.n) * 1000) / 1000 }]));
  return { n, hit_rate: Math.round((hits / n) * 1000) / 10, brier: Math.round((brier / n) * 1000) / 1000, avg_abs_error_pct: Math.round((err / n) * 100) / 100, by_model };
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
