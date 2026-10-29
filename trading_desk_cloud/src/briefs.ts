// Autopilot: scheduled market briefs. A Cloudflare cron fires every 15 minutes on weekdays;
// when New York time reaches an enabled slot, a Claude session runs that slot's routine with
// the trader-* skills. Results are collected on later ticks (or when the UI asks) and stored in D1.
import type { Env } from "./env";
import { client, configContext, createSession } from "./agent";
import { capBlocks, isEngine, recordSpend } from "./cost";
import { getSetting, getSettings } from "./db";
import { autoTradeNewBriefs, runEngine } from "./paper";
import { DEFAULT_FILTERS, enforceFilters, filtersPrompt, sanitizeFilters, type ScanFilters } from "./filters";

export async function getScanFilters(db: D1Database): Promise<ScanFilters> {
  return sanitizeFilters(await getSetting<unknown>(db, "scan_filters", DEFAULT_FILTERS));
}

export type SlotId = "fullscan" | "premarket" | "preopen" | "open" | "midday" | "power" | "review";
type Slot = { id: SlotId; label: string; et: string; defaultOn: boolean; prompt: string };

// Structured result every brief ends with; the UI turns it into tables and charts.
export const RESULT_FORMAT = `
End your answer with ONE fenced \`\`\`json block (nothing after it) with this exact shape. Use real numbers from your tools (null when unknown, never invented):
{
 "market": {
  "regime": "risk-on | risk-off | mixed",
  "summary": "2-3 sentences on what drives the market today",
  "indices": [{"symbol":"SPY","last":580.1,"change_pct":0.4,"bias":"bullish|bearish|neutral","support":[577.5],"resistance":[583.0]}],
  "sectors": [{"name":"Technology","etf":"XLK","change_pct":1.2}],
  "breadth": {"advancers":0,"decliners":0,"note":""},
  "events": [{"time_et":"08:30","event":"CPI","impact":"high|medium|low"}]
 },
 "picks": [{
  "rank":1, "symbol":"NVDA", "name":"NVIDIA", "sector":"Technology", "bias":"long|short",
  "setup":"gap-and-go above premarket high", "score":0-100, "confidence":"high|medium|low",
  "last":131.2, "premarket_change_pct":4.1, "rvol":3.2, "catalyst":"earnings beat",
  "market_cap":3.2e12, "avg_volume":2.5e8, "float_shares":2.4e10, "atr_pct":3.1, "exchange":"NASDAQ", "is_etf":false, "earnings_today":false,
  "entry":131.25, "stop":129.9, "targets":[133.0,134.8], "rr":2.6, "size_shares":55,
  "exit_plan":"scale 1/2 at T1, stop to breakeven, trail rest under 9 EMA; flat by 15:55",
  "invalidation":"loses VWAP on volume", "skills":["trader-scan","trader-risk"], "reason":"one line"
 }],
 "avoid": [{"symbol":"XYZ","reason":"low float halt risk"}],
 "skills_run": [{"skill":"trader-scan","status":"ok|failed|skipped","note":""}]
}
Rank picks best first (max 10), one entry per symbol, sizes within /workspace/trader/config.json.`;

