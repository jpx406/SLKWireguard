// "Promote to rule": a tested TV strategy (its exact parameters, symbol, bar size and direction) is stored with its
// in-sample (first 70% of the history) and out-of-sample (last 30%) results as a PROPOSED rule. The admin approves or
// rejects it. A promotion whose out-of-sample part is too thin (< 30 trades) or not profitable is "not validated" and
// can never be approved. Approval is a record of a decision: it does NOT start any trading by itself.
import type { Part, Result } from "./strategies";

export const PROMOTE_MIN_OOS_TRADES = 30;
export type PromoStatus = "proposed" | "approved" | "rejected";
export type Promotion = {
  id: string; user: string; strategy_id: string; name: string; symbol: string; interval: string; direction: string; params: Record<string, number>; commission_pct: number;
  in_sample: Part; out_sample: Part; total: { net_pct: number; trades: number; buy_hold_pct: number; max_dd_pct: number; profit_factor: number | null; bars: number; from: number; to: number };
  validated: boolean; why: string; status: PromoStatus; created_at: number; decided_at: number | null; decided_by: string | null;
};

/** The gate: at least 30 out-of-sample trades and a positive out-of-sample result. Pure, so it can be tested. */
export function validatePromotion(out: { trades?: number | null; net_pct?: number | null } | null | undefined): { validated: boolean; why: string } {
  const n = Number(out?.trades) || 0, net = Number(out?.net_pct);
  const few = n < PROMOTE_MIN_OOS_TRADES, bad = !(Number.isFinite(net) && net > 0);
  if (!few && !bad) return { validated: true, why: `Validated: ${n} out-of-sample trades with a positive result (${net > 0 ? "+" : ""}${net}%).` };
  const parts: string[] = [];
  if (few) parts.push(`only ${n} out-of-sample trade${n === 1 ? "" : "s"} (needs ${PROMOTE_MIN_OOS_TRADES} or more)`);
  if (bad) parts.push(`the out-of-sample result is not positive (${Number.isFinite(net) ? `${net}%` : "unknown"})`);
  return { validated: false, why: `Not validated: ${parts.join(" and ")}.` };
}

let ready = false;
async function ensure(db: D1Database) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS strategy_promotions (
    id TEXT PRIMARY KEY, user TEXT NOT NULL, strategy_id TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL, direction TEXT NOT NULL,
    params TEXT NOT NULL, commission_pct REAL NOT NULL DEFAULT 0, in_sample TEXT NOT NULL, out_sample TEXT NOT NULL, total TEXT NOT NULL,
    validated INTEGER NOT NULL DEFAULT 0, why TEXT, status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT)`).run();
  ready = true;
}

type Row = Omit<Promotion, "params" | "in_sample" | "out_sample" | "total" | "validated"> & { params: string; in_sample: string; out_sample: string; total: string; validated: number };
const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const EMPTY: Part = { net_pct: 0, trades: 0, win_rate: null, profit_factor: null, max_dd_pct: 0, avg_trade_pct: null };
const view = (r: Row): Promotion => ({ ...r, params: parse(r.params, {}), in_sample: parse(r.in_sample, EMPTY), out_sample: parse(r.out_sample, EMPTY), total: parse(r.total, { net_pct: 0, trades: 0, buy_hold_pct: 0, max_dd_pct: 0, profit_factor: null, bars: 0, from: 0, to: 0 }), validated: !!r.validated });

/** Every promotion on the desk, newest first (the list is shared: the admin decides on them). */
export async function listPromoted(db: D1Database): Promise<{ rows: Promotion[]; min_oos_trades: number; note: string }> {
  await ensure(db);
  const { results } = await db.prepare("SELECT * FROM strategy_promotions ORDER BY created_at DESC LIMIT 200").all<Row>();
  return { rows: results.map(view), min_oos_trades: PROMOTE_MIN_OOS_TRADES, note: "Approving a rule records the decision only. It does not start any trading by itself." };
}

/** Store a freshly tested strategy as a proposed rule. `r` must come from runStrategy on the server, never from the browser. */
export async function addPromotion(db: D1Database, user: string, r: Result, symbol: string, interval: string): Promise<{ error?: string; promotion?: Promotion }> {
  await ensure(db);
  const params = JSON.stringify(r.params || {});
  const dup = await db.prepare("SELECT id FROM strategy_promotions WHERE strategy_id = ? AND symbol = ? AND interval = ? AND direction = ? AND params = ? AND status != 'rejected' LIMIT 1")
    .bind(r.id, symbol, interval, r.direction, params).first<{ id: string }>();
  if (dup) return { error: "This exact strategy, symbol, bar size, direction and settings is already on the promoted list." };
  const count = await db.prepare("SELECT COUNT(*) AS n FROM strategy_promotions").first<{ n: number }>();
  if ((count?.n ?? 0) >= 200) return { error: "The promoted list is full (200). Remove old entries first." };
  const v = validatePromotion(r.out_sample), id = crypto.randomUUID().replace(/-/g, "").slice(0, 16), now = Math.floor(Date.now() / 1000);
  const total = { net_pct: r.net_pct, trades: r.trades, buy_hold_pct: r.buy_hold_pct, max_dd_pct: r.max_dd_pct, profit_factor: r.profit_factor, bars: r.bars, from: r.from, to: r.to };
  await db.prepare(`INSERT INTO strategy_promotions (id, user, strategy_id, name, symbol, interval, direction, params, commission_pct, in_sample, out_sample, total, validated, why, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`)
    .bind(id, user, r.id, r.name, symbol, interval, r.direction, params, r.commission_pct, JSON.stringify(r.in_sample), JSON.stringify(r.out_sample), JSON.stringify(total), v.validated ? 1 : 0, v.why, now).run();
  const row = await db.prepare("SELECT * FROM strategy_promotions WHERE id = ?").bind(id).first<Row>();
  return { promotion: row ? view(row) : undefined };
}

/** Admin decision. A promotion that is not validated cannot be approved (the stored numbers are re-checked here). */
export async function decidePromotion(db: D1Database, id: string, action: "approve" | "reject", by: string): Promise<{ error?: string; promotion?: Promotion }> {
  await ensure(db);
  const row = await db.prepare("SELECT * FROM strategy_promotions WHERE id = ?").bind(id).first<Row>();
  if (!row) return { error: "No such promoted strategy." };
  const p = view(row);
  if (action === "approve") {
    const v = validatePromotion(p.out_sample);
    if (!p.validated || !v.validated) return { error: `Cannot approve: ${v.validated ? "this promotion is marked not validated." : v.why.replace(/^Not validated: /, "")}` };
  }
  await db.prepare("UPDATE strategy_promotions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?").bind(action === "approve" ? "approved" : "rejected", Math.floor(Date.now() / 1000), by, id).run();
  const next = await db.prepare("SELECT * FROM strategy_promotions WHERE id = ?").bind(id).first<Row>();
  return { promotion: next ? view(next) : undefined };
}

export async function removePromotion(db: D1Database, id: string): Promise<void> {
  await ensure(db);
  await db.prepare("DELETE FROM strategy_promotions WHERE id = ?").bind(id).run();
}
