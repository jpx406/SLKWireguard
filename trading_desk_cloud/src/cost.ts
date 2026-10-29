// Claude spend: what each session cost (briefs and Copilot chats), a daily cap, and the per-task "engine"
// (model + effort) a session runs on. Session costs come from the Managed Agents list cost, in cents.

/** Engines a brief or chat can run on. "default" = the agent as configured by setup-agent.mjs (Opus 5.5, high effort). */
export const ENGINES = {
  default: { label: "Agent default (Opus 5.5 · high effort)", model: null },
  "opus-medium": { label: "Opus 5.5 · medium effort", model: { id: "claude-opus-5-5", effort: "medium" } },
  "sonnet-high": { label: "Sonnet 5.5 · high effort", model: { id: "claude-sonnet-5-5", effort: "high" } },
} as const;
export type EngineId = keyof typeof ENGINES;
export const isEngine = (v: unknown): v is EngineId => typeof v === "string" && v in ENGINES;

/** "37 USD" -> 37 (cents); anything else -> null. */
export function cents(cost: string | null | undefined): number | null {
  const m = /^(\d+)\s+USD$/.exec(String(cost ?? "").trim());
  return m ? Number(m[1]) : null;
}

let ready = false;
async function ensureSpend(db: D1Database) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS spend (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, slot TEXT, user TEXT,
    day TEXT NOT NULL, cents INTEGER NOT NULL, engine TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run();
  // Briefs from before this table existed carry their cost: copy them once.
  try {
    const rows = (await db.prepare("SELECT session_id, slot, day, cost FROM briefs WHERE cost IS NOT NULL AND session_id IS NOT NULL").all<{ session_id: string; slot: string; day: string; cost: string }>()).results;
    for (const r of rows) {
      const c = cents(r.cost);
      if (c !== null) await db.prepare("INSERT OR IGNORE INTO spend (session_id, kind, slot, day, cents) VALUES (?, 'brief', ?, ?, ?)").bind(r.session_id, r.slot, r.day, c).run();
    }
  } catch { /* no briefs table yet */ }
  ready = true;
}

/** Store a session's cumulative cost (chats grow turn by turn, so this replaces the previous value). */
export async function recordSpend(db: D1Database, s: { session_id: string; kind: "brief" | "chat"; slot?: string | null; user?: string | null; day: string; cost: string | null; engine?: string | null }) {
  const c = cents(s.cost);
  if (c === null) return;
  await ensureSpend(db);
  await db.prepare(`INSERT INTO spend (session_id, kind, slot, user, day, cents, engine) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET cents = MAX(cents, excluded.cents), updated_at = datetime('now')`)
    .bind(s.session_id, s.kind, s.slot ?? null, s.user ?? null, s.day, c, s.engine ?? null).run();
}

export async function spentOn(db: D1Database, day: string): Promise<number> {
  await ensureSpend(db);
  return ((await db.prepare("SELECT COALESCE(SUM(cents), 0) AS c FROM spend WHERE day = ?").bind(day).first<{ c: number }>())?.c ?? 0) / 100;
}

/** null when the daily cap allows another session, else the reason. */
export async function capBlocks(db: D1Database, capUsd: number, day: string): Promise<string | null> {
  if (!(capUsd > 0)) return null;
  const spent = await spentOn(db, day);
  return spent >= capUsd ? `Daily Claude spending cap reached ($${spent.toFixed(2)} of $${capUsd.toFixed(2)} today). Raise it in Settings or wait until tomorrow.` : null;
}

export async function usageReport(db: D1Database, today: string) {
  await ensureSpend(db);
  const since = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
  const sum = async (from: string) => ((await db.prepare("SELECT COALESCE(SUM(cents), 0) AS c FROM spend WHERE day >= ?").bind(from).first<{ c: number }>())?.c ?? 0) / 100;
  const by = (await db.prepare(`SELECT kind, COALESCE(slot, '') AS slot, COUNT(*) AS runs, SUM(cents) AS cents, MAX(cents) AS max_cents
      FROM spend WHERE day >= ? GROUP BY kind, slot ORDER BY cents DESC`).bind(since(29)).all<{ kind: string; slot: string; runs: number; cents: number; max_cents: number }>()).results;
  const users = (await db.prepare(`SELECT COALESCE(user, '') AS user, COUNT(*) AS sessions, SUM(cents) AS cents FROM spend
      WHERE kind = 'chat' AND day >= ? GROUP BY user ORDER BY cents DESC`).bind(since(29)).all<{ user: string; sessions: number; cents: number }>()).results;
  const daily = (await db.prepare("SELECT day, SUM(cents) AS cents FROM spend WHERE day >= ? GROUP BY day ORDER BY day").bind(since(29)).all<{ day: string; cents: number }>()).results;
  return { today: await sum(today), last7: await sum(since(6)), last30: await sum(since(29)), by, users, daily };
}