export const SLOTS: Slot[] = [
  { id: "fullscan", label: "Full market scan (all skills)", et: "08:15", defaultOn: true, prompt:
    `Run my COMPLETE pipeline now, using EVERY one of my trader-* skills in a sensible order, over the WHOLE US market (not only my watchlist):
1. Market regime: index futures/ETFs (SPY, QQQ, IWM, DIA), VIX, 10y yield, dollar, oil; sector ETF performance (XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLB, XLU, XLRE, XLC); breadth.
2. Calendar: economic releases and Fed speakers today, notable earnings before/after the bell.
3. Universe: pre-market gainers and losers, most active by volume, unusual relative volume, new highs/lows, sector leaders and laggards. Use your skills first and the web (finviz, stockanalysis, nasdaq, Yahoo Finance) to fill gaps.
4. For each candidate: catalyst and news, SEC filings and halts, float/liquidity, key levels (premarket high/low, previous day high/low/close, VWAP), and a setup with entry, stop, targets and exit plan.
5. Risk: size every plan with my risk skill and the limits in /workspace/trader/config.json; drop anything that breaks a rule (and list it under "avoid").
6. Merge everything into ONE de-duplicated list ranked by quality (score 0-100), mixing longs and shorts and different sectors so it represents the whole market, not just a few names.
Report which skills you ran and whether each one worked. Then a short written briefing, then the JSON.` },
  { id: "premarket", label: "Pre-market scan", et: "08:00", defaultOn: false, prompt:
    `Run my full PRE-MARKET routine now with my trader-* skills: market regime (index futures, VIX, yields, dollar), economic calendar and earnings today, top pre-market gappers and unusual volume with their catalysts (news, filings, halts), and key levels for SPY and QQQ. Then give a ranked list of the best day-trade candidates for today with a complete plan for each (entry trigger, stop, targets in R, size within the limits in /workspace/trader/config.json). Skip names that break my rules and say why.` },
  { id: "preopen", label: "Final pre-open plan", et: "09:10", defaultOn: true, prompt:
    `It is 20 minutes before the US open. Use my trader-* skills to refresh the pre-market picture: update pre-market highs and lows, volume and news for today's best candidates, drop any that faded, add new movers, and give the final ranked game plan for the open with exact triggers, stops, targets and sizes per /workspace/trader/config.json.` },
  { id: "open", label: "Opening range update", et: "09:50", defaultOn: true, prompt:
    `The first 20 minutes of the US session are done. Use my trader-* skills to check the opening range and relative volume of today's candidates and the strongest and weakest movers, then say which setups are triggering or about to trigger, with entry, stop, targets and size per /workspace/trader/config.json. Say clearly which ideas from the pre-market plan are invalid now.` },
  { id: "midday", label: "Midday check", et: "12:30", defaultOn: false, prompt:
    `Midday check: use my trader-* skills to find the cleanest afternoon setups (trend continuation, VWAP reclaims, range breaks) among the day's movers and my watchlist, with full plans per /workspace/trader/config.json.` },
  { id: "power", label: "Power hour", et: "15:00", defaultOn: false, prompt:
    `Power hour: use my trader-* skills to find setups for the last hour (closing strength or weakness, end-of-day breakouts), with full plans per /workspace/trader/config.json. Remind me to be flat before the close if my rules require it.` },
  { id: "review", label: "End-of-day review", et: "16:15", defaultOn: false, prompt:
    `End-of-day review with my trader-* skills: how today's pre-market picks actually played out (trigger hit? target or stop?), the day's biggest movers I missed and why, and 3 lessons for tomorrow.` },
];

export type Autopilot = { enabled: boolean; slots: Record<SlotId, boolean> };
export const DEFAULT_AUTOPILOT: Autopilot = {
  enabled: true,
  slots: Object.fromEntries(SLOTS.map((s) => [s.id, s.defaultOn])) as Record<SlotId, boolean>,
};

// NYSE full-day closures (no briefs on these dates).
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
// Tests can move the session clock (DEV_CLOCK_SHIFT_SEC in .dev.vars); always 0 in production.
let clockShiftMs = 0;
export const setClockShift = (sec: number) => { clockShiftMs = Number.isFinite(sec) ? sec * 1000 : 0; };
export const clockNow = () => new Date(Date.now() + clockShiftMs);
export function nyNow(d = clockNow()) {
  const p = Object.fromEntries(nyFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: +p.hour * 60 + +p.minute };
}
const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
export const isTradingDay = (ny = nyNow()) => !["Sat", "Sun"].includes(ny.weekday) && !HOLIDAYS.has(ny.date);

// NYSE early closes: regular session ends 13:00 New York, after-hours at 17:00.
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
export const CALENDAR = { holidays: [...HOLIDAYS], early_closes: [...EARLY_CLOSES] };

