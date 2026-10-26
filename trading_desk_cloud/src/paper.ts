// Paper trading: simulated accounts per user, bracket orders (entry + stop-loss + take-profit),
// and an engine that fills them against 1-minute bars. No real broker is involved anywhere.
import { candles } from "./market";
import { nyNow, isTradingDay } from "./briefs";

export type Side = "long" | "short";
export type OrderType = "market" | "limit" | "stop";

export type PaperSettings = {
  auto_trade: boolean;          // place orders automatically from finished scan recommendations
  auto_min_score: number;       // only picks with score >= this
  auto_max_positions: number;   // open positions + working orders cap
  auto_valid_min: number;       // auto entry orders expire after N minutes
  sizing: "risk" | "rec" | "fixed";
  risk_pct: number;             // sizing=risk: % of equity risked per trade (entry→stop)
  fixed_usd: number;            // sizing=fixed: dollars per trade
  max_position_pct: number;     // cap any position at this % of equity
  target: "t1" | "t2";          // which recommendation target becomes the take-profit
  commission: number;           // $ per fill
  auto_flat: boolean;           // close everything at 15:55 New York time
};
export const DEFAULT_PAPER: PaperSettings = {
  auto_trade: false, auto_min_score: 70, auto_max_positions: 5, auto_valid_min: 120,
  sizing: "risk", risk_pct: 1, fixed_usd: 2000, max_position_pct: 25, target: "t1", commission: 0, auto_flat: true,
};

type Account = { user: string; starting_cash: number; cash: number; settings: string; created_at: string };
type Order = {
  id: string; user: string; symbol: string; side: Side; type: OrderType; price: number | null; qty: number;
  stop: number | null; target: number | null; status: string; source: string; brief_id: string | null; note: string | null;
  day: string; created_at: number; last_checked: number; filled_at: number | null; fill_price: number | null; reason: string | null;
};
type Position = {
  id: string; user: string; symbol: string; side: Side; qty: number; entry: number; stop: number | null; target: number | null;
  status: string; source: string; note: string | null; opened_at: number; last_checked: number; closed_at: number | null;
  exit: number | null; exit_reason: string | null; pnl: number | null; fees: number; day_opened: string; day_closed: string | null; order_id: string | null;
};
type Bar = { time: number; open: number; high: number; low: number; close: number };

const nowS = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);
const r2 = (n: number) => Math.round(n * 100) / 100;
const sign = (s: Side) => (s === "long" ? 1 : -1);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

