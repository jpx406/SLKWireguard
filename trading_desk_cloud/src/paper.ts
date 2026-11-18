// Paper trading: simulated accounts per user, bracket orders (entry + stop-loss + take-profit),
// and an engine that fills them against 1-minute bars. No real broker is involved anywhere.
import { candles, isCrypto, latestPrice } from "./market";
import { activeRules, ruleBlocks } from "./strategy";
import { kellyRead, marketRegime, riskLog, type RegimeRead } from "./risk";
import { clockNow, nyNow, isTradingDay, inSession, marketPhase, orderDay, sessionTimes, nextTradingDate } from "./briefs";
import { applyExit, dailyAtr, edgeStatus, exitPolicy, type ExitPolicy, type Horizon } from "./exits";
import { deskConfig, entryTypeOf, sourceOf, SOURCE_LABEL, type DeskConfig, type EntryType } from "./deskcfg";

export type Side = "long" | "short";
/** "stop" only exists on rows from older versions; it is now handled exactly like a limit. */
export type OrderType = "market" | "limit" | "stop";
/** eod = close 5 min before the regular close (or before the after-hours end for trades opened after the bell); hold = keep (overnight too) until the stop-loss or take-profit is hit, or you close it. */
export type ExitMode = "eod" | "hold";

export type PaperSettings = {
  auto_trade: boolean;          // place orders automatically from finished scan recommendations
  auto_min_score: number;       // only picks with score >= this
  auto_max_positions: number;   // open positions + working orders cap
  auto_valid_min: number;       // auto entry orders expire after N minutes
  sizing: "risk" | "rec" | "fixed" | "kelly"; // kelly = quarter Kelly from the desk's own settled plans (capped at 2%), else risk_pct
  risk_pct: number;             // sizing=risk: % of equity risked per trade (entry→stop)
  fixed_usd: number;            // sizing=fixed: dollars per trade
  max_position_pct: number;     // cap any position at this % of equity
  target: "t1" | "t2";          // which recommendation target becomes the take-profit
  commission: number;           // $ per fill
  auto_flat: boolean;           // default exit for new trades: true = close at 15:55 New York, false = hold until stop/target
  // Per-user triggers: which recommendations this account trades automatically.
  auto_slots: string[];         // scans that trigger auto-trades ([] = every scan)
  auto_side: "both" | "long" | "short";
  auto_min_rr: number;          // reward:risk to the chosen target (0 = any)
  auto_min_price: number;       // skip stocks under this price (0 = any)
  auto_blocked: string[];       // never auto-trade these symbols
  auto_start: string;           // auto entries only between these New York times
  auto_end: string;
  auto_max_trades_day: number;  // auto entries per day
  auto_max_daily_loss: number;  // stop auto entries once today's P&L is down this many $ (0 = off)
  // Hard risk layer (risk.ts): code decides, the AI only suggests.
  kill_switch: boolean;         // true = no automatic entries; turning it on flattens the account
  kill_reason: string;          // why it tripped (manual, or the drawdown guard)
  max_drawdown_pct: number;     // equity this far below its peak trips the kill switch (0 = off)
  regime_sizing: boolean;       // scale automatic sizes by the market regime (CRASH = no entries)
};
export const DEFAULT_PAPER: PaperSettings = {
  auto_trade: false, auto_min_score: 70, auto_max_positions: 5, auto_valid_min: 120,
  sizing: "risk", risk_pct: 1, fixed_usd: 2000, max_position_pct: 25, target: "t1", commission: 0, auto_flat: true,
  auto_slots: [], auto_side: "both", auto_min_rr: 0, auto_min_price: 0, auto_blocked: [],
  auto_start: "07:00", auto_end: "15:30", auto_max_trades_day: 10, auto_max_daily_loss: 0,
  kill_switch: false, kill_reason: "", max_drawdown_pct: 15, regime_sizing: true,
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

type Account = { user: string; starting_cash: number; cash: number; settings: string; created_at: string };
type Order = {
  id: string; user: string; symbol: string; side: Side; type: OrderType; price: number | null; qty: number;
  stop: number | null; target: number | null; status: string; source: string; brief_id: string | null; note: string | null;
  day: string; created_at: number; last_checked: number; filled_at: number | null; fill_price: number | null; reason: string | null;
  exit_mode: ExitMode | null; entry_type?: EntryType | null; client_id?: string | null; src?: string | null; trail?: number | null; hold_days?: number | null; chase?: number | null;
};
type Position = {
  id: string; user: string; symbol: string; side: Side; qty: number; entry: number; stop: number | null; target: number | null;
  status: string; source: string; note: string | null; opened_at: number; last_checked: number; closed_at: number | null;
  exit: number | null; exit_reason: string | null; pnl: number | null; fees: number; day_opened: string; day_closed: string | null; order_id: string | null;
  exit_mode: ExitMode | null; close_req?: number | null;
  src?: string | null; init_stop?: number | null; qty0?: number | null; scaled?: number | null; best?: number | null; realized?: number | null; trail?: number | null; hold_days?: number | null;
};
type Bar = { time: number; open: number; high: number; low: number; close: number };

const nowS = () => Math.floor(clockNow().getTime() / 1000);
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
  // Added later: per-trade exit mode (older rows follow the account default).
  for (const t of ["paper_orders", "paper_positions"]) { try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN exit_mode TEXT`).run(); } catch { /* exists */ } }
  // Added later: a sell requested while the market is closed executes at the next session's first trade.
  try { await db.prepare("ALTER TABLE paper_positions ADD COLUMN close_req INTEGER").run(); } catch { /* exists */ }
  try { await db.prepare("ALTER TABLE paper_accounts ADD COLUMN peak_equity REAL").run(); } catch { /* exists */ }
  // Added with the order-engine rework: how the entry is reached, an id that makes an order unrepeatable, which part
  // of the desk placed it, and what the scale-out exit needs to remember.
  for (const c of ["entry_type TEXT", "client_id TEXT", "src TEXT", "trail REAL", "hold_days INTEGER", "chase REAL"]) { try { await db.prepare(`ALTER TABLE paper_orders ADD COLUMN ${c}`).run(); } catch { /* exists */ } }
  for (const c of ["src TEXT", "init_stop REAL", "qty0 REAL", "scaled INTEGER", "best REAL", "realized REAL", "trail REAL", "hold_days INTEGER"]) { try { await db.prepare(`ALTER TABLE paper_positions ADD COLUMN ${c}`).run(); } catch { /* exists */ } }
  try { await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS paper_orders_client ON paper_orders (user, client_id) WHERE client_id IS NOT NULL").run(); } catch { /* older duplicates: the lookup in placeOrder still guards */ }
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
  if (o.sizing === "risk" || o.sizing === "rec" || o.sizing === "fixed" || o.sizing === "kelly") s.sizing = o.sizing;
  if ("kill_switch" in o) s.kill_switch = o.kill_switch === true;
  if (typeof o.kill_reason === "string") s.kill_reason = o.kill_reason.slice(0, 200);
  if ("max_drawdown_pct" in o) s.max_drawdown_pct = clamp(o.max_drawdown_pct, 0, 90, s.max_drawdown_pct);
  if ("regime_sizing" in o) s.regime_sizing = o.regime_sizing !== false;
  if ("risk_pct" in o) s.risk_pct = clamp(o.risk_pct, 0.05, 10, s.risk_pct);
  if ("fixed_usd" in o) s.fixed_usd = clamp(o.fixed_usd, 10, 10_000_000, s.fixed_usd);
  if ("max_position_pct" in o) s.max_position_pct = clamp(o.max_position_pct, 1, 100, s.max_position_pct);
  if (o.target === "t1" || o.target === "t2") s.target = o.target;
  if ("commission" in o) s.commission = clamp(o.commission, 0, 100, s.commission);
  if (Array.isArray(o.auto_slots)) s.auto_slots = [...new Set(o.auto_slots.map(String).filter((x) => /^[a-z]{2,20}$/.test(x)))].slice(0, 20);
  if (o.auto_side === "both" || o.auto_side === "long" || o.auto_side === "short") s.auto_side = o.auto_side;
  if ("auto_min_rr" in o) s.auto_min_rr = clamp(o.auto_min_rr, 0, 20, s.auto_min_rr);
  if ("auto_min_price" in o) s.auto_min_price = clamp(o.auto_min_price, 0, 100_000, s.auto_min_price);
  if (Array.isArray(o.auto_blocked)) s.auto_blocked = [...new Set(o.auto_blocked.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9.\-]{1,15}$/.test(x)))].slice(0, 200);
  if (typeof o.auto_start === "string" && HHMM.test(o.auto_start)) s.auto_start = o.auto_start;
  if (typeof o.auto_end === "string" && HHMM.test(o.auto_end)) s.auto_end = o.auto_end;
  if ("auto_max_trades_day" in o) s.auto_max_trades_day = Math.round(clamp(o.auto_max_trades_day, 1, 100, s.auto_max_trades_day));
  if ("auto_max_daily_loss" in o) s.auto_max_daily_loss = clamp(o.auto_max_daily_loss, 0, 100_000_000, s.auto_max_daily_loss);
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
  const cutoff = nowS() - 60; // only completed minutes, and only trades inside our sessions (07:00-20:00 New York); crypto trades 24/7
  return all.filter((b) => b.time <= cutoff && (isCrypto(symbol) || inSession(b.time)));
}
export const lastPrice = latestPrice;

// --------------------------------------------------------------------------------------- orders
export type OrderInput = {
  symbol: string; side: Side; type: OrderType; price?: number | null; qty?: number | null; amount_usd?: number | null;
  stop?: number | null; target?: number | null; note?: string | null; source?: "manual" | "auto" | "chart" | "tv"; brief_id?: string | null;
  exit_mode?: ExitMode | null;
  entry_type?: EntryType | null;   // automatic paths only: limit (most to pay), stop (trade through the trigger), stop_on_close (a bar must close beyond it)
  client_id?: string | null;       // the same id is accepted once per account: a repeated signal cannot fill twice
  src?: string | null;             // routine | copy | chart_signal | chart_plan | deep | strategy
  trail?: number | null;           // scale-out exit: distance of the trailing stop once half is off
  hold_days?: number | null;       // sessions before a held trade is closed at the market
  atr?: number | null;             // ATR used for the "max chase" check
};

export async function placeOrder(db: D1Database, user: string, inp: OrderInput): Promise<{ order?: Order; position?: Position; error?: string }> {
  const acct = await getAccount(db, user);
  const symbol = String(inp.symbol || "").toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return { error: "Bad symbol" };
  const side: Side = inp.side === "short" ? "short" : "long";
  // The entry price is the most you pay on a buy (the least you accept on a short). If the market is already
  // at or better than it, the order fills now at the market price; otherwise it waits for the price to come to it.
  const type: OrderType = inp.type === "limit" || inp.type === "stop" ? "limit" : "market";
  const source = inp.source ?? "manual", auto = source !== "manual", cfg = await deskConfig(db);
  const src = inp.src || sourceOf({ source, note: inp.note });
  // Breakout entries exist for the automatic paths only; an order you place by hand keeps "entry = the most to pay".
  const etype: EntryType = auto && type !== "market" && (inp.entry_type === "stop" || inp.entry_type === "stop_on_close") ? inp.entry_type : "limit";
  const stop = num(inp.stop), target = num(inp.target);
  let price = num(inp.price);
  let last: number;
  try { last = await lastPrice(symbol); } catch (e) { return { error: (e as Error).message } }
  if (type !== "market" && !(price && price > 0)) return { error: "Limit orders need an entry price." };
  const beyond = type !== "market" && (side === "long" ? last >= price! : last <= price!); // already through a breakout trigger
  if (etype === "stop" && beyond && inp.atr && Math.abs(last - price!) > cfg.max_chase_atr * inp.atr) return { error: `Price (${r2(last)}) is already more than ${cfg.max_chase_atr} × ATR past the trigger (${r2(price!)}): not chasing.` };
  const marketable = type === "market" || (etype === "limit" ? (side === "long" ? last <= price! : last >= price!) : etype === "stop" && beyond);
  const ref = marketable ? last : price!;
  // Automatic entries pass the one risk gate and may not repeat the same signal.
  const clientId = inp.client_id ? String(inp.client_id).slice(0, 120) : auto ? `${symbol}:${Math.floor(nowS() / 60)}:${src}:${side}` : null;
  if (clientId) { const dup = await db.prepare("SELECT id FROM paper_orders WHERE user = ? AND client_id = ? LIMIT 1").bind(user, clientId).first(); if (dup) { await riskLog(db, user, symbol, "duplicate", `duplicate order rejected (${clientId})`); return { error: "Duplicate order: this signal already placed one." }; } }
  if (auto) { const g = await entryLimits(db, user, symbol, src, cfg, inp.exit_mode === "hold"); if (!g.ok) return { error: `Risk gate: ${g.reason}` }; }
  let qty = num(inp.qty);
  // Crypto trades in fractions (6 decimals, at least $1 of notional); stocks in whole shares.
  const crypto = isCrypto(symbol);
  if (!qty && num(inp.amount_usd)) qty = crypto ? num(inp.amount_usd)! / ref : Math.floor(num(inp.amount_usd)! / ref);
  qty = qty ? (crypto ? Math.round(qty * 1e6) / 1e6 : Math.floor(qty)) : 0;
  if (crypto ? qty * ref < 1 : qty < 1) return { error: crypto ? "Quantity must be worth at least $1." : "Quantity must be at least 1 share." };
  const at = marketable ? `the market price (${r2(ref)}), where this order fills now` : `the entry price (${r2(ref)})`;
  if (stop !== null && (side === "long" ? stop >= ref : stop <= ref)) return { error: `Stop-loss must be ${side === "long" ? "below" : "above"} ${at}.` };
  if (target !== null && (side === "long" ? target <= ref : target >= ref)) return { error: `Take-profit must be ${side === "long" ? "above" : "below"} ${at}.` };
  const need = qty * ref + acct.s.commission + cfg.commission_per_share * qty;
  if (need > acct.cash + 1e-6) return { error: `Not enough paper cash: need $${r2(need)}, have $${r2(acct.cash)}.` };

  const exitMode: ExitMode = inp.exit_mode === "eod" || inp.exit_mode === "hold" ? inp.exit_mode : acct.s.auto_flat ? "eod" : "hold";
  const t = nowS(), ny = nyNow();
  // Orders work in pre-market, regular and after-hours sessions. Placed while the market is closed,
  // they belong to the next session (a market order then fills at its first trade).
  const closed = marketPhase(ny) === "closed";
  const order: Order = {
    id: uid(), user, symbol, side, type, price: type === "market" ? null : price, qty, stop, target, status: "open",
    source, brief_id: inp.brief_id ?? null, note: (inp.note ?? "").slice(0, 300) || null, day: orderDay(ny),
    created_at: t, last_checked: Math.floor(t / 60) * 60 + 60, filled_at: null, fill_price: null, reason: null, exit_mode: exitMode,
    entry_type: etype, client_id: clientId, src, trail: num(inp.trail), hold_days: num(inp.hold_days), chase: inp.atr ? cfg.max_chase_atr * inp.atr : null,
  };
  try {
    await db.prepare(`INSERT INTO paper_orders (id,user,symbol,side,type,price,qty,stop,target,status,source,brief_id,note,day,created_at,last_checked,exit_mode,entry_type,client_id,src,trail,hold_days,chase)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(order.id, user, symbol, side, type, order.price, qty, stop, target, "open",
      order.source, order.brief_id, order.note, order.day, t, order.last_checked, exitMode, etype, clientId, src, order.trail ?? null, order.hold_days ?? null, order.chase ?? null).run();
  } catch (e) { if (/UNIQUE/i.test(String((e as Error).message))) return { error: "Duplicate order: this signal already placed one." }; throw e; }
  // An automatic order fills at once only against a price that is actually trading: on a stale quote it rests and the
  // engine fills it from real bars. (This is what produced round trips at identical prices in thin after-hours.)
  if (marketable && !closed && (!auto || (await freshness(symbol, cfg.max_bar_age_min)).fresh)) {
    const position = await fill(db, order, last, t);
    return position ? { order: { ...order, status: "filled", fill_price: last }, position } : { error: "Fill rejected (cash changed)." };
  }
  return { order };
}

