// Trading Desk on Cloudflare: static UI (./public) + JSON API under /api, behind Cloudflare Access.
import type { Env } from "./env";
import { authenticate, login, logout, listUsers, createUser, updateUser, deleteUser, changeOwnPassword, type Identity } from "./auth";
import { autoTradeNewBriefs, cancelOrder, closePosition, getAccount, placeOrder, resetAccount, runEngine, sanitizePaperSettings, summary, updatePosition } from "./paper";
import { ensureSchema, getSettings, setSetting, getSetting, normalizeTrade, tradeStats, DEFAULT_SETTINGS, type Trade } from "./db";
import { candles, quotes, INTERVALS, SYMBOL_RE, setMarketBase, configureMarket, marketInfo, testAlpaca, type DataSource } from "./market";
import { configContext, createSession, listAgentSkills, runTurn, syncConfigFile, CONFIG_MOUNT } from "./agent";
import { DEFAULT_FILTERS, EXCHANGES, SECTORS, describeFilters, sanitizeFilters } from "./filters";
import { RESULT_FORMAT, SLOTS, ensureBriefSchema, finalizeBriefs, getAutopilot, getScanFilters, CALENDAR, isTradingDay, nyNow, runSchedule, startBrief, type Autopilot, type SlotId } from "./briefs";

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

/** Point market data at the configured source (setting cached for 30 s per isolate). */
let srcCache: { at: number; v: DataSource } | null = null;
async function setupMarket(env: Env) {
  setMarketBase(env.MARKET_DATA_BASE);
  if (!srcCache || Date.now() - srcCache.at > 30_000) {
    let v: DataSource = "auto";
    try { await ensureSchema(env.DB); v = await getSetting<DataSource>(env.DB, "data_source", "auto"); } catch { /* default */ }
    srcCache = { at: Date.now(), v };
  }
  configureMarket({ source: srcCache.v, keyId: env.ALPACA_KEY_ID, secret: env.ALPACA_SECRET_KEY, alpacaBase: env.ALPACA_DATA_BASE });
}

// Claude-powered actions cost money: only the admin and users the admin allows may run them.
const AI_ROUTES = [/^\/chat$/, /^\/briefs\/run$/];
// Shared settings: admin only.
const ADMIN_WRITES = [/^\/settings$/, /^\/guide$/, /^\/autopilot$/, /^\/scan-filters$/, /^\/users/];