/** Trading sessions (minutes after New York midnight): pre-market from 07:00, open 09:30, close 16:00, after-hours to 20:00. */
export function sessionTimes(date: string) {
  const early = EARLY_CLOSES.has(date);
  return { pre: 420, open: 570, close: early ? 780 : 960, postEnd: early ? 1020 : 1200 };
}
export type Phase = "pre" | "regular" | "post" | "closed";
export function marketPhase(ny = nyNow()): Phase {
  if (!isTradingDay(ny)) return "closed";
  const t = sessionTimes(ny.date), m = ny.minutes;
  return m < t.pre ? "closed" : m < t.open ? "pre" : m < t.close ? "regular" : m < t.postEnd ? "post" : "closed";
}
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** First trading date strictly after `date` (YYYY-MM-DD). */
export function nextTradingDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay({ date: iso, weekday: WD[d.getUTCDay()], minutes: 0 })) return iso;
  }
  return date;
}
/** True when a bar starting at unix time `ts` falls inside pre-market, regular or after-hours. Cached per hour (DST shifts on the hour). */
const hourCache = new Map<number, ReturnType<typeof nyNow>>();
export function inSession(ts: number): boolean {
  const h = Math.floor(ts / 3600);
  let base = hourCache.get(h);
  if (!base) { base = nyNow(new Date(h * 3600 * 1000)); if (hourCache.size > 5000) hourCache.clear(); hourCache.set(h, base); }
  return marketPhase({ ...base, minutes: base.minutes + Math.floor((ts % 3600) / 60) }) !== "closed";
}
/** The trading day a new order belongs to: today until after-hours end, otherwise the next session. */
export function orderDay(ny = nyNow()): string {
  return isTradingDay(ny) && ny.minutes < sessionTimes(ny.date).postEnd ? ny.date : nextTradingDate(ny.date);
}

let briefSchemaReady = false;
export async function ensureBriefSchema(db: D1Database) {
  if (briefSchemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, slot TEXT NOT NULL, label TEXT, session_id TEXT, status TEXT NOT NULL,
    content TEXT, picks TEXT, cost TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), finished_at TEXT)`).run();
  // Added later: the full structured result (market, picks, avoid, skills_run).
  try { await db.prepare("ALTER TABLE briefs ADD COLUMN data TEXT").run(); } catch { /* already there */ }
  try { await db.prepare("ALTER TABLE briefs ADD COLUMN params TEXT").run(); } catch { /* already there */ }
  try { await db.prepare("ALTER TABLE briefs ADD COLUMN auto_done INTEGER").run(); } catch { /* already there */ }
  try { await db.prepare("ALTER TABLE briefs ADD COLUMN engine TEXT").run(); } catch { /* already there */ }
  briefSchemaReady = true;
}

/** Saved autopilot settings merged with defaults, so new routines appear with their default state. */
export async function getAutopilot(db: D1Database): Promise<Autopilot> {
  const saved = await getSetting<Autopilot>(db, "autopilot", DEFAULT_AUTOPILOT);
  return { enabled: saved.enabled ?? true, slots: { ...DEFAULT_AUTOPILOT.slots, ...(saved.slots ?? {}) } };
}

// Briefs that refresh an earlier plan instead of researching from scratch (when "reuse research" is on).
const REFRESH_SLOTS = new Set(["preopen", "open", "midday", "power", "review"]);
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * The latest finished plan of the day as a compact hand-off, so a refresh brief re-checks what changes
 * intraday (prices, levels, volume, news) instead of re-running the slow-moving research again.
 */
async function priorPlan(db: D1Database, day: string): Promise<string> {
  const b = await db.prepare("SELECT label, created_at, data FROM briefs WHERE day = ? AND status = 'done' AND data IS NOT NULL AND data != 'null' ORDER BY created_at DESC LIMIT 1")
    .bind(day).first<{ label: string; created_at: string; data: string }>();
  if (!b) return "";
  let d: Record<string, any>;
  try { d = JSON.parse(b.data); } catch { return ""; }
  if (!d || !Array.isArray(d.picks) || !d.picks.length) return "";
  const keep = ["rank", "symbol", "bias", "setup", "score", "entry", "stop", "targets", "rr", "exit_plan", "invalidation", "catalyst", "market_cap", "avg_volume", "float_shares", "exchange", "is_etf", "earnings_today"];
  const plan = {
    market: d.market ? { regime: d.market.regime, summary: d.market.summary, events: d.market.events } : undefined,
    picks: d.picks.slice(0, 10).map((p: Record<string, unknown>) => Object.fromEntries(keep.filter((k) => k in p).map((k) => [k, p[k]]))),
    avoid: Array.isArray(d.avoid) ? d.avoid.slice(0, 15) : undefined,
  };
  const at = nyNow(new Date(b.created_at.replace(" ", "T") + "Z"));
  return `[Earlier today] My "${b.label}" brief at ${hhmm(at.minutes)} New York produced this plan:
\`\`\`json
${JSON.stringify(plan)}
\`\`\`
Start from it instead of redoing the whole research. Keep the slow-moving parts as they are (market backdrop, SEC filings and fundamentals, insider/13F data, earnings and economic calendar, sector context) unless something new has happened since. Put your work into what changes during the day: current prices and key levels, volume and relative volume, fresh news, halts or filings for these names, and strong new movers that are not in the plan. Re-check every pick's entry, stop and targets against current prices and drop or replace the ones that no longer work. In skills_run, mark skills whose earlier results you reused as status "reused".

`;
}