/** Turn a working order into a position. Guarded so an order can only fill once. */
async function fill(db: D1Database, o: Order, price: number, at: number): Promise<Position | null> {
  const acct = await getAccount(db, o.user), perShare = (await deskConfig(db)).commission_per_share * o.qty;
  const cost = o.qty * price + acct.s.commission + perShare;
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
    pnl: null, fees: acct.s.commission + perShare, day_opened: nyNow(new Date(at * 1000)).date, day_closed: null, order_id: o.id,
    exit_mode: o.exit_mode ?? (acct.s.auto_flat ? "eod" : "hold"),
    src: o.src ?? sourceOf(o), init_stop: o.stop, qty0: o.qty, scaled: 0, best: price, realized: 0, trail: o.trail ?? null, hold_days: o.hold_days ?? null,
  };
  await db.prepare(`INSERT INTO paper_positions (id,user,symbol,side,qty,entry,stop,target,status,source,note,opened_at,last_checked,fees,day_opened,order_id,exit_mode,src,init_stop,qty0,scaled,best,realized,trail,hold_days)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(p.id, p.user, p.symbol, p.side, p.qty, p.entry, p.stop, p.target, "open", p.source, p.note,
    p.opened_at, p.last_checked, p.fees, p.day_opened, p.order_id, p.exit_mode, p.src, p.init_stop, p.qty0, 0, price, 0, p.trail ?? null, p.hold_days ?? null).run();
  return p;
}

/** Close a position (manual, stop, target or end of day). Guarded so it can only close once. */
async function closePos(db: D1Database, p: Position, price: number, reason: string, at = nowS()) {
  const acct = await getAccount(db, p.user), out = acct.s.commission + (await deskConfig(db)).commission_per_share * p.qty;
  const fees = p.fees + out;
  const gross = (price - p.entry) * p.qty * sign(p.side);
  const pnl = r2(gross - fees + (p.realized ?? 0)); // what the half sold earlier made is part of this trade's result
  const upd = await db.prepare(`UPDATE paper_positions SET status = 'closed', closed_at = ?, exit = ?, exit_reason = ?, pnl = ?, fees = ?, day_closed = ?
    WHERE id = ? AND status = 'open'`).bind(at, price, reason, pnl, fees, nyNow(new Date(at * 1000)).date, p.id).run();
  if (!upd.meta.changes) return false;
  await db.prepare("UPDATE paper_accounts SET cash = cash + ? WHERE user = ?").bind(p.qty * p.entry + gross - out, p.user).run();
  return true;
}
/** Scale-out: sell half at +1R, move the stop to the entry price. The trade stays open with the other half. */
async function scaleOut(db: D1Database, p: Position, price: number, cfg: DeskConfig) {
  const crypto = isCrypto(p.symbol), half = crypto ? Math.floor((p.qty / 2) * 1e6) / 1e6 : Math.floor(p.qty / 2);
  const fee = half > 0 ? cfg.commission_per_share * half : 0, gain = half > 0 ? (price - p.entry) * half * sign(p.side) - fee : 0, rest = crypto ? Math.round((p.qty - half) * 1e6) / 1e6 : p.qty - half;
  const upd = await db.prepare("UPDATE paper_positions SET scaled = 1, qty = ?, stop = ?, realized = COALESCE(realized, 0) + ?, note = substr(COALESCE(note, '') || ?, 1, 300) WHERE id = ? AND status = 'open' AND COALESCE(scaled, 0) = 0")
    .bind(rest, p.entry, gain, half > 0 ? ` · half off at +1R (${r2(price)}), stop to break-even` : " · +1R reached: stop to break-even", p.id).run();
  if (!upd.meta.changes) return;
  if (half > 0) await db.prepare("UPDATE paper_accounts SET cash = cash + ? WHERE user = ?").bind(half * p.entry + gain, p.user).run();
  p.scaled = 1; p.qty = rest; p.stop = p.entry; p.realized = (p.realized ?? 0) + gain;
}

export async function cancelOrder(db: D1Database, user: string, id: string) {
  const r = await db.prepare("UPDATE paper_orders SET status = 'cancelled', reason = 'by user' WHERE id = ? AND user = ? AND status = 'open'").bind(id, user).run();
  return !!r.meta.changes;
}

export async function closePosition(db: D1Database, user: string, id: string) {
  const p = await db.prepare("SELECT * FROM paper_positions WHERE id = ? AND user = ? AND status = 'open'").bind(id, user).first<Position>();
  if (!p) return { error: "Position not found or already closed." };
  if (marketPhase() === "closed" && !isCrypto(p.symbol)) {
    // Nothing trades now: sell at the first trade of the next session (07:00 New York pre-market).
    await db.prepare("UPDATE paper_positions SET close_req = ? WHERE id = ? AND status = 'open'").bind(nowS(), id).run();
    return { ok: true, queued: true };
  }
  const price = await lastPrice(p.symbol);
  return (await closePos(db, p, price, "manual")) ? { ok: true, price } : { error: "Already closed." };
}

/** Change stop / target / exit mode; a field left undefined keeps its current value (null clears it). */
export async function updatePosition(db: D1Database, user: string, id: string, stopIn: number | null | undefined, targetIn: number | null | undefined, exitMode?: ExitMode) {
  const p = await db.prepare("SELECT * FROM paper_positions WHERE id = ? AND user = ? AND status = 'open'").bind(id, user).first<Position>();
  if (!p) return "Position not found.";
  if (exitMode) await db.prepare("UPDATE paper_positions SET exit_mode = ? WHERE id = ?").bind(exitMode, id).run();
  if (stopIn === undefined && targetIn === undefined) return null;
  const stop = stopIn === undefined ? p.stop : stopIn, target = targetIn === undefined ? p.target : targetIn;
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
  try { await db.prepare("DELETE FROM paper_auto WHERE user = ?").bind(user).run(); } catch { /* no chart autopilots yet */ }
}

/** Is the newest completed 1-minute bar recent? Age is measured from the END of that bar. */
export async function freshness(symbol: string, maxMin?: number): Promise<{ fresh: boolean; age_min: number | null; phase: string }> {
  const phase = isCrypto(symbol) ? "open" : marketPhase();
  try { const bars = await candles(symbol, "1m"), lastT = bars.length ? bars[bars.length - 1].time : 0, age = lastT ? (nowS() - lastT - 60) / 60 : null;
    return { fresh: age !== null && age <= (maxMin ?? 2) + 1, age_min: age === null ? null : Math.max(0, Math.round(age)), phase }; } catch { return { fresh: false, age_min: null, phase }; }
}
/** THE risk gate for automatic entries: every path (scan routines, copy desk, chart autopilot, Deep Analysis,
 *  strategy auto-trader) reaches placeOrder, and placeOrder asks here. Limits come from the one desk config.
 *  A halt stops NEW entries only: open positions keep their stops and targets. Manual orders are not gated. */
export async function entryLimits(db: D1Database, user: string, symbol: string, src: string, cfg: DeskConfig, hold = false): Promise<{ ok: boolean; reason?: string }> {
  const block = async (reason: string) => { await riskLog(db, user, symbol, "limit", reason); return { ok: false, reason }; };
  try {
    const ny = nyNow(), t = nowS(), crypto = isCrypto(symbol), a = await getAccount(db, user);
    if (cfg.sources_off.includes(src)) return block(`${SOURCE_LABEL[src] || src} is switched off`);
    if (crypto && !cfg.crypto_autotrade) return block("crypto auto-trading is off until a positive sample exists");
    if (a.s.kill_switch) return block(`kill switch on (${a.s.kill_reason || "manual"})`);
    if (!crypto && marketPhase(ny) === "closed" && !hold) return block("market closed: no day-trade entries");
    if (!crypto && !hold && isTradingDay(ny) && ny.minutes >= sessionTimes(ny.date).close - 15) return block("too close to the end-of-day flatten for a day trade");
    const day = orderDay(ny);
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE user = ? AND source != 'manual' AND day = ? AND status IN ('open','filled')").bind(user, day).first<{ n: number }>())?.n ?? 0;
    if (n >= cfg.max_trades_per_day) return block(`${n} automatic entries today (limit ${cfg.max_trades_per_day})`);
    const open = ((await db.prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE user = ? AND status = 'open'").bind(user).first<{ n: number }>())?.n ?? 0)
      + ((await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE user = ? AND status = 'open'").bind(user).first<{ n: number }>())?.n ?? 0);
    if (open >= cfg.max_concurrent) return block(`${open} positions and working orders open (limit ${cfg.max_concurrent})`);
    const ns = (await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE user = ? AND symbol = ? AND source != 'manual' AND day = ? AND status IN ('open','filled')").bind(user, symbol, day).first<{ n: number }>())?.n ?? 0;
    if (ns >= cfg.max_entries_per_symbol_per_day) return block(`${symbol} already entered ${ns} times today (limit ${cfg.max_entries_per_symbol_per_day})`);
    if (cfg.cooldown_after_stop_min > 0) {
      const st = await db.prepare("SELECT closed_at FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'closed' AND exit_reason LIKE 'stop%' ORDER BY closed_at DESC LIMIT 1").bind(user, symbol).first<{ closed_at: number }>();
      if (st && t - st.closed_at < cfg.cooldown_after_stop_min * 60) return block(`${symbol} was stopped out ${Math.round((t - st.closed_at) / 60)} min ago (cooldown ${cfg.cooldown_after_stop_min} min)`);
    }
    if (cfg.daily_loss_halt_pct > 0 || cfg.weekly_loss_halt_pct > 0) {
      const eq = await equityOf(db, user), dayPnl = await todayPnl(db, user, ny.date);
      if (cfg.daily_loss_halt_pct > 0 && dayPnl <= -eq * cfg.daily_loss_halt_pct / 100) return block(`daily loss halt: today is ${r2(dayPnl)} (limit -${cfg.daily_loss_halt_pct}% of equity). New entries resume tomorrow; open positions are kept`);
      if (cfg.weekly_loss_halt_pct > 0) {
        const d = new Date(`${ny.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const monday = d.toISOString().slice(0, 10);
        const before = (await db.prepare("SELECT COALESCE(SUM(pnl), 0) AS p FROM paper_positions WHERE user = ? AND status = 'closed' AND day_closed >= ? AND day_closed < ?").bind(user, monday, ny.date).first<{ p: number }>())?.p ?? 0;
        if (before + dayPnl <= -eq * cfg.weekly_loss_halt_pct / 100) return block(`weekly loss halt: this week is ${r2(before + dayPnl)} (limit -${cfg.weekly_loss_halt_pct}% of equity). New entries resume on Monday`);
      }
    }
    return { ok: true };
  } catch (e) { return block(`limit check failed (${String((e as Error).message || e).slice(0, 80)}): no trade`); }
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
  const ny = nyNow(), t = nowS(), cfg = await deskConfig(db); let holdDays: number | undefined;
  const symbols = [...new Set([...orders.map((o) => o.symbol), ...positions.map((p) => p.symbol)])];
  const bars = new Map<string, Bar[]>();
  await Promise.all(symbols.map(async (s) => { try { bars.set(s, await barsFor(s)); } catch { /* data hiccup: retry next run */ } }));
  const settings = new Map<string, PaperSettings>();
  const sOf = async (u: string) => { if (!settings.has(u)) settings.set(u, (await getAccount(db, u)).s); return settings.get(u)!; };

  for (const o of orders) {
    const s = await sOf(o.user);
    // Day orders stay working through pre-market, the regular session and after-hours.
    if (isCrypto(o.symbol) ? t > o.created_at + 7 * 86400 : (o.day < ny.date || (o.day === ny.date && ny.minutes >= sessionTimes(o.day).postEnd))) {
      await db.prepare("UPDATE paper_orders SET status = 'expired', reason = 'day order expired' WHERE id = ? AND status = 'open'").bind(o.id).run(); continue;
    }
    if ((o.source === "auto" || o.source === "chart") && t > o.created_at + s.auto_valid_min * 60) {
      await db.prepare("UPDATE paper_orders SET status = 'expired', reason = 'auto entry not triggered in time' WHERE id = ? AND status = 'open'").bind(o.id).run(); continue;
    }
    const bs = (bars.get(o.symbol) || []).filter((b) => b.time >= o.last_checked);
    let filled: Position | null = null;
    const et = o.type === "market" ? "limit" : o.entry_type || "limit", long = o.side === "long";
    if (et === "stop_on_close") {
      // A breakout that needs confirmation: a whole N-minute bar must CLOSE beyond the trigger. The fill is that close.
      // A close that is already too far past the trigger is not chased; the order keeps waiting for a better one.
      const step = cfg.confirm_minutes * 60, all = (bars.get(o.symbol) || []).filter((b) => b.time + 60 > o.created_at), newest = all.at(-1)?.time ?? 0, chase = o.chase ?? Math.abs(o.price! - (o.stop ?? o.price!)) * cfg.max_chase_atr * 2;
      const buckets = new Map<number, Bar[]>(); for (const b of all) { const k = Math.floor(b.time / step) * step; buckets.set(k, [...(buckets.get(k) || []), b]); }
      for (const [k, bb] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
        if (k + step > newest + 60 || k + step <= o.last_checked - 60) continue; // still forming, or judged on an earlier run
        const close = bb[bb.length - 1].close;
        if (long ? close <= o.price! : close >= o.price!) continue;
        if (o.stop !== null && (long ? close <= o.stop : close >= o.stop)) continue;
        if (chase > 0 && Math.abs(close - o.price!) > chase) { await db.prepare("UPDATE paper_orders SET reason = ? WHERE id = ? AND status = 'open'").bind(`closed ${r2(close)}, too far past the trigger ${r2(o.price!)}: not chased`, o.id).run(); continue; }
        filled = await fill(db, o, r2(close), k + step - 1); if (filled) positions.push(filled); break;
      }
      if (!filled && bs.length) await db.prepare("UPDATE paper_orders SET last_checked = ? WHERE id = ? AND status = 'open'").bind(bs.at(-1)!.time + 60, o.id).run();
      continue;
    }
    for (const b of bs) {
      let px: number | null = null;
      if (o.type === "market") px = b.open; // queued while closed: first trade of the session
      else if (et === "stop") {
        // A breakout: fills when the price trades up through the trigger (down, for a short), at the trigger or at the open if it gapped.
        if (long && b.high >= o.price!) px = Math.max(o.price!, b.open);
        if (!long && b.low <= o.price!) px = Math.min(o.price!, b.open);
        if (px !== null && o.chase && Math.abs(px - o.price!) > o.chase) { await db.prepare("UPDATE paper_orders SET status = 'cancelled', reason = 'gapped past the trigger by more than the max chase' WHERE id = ? AND status = 'open'").bind(o.id).run(); break; }
      } else {
        // Buy at or below the entry (short at or above), at the bar's open if it is already better.
        if (o.side === "long" && b.low <= o.price!) px = Math.min(o.price!, b.open);
        if (o.side === "short" && b.high >= o.price!) px = Math.max(o.price!, b.open);
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
      if (p.close_req && b.time >= p.close_req) { done = await closePos(db, p, r2(b.open), "manual (next open)", b.time + 59); break; }
      // Conservative: if one bar touches both stop and target, assume the stop came first.
      if (p.stop !== null && (p.side === "long" ? b.low <= p.stop : b.high >= p.stop)) {
        // A stop is a market order once touched: it fills a little worse than its price (slippage), or at the open after a gap.
        const raw = p.side === "long" ? Math.min(p.stop, b.open) : Math.max(p.stop, b.open), slip = p.source === "manual" ? 0 : raw * cfg.stop_slippage_pct / 100; // trades placed by hand keep their old fills
        const px = p.side === "long" ? raw - slip : raw + slip;
        done = await closePos(db, p, r2(px), p.scaled ? (p.stop === p.entry ? "stop (break-even)" : "stop (trailing)") : "stop", b.time + 59); break;
      }
      // Scale-out exit (day trades placed by the desk): half off at +1R, stop to break-even, then trail the rest.
      const R = p.init_stop != null ? Math.abs(p.entry - p.init_stop) : 0, managed = cfg.exit_model === "scale" && p.source !== "manual" && p.exit_mode !== "hold" && !isCrypto(p.symbol) && R > 0;
      if (managed && !p.scaled && (p.side === "long" ? b.high >= p.entry + R : b.low <= p.entry - R) && (p.target === null || (p.side === "long" ? p.target > p.entry + R : p.target < p.entry - R))) await scaleOut(db, p, r2(p.side === "long" ? p.entry + R : p.entry - R), cfg);
      if (managed && p.scaled) {
        const best = p.side === "long" ? Math.max(p.best ?? p.entry, b.high) : Math.min(p.best ?? p.entry, b.low), dist = p.trail && p.trail > 0 ? p.trail : R;
        const ts = p.side === "long" ? best - dist : best + dist, ns = p.side === "long" ? Math.max(p.stop ?? p.entry, ts) : Math.min(p.stop ?? p.entry, ts);
        if (best !== p.best || ns !== p.stop) { p.best = best; p.stop = r2(ns); await db.prepare("UPDATE paper_positions SET best = ?, stop = ? WHERE id = ? AND status = 'open'").bind(best, p.stop, p.id).run(); }
      }
      if (p.target !== null && (p.side === "long" ? b.high >= p.target : b.low <= p.target)) {
        const px = p.side === "long" ? Math.max(p.target, b.open) : Math.min(p.target, b.open);
        done = await closePos(db, p, r2(px), "target", b.time + 59); break;
      }
    }
    if (done) continue;
    // End-of-day trades close 5 minutes before the regular close; ones opened after the bell close 5 minutes
    // before after-hours ends (or at the next run if one was opened on an earlier day).
    const mode = isCrypto(p.symbol) ? "hold" : p.exit_mode ?? (s.auto_flat ? "eod" : "hold"); // crypto has no close: always held to the stop or target
    const st = sessionTimes(p.day_opened);
    const cut = nyNow(new Date(p.opened_at * 1000)).minutes >= st.close - 5 ? st.postEnd - 5 : st.close - 5;
    if (mode === "eod" && (p.day_opened < ny.date || (p.day_opened === ny.date && ny.minutes >= cut))) {
      const last = bars.get(p.symbol)?.at(-1)?.close;
      if (last) { await closePos(db, p, last, "end of day"); continue; }
    }
    // An automatic swing trade that has hit neither level after the time limit is closed: money tied up in a trade
    // that is going nowhere is the cost a wide stop would otherwise hide.
    if (p.exit_mode === "hold" && p.source === "auto") {
      holdDays ??= (await exitPolicy(db)).swing_hold_days;
      const limitDays = p.hold_days && p.hold_days > 0 ? p.hold_days : holdDays;
      let over = false;
      if (isCrypto(p.symbol)) over = t - p.opened_at >= limitDays * 86400;
      else if (isTradingDay(ny) && ny.minutes >= sessionTimes(ny.date).close - 5) { let d = p.day_opened, n = 0; while (d < ny.date && n < limitDays) { d = nextTradingDate(d); n++; } over = n >= limitDays; }
      const last = bars.get(p.symbol)?.at(-1)?.close;
      if (over && last) { await closePos(db, p, last, `time limit (${limitDays} sessions)`); continue; }
    }
    if (bs.length) await db.prepare("UPDATE paper_positions SET last_checked = ? WHERE id = ? AND status = 'open'").bind(bs.at(-1)!.time + 60, p.id).run();
  }
}