async function api(req: Request, env: Env, url: URL, who: Identity): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "");
  const m = req.method;
  await ensureSchema(env.DB);
  await ensureBriefSchema(env.DB);
  if (who.role !== "admin" && (path.startsWith("/users") || (m !== "GET" && ADMIN_WRITES.some((r) => r.test(path)))))
    return bad("Only the admin can change this.", 403);
  if (!who.ai && AI_ROUTES.some((r) => r.test(path))) return bad("Your account is not allowed to run Claude scans or chat. Ask the admin.", 403);

  if (path === "/market/test" && m === "GET") {
    if (who.role !== "admin") return bad("Only the admin can test the data connection.", 403);
    return json({ iex: await testAlpaca("iex"), sip: await testAlpaca("sip"), info: marketInfo() });
  }
  if (path === "/me" && m === "GET") return json({ user: who.user, role: who.role, ai: who.ai, password_login: !!env.LOGIN_PASSWORD });
  if (path === "/me/password" && m === "POST") {
    const b = await body<{ current?: string; next?: string }>(req);
    return changeOwnPassword(env, who, String(b.current ?? ""), String(b.next ?? ""));
  }

  // ---- users (admin)
  if (path === "/users" && m === "GET") return json(await listUsers(env.DB));
  if (path === "/users" && m === "POST") {
    const b = await body<{ username?: string; password?: string; ai?: boolean; role?: string }>(req);
    const err = await createUser(env.DB, String(b.username ?? "").trim().toLowerCase(), String(b.password ?? ""), b.ai === true, b.role === "admin" ? "admin" : "user");
    return err ? bad(err) : json(await listUsers(env.DB));
  }
  const um = path.match(/^\/users\/([a-z0-9_.-]{3,32})$/);
  if (um && m === "PUT") {
    const b = await body<{ password?: string; ai?: boolean; role?: string }>(req);
    const err = await updateUser(env.DB, um[1], {
      ...(typeof b.password === "string" && b.password ? { password: b.password } : {}),
      ...(typeof b.ai === "boolean" ? { ai: b.ai } : {}),
      ...(b.role === "admin" || b.role === "user" ? { role: b.role } : {}),
    });
    return err ? bad(err) : json(await listUsers(env.DB));
  }
  if (um && m === "DELETE") { await deleteUser(env.DB, um[1]); return json(await listUsers(env.DB)); }

  // ---- paper trading (per user)
  if (path === "/paper" && m === "GET") {
    await runEngine(env.DB, who.user);
    return json(await summary(env.DB, who.user));
  }
  if (path === "/paper/orders" && m === "POST") {
    const b = await body<Record<string, unknown>>(req);
    const r = await placeOrder(env.DB, who.user, {
      symbol: String(b.symbol ?? ""), side: b.side === "short" ? "short" : "long",
      type: b.type === "limit" || b.type === "stop" ? b.type : "market",
      price: b.price as number | null, qty: b.qty as number | null, amount_usd: b.amount_usd as number | null,
      stop: b.stop as number | null, target: b.target as number | null, note: b.note == null ? null : String(b.note), source: "manual",
      exit_mode: b.exit_mode === "eod" || b.exit_mode === "hold" ? b.exit_mode : null,
    });
    return r.error ? bad(r.error) : json(r);
  }
  const om = path.match(/^\/paper\/orders\/([a-z0-9]{6,32})$/);
  if (om && m === "DELETE") return (await cancelOrder(env.DB, who.user, om[1])) ? json({ ok: true }) : bad("Order not found or no longer working.", 404);
  const pm = path.match(/^\/paper\/positions\/([a-z0-9]{6,32})(\/close)?$/);
  if (pm && pm[2] && m === "POST") { const r = await closePosition(env.DB, who.user, pm[1]); return r.error ? bad(r.error) : json(r); }
  if (pm && !pm[2] && m === "PUT") {
    const b = await body<{ stop?: unknown; target?: unknown; exit_mode?: unknown }>(req);
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const err = await updatePosition(env.DB, who.user, pm[1], "stop" in b ? n(b.stop) : undefined, "target" in b ? n(b.target) : undefined,
      b.exit_mode === "eod" || b.exit_mode === "hold" ? b.exit_mode : undefined);
    return err ? bad(err) : json({ ok: true });
  }
  if (path === "/paper/settings" && m === "PUT") {
    const a = await getAccount(env.DB, who.user);
    const next = sanitizePaperSettings((await body<{ settings: unknown }>(req)).settings, a.s);
    await env.DB.prepare("UPDATE paper_accounts SET settings = ? WHERE user = ?").bind(JSON.stringify(next), who.user).run();
    return json(next);
  }
  if (path === "/paper/reset" && m === "POST") {
    const cash = Number((await body<{ starting_cash?: unknown }>(req)).starting_cash);
    if (!(cash >= 100 && cash <= 100_000_000)) return bad("Starting cash must be between $100 and $100,000,000.");
    await resetAccount(env.DB, who.user, Math.round(cash * 100) / 100);
    return json(await summary(env.DB, who.user));
  }

  if (path === "/status" && m === "GET") {
    const s = await getSettings(env.DB);
    const { config, error } = parseConfig(s.trader_config);
    return json({
      config, config_error: error, config_mount: CONFIG_MOUNT,
      paper: config ? config.paper !== false : null,
      agent_ready: !!(env.ANTHROPIC_API_KEY && env.AGENT_ID && env.ENVIRONMENT_ID),
      market: marketInfo(),
      calendar: CALENDAR,
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
    if ("data_source" in patch) {
      const v = String(patch.data_source);
      if (!["auto", "yahoo", "alpaca_iex", "alpaca_sip"].includes(v)) return bad("Unknown data source.");
      await setSetting(env.DB, "data_source", v);
      srcCache = null; await setupMarket(env);
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
    let text = prompt;
    if (!sid) {
      const s = await getSettings(env.DB);
      sid = await createSession(env, s.session_budget_usd);
      text = configContext(s.trader_config) + prompt;
    }
    return new Response(runTurn(env, sid, text), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  }

  if (path === "/briefs" && m === "GET") {
    const agentReady = !!(env.AGENT_ID && env.ENVIRONMENT_ID && env.ANTHROPIC_API_KEY);
    if (agentReady) await finalizeBriefs(env);
    const { results } = await env.DB.prepare("SELECT * FROM briefs ORDER BY created_at DESC LIMIT 30").all<Record<string, unknown>>();
    const ny = nyNow();
    return json({
      autopilot: await getAutopilot(env.DB), result_format: RESULT_FORMAT,
      slots: SLOTS.map(({ id, label, et }) => ({ id, label, et })),
      trading_day: isTradingDay(ny), ny_minutes: ny.minutes, agent_ready: agentReady,
      briefs: results.map((r) => {
        const parse = (v: unknown, d: unknown) => { try { return v ? JSON.parse(String(v)) : d; } catch { return d; } };
        const params = parse(r.params, null);
        return { ...r, picks: parse(r.picks, []), data: parse(r.data, null), params, filters: params ? describeFilters(sanitizeFilters(params)) : null };
      }),
    });
  }
  if (path === "/briefs/run" && m === "POST") {
    if (!env.AGENT_ID || !env.ENVIRONMENT_ID || !env.ANTHROPIC_API_KEY) return bad("Agent not configured.", 503);
    const rb = await body<{ slot: string; filters?: unknown }>(req);
    const slot = String(rb.slot) as SlotId;
    if (!SLOTS.some((s) => s.id === slot)) return bad("Unknown brief");
    const running = await env.DB.prepare("SELECT 1 FROM briefs WHERE status IN ('starting','running') AND slot = ? LIMIT 1").bind(slot).first();
    if (running) return bad("That brief is already running.", 409);
    return json({ id: await startBrief(env, slot, undefined, rb.filters ? sanitizeFilters(rb.filters) : undefined) });
  }
  if (path === "/scan-filters" && m === "GET") {
    const f = await getScanFilters(env.DB);
    return json({ filters: f, defaults: DEFAULT_FILTERS, sectors: SECTORS, exchanges: EXCHANGES, summary: describeFilters(f) });
  }
  if (path === "/scan-filters" && m === "PUT") {
    const f = sanitizeFilters((await body<{ filters: unknown }>(req)).filters);
    await setSetting(env.DB, "scan_filters", f);
    return json({ filters: f, summary: describeFilters(f) });
  }
  if (path === "/autopilot" && m === "PUT") {
    const b = await body<Partial<Autopilot>>(req);
    const cur = await getAutopilot(env.DB);
    const next: Autopilot = { enabled: typeof b.enabled === "boolean" ? b.enabled : cur.enabled, slots: { ...cur.slots } };
    for (const s of SLOTS) if (typeof b.slots?.[s.id] === "boolean") next.slots[s.id] = b.slots[s.id];
    await setSetting(env.DB, "autopilot", next);
    return json(next);
  }

  const cm = path.match(/^\/candles\/([^/]+)$/);
  if (cm && m === "GET") {
    const sym = decodeURIComponent(cm[1]).toUpperCase(), iv = url.searchParams.get("interval") || "5m";
    if (!SYMBOL_RE.test(sym)) return bad("Bad symbol");
    if (!(iv in INTERVALS)) return bad("Bad interval");
    const daysQ = url.searchParams.get("days");
    const days = daysQ === null ? undefined : Number(daysQ);
    if (days !== undefined && !(days >= 1 && days <= 3650)) return bad("days must be 1-3650");
    try { return json(await candles(sym, iv, days)); } catch (e) { return bad(`Data error: ${(e as Error).message}`, 502); }
  }
  if (path === "/quotes" && m === "GET") {
    const syms = (url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
    if (syms.some((s) => !SYMBOL_RE.test(s))) return bad("Bad symbol");
    return json(await quotes(syms));
  }

  if (path === "/journal" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM journal WHERE user = ? ORDER BY date DESC, created_at DESC LIMIT 2000").bind(who.user).all<Trade>();
    return json(results.map(tradeStats));
  }
  if (path === "/journal" && m === "POST") {
    const t = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), ...normalizeTrade((await body<{ trade: Record<string, unknown> }>(req)).trade ?? {}) };
    if (!t.symbol) return bad("Symbol required");
    await env.DB.prepare("INSERT INTO journal (id,date,symbol,side,qty,entry,stop,exit,fees,setup,notes,user) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(t.id, t.date, t.symbol, t.side, t.qty, t.entry, t.stop, t.exit, t.fees, t.setup, t.notes, who.user).run();
    return json(tradeStats(t));
  }
  const jm = path.match(/^\/journal\/([A-Za-z0-9]{1,32})$/);
  if (jm && m === "DELETE") {
    await env.DB.prepare("DELETE FROM journal WHERE id = ? AND user = ?").bind(jm[1], who.user).run();
    return json({ ok: true });
  }

  return bad("Not found", 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) await setupMarket(env);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method === "POST" && url.pathname === "/api/login") {
      if (req.headers.get("content-type")?.split(";")[0] !== "application/json") return bad("JSON required", 415);
      await ensureSchema(env.DB);
      return login(req, env);
    }
    if (req.method === "POST" && url.pathname === "/api/logout") return logout();
    const who = await authenticate(req, env);
    if (who instanceof Response) return who;
    if (req.method !== "GET" && req.headers.get("content-type")?.split(";")[0] !== "application/json") return bad("JSON required", 415);
    try {
      return await api(req, env, url, who);
    } catch (e) {
      if (e instanceof HttpError) return bad(e.message, e.status);
      const err = e as { status?: number; message?: string };
      return bad(err.message || "Server error", err.status && err.status >= 400 && err.status < 600 ? 502 : 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(setupMarket(env).then(() => runSchedule(env)));
  },
} satisfies ExportedHandler<Env>;

export { DEFAULT_SETTINGS };
