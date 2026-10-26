// Trading Desk on Cloudflare: static UI (./public) + JSON API under /api, behind Cloudflare Access.
import type { Env } from "./env";
import { authenticate } from "./auth";
import { ensureSchema, getSettings, setSetting, getSetting, normalizeTrade, tradeStats, DEFAULT_SETTINGS, type Trade } from "./db";
import { candles, quotes, INTERVALS, SYMBOL_RE } from "./market";
import { createSession, listAgentSkills, runTurn, syncConfigFile, CONFIG_MOUNT } from "./agent";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const bad = (detail: string, status = 400) => json({ detail }, status);

async function body<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "Invalid JSON body"); }
}
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function parseConfig(raw: string) {
  if (!raw.trim()) return { config: null, error: null };
  try { return { config: JSON.parse(raw) as Record<string, unknown>, error: null }; }
  catch (e) { return { config: null, error: String((e as Error).message) }; }
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "");
  const m = req.method;
  await ensureSchema(env.DB);

  if (path === "/status" && m === "GET") {
    const s = await getSettings(env.DB);
    const { config, error } = parseConfig(s.trader_config);
    return json({
      config, config_error: error, config_mount: CONFIG_MOUNT,
      paper: config ? config.paper !== false : null,
      agent_ready: !!(env.ANTHROPIC_API_KEY && env.AGENT_ID && env.ENVIRONMENT_ID),
      server_time: new Date().toISOString(),
    });
  }

  if (path === "/settings" && m === "GET") return json(await getSettings(env.DB));
  if (path === "/settings" && m === "PUT") {
    const patch = (await body<{ settings: Record<string, unknown> }>(req)).settings ?? {};
    if ("watchlist" in patch) {
      const wl = Array.isArray(patch.watchlist) ? patch.watchlist.map((x) => String(x).trim().toUpperCase()).filter((x) => SYMBOL_RE.test(x)) : [];
      await setSetting(env.DB, "watchlist", [...new Set(wl)].slice(0, 40));
    }
    if ("session_budget_usd" in patch) {
      const b = Number(patch.session_budget_usd);
      if (!(b > 0 && b <= 100)) return bad("Session budget must be between 0 and 100 USD.");
      await setSetting(env.DB, "session_budget_usd", b);
    }
    if ("trader_config" in patch) {
      const raw = String(patch.trader_config ?? "");
      if (raw.length > 100_000) return bad("Config too large.");
      const { error } = parseConfig(raw);
      if (error) return bad(`trader/config.json is not valid JSON: ${error}`);
      await setSetting(env.DB, "trader_config", raw);
      if (env.ANTHROPIC_API_KEY) await syncConfigFile(env, raw);
    }
    return json(await getSettings(env.DB));
  }

  if (path === "/guide" && m === "GET") return json({ markdown: await getSetting(env.DB, "guide_md", "") });
  if (path === "/guide" && m === "PUT") {
    const md = String((await body<{ markdown: string }>(req)).markdown ?? "");
    if (md.length > 500_000) return bad("Guide too large.");
    await setSetting(env.DB, "guide_md", md);
    return json({ ok: true });
  }

  if (path === "/skills" && m === "GET") {
    if (!env.AGENT_ID || !env.ANTHROPIC_API_KEY) return json([]);
    return json(await listAgentSkills(env));
  }

  if (path === "/chat" && m === "POST") {
    if (!env.AGENT_ID || !env.ENVIRONMENT_ID || !env.ANTHROPIC_API_KEY) return bad("Agent not configured. Run setup/setup-agent.mjs and set AGENT_ID, ENVIRONMENT_ID and the ANTHROPIC_API_KEY secret.", 503);
    const b = await body<{ prompt?: string; session_id?: string | null }>(req);
    const prompt = String(b.prompt ?? "").trim();
    if (!prompt) return bad("Empty prompt");
    if (prompt.length > 50_000) return bad("Prompt too long");
    let sid = b.session_id ?? null;
    if (sid && !/^[A-Za-z0-9_-]{8,128}$/.test(sid)) return bad("Bad session id");
    if (!sid) sid = await createSession(env, (await getSettings(env.DB)).session_budget_usd);
    return new Response(runTurn(env, sid, prompt), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }

  const cm = path.match(/^\/candles\/([^/]+)$/);
  if (cm && m === "GET") {
    const sym = decodeURIComponent(cm[1]).toUpperCase(), iv = url.searchParams.get("interval") || "5m";
    if (!SYMBOL_RE.test(sym)) return bad("Bad symbol");
    if (!(iv in INTERVALS)) return bad("Bad interval");
    try { return json(await candles(sym, iv)); } catch (e) { return bad(`Data error: ${(e as Error).message}`, 502); }
  }
  if (path === "/quotes" && m === "GET") {
    const syms = (url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
    if (syms.some((s) => !SYMBOL_RE.test(s))) return bad("Bad symbol");
    return json(await quotes(syms));
  }

  if (path === "/journal" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM journal ORDER BY date DESC, created_at DESC LIMIT 2000").all<Trade>();
    return json(results.map(tradeStats));
  }
  if (path === "/journal" && m === "POST") {
    const t = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), ...normalizeTrade((await body<{ trade: Record<string, unknown> }>(req)).trade ?? {}) };
    if (!t.symbol) return bad("Symbol required");
    await env.DB.prepare("INSERT INTO journal (id,date,symbol,side,qty,entry,stop,exit,fees,setup,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(t.id, t.date, t.symbol, t.side, t.qty, t.entry, t.stop, t.exit, t.fees, t.setup, t.notes).run();
    return json(tradeStats(t));
  }
  const jm = path.match(/^\/journal\/([A-Za-z0-9]{1,32})$/);
  if (jm && m === "DELETE") {
    await env.DB.prepare("DELETE FROM journal WHERE id = ?").bind(jm[1]).run();
    return json({ ok: true });
  }

  return bad("Not found", 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const who = await authenticate(req, env);
    if (who instanceof Response) return who;
    if (req.method !== "GET" && req.headers.get("content-type")?.split(";")[0] !== "application/json") return bad("JSON required", 415);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return bad(e.message, e.status);
      const err = e as { status?: number; message?: string };
      return bad(err.message || "Server error", err.status && err.status >= 400 && err.status < 600 ? 502 : 500);
    }
  },
} satisfies ExportedHandler<Env>;

export { DEFAULT_SETTINGS };