// --------------------------------------------------------------------------------------- hard risk gate
/** Trip (or re-arm) the kill switch. Tripping cancels working orders and flattens every open position. */
export async function setKillSwitch(db: D1Database, user: string, on: boolean, reason = "manual") {
  const a = await getAccount(db, user);
  const next = { ...a.s, kill_switch: on, kill_reason: on ? reason : "" };
  await db.prepare("UPDATE paper_accounts SET settings = ? WHERE user = ?").bind(JSON.stringify(next), user).run();
  let closed = 0, cancelled = 0;
  if (on) {
    cancelled = (await db.prepare("UPDATE paper_orders SET status = 'cancelled', reason = 'kill switch' WHERE user = ? AND status = 'open'").bind(user).run()).meta.changes ?? 0;
    const pos = (await db.prepare("SELECT id FROM paper_positions WHERE user = ? AND status = 'open'").bind(user).all<{ id: string }>()).results;
    for (const p of pos) { const r = await closePosition(db, user, p.id); if (!r.error) closed++; }
    await riskLog(db, user, "*", "kill", `Kill switch ON (${reason}): ${closed} positions closed, ${cancelled} orders cancelled`);
  } else {
    // Re-arm from here: the drawdown guard measures from the current equity, not the old peak.
    await db.prepare("UPDATE paper_accounts SET peak_equity = ? WHERE user = ?").bind(await equityOf(db, user), user).run();
    await riskLog(db, user, "*", "rearm", "Kill switch OFF: automatic entries allowed again");
  }
  return { ok: true, kill_switch: on, closed, cancelled };
}

