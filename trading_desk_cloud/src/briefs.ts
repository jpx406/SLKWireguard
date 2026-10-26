// Autopilot: scheduled market briefs. A Cloudflare cron fires every 15 minutes on weekdays;
// when New York time reaches an enabled slot, a Claude session runs that slot's routine with
// the trader-* skills. Results are collected on later ticks (or when the UI asks) and stored in D1.
import type { Env } from "./env";
import { client, createSession } from "./agent";
import { getSetting, getSettings } from "./db";

export type SlotId = "premarket" | "preopen" | "open" | "midday" | "power" | "review";
type Slot = { id: SlotId; label: string; et: string; defaultOn: boolean; prompt: string };

const PICKS_FORMAT = `
End your answer with one fenced \`\`\`json block (nothing after it) in exactly this shape, best idea first, at most 6 picks (empty list if nothing qualifies):
{"picks":[{"symbol":"NVDA","bias":"long","setup":"gap-and-go above premarket high","entry":123.4,"stop":121.9,"targets":[125.0,126.5],"size_shares":40,"confidence":"high|medium|low","reason":"one line"}]}`;

export const SLOTS: Slot[] = [
  { id: "premarket", label: "Pre-market scan", et: "08:00", defaultOn: true, prompt:
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
export function nyNow(d = new Date()) {
  const p = Object.fromEntries(nyFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: +p.hour * 60 + +p.minute };
}
const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
export const isTradingDay = (ny = nyNow()) => !["Sat", "Sun"].includes(ny.weekday) && !HOLIDAYS.has(ny.date);

export async function ensureBriefSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, slot TEXT NOT NULL, label TEXT, session_id TEXT, status TEXT NOT NULL,
    content TEXT, picks TEXT, cost TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), finished_at TEXT)`).run();
}

/** Start a brief now (from the cron or the "Run now" button). */
export async function startBrief(env: Env, slotId: SlotId, ny = nyNow()) {
  const slot = SLOTS.find((s) => s.id === slotId);
  if (!slot) throw new Error("Unknown brief");
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  await env.DB.prepare("INSERT INTO briefs (id, day, slot, label, status) VALUES (?, ?, ?, ?, 'starting')").bind(id, ny.date, slot.id, slot.label).run();
  try {
    const s = await getSettings(env.DB);
    const watchlist = s.watchlist.join(", ");
    const sid = await createSession(env, s.session_budget_usd);
    const text = `[Autopilot — ${slot.label}, ${ny.date}, New York ${String(Math.floor(ny.minutes / 60)).padStart(2, "0")}:${String(ny.minutes % 60).padStart(2, "0")}] My watchlist: ${watchlist}.\n\n${slot.prompt}\n${PICKS_FORMAT}`;
    await client(env).beta.sessions.events.send(sid, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
    await env.DB.prepare("UPDATE briefs SET session_id = ?, status = 'running' WHERE id = ?").bind(sid, id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE briefs SET status = 'error', error = ?, finished_at = datetime('now') WHERE id = ?").bind(String((e as Error).message || e).slice(0, 500), id).run();
  }
  return id;
}

function extractPicks(text: string): unknown[] | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last) return null;
  try {
    const obj = JSON.parse(last[1]);
    return Array.isArray(obj?.picks) ? obj.picks.slice(0, 10) : null;
  } catch { return null; }
}

/** Collect results of running briefs; deny any tool call left waiting for approval. */
export async function finalizeBriefs(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, session_id, created_at FROM briefs WHERE status = 'running'").all<{ id: string; session_id: string; created_at: string }>();
  const anthropic = client(env);
  for (const b of results) {
    try {
      const s = await anthropic.beta.sessions.retrieve(b.session_id);
      const ageMin = (Date.now() - Date.parse(b.created_at.replace(" ", "T") + "Z")) / 60000;
      const texts: string[] = [];
      const asks = new Set<string>(), answered = new Set<string>();
      for await (const ev of anthropic.beta.sessions.events.list(b.session_id)) {
        if (ev.type === "agent.message") for (const c of ev.content) { if (c.type === "text") texts.push(c.text); }
        if ((ev.type === "agent.tool_use" || ev.type === "agent.mcp_tool_use") && ev.evaluated_permission === "ask") asks.add(ev.id);
        if (ev.type === "user.tool_confirmation") answered.add(ev.tool_use_id);
      }
      const pending = [...asks].filter((x) => !answered.has(x));
      if (pending.length) {
        await anthropic.beta.sessions.events.send(b.session_id, {
          events: pending.map((tool_use_id) => ({ type: "user.tool_confirmation" as const, tool_use_id, result: "deny" as const })),
        });
        continue; // it resumes; collect on a later tick
      }
      const cost = s.usage?.list_cost ? `${s.usage.list_cost.amount} ${s.usage.list_cost.currency}` : null;
      if (s.status === "idle" || s.status === "terminated") {
        const content = texts.join("\n\n");
        await env.DB.prepare("UPDATE briefs SET status = ?, content = ?, picks = ?, cost = ?, error = ?, finished_at = datetime('now') WHERE id = ?")
          .bind(content ? "done" : "error", content, JSON.stringify(extractPicks(content) ?? []), cost, content ? null : "No answer (session ended or hit its budget).", b.id).run();
      } else if (ageMin > 45) {
        await env.DB.prepare("UPDATE briefs SET status = 'error', content = ?, cost = ?, error = 'Timed out after 45 minutes', finished_at = datetime('now') WHERE id = ?")
          .bind(texts.join("\n\n"), cost, b.id).run();
      }
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 404) await env.DB.prepare("UPDATE briefs SET status = 'error', error = 'Session not found' WHERE id = ?").bind(b.id).run();
    }
  }
}

/** Cron entry point. */
export async function runSchedule(env: Env, now = new Date()) {
  await ensureBriefSchema(env.DB);
  if (!env.AGENT_ID || !env.ENVIRONMENT_ID || !env.ANTHROPIC_API_KEY) return;
  await finalizeBriefs(env);
  const ny = nyNow(now);
  const ap = await getSetting<Autopilot>(env.DB, "autopilot", DEFAULT_AUTOPILOT);
  if (!ap.enabled || !isTradingDay(ny)) return;
  for (const slot of SLOTS) {
    if (!ap.slots?.[slot.id]) continue;
    const start = toMin(slot.et);
    if (ny.minutes < start || ny.minutes >= start + 30) continue; // 30-min window tolerates a missed tick
    const exists = await env.DB.prepare("SELECT 1 FROM briefs WHERE day = ? AND slot = ? LIMIT 1").bind(ny.date, slot.id).first();
    if (!exists) await startBrief(env, slot.id, ny);
  }
}