let ready = false;
export async function ensurePaper(db: D1Database) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_accounts (user TEXT PRIMARY KEY, starting_cash REAL NOT NULL, cash REAL NOT NULL,
      settings TEXT, created_at TEXT DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_orders (id TEXT PRIMARY KEY, user TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
      type TEXT NOT NULL, price REAL, qty INTEGER NOT NULL, stop REAL, target REAL, status TEXT NOT NULL, source TEXT NOT NULL,
      brief_id TEXT, note TEXT, day TEXT NOT NULL, created_at INTEGER NOT NULL, last_checked INTEGER NOT NULL,
      filled_at INTEGER, fill_price REAL, reason TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS paper_positions (id TEXT PRIMARY KEY, user TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
      qty INTEGER NOT NULL, entry REAL NOT NULL, stop REAL, target REAL, status TEXT NOT NULL, source TEXT NOT NULL, note TEXT,
      opened_at INTEGER NOT NULL, last_checked INTEGER NOT NULL, closed_at INTEGER, exit REAL, exit_reason TEXT, pnl REAL,
      fees REAL NOT NULL DEFAULT 0, day_opened TEXT NOT NULL, day_closed TEXT, order_id TEXT)`),
    db.prepare("CREATE INDEX IF NOT EXISTS paper_orders_status ON paper_orders (status, user)"),
    db.prepare("CREATE INDEX IF NOT EXISTS paper_positions_status ON paper_positions (status, user)"),
  ]);
  try { await db.prepare("ALTER TABLE briefs ADD COLUMN auto_done INTEGER").run(); } catch { /* exists or briefs not yet created */ }
  ready = true;
}

export function sanitizePaperSettings(x: unknown, base: PaperSettings = DEFAULT_PAPER): PaperSettings {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const s = { ...base };
  const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = num(v); return n === null ? d : Math.min(hi, Math.max(lo, n)); };
  if ("auto_trade" in o) s.auto_trade = o.auto_trade === true;
  if ("auto_flat" in o) s.auto_flat = o.auto_flat !== false;
  if ("auto_min_score" in o) s.auto_min_score = clamp(o.auto_min_score, 0, 100, s.auto_min_score);
  if ("auto_max_positions" in o) s.auto_max_positions = Math.round(clamp(o.auto_max_positions, 1, 20, s.auto_max_positions));
  if ("auto_valid_min" in o) s.auto_valid_min = Math.round(clamp(o.auto_valid_min, 5, 390, s.auto_valid_min));
  if (o.sizing === "risk" || o.sizing === "rec" || o.sizing === "fixed") s.sizing = o.sizing;
  if ("risk_pct" in o) s.risk_pct = clamp(o.risk_pct, 0.05, 10, s.risk_pct);
  if ("fixed_usd" in o) s.fixed_usd = clamp(o.fixed_usd, 10, 10_000_000, s.fixed_usd);
  if ("max_position_pct" in o) s.max_position_pct = clamp(o.max_position_pct, 1, 100, s.max_position_pct);
  if (o.target === "t1" || o.target === "t2") s.target = o.target;
  if ("commission" in o) s.commission = clamp(o.commission, 0, 100, s.commission);
  return s;
}

export async function getAccount(db: D1Database, user: string): Promise<Account & { s: PaperSettings }> {
  await ensurePaper(db);
  let a = await db.prepare("SELECT * FROM paper_accounts WHERE user = ?").bind(user).first<Account>();
  if (!a) {
    await db.prepare("INSERT OR IGNORE INTO paper_accounts (user, starting_cash, cash, settings) VALUES (?, 10000, 10000, ?)").bind(user, JSON.stringify(DEFAULT_PAPER)).run();
    a = (await db.prepare("SELECT * FROM paper_accounts WHERE user = ?").bind(user).first<Account>())!;
  }
  let s = DEFAULT_PAPER;
  try { s = sanitizePaperSettings(JSON.parse(a.settings || "{}")); } catch { /* defaults */ }
  return { ...a, s };
}

async function barsFor(symbol: string): Promise<Bar[]> {
  const all = await candles(symbol, "1m");
  const cutoff = nowS() - 60; // only completed minutes
  return all.filter((b) => b.time <= cutoff);
}
export async function lastPrice(symbol: string): Promise<number> {
  const all = await candles(symbol, "1m");
  const last = all.at(-1);
  if (!last) throw new Error(`No price for ${symbol}`);
  return last.close;
}

// --------------------------------------------------------------------------------------- orders
export type OrderInput = {
  symbol: string; side: Side; type: OrderType; price?: number | null; qty?: number | null; amount_usd?: number | null;
  stop?: number | null; target?: number | null; note?: string | null; source?: "manual" | "auto"; brief_id?: string | null;
};

export async function placeOrder(db: D1Database, user: string, inp: OrderInput): Promise<{ order?: Order; position?: Position; error?: string }> {
  const acct = await getAccount(db, user);
  const symbol = String(inp.symbol || "").toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return { error: "Bad symbol" };
  const side: Side = inp.side === "short" ? "short" : "long";
  const type: OrderType = inp.type === "limit" || inp.type === "stop" ? inp.type : "market";
  const stop = num(inp.stop), target = num(inp.target);
  let price = num(inp.price);
  let last: number;
  try { last = await lastPrice(symbol); } catch (e) { return { error: (e as Error).message } }
  if (type !== "market" && !(price && price > 0)) return { error: "Limit/stop orders need a price." };
  const ref = type === "market" ? last : price!;
  let qty = num(inp.qty);
  if (!qty && num(inp.amount_usd)) qty = Math.floor(num(inp.amount_usd)! / ref);
  qty = qty ? Math.floor(qty) : 0;
  if (qty < 1) return { error: "Quantity must be at least 1 share." };
  if (stop !== null && (side === "long" ? stop >= ref : stop <= ref)) return { error: `Stop-loss must be ${side === "long" ? "below" : "above"} the entry price (${r2(ref)}).` };
  if (target !== null && (side === "long" ? target <= ref : target >= ref)) return { error: `Take-profit must be ${side === "long" ? "above" : "below"} the entry price (${r2(ref)}).` };
  if (type === "limit" && (side === "long" ? price! > last * 1.02 : price! < last * 0.98))
    return { error: `A ${side} limit that far through the market (${r2(last)}) would fill at once; use a market order or a stop order.` };
  const need = qty * ref + acct.s.commission;
  if (need > acct.cash + 1e-6) return { error: `Not enough paper cash: need $${r2(need)}, have $${r2(acct.cash)}.` };

  const t = nowS(), ny = nyNow();
  const order: Order = {
    id: uid(), user, symbol, side, type, price: type === "market" ? null : price, qty, stop, target, status: "open",
    source: inp.source ?? "manual", brief_id: inp.brief_id ?? null, note: (inp.note ?? "").slice(0, 300) || null, day: ny.date,
    created_at: t, last_checked: Math.floor(t / 60) * 60 + 60, filled_at: null, fill_price: null, reason: null,
  };
  await db.prepare(`INSERT INTO paper_orders (id,user,symbol,side,type,price,qty,stop,target,status,source,brief_id,note,day,created_at,last_checked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(order.id, user, symbol, side, type, order.price, qty, stop, target, "open",
    order.source, order.brief_id, order.note, order.day, t, order.last_checked).run();
  if (type === "market") {
    const position = await fill(db, order, last, t);
    return position ? { order: { ...order, status: "filled", fill_price: last }, position } : { error: "Fill rejected (cash changed)." };
  }
  return { order };
}

/** Turn a working order into a position. Guarded so an order can only fill once. */
async function fill(db: D1Database, o: Order, price: number, at: number): Promise<Position | null> {
  const acct = await getAccount(db, o.user);
  const cost = o.qty * price + acct.s.commission;
  const upd = await db.prepare("UPDATE paper_orders SET status = 'filled', filled_at = ?, fill_price = ? WHERE id = ? AND status = 'open'").bind(at, price, o.id).run();
  if (!upd.meta.changes) return null;
  const cash = await db.prepare("UPDATE paper_accounts SET cash = cash - ? WHERE user = ? AND cash >= ?").bind(cost, o.user, cost).run();
  if (!cash.meta.changes) {
    await db.prepare("UPDATE paper_orders SET status = 'rejected', reason = 'not enough cash at fill' WHERE id = ?").bind(o.id).run();
    return null;
  }
  const p: Position = {
    id: uid(), user: o.user, symbol: o.symbol, side: o.side, qty: o.qty, entry: price, stop: o.stop, target: o.target, status: "open",
    source: o.source, note: o.note, opened_at: at, last_checked: Math.floor(at / 60) * 60 + 60, closed_at: null, exit: null, exit_reason: null,
    pnl: null, fees: acct.s.commission, day_opened: nyNow(new Date(at * 1000)).date, day_closed: null, order_id: o.id,
  };
  await db.prepare(`INSERT INTO paper_positions (id,user,symbol,side,qty,entry,stop,target,status,source,note,opened_at,last_checked,fees,day_opened,order_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(p.id, p.user, p.symbol, p.side, p.qty, p.entry, p.stop, p.target, "open", p.source, p.note,
    p.opened_at, p.last_checked, p.fees, p.day_opened, p.order_id).run();
  return p;
}

/** Close a position (manual, stop, target or end of day). Guarded so it can only close once. */
async function closePos(db: D1Database, p: Position, price: number, reason: string, at = nowS()) {
  const acct = await getAccount(db, p.user);
  const fees = p.fees + acct.s.commission;
  const gross = (price - p.entry) * p.qty * sign(p.side);
  const pnl = r2(gross - fees);
  const upd = await db.prepare(`UPDATE paper_positions SET status = 'closed', closed_at = ?, exit = ?, exit_reason = ?, pnl = ?, fees = ?, day_closed = ?
    WHERE id = ? AND status = 'open'`).bind(at, price, reason, pnl, fees, nyNow(new Date(at * 1000)).date, p.id).run();
  if (!upd.meta.changes) return false;
  await db.prepare("UPDATE paper_accounts SET cash = cash + ? WHERE user = ?").bind(p.qty * p.entry + gross - acct.s.commission, p.user).run();
  return true;
}

export async function cancelOrder(db: D1Database, user: string, id: string) {
  const r = await db.prepare("UPDATE paper_orders SET status = 'cancelled', reason = 'by user' WHERE id = ? AND user = ? AND status = 'open'").bind(id, user).run();
  return !!r.meta.changes;
}

export async function closePosition(db: D1Database, user: string, id: string) {
  const p = await db.prepare("SELECT * FROM paper_positions WHERE id = ? AND user = ? AND status = 'open'").bind(id, user).first<Position>();
  if (!p) return { error: "Position not found or already closed." };
  const price = await lastPrice(p.symbol);
  return (await closePos(db, p, price, "manual")) ? { ok: true, price } : { error: "Already closed." };
}

export async function updatePosition(db: D1Database, user: string, id: string, stop: number | null, target: number | null) {
  const p = await db.prepare("SELECT * FROM paper_positions WHERE id = ? AND user = ? AND status = 'open'").bind(id, user).first<Position>();
  if (!p) return "Position not found.";
  const last = await lastPrice(p.symbol);
  if (stop !== null && (p.side === "long" ? stop >= last : stop <= last)) return `Stop must be ${p.side === "long" ? "below" : "above"} the current price (${r2(last)}).`;
  if (target !== null && (p.side === "long" ? target <= last : target >= last)) return `Target must be ${p.side === "long" ? "above" : "below"} the current price (${r2(last)}).`;
  await db.prepare("UPDATE paper_positions SET stop = ?, target = ? WHERE id = ?").bind(stop, target, id).run();
  return null;
}

export async function resetAccount(db: D1Database, user: string, startingCash: number) {
  await getAccount(db, user);
  await db.batch([
    db.prepare("DELETE FROM paper_orders WHERE user = ?").bind(user),
    db.prepare("DELETE FROM paper_positions WHERE user = ?").bind(user),
    db.prepare("UPDATE paper_accounts SET starting_cash = ?, cash = ? WHERE user = ?").bind(startingCash, startingCash, user),
  ]);
}

// --------------------------------------------------------------------------------------- engine
/** Check every working order and open position against 1-minute bars. Runs every minute (cron) and on page loads. */
export async function runEngine(db: D1Database, onlyUser?: string) {
  await ensurePaper(db);
  const where = onlyUser ? " AND user = ?" : "";
  const bind = onlyUser ? [onlyUser] : [];
  const orders = (await db.prepare(`SELECT * FROM paper_orders WHERE status = 'open'${where}`).bind(...bind).all<Order>()).results;
  const positions = (await db.prepare(`SELECT * FROM paper_positions WHERE status = 'open'${where}`).bind(...bind).all<Position>()).results;
  if (!orders.length && !positions.length) return;
  const ny = nyNow(), t = nowS();
  const symbols = [...new Set([...orders.map((o) => o.symbol), ...positions.map((p) => p.symbol)])];
  const bars = new Map<string, Bar[]>();
  await Promise.all(symbols.map(async (s) => { try { bars.set(s, await barsFor(s)); } catch { /* data hiccup: retry next run */ } }));
  const settings = new Map<string, PaperSettings>();
  const sOf = async (u: string) => { if (!settings.has(u)) settings.set(u, (await getAccount(db, u)).s); return settings.get(u)!; };

  for (const o of orders) {
    const s = await sOf(o.user);
    if (o.day < ny.date || (o.day === ny.date && ny.minutes >= 16 * 60)) {
      await db.prepare("UPDATE paper_orders SET status = 'expired', reason = 'day order expired' WHERE id = ? AND status = 'open'").bind(o.id).run(); continue;
    }
    if (o.source === "auto" && t > o.created_at + s.auto_valid_min * 60) {
      await db.prepare("UPDATE paper_orders SET status = 'expired', reason = 'auto entry not triggered in time' WHERE id = ? AND status = 'open'").bind(o.id).run(); continue;
    }
    const bs = (bars.get(o.symbol) || []).filter((b) => b.time >= o.last_checked);
    let filled: Position | null = null;
    for (const b of bs) {
      let px: number | null = null;
      if (o.type === "limit") {
        if (o.side === "long" && b.low <= o.price!) px = Math.min(o.price!, b.open);
        if (o.side === "short" && b.high >= o.price!) px = Math.max(o.price!, b.open);
      } else if (o.type === "stop") {
        if (o.side === "long" && b.high >= o.price!) px = Math.max(o.price!, b.open);
        if (o.side === "short" && b.low <= o.price!) px = Math.min(o.price!, b.open);
      }
      if (px !== null) {
        // If the bar already gapped through the bracket stop, the trade is invalid: cancel instead of filling.
        if (o.stop !== null && (o.side === "long" ? px <= o.stop : px >= o.stop)) {
          await db.prepare("UPDATE paper_orders SET status = 'cancelled', reason = 'price gapped through the stop' WHERE id = ? AND status = 'open'").bind(o.id).run();
          break;
        }
        filled = await fill(db, o, r2(px), b.time + 59);
        if (filled) positions.push(filled);
        break;
      }
    }
    if (!filled && bs.length) await db.prepare("UPDATE paper_orders SET last_checked = ? WHERE id = ? AND status = 'open'").bind(bs.at(-1)!.time + 60, o.id).run();
  }

  for (const p of positions) {
    if (p.status !== "open") continue;
    const s = await sOf(p.user);
    const bs = (bars.get(p.symbol) || []).filter((b) => b.time >= p.last_checked);
    let done = false;
    for (const b of bs) {
      // Conservative: if one bar touches both stop and target, assume the stop came first.
      if (p.stop !== null && (p.side === "long" ? b.low <= p.stop : b.high >= p.stop)) {
        const px = p.side === "long" ? Math.min(p.stop, b.open) : Math.max(p.stop, b.open);
        done = await closePos(db, p, r2(px), "stop", b.time + 59); break;
      }
      if (p.target !== null && (p.side === "long" ? b.high >= p.target : b.low <= p.target)) {
        const px = p.side === "long" ? Math.max(p.target, b.open) : Math.min(p.target, b.open);
        done = await closePos(db, p, r2(px), "target", b.time + 59); break;
      }
    }
    if (done) continue;
    if (s.auto_flat && isTradingDay(ny) && ny.minutes >= 15 * 60 + 55 && p.day_opened <= ny.date) {
      const last = bars.get(p.symbol)?.at(-1)?.close;
      if (last) { await closePos(db, p, last, "end of day"); continue; }
    }
    if (bs.length) await db.prepare("UPDATE paper_positions SET last_checked = ? WHERE id = ? AND status = 'open'").bind(bs.at(-1)!.time + 60, p.id).run();
  }
}

// --------------------------------------------------------------------------------------- auto-trading
type Pick = { symbol?: string; bias?: string; score?: number; entry?: number; stop?: number; targets?: number[]; size_shares?: number; setup?: string };

/** Place paper orders from finished briefs for every account with auto-trade on (once per brief). */
export async function autoTradeNewBriefs(db: D1Database) {
  await ensurePaper(db);
  const ny = nyNow();
  let briefs: { id: string; data: string | null; label: string }[] = [];
  try {
    briefs = (await db.prepare("SELECT id, data, label FROM briefs WHERE status = 'done' AND auto_done IS NULL AND day = ?").bind(ny.date).all<{ id: string; data: string | null; label: string }>()).results;
  } catch { return; }
  if (!briefs.length) return;
  for (const b of briefs) await db.prepare("UPDATE briefs SET auto_done = 1 WHERE id = ?").bind(b.id).run();
  if (!isTradingDay(ny) || ny.minutes >= 15 * 60 + 30) return; // too late to open day trades
  const accounts = (await db.prepare("SELECT * FROM paper_accounts").all<Account>()).results
    .map((a) => ({ ...a, s: sanitizePaperSettings(JSON.parse(a.settings || "{}")) })).filter((a) => a.s.auto_trade);
  for (const b of briefs) {
    let picks: Pick[] = [];
    try { picks = (JSON.parse(b.data || "{}")?.picks ?? []) as Pick[]; } catch { continue; }
    for (const a of accounts) await autoTradeAccount(db, a, picks, b);
  }
}

async function autoTradeAccount(db: D1Database, a: Account & { s: PaperSettings }, picks: Pick[], b: { id: string; label: string }) {
  const s = a.s;
  const openPos = (await db.prepare("SELECT symbol FROM paper_positions WHERE user = ? AND status = 'open'").bind(a.user).all<{ symbol: string }>()).results;
  const openOrd = (await db.prepare("SELECT symbol FROM paper_orders WHERE user = ? AND status = 'open'").bind(a.user).all<{ symbol: string }>()).results;
  const busy = new Set([...openPos, ...openOrd].map((x) => x.symbol));
  let slots = s.auto_max_positions - busy.size;
  const eq = await equityOf(db, a.user);
  for (const p of [...picks].sort((x, y) => (num(y.score) ?? 0) - (num(x.score) ?? 0))) {
    if (slots <= 0) break;
    const symbol = String(p.symbol || "").toUpperCase(), entry = num(p.entry), stop = num(p.stop);
    if (!symbol || busy.has(symbol) || entry === null || stop === null || (num(p.score) ?? 0) < s.auto_min_score) continue;
    const side: Side = /short/i.test(p.bias || "") ? "short" : "long";
    const targets = (p.targets || []).map(num).filter((x): x is number => x !== null);
    const target = (s.target === "t2" ? targets[1] : undefined) ?? targets[0] ?? null;
    const perShareRisk = Math.abs(entry - stop);
    let qty = s.sizing === "rec" ? num(p.size_shares) ?? 0 : s.sizing === "fixed" ? s.fixed_usd / entry : perShareRisk > 0 ? (eq * s.risk_pct / 100) / perShareRisk : 0;
    qty = Math.floor(Math.min(qty, (eq * s.max_position_pct / 100) / entry));
    if (qty < 1) continue;
    let last: number;
    try { last = await lastPrice(symbol); } catch { continue; }
    // Entry above the market (long) / below (short) is a breakout trigger -> stop order; otherwise a limit.
    const type: OrderType = side === "long" ? (entry > last ? "stop" : "limit") : (entry < last ? "stop" : "limit");
    const r = await placeOrder(db, a.user, { symbol, side, type, price: entry, qty, stop, target, source: "auto", brief_id: b.id, note: `${b.label}: ${p.setup ?? ""}`.slice(0, 300) });
    if (!r.error) { busy.add(symbol); slots--; }
  }
}

// --------------------------------------------------------------------------------------- reporting
async function equityOf(db: D1Database, user: string) {
  const a = await getAccount(db, user);
  const pos = (await db.prepare("SELECT * FROM paper_positions WHERE user = ? AND status = 'open'").bind(user).all<Position>()).results;
  let eq = a.cash;
  for (const p of pos) {
    let last = p.entry;
    try { last = await lastPrice(p.symbol); } catch { /* use entry */ }
    eq += p.qty * p.entry + (last - p.entry) * p.qty * sign(p.side);
  }
  return eq;
}

export async function summary(db: D1Database, user: string) {
  const a = await getAccount(db, user);
  const ny = nyNow();
  const pos = (await db.prepare("SELECT * FROM paper_positions WHERE user = ? AND status = 'open' ORDER BY opened_at DESC").bind(user).all<Position>()).results;
  const orders = (await db.prepare("SELECT * FROM paper_orders WHERE user = ? AND (status = 'open' OR created_at > ?) ORDER BY created_at DESC LIMIT 100").bind(user, nowS() - 3 * 86400).all<Order>()).results;
  const trades = (await db.prepare("SELECT * FROM paper_positions WHERE user = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 500").bind(user).all<Position>()).results;
  const daily = (await db.prepare(`SELECT day_closed AS day, ROUND(SUM(pnl), 2) AS pnl, COUNT(*) AS trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(MAX(pnl), 2) AS best, ROUND(MIN(pnl), 2) AS worst
      FROM paper_positions WHERE user = ? AND status = 'closed' GROUP BY day_closed ORDER BY day_closed`).bind(user).all<{ day: string; pnl: number; trades: number; wins: number; losses: number; best: number; worst: number }>()).results;

  let unreal = 0, invested = 0;
  const positions = await Promise.all(pos.map(async (p) => {
    let last: number | null = null;
    try { last = await lastPrice(p.symbol); } catch { /* unknown */ }
    const u = last === null ? 0 : (last - p.entry) * p.qty * sign(p.side);
    unreal += u; invested += p.qty * p.entry;
    return { ...p, last, unrealized: r2(u), unrealized_pct: last === null ? null : r2(((last - p.entry) / p.entry) * 100 * sign(p.side)) };
  }));
  const realized = r2(daily.reduce((x, d) => x + d.pnl, 0));
  const equity = r2(a.cash + invested + unreal);
  let running = a.starting_cash;
  const curve = daily.map((d) => ({ day: d.day, equity: r2((running += d.pnl)) }));
  const today = daily.find((d) => d.day === ny.date);
  const closedAll = trades.length, wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  return {
    account: {
      user, starting_cash: a.starting_cash, cash: r2(a.cash), equity, invested: r2(invested), unrealized: r2(unreal), realized,
      total_pnl: r2(equity - a.starting_cash), total_pct: r2(((equity - a.starting_cash) / a.starting_cash) * 100),
      today_realized: today?.pnl ?? 0, today_trades: today?.trades ?? 0, win_rate: closedAll ? r2((wins / closedAll) * 100) : null, trades: closedAll,
    },
    settings: a.s, positions, orders, trades, daily, curve, ny_date: ny.date,
  };
}