/** Checked before EVERY automatic entry. Fails closed: anything unclear means no trade, with a logged reason. */
export async function riskGate(db: D1Database, user: string, symbol: string): Promise<{ ok: boolean; reason?: string; size_mult: number; regime?: RegimeRead }> {
  const block = async (reason: string, regime?: RegimeRead) => { await riskLog(db, user, symbol, "block", reason); return { ok: false, reason, size_mult: 0, regime }; };
  try {
    const a = await getAccount(db, user);
    if (a.s.kill_switch) return block(`kill switch on (${a.s.kill_reason || "manual"})`);
    const eq = await equityOf(db, user);
    const row = await db.prepare("SELECT peak_equity FROM paper_accounts WHERE user = ?").bind(user).first<{ peak_equity: number | null }>();
    const peak = Math.max(row?.peak_equity ?? a.starting_cash, eq);
    if (peak !== row?.peak_equity) await db.prepare("UPDATE paper_accounts SET peak_equity = ? WHERE user = ?").bind(peak, user).run();
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (a.s.max_drawdown_pct > 0 && dd >= a.s.max_drawdown_pct) {
      await setKillSwitch(db, user, true, `max drawdown: equity ${r2(dd)}% below its peak (limit ${a.s.max_drawdown_pct}%)`);
      return block(`max drawdown ${r2(dd)}% reached: kill switch tripped, account flattened`);
    }
    // Stale data: the newest 1-minute bar must be recent while this market trades.
    const crypto = isCrypto(symbol);
    if (crypto || marketPhase() !== "closed") {
      const bars = await candles(symbol, "1m");
      const lastT = bars.length ? bars[bars.length - 1].time : 0;
      const ageMin = lastT ? Math.round((nowS() - lastT) / 60) : null, ph = crypto ? "regular" : marketPhase();
      // Thin extended-hours trading is not a data fault: say which one it is.
      if (!lastT || nowS() - lastT > 20 * 60) return block(ph === "regular" ? `stale data: the last ${symbol} bar is ${ageMin ?? "?"} minutes old while the market is open` : `no recent ${symbol} trade in ${ph === "pre" ? "pre-market" : "after-hours"} (last bar ${ageMin ?? "?"} min ago): waiting for the regular session`);
    }
    if (!a.s.regime_sizing) return { ok: true, size_mult: 1 };
    const regime = await marketRegime(db, crypto);
    if (regime.size_mult <= 0) return block(`regime ${regime.regime} (${regime.why}): staying flat`, regime);
    return { ok: true, size_mult: regime.size_mult, regime };
  } catch (e) { return block(`risk check failed (${String((e as Error).message || e).slice(0, 80)}): no trade`); }
}

