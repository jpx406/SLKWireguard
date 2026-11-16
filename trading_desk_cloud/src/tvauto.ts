// Strategy auto-trader (paper only): one tested strategy per symbol may trade the paper account by itself.
// Each time a bar finishes, the strategy is replayed on the finished bars and the desk checks which way it is
// positioned. When that changes (flat, long, short) the paper position is changed to match: the old one is closed
// and the new one opened at the market, sized from the amount set here. Switching it on never jumps into a trade
// that is already running: it waits for the strategy's next change. Entries go through the same risk gate as
// every other automatic order (kill switch, drawdown guard, market regime).
import { isTradingDay, marketPhase, nyNow } from "./briefs";
import { candles, isCrypto } from "./market";
import { closePosition, ensurePaper, getAccount, placeOrder, riskGate } from "./paper";
import { riskLog } from "./risk";
import { STRATEGIES, runStrategy, type Bar, type Def } from "./strategies";
import { customDef } from "./pineconv";

export const TV_INTERVALS = ["5m", "15m", "60m", "1d"] as const;
const STEP: Record<string, number> = { "5m": 300, "15m": 900, "60m": 3600, "1d": 86400 };
export const TV_DAYS: Record<string, number> = { "5m": 59, "15m": 59, "60m": 700, "1d": 1500 };
const LIVE_DAYS: Record<string, number> = { "5m": 20, "15m": 40, "60m": 150, "1d": 600 };
export type TvAuto = { user: string; symbol: string; strategy: string; interval: string; params: string; direction: string; amount_usd: number; enabled: number; last_bar: number; last_target: string | null; last_note: string | null; last_at: number | null; created_at: number };