/** Start a brief now (from the cron or the "Run now" button). */
export async function startBrief(env: Env, slotId: SlotId, ny = nyNow(), filtersOverride?: ScanFilters) {
  const slot = SLOTS.find((s) => s.id === slotId);
  if (!slot) throw new Error("Unknown brief");
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await ensureBriefSchema(env.DB);
  await env.DB.prepare("INSERT INTO briefs (id, day, slot, label, status) VALUES (?, ?, ?, ?, 'starting')").bind(id, ny.date, slot.id, slot.label).run();
  try {
    const s = await getSettings(env.DB);
    const capped = await capBlocks(env.DB, s.daily_cap_usd, ny.date);
    if (capped) throw new Error(capped);
    const watchlist = s.watchlist.join(", ");
    const engine = isEngine(s.engines?.[slot.id]) ? s.engines[slot.id] : "default";
    // The full scan runs every skill, so it gets twice the normal per-session budget.
    const sid = await createSession(env, slot.id === "fullscan" ? s.session_budget_usd * 2 : s.session_budget_usd, engine as never);
    await env.DB.prepare("UPDATE briefs SET engine = ? WHERE id = ?").bind(engine, id).run();
    const handoff = s.reuse_research && REFRESH_SLOTS.has(slot.id) ? await priorPlan(env.DB, ny.date) : "";
    const filters = slot.id === "fullscan" ? filtersOverride ?? (await getScanFilters(env.DB)) : null;
    if (filters) await env.DB.prepare("UPDATE briefs SET params = ? WHERE id = ?").bind(JSON.stringify(filters), id).run();
    const text = `${configContext(s.trader_config)}[Autopilot — ${slot.label}, ${ny.date}, New York ${String(Math.floor(ny.minutes / 60)).padStart(2, "0")}:${String(ny.minutes % 60).padStart(2, "0")}] My watchlist: ${watchlist}.\n\n${handoff}${slot.prompt}\n${filters ? filtersPrompt(filters) : ""}\n${RESULT_FORMAT}`;
    await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    await env.DB.prepare("UPDATE briefs SET session_id = ?, status = 'running' WHERE id = ?").bind(sid, id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE briefs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").bind(String((e as Error).message || e).slice(0, 500), id).run();
  }
  return id;
}

/** The last fenced json block of the answer: {market, picks, avoid, skills_run} (or a bare {picks}). */
export function extractResult(text: string): { picks: unknown[]; [k: string]: unknown } | null {
  const last = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1);
  if (!last) return null;
  try {
    const obj = JSON.parse(last[1]);
    if (!obj || typeof obj !== "object") return null;
    return { ...obj, picks: Array.isArray(obj.picks) ? obj.picks.slice(0, 15) : [] };
  } catch { return null; }
}