// --------------------------------------------------------------------------------------- auto-trading
type Pick = { symbol?: string; bias?: string; score?: number; entry?: number; stop?: number; targets?: number[]; size_shares?: number; setup?: string; horizon?: string; entry_type?: string; sources?: { type?: string }[] };
/** Insider, fund (13F) and politician buying is a weeks-long edge: such plans are swing trades whatever the scan called them. */
export const isCopyPick = (slot: string, p: { sources?: { type?: string }[] | null }) => slot === "winners" || (Array.isArray(p.sources) && p.sources.some((x) => /insider|fund|13f|congress|politic|senat/i.test(String(x?.type || ""))));

/** Place paper orders from finished briefs for every account with auto-trade on (once per brief). */
export async function autoTradeNewBriefs(db: D1Database) {
  await ensurePaper(db);
  const ny = nyNow();
  let briefs: { id: string; data: string | null; label: string; slot: string }[] = [];
  try {
    briefs = (await db.prepare("SELECT id, data, label, slot FROM briefs WHERE status = 'done' AND auto_done IS NULL AND day = ?").bind(ny.date).all<{ id: string; data: string | null; label: string; slot: string }>()).results;
  } catch { return; }
  if (!briefs.length) return;
  for (const b of briefs) await db.prepare("UPDATE briefs SET auto_done = 1 WHERE id = ?").bind(b.id).run();
  if (!isTradingDay(ny)) return;
  // Day-trade briefs are too late to act on in the last 30 minutes; swing setups (held for days) are not.
  const lateForDay = ny.minutes >= sessionTimes(ny.date).close - 30;
  const accounts = (await db.prepare("SELECT * FROM paper_accounts").all<Account>()).results
    .map((a) => ({ ...a, s: sanitizePaperSettings(JSON.parse(a.settings || "{}")) })).filter((a) => a.s.auto_trade);
  const active = await activeRules(db);
  // Exit engine: minimum stop distance, long-only swings, and the guard that pauses a horizon which keeps losing.
  const pol = await exitPolicy(db), edge = pol.edge_guard ? await edgeStatus(db) : null;
  for (const b of briefs) {
    let picks: Pick[] = [], regime: string | null = null;
    try { const d = JSON.parse(b.data || "{}"); picks = (d?.picks ?? []) as Pick[]; regime = typeof d?.market?.regime === "string" ? d.market.regime.toLowerCase() : null; } catch { continue; }
    picks = picks.map((p) => (isCopyPick(b.slot, p) ? { ...p, horizon: "swing" } : p));
    if (lateForDay) picks = picks.filter((p) => p.horizon === "swing");
    // The active strategy version (Performance › self-improving loop) filters what auto-trade may take.
    if (active) picks = picks.filter((p) => !ruleBlocks(active.rules, { score: num(p.score), setup: p.setup ?? null, slot: b.slot, symbol: p.symbol ?? null, regime, created_at: nowS(),
      sources: Array.isArray((p as Pick & { sources?: { type?: string }[] }).sources) ? ((p as Pick & { sources?: { type?: string }[] }).sources || []).map((x) => String(x.type || "")) : null }));
    const hz = (p: Pick): Horizon => (p.horizon === "swing" ? "swing" : "day");
    const paused = edge ? (["day", "swing"] as Horizon[]).filter((h) => edge[h].paused && picks.some((p) => hz(p) === h)) : [];
    if (paused.length) { for (const a of accounts) for (const h of paused) await riskLog(db, a.user, "*", "edge-guard", edge![h].text); picks = picks.filter((p) => !paused.includes(hz(p))); }
    if (pol.swing_long_only) picks = picks.filter((p) => !(hz(p) === "swing" && /short/i.test(p.bias || "") && !isCrypto(String(p.symbol || ""))));
    if (!picks.length) continue;
    for (const a of accounts) {
      // Each account's own triggers: which scans, which time window (swing picks ignore the intraday window).
      if (a.s.auto_slots.length && !a.s.auto_slots.includes(b.slot)) continue;
      if (b.slot !== "swing" && (ny.minutes < toMin(a.s.auto_start) || ny.minutes >= toMin(a.s.auto_end))) continue;
      await autoTradeAccount(db, a, picks, b, pol);
    }
  }
}

