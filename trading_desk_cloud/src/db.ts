// D1 storage: settings (key/value) and the trade journal. Tables are created lazily.
let ready: Promise<unknown> | null = null;

export function ensureSchema(db: D1Database) {
  ready ??= db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS journal (
      id TEXT PRIMARY KEY, date TEXT, symbol TEXT, side TEXT, qty REAL, entry REAL, stop REAL,
      exit REAL, fees REAL, setup TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`),
  ]).then(async () => {
    // Added later: journal rows belong to a user (older rows are the admin's).
    try { await db.prepare("ALTER TABLE journal ADD COLUMN user TEXT NOT NULL DEFAULT 'admin'").run(); } catch { /* exists */ }
  }).catch((e) => { ready = null; throw e; });
  return ready;
}

export const DEFAULT_SETTINGS = {
  watchlist: ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "AMD", "MSFT", "META"],
  session_budget_usd: 5,
  trader_config: "", // raw text of trader/config.json
  data_source: "auto" as "auto" | "yahoo" | "alpaca_iex" | "alpaca_sip",
  // Cost controls (see cost.ts).
  daily_cap_usd: 0,                        // stop starting Claude sessions once today's spend reaches this (0 = no cap)
  reuse_research: true,                    // later briefs start from the day's earlier plan instead of redoing it
  engines: {} as Record<string, string>,   // per brief slot (and "chat"): engine id; missing = "default"
};
export type Settings = typeof DEFAULT_SETTINGS;

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export async function setSetting(db: D1Database, key: string, value: unknown) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value)).run();
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = await getSetting(db, k, out[k]);
  return out as Settings;
}

export type Trade = {
  id: string; date: string; symbol: string; side: "long" | "short"; qty: number | null; entry: number | null;
  stop: number | null; exit: number | null; fees: number | null; setup: string; notes: string;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function normalizeTrade(t: Record<string, unknown>): Omit<Trade, "id"> {
  const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) ? String(t.date) : new Date().toISOString().slice(0, 10),
    symbol: str(t.symbol, 15).toUpperCase(),
    side: t.side === "short" ? "short" : "long",
    qty: num(t.qty), entry: num(t.entry), stop: num(t.stop), exit: num(t.exit), fees: num(t.fees),
    setup: str(t.setup, 100), notes: str(t.notes, 2000),
  };
}

export function tradeStats(t: Trade) {
  const sign = t.side === "long" ? 1 : -1;
  let pnl: number | null = null, r: number | null = null;
  if (t.entry !== null && t.exit !== null && t.qty) {
    pnl = Math.round(((t.exit - t.entry) * t.qty * sign - (t.fees ?? 0)) * 100) / 100;
    if (t.stop !== null && t.stop !== t.entry) r = Math.round(((t.exit - t.entry) * sign / Math.abs(t.entry - t.stop)) * 100) / 100;
  }
  return { ...t, pnl, r };
}