/** Collect results of running briefs; deny any tool call left waiting for approval. */
export async function finalizeBriefs(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, session_id, created_at, params, slot, day, engine FROM briefs WHERE status = 'running'")
    .all<{ id: string; session_id: string; created_at: string; params: string | null; slot: string; day: string; engine: string | null }>();
  const anthropic = client(env);
  for (const b of results) {
    try {
      const s = await anthropic.beta.sessions.retrieve(b.session_id);
      const ageMin = (Date.now() - Date.parse(b.created_at.replace(" ", "T") + "Z")) / 60000;
      const texts: string[] = [], errors: string[] = [];
      const asks = new Set<string>(), answered = new Set<string>();
      let sawPrompt = false, idleReason: string | null = null;
      for await (const ev of anthropic.beta.sessions.events.list(b.session_id, { order: "asc" })) {
        if (ev.type === "user.message") { sawPrompt = true; idleReason = null; }
        if (ev.type === "agent.message") for (const c of ev.content) { if (c.type === "text") texts.push(c.text); }
        if ((ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use") && ev.evaluated_permission === "ask") asks.add(ev.id);
        if (ev.type === "user.tool_confirmation") answered.add(ev.tool_use_id);
        if (ev.type === "session.error") errors.push(`${ev.error.type}${"message" in ev.error && ev.error.message ? `: ${ev.error.message}` : ""}`);
        // Only an idle that comes AFTER our prompt means the turn finished; a new session is idle before it starts.
        if (ev.type === "session.status_idle" && sawPrompt) idleReason = ev.stop_reason.type;
      }
      const cost = s.usage?.list_cost ? `${s.usage.list_cost.amount} ${s.usage.list_cost.currency}` : null;
      const content = texts.join("\n\n");
      const filters = b.params ? sanitizeFilters(JSON.parse(b.params)) : null;
      const result = filters ? enforceFilters(extractResult(content), filters) : extractResult(content);
      const finish = async (status: "done" | "error", error: string | null) => {
        await recordSpend(env.DB, { session_id: b.session_id, kind: "brief", slot: b.slot, day: b.day, cost, engine: b.engine });
        return env.DB.prepare("UPDATE briefs SET status = ?, content = ?, picks = ?, data = ?, cost = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
          .bind(status, content, JSON.stringify(result?.picks ?? []), JSON.stringify(result), cost, error, b.id).run();
      };

      if (idleReason === "requires_action") {
        const pending = [...asks].filter((x) => !answered.has(x));
        if (pending.length) await anthropic.beta.sessions.events.send(b.session_id, {
          events: pending.map((tool_use_id) => ({ type: "user.tool_confirmation" as const, tool_use_id, result: "deny" as const })),
        });
        continue; // it resumes; collect on a later check
      }
      if (idleReason) {
        const why: Record<string, string> = {
          budget_reached: "Stopped at the session budget. Raise it in Settings.",
          refusal: "Claude declined this request.",
          retries_exhausted: "Failed after retries.",
        };
        const err = idleReason === "end_turn" ? null : why[idleReason] ?? idleReason;
        if (content) await finish("done", err);
        else await finish("error", [err, ...errors].filter(Boolean).join(" · ") || "Claude finished without writing an answer.");
      } else if (s.status === "terminated") {
        await finish(content ? "done" : "error", content ? null : errors.join(" · ") || "The session ended before answering.");
      } else if (ageMin > 45) {
        await finish("error", ["Timed out after 45 minutes", ...errors].join(" · "));
      }
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 404) await env.DB.prepare("UPDATE briefs SET status = 'error', error = 'Session not found' WHERE id = ?").bind(b.id).run();
    }
  }
}

/** Cron entry point. */
export async function runSchedule(env: Env, now = clockNow()) {
  await ensureBriefSchema(env.DB);
  // Paper trading: fill/close against the latest 1-minute bars, then auto-trade any newly finished brief.
  try { await runEngine(env.DB); } catch (e) { console.error("paper engine", e); }
  if (!env.AGENT_ID || !env.ENVIRONMENT_ID || !env.ANTHROPIC_API_KEY) return;
  await finalizeBriefs(env);
  try { await autoTradeNewBriefs(env.DB); } catch (e) { console.error("auto-trade", e); }
  const ny = nyNow(now);
  const ap = await getAutopilot(env.DB);
  if (!ap.enabled || !isTradingDay(ny)) return;
  for (const slot of SLOTS) {
    if (!ap.slots?.[slot.id]) continue;
    const start = toMin(slot.et);
    if (ny.minutes < start || ny.minutes >= start + 30) continue; // 30-min window tolerates a missed tick
    const exists = await env.DB.prepare("SELECT 1 FROM briefs WHERE day = ? AND slot = ? LIMIT 1").bind(ny.date, slot.id).first();
    if (exists) continue;
    // Skip a scheduled brief when another one is still running or started within the last 30 minutes
    // (for example a manual run): it would repeat the same research minutes apart. Only another full scan
    // stands in for a full scan.
    const recent = await env.DB.prepare(`SELECT 1 FROM briefs WHERE status != 'skipped' AND ((status IN ('starting', 'running') AND created_at > datetime('now', '-60 minutes')) OR created_at > datetime('now', '-30 minutes'))
      ${slot.id === "fullscan" ? "AND slot = 'fullscan'" : ""} LIMIT 1`).first();
    if (recent) {
      await env.DB.prepare("INSERT INTO briefs (id, day, slot, label, status, error, finished_at) VALUES (?, ?, ?, ?, 'skipped', ?, datetime('now'))")
        .bind(crypto.randomUUID().replace(/-/g, "").slice(0, 16), ny.date, slot.id, slot.label, "Skipped: another brief ran less than 30 minutes ago (saves a duplicate run).").run();
      continue;
    }
    await startBrief(env, slot.id, ny);
  }
}