let ready = false;
async function ensure(db: D1Database) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS tv_auto (user TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL, interval TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', direction TEXT NOT NULL DEFAULT 'both',
    amount_usd REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_bar INTEGER NOT NULL DEFAULT 0, last_target TEXT, last_note TEXT, last_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (user, symbol))`).run();
  ready = true;
}
/** Finished bars only: the bar still forming is dropped. */
export function finished(b: Bar[], interval: string): Bar[] { return b.length && Date.now() / 1000 < b[b.length - 1].time + STEP[interval] ? b.slice(0, -1) : b; }
/** A built-in strategy, or one of this user's converted strategies (only a verified one may auto-trade). */
const defOf = async (db: D1Database, user: string, strategy: string): Promise<Def | null> => STRATEGIES.find((s) => s.id === strategy) ?? (await customDef(db, user, strategy, true));
const targetOf = (strategy: Def, bars: Bar[], params: Record<string, number>, direction: string) => runStrategy(strategy, bars, { params, direction: direction as "both" | "long" | "short", commission_pct: 0 }).open?.side ?? "flat";

export async function listTvAuto(db: D1Database, user: string) {
  await ensure(db);
  const { results } = await db.prepare("SELECT * FROM tv_auto WHERE user = ? ORDER BY created_at DESC").bind(user).all<TvAuto>();
  const out = []; for (const r of results) out.push({ ...r, params: JSON.parse(r.params || "{}"), enabled: !!r.enabled, name: (await defOf(db, user, r.strategy))?.name ?? "(strategy no longer available)" });
  return out;
}

export async function setTvAuto(db: D1Database, user: string, b: { symbol?: unknown; strategy?: unknown; interval?: unknown; params?: unknown; direction?: unknown; amount_usd?: unknown; enabled?: unknown }): Promise<string | null> {
  await ensure(db);
  const symbol = String(b.symbol ?? "").trim().toUpperCase(), strategy = String(b.strategy ?? ""), interval = String(b.interval ?? ""), amount = Number(b.amount_usd);
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return "Bad symbol";
  const def = await defOf(db, user, strategy); if (!def) return strategy.startsWith("c:") ? "Only a converted strategy that passed its check can auto-trade." : "Unknown strategy.";
  if (!(TV_INTERVALS as readonly string[]).includes(interval)) return "Bar size must be 5m, 15m, 1h or 1D.";
  if (!(amount >= 50 && amount <= 1_000_000)) return "Amount per trade: $50 to $1,000,000.";
  const direction = b.direction === "long" || b.direction === "short" ? b.direction : "both", params: Record<string, number> = {};
  for (const d of def.params) { const v = Number((b.params as Record<string, unknown> | undefined)?.[d.key]); if (Number.isFinite(v)) params[d.key] = Math.min(d.max, Math.max(d.min, v)); }
  const n = await db.prepare("SELECT COUNT(*) AS n FROM tv_auto WHERE user = ? AND symbol != ?").bind(user, symbol).first<{ n: number }>();
  if ((n?.n ?? 0) >= 12) return "You already have 12 strategy auto-traders. Remove one first.";
  // Where the strategy stands right now: the auto-trader starts from there and acts on the next change only.
  let bars: Bar[]; try { bars = finished((await candles(symbol, interval, LIVE_DAYS[interval])) as Bar[], interval); } catch (e) { return String((e as Error).message || e).slice(0, 200); }
  if (bars.length < 80) return `Not enough ${interval} history for ${symbol}.`;
  const target = targetOf(def, bars, params, direction), now = Math.floor(Date.now() / 1000), enabled = b.enabled === false ? 0 : 1;
  await db.prepare(`INSERT INTO tv_auto (user, symbol, strategy, interval, params, direction, amount_usd, enabled, last_bar, last_target, last_note, last_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user, symbol) DO UPDATE SET strategy = excluded.strategy, interval = excluded.interval, params = excluded.params, direction = excluded.direction, amount_usd = excluded.amount_usd, enabled = excluded.enabled, last_bar = excluded.last_bar, last_target = excluded.last_target, last_note = excluded.last_note, last_at = excluded.last_at`)
    .bind(user, symbol, strategy, interval, JSON.stringify(params), direction, amount, enabled, bars[bars.length - 1].time, target, enabled ? `Armed. The strategy is ${target} now; the first paper trade comes at its next change.` : "Paused.", now, now).run();
  return null;
}
export async function removeTvAuto(db: D1Database, user: string, symbol: string) { await ensure(db); await db.prepare("DELETE FROM tv_auto WHERE user = ? AND symbol = ?").bind(user, symbol.toUpperCase()).run(); }

/** Every minute: bring each enabled auto-trader's paper position in line with its strategy. Returns how many acted. */
export async function runTvAuto(db: D1Database): Promise<number> {
  await ensure(db);
  const { results } = await db.prepare("SELECT * FROM tv_auto WHERE enabled = 1").all<TvAuto>();
  if (!results.length) return 0;
  await ensurePaper(db);
  const now = Math.floor(Date.now() / 1000), ny = nyNow(); let acted = 0;
  const note = (r: TvAuto, text: string, extra = "") => db.prepare(`UPDATE tv_auto SET last_note = ?, last_at = ?${extra} WHERE user = ? AND symbol = ?`).bind(text.slice(0, 300), now, r.user, r.symbol).run();
  for (const r of results) {
    try {
      const crypto = isCrypto(r.symbol), step = STEP[r.interval];
      // Stocks trade in the regular session only; the next finished bar cannot exist before its time.
      if (!crypto && (!isTradingDay(ny) || marketPhase(ny) !== "regular")) continue;
      if (r.interval !== "1d" && now < r.last_bar + 2 * step) continue;
      if (r.interval === "1d" && ny.minutes % 10 !== 0 && !crypto) continue;
      const bars = finished((await candles(r.symbol, r.interval, LIVE_DAYS[r.interval])) as Bar[], r.interval), last = bars[bars.length - 1];
      if (!last || last.time <= r.last_bar) continue;
      const def = await defOf(db, r.user, r.strategy);
      if (!def) { await db.prepare("UPDATE tv_auto SET enabled = 0, last_note = ?, last_at = ? WHERE user = ? AND symbol = ?").bind("Paused: this strategy is no longer available or no longer verified.", now, r.user, r.symbol).run(); continue; }
      const target = targetOf(def, bars, JSON.parse(r.params || "{}"), r.direction), name = def.name;
      const seen = `, last_bar = ${last.time}`;
      if (target === r.last_target) { await db.prepare("UPDATE tv_auto SET last_bar = ? WHERE user = ? AND symbol = ?").bind(last.time, r.user, r.symbol).run(); continue; }
      const mine = await db.prepare("SELECT id, side FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'open' AND source = 'tv' LIMIT 1").bind(r.user, r.symbol).first<{ id: string; side: string }>();
      const other = await db.prepare("SELECT id FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'open' AND source != 'tv' LIMIT 1").bind(r.user, r.symbol).first();
      if (mine && mine.side !== target) await closePosition(db, r.user, mine.id);
      if (target === "flat") { await note(r, `${name}: flat. ${mine ? "Paper position closed." : "Nothing to close."}`, `${seen}, last_target = 'flat'`); acted++; continue; }
      if (other) { await note(r, `${name} turned ${target}, but another position is open on ${r.symbol}: not adding to it.`, `${seen}, last_target = '${target}'`); continue; }
      const gate = await riskGate(db, r.user, r.symbol);
      if (!gate.ok) { await riskLog(db, r.user, r.symbol, "blocked", `Strategy auto: ${gate.reason}`); await note(r, `${name} turned ${target}, blocked by the risk gate: ${gate.reason}`, `${seen}, last_target = '${target}'`); continue; }
      const acct = await getAccount(db, r.user), budget = Math.min(r.amount_usd, acct.cash) * gate.size_mult;
      if (budget < 50) { await note(r, `${name} turned ${target}, but there is not enough paper cash.`, `${seen}, last_target = '${target}'`); continue; }
      const res = await placeOrder(db, r.user, { symbol: r.symbol, side: target as "long" | "short", type: "market", amount_usd: budget, exit_mode: "hold", source: "tv", note: `Strategy auto: ${name} on ${r.interval === "60m" ? "1h" : r.interval} bars` });
      await note(r, res.error ? `${name} turned ${target}; order refused: ${res.error}` : `${name} turned ${target}: paper ${target === "long" ? "buy" : "short"} placed for about $${Math.round(budget)}.`, `${seen}, last_target = '${target}'`);
      acted++;
    } catch (e) { console.error("tv auto", r.symbol, e); }
  }
  return acted;
}