async function autoTradeAccount(db: D1Database, a: Account & { s: PaperSettings }, picks: Pick[], b: { id: string; label: string; slot: string }, pol: ExitPolicy) {
  const cfg = await deskConfig(db);
  const s = a.s, today = nyNow().date;
  const cap = (await activeRules(db))?.rules.max_trades_day;
  let tradesLeft = Math.min(s.auto_max_trades_day, cap ?? Infinity) - ((await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE user = ? AND source = 'auto' AND day = ? AND status IN ('open', 'filled')")
    .bind(a.user, today).first<{ n: number }>())?.n ?? 0);
  if (tradesLeft <= 0) return;
  if (s.auto_max_daily_loss > 0 && (await todayPnl(db, a.user, today)) <= -s.auto_max_daily_loss) return;
  const blocked = new Set(s.auto_blocked);
  const openPos = (await db.prepare("SELECT symbol FROM paper_positions WHERE user = ? AND status = 'open'").bind(a.user).all<{ symbol: string }>()).results;
  const openOrd = (await db.prepare("SELECT symbol FROM paper_orders WHERE user = ? AND status = 'open'").bind(a.user).all<{ symbol: string }>()).results;
  const busy = new Set([...openPos, ...openOrd].map((x) => x.symbol));
  let slots = s.auto_max_positions - busy.size;
  let kelly: number | undefined;
  const eq = await equityOf(db, a.user);
  for (const p of [...picks].sort((x, y) => (num(y.score) ?? 0) - (num(x.score) ?? 0))) {
    if (slots <= 0 || tradesLeft <= 0) break;
    const symbol = String(p.symbol || "").toUpperCase(), entry = num(p.entry), planStop = num(p.stop);
    if (!symbol || busy.has(symbol) || blocked.has(symbol) || entry === null || planStop === null || entry === planStop || (num(p.score) ?? 0) < s.auto_min_score) continue;
    const side: Side = /short/i.test(p.bias || "") ? "short" : "long";
    if (s.auto_side !== "both" && s.auto_side !== side) continue;
    if (entry < s.auto_min_price) continue;
    const targets = (p.targets || []).map(num).filter((x): x is number => x !== null);
    const planTarget = (s.target === "t2" ? targets[1] : undefined) ?? targets[0] ?? null;
    // Your reward:risk filter judges the plan as it was recommended.
    if (s.auto_min_rr > 0 && (planTarget === null || Math.abs(planTarget - entry) / Math.max(Math.abs(entry - planStop), 1e-9) < s.auto_min_rr)) continue;
    let last: number;
    try { last = await lastPrice(symbol); } catch { continue; }
    // Entry = most to pay: fills now if the market is at or below it (long), else waits for a pullback to it. So the
    // price the trade will really start from is the better of the two, and the stop distance is measured from there:
    // a plan "buy 131.25, stop 129.90" filled at 130.00 would otherwise sit 10 cents from its stop.
    const copy = isCopyPick(b.slot, p), src = copy ? "copy" : "routine";
    // How the entry is meant to be reached: a breakout waits for the price to get there (and, by default, for a bar to
    // CLOSE beyond the trigger); only a pullback or reversal plan is "the most to pay". Buying a breakout before it
    // breaks out was the largest single fault in the old fills.
    const etype = entryTypeOf({ entry_type: p.entry_type, setup: p.setup, slot: b.slot, side, entry, last });
    // The setup is gone when the price is past the target, or (for a pullback entry) already through the stop. A breakout
    // that has not triggered yet normally trades under its own stop: that is not a reason to drop it.
    if (planTarget !== null && (side === "long" ? last >= planTarget : last <= planTarget)) continue;
    if (etype === "limit" && (side === "long" ? last <= planStop : last >= planStop)) continue;
    const ref = etype !== "limit" ? entry : side === "long" ? Math.min(entry, last) : Math.max(entry, last);
    // Skip the pick when the price is already through the stop-loss or past the take-profit.

    // The plan says where; the exit engine says how far at least: a stop inside the stock's normal noise is widened
    // (and the size below shrinks with it, so the dollars at risk stay the same).
    const dAtr = await dailyAtr(symbol, today);
    const adj = applyExit({ side, entry: ref, stop: planStop, target: planTarget, horizon: p.horizon === "swing" ? "swing" : "day" }, dAtr, copy ? { ...pol, swing_stop_atr: cfg.copy_stop_atr, swing_min_rr: cfg.copy_min_rr } : pol);
    const stop = adj.stop, target = adj.target, perShareRisk = adj.risk;
    // Hard gate before every order: kill switch, drawdown guard, stale data, regime (size multiplier).
    const gate = await riskGate(db, a.user, symbol);
    if (!gate.ok) continue;
    const riskPct = s.sizing === "kelly" ? (kelly ??= (await kellyRead(db)).risk_pct ?? s.risk_pct) : s.risk_pct;
    let qty = s.sizing === "rec" ? num(p.size_shares) ?? 0 : s.sizing === "fixed" ? s.fixed_usd / entry : perShareRisk > 0 ? (eq * riskPct / 100) / perShareRisk : 0;
    // A recommended size assumed the recommended stop: when the stop was widened, the size shrinks in proportion.
    if (s.sizing === "rec" && adj.widened) qty *= Math.abs(ref - planStop) / adj.risk;
    qty = Math.min(qty, (eq * Math.min(s.max_position_pct, cfg.max_notional_pct) / 100) / entry) * gate.size_mult;
    // Stocks trade in whole shares; crypto in fractions (a whole coin would be far more than the risk allows).
    qty = isCrypto(symbol) ? Math.floor(qty * 1e6) / 1e6 : Math.floor(qty);
    if (isCrypto(symbol) ? qty * entry < 10 : qty < 1) continue;
    // A trade that risks almost nothing cannot pay for its own costs: skip it rather than collect small losses.
    if (cfg.risk_min_pct > 0 && qty * perShareRisk < eq * cfg.risk_min_pct / 100) { await riskLog(db, a.user, symbol, "skip", `risk $${r2(qty * perShareRisk)} is under ${cfg.risk_min_pct}% of equity after the ${Math.min(s.max_position_pct, cfg.max_notional_pct)}% position cap: skipped`); continue; }
    const r = await placeOrder(db, a.user, { symbol, side, type: "limit", price: entry, qty, stop, target, source: "auto", brief_id: b.id, note: `${b.label}: ${p.setup ?? ""}${etype === "limit" ? "" : ` · waits for ${etype === "stop" ? "a trade through" : `a ${cfg.confirm_minutes}-min close beyond`} ${entry}`}${adj.note ? ` · ${adj.note}` : ""}`.slice(0, 300),
      exit_mode: p.horizon === "swing" ? "hold" : null, entry_type: etype, src, client_id: `${symbol}:brief:${b.id}:${side}`, atr: dAtr, trail: dAtr ? Math.round((dAtr / 11) * 1e4) / 1e4 : null, hold_days: copy ? cfg.copy_hold_days : null }); // a swing pick is held through the stop or target, whatever the account default
    if (!r.error) { busy.add(symbol); slots--; tradesLeft--; }
  }
}

/** Today's realized P&L plus the open positions' unrealized P&L. */
async function todayPnl(db: D1Database, user: string, day: string) {
  const realized = (await db.prepare("SELECT COALESCE(SUM(pnl), 0) AS p FROM paper_positions WHERE user = ? AND status = 'closed' AND day_closed = ?").bind(user, day).first<{ p: number }>())?.p ?? 0;
  const pos = (await db.prepare("SELECT * FROM paper_positions WHERE user = ? AND status = 'open'").bind(user).all<Position>()).results;
  let unreal = 0;
  for (const p of pos) { try { unreal += ((await lastPrice(p.symbol)) - p.entry) * p.qty * sign(p.side); } catch { /* skip */ } }
  return realized + unreal;
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

/** Every account's headline numbers, best total return first (everyone can see these, read-only). */
export async function leaderboard(db: D1Database) {
  await ensurePaper(db);
  let known = new Set<string>(["admin"]);
  try { known = new Set([...known, ...(await db.prepare("SELECT id FROM users").all<{ id: string }>()).results.map((u) => u.id)]); } catch { /* no users table yet */ }
  // Hide accounts of deleted password users (Cloudflare Access users are e-mails and always shown).
  const users = (await db.prepare("SELECT user FROM paper_accounts").all<{ user: string }>()).results.map((r) => r.user)
    .filter((u) => u.includes("@") || known.has(u));
  const rows = await Promise.all(users.map(async (u) => {
    const s = await summary(db, u);
    return { ...s.account, open_positions: s.positions.length, working_orders: s.orders.filter((o) => o.status === "open").length, auto_trade: s.settings.auto_trade };
  }));
  return rows.sort((a, b) => b.total_pct - a.total_pct);
}

export async function hasAccount(db: D1Database, user: string) {
  await ensurePaper(db);
  return !!(await db.prepare("SELECT 1 FROM paper_accounts WHERE user = ?").bind(user).first());
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
    session: { phase: marketPhase(ny), ...sessionTimes(ny.date), next_day: orderDay(ny) },
  };
}
