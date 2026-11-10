// Chart autopilot: per user and per symbol, an amount of paper money that trades that chart automatically.
// Entries come from the symbol's current plan (an open position/order, today's latest recommendation, or a
// Deep Analysis) or, with no plan, from a strong candlestick signal on completed 5-minute bars. Exits are the
// plan's stop / target (the paper engine), plus a strong reversal signal against the trade. Paper only.
import "../public/candles.js";
import { candles, isCrypto, latestPrice } from "./market";
import { kronosAgrees } from "./kronos";
import { getSettings } from "./db";
import { inSession, isTradingDay, nyNow, clockNow } from "./briefs";
import { closePosition, ensurePaper, getAccount, placeOrder, riskGate, type Side } from "./paper";
import { patternAllowed } from "./learn";
import { activeRules, ruleBlocks } from "./strategy";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Hit = { index: number; time: number; pattern: string; label: string; dir: "bullish" | "bearish"; bars: number; trend: string; volume: boolean; strength: number; strong: boolean };
const Candles = () => (globalThis as unknown as { TDCandles: { detect(bars: Bar[], opts?: Record<string, unknown>): Hit[] } }).TDCandles;

export type AutoRule = "plan" | "signal" | "both";
export type AutoRow = { user: string; symbol: string; amount_usd: number; rule: AutoRule; enabled: number; created_at: number; last_note: string | null; last_at: number | null };
export type Plan = {
  source: "position" | "order" | "brief" | "deep"; side: Side; entry: number; stop: number | null; targets: number[];
  time: number | null; setup: string; score?: number | null; rating?: string | null; label?: string; id?: string | null;
  entered?: boolean; qty?: number | null;
};

const nowS = () => Math.floor(clockNow().getTime() / 1000);
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const SYMBOL = /^[A-Z0-9.\-]{1,15}$/;
const MAX_ENTRIES_PER_DAY = 4;      // per symbol and account: a chart that keeps stopping out stays off for the day
const REENTRY_COOLDOWN_SEC = 30 * 60;

let ready = false;
export async function ensureAutoChart(db: D1Database) {
  if (ready) return;
  await ensurePaper(db);
  await db.prepare(`CREATE TABLE IF NOT EXISTS paper_auto (user TEXT NOT NULL, symbol TEXT NOT NULL, amount_usd REAL NOT NULL, rule TEXT NOT NULL DEFAULT 'both',
    enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_note TEXT, last_at INTEGER, PRIMARY KEY (user, symbol))`).run();
  ready = true;
}

// ------------------------------------------------------------------------------------------------ plans
/** The plan a chart should watch, in priority order: your open position, your working order, today's latest
 *  recommendation for the symbol (any brief), then the latest Deep Analysis (5 days) with an entry and stop. */
export async function planFor(db: D1Database, user: string, symbol: string): Promise<Plan | null> {
  await ensureAutoChart(db);
  const pos = await db.prepare("SELECT * FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1").bind(user, symbol)
    .first<{ id: string; side: Side; entry: number; stop: number | null; target: number | null; opened_at: number; note: string | null; qty: number; source: string }>();
  if (pos) return { source: "position", side: pos.side, entry: pos.entry, stop: pos.stop, targets: pos.target === null ? [] : [pos.target], time: pos.opened_at, setup: pos.note || `${pos.source} trade`, id: pos.id, entered: true, qty: pos.qty };
  const ord = await db.prepare("SELECT * FROM paper_orders WHERE user = ? AND symbol = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").bind(user, symbol)
    .first<{ id: string; side: Side; price: number | null; stop: number | null; target: number | null; created_at: number; note: string | null; qty: number }>();
  if (ord && ord.price !== null) return { source: "order", side: ord.side, entry: ord.price, stop: ord.stop, targets: ord.target === null ? [] : [ord.target], time: ord.created_at, setup: ord.note || "working order", id: ord.id, entered: false, qty: ord.qty };
  const ny = nyNow();
  let briefs: { id: string; label: string; data: string | null; finished_at: string | null }[] = [];
  try { briefs = (await db.prepare("SELECT id, label, data, finished_at FROM briefs WHERE status = 'done' AND day = ? ORDER BY finished_at DESC, created_at DESC LIMIT 12").bind(ny.date).all<{ id: string; label: string; data: string | null; finished_at: string | null }>()).results; }
  catch { briefs = []; }
  for (const b of briefs) {
    let picks: Record<string, unknown>[] = [];
    try { picks = JSON.parse(b.data || "{}")?.picks ?? []; } catch { continue; }
    const p = picks.find((x) => String(x.symbol || "").toUpperCase() === symbol);
    if (!p) continue;
    const entry = num(p.entry); if (entry === null) continue;
    const targets = (Array.isArray(p.targets) ? p.targets : []).map(num).filter((x): x is number => x !== null);
    const t = b.finished_at ? Math.floor(Date.parse(b.finished_at.replace(" ", "T") + "Z") / 1000) : null;
    return { source: "brief", side: /short/i.test(String(p.bias || "")) ? "short" : "long", entry, stop: num(p.stop), targets, time: t, setup: String(p.setup || ""), score: num(p.score), label: b.label, id: b.id };
  }
  try {
    const d = await db.prepare("SELECT id, rating, data, finished_at FROM deep_runs WHERE symbol = ? AND status = 'done' AND day >= date('now', '-5 days') ORDER BY created_at DESC LIMIT 1").bind(symbol)
      .first<{ id: string; rating: string | null; data: string | null; finished_at: string | null }>();
    if (d) {
      const x = JSON.parse(d.data || "{}") as Record<string, unknown>;
      const entry = num(x.entry), stop = num(x.stop);
      if (entry !== null && stop !== null && d.rating && d.rating !== "Hold") {
        const side: Side = /Sell|Underweight/.test(d.rating) ? "short" : "long";
        const targets = (Array.isArray(x.targets) ? (x.targets as unknown[]) : []).map(num).filter((v): v is number => v !== null);
        return { source: "deep", side, entry, stop, targets, time: d.finished_at ? Math.floor(Date.parse(d.finished_at.replace(" ", "T") + "Z") / 1000) : null, setup: String(x.summary || "").slice(0, 160), rating: d.rating, id: d.id };
      }
    }
  } catch { /* no deep table yet */ }
  return null;
}

// ------------------------------------------------------------------------------------------------ rows
export async function listAuto(db: D1Database, user: string) {
  await ensureAutoChart(db);
  const rows = (await db.prepare("SELECT * FROM paper_auto WHERE user = ? ORDER BY created_at DESC").bind(user).all<AutoRow>()).results;
  return Promise.all(rows.map(async (r) => {
    const pos = await db.prepare("SELECT id, side, qty, entry, stop, target FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'open' LIMIT 1").bind(user, r.symbol).first();
    const ord = await db.prepare("SELECT id, side, qty, price, stop, target FROM paper_orders WHERE user = ? AND symbol = ? AND status = 'open' LIMIT 1").bind(user, r.symbol).first();
    const today = (await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE user = ? AND symbol = ? AND source = 'chart' AND day = ?").bind(user, r.symbol, nyNow().date).first<{ n: number }>())?.n ?? 0;
    return { ...r, enabled: !!r.enabled, position: pos, order: ord, entries_today: today };
  }));
}

export async function setAuto(db: D1Database, user: string, inp: { symbol: unknown; amount_usd?: unknown; rule?: unknown; enabled?: unknown }) {
  await ensureAutoChart(db);
  const symbol = String(inp.symbol || "").toUpperCase();
  if (!SYMBOL.test(symbol)) return { error: "Bad symbol" };
  const cur = await db.prepare("SELECT * FROM paper_auto WHERE user = ? AND symbol = ?").bind(user, symbol).first<AutoRow>();
  const amount = inp.amount_usd === undefined ? (cur?.amount_usd ?? 1000) : Number(inp.amount_usd);
  if (!(amount >= 50 && amount <= 10_000_000)) return { error: "Amount must be between $50 and $10,000,000." };
  const rule: AutoRule = inp.rule === "plan" || inp.rule === "signal" || inp.rule === "both" ? inp.rule : (cur?.rule ?? "both");
  const enabled = inp.enabled === undefined ? (cur ? !!cur.enabled : true) : !!inp.enabled;
  const acct = await getAccount(db, user);
  if (enabled && amount > acct.cash + 1e-9 && !cur) return { error: `Not enough paper cash: ${r2(acct.cash)} available.` };
  await db.prepare(`INSERT INTO paper_auto (user, symbol, amount_usd, rule, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user, symbol) DO UPDATE SET amount_usd = excluded.amount_usd, rule = excluded.rule, enabled = excluded.enabled`).bind(user, symbol, r2(amount), rule, enabled ? 1 : 0, nowS()).run();
  return { ok: true, symbol, amount_usd: r2(amount), rule, enabled };
}

export async function removeAuto(db: D1Database, user: string, symbol: string) {
  await ensureAutoChart(db);
  const r = await db.prepare("DELETE FROM paper_auto WHERE user = ? AND symbol = ?").bind(user, symbol.toUpperCase()).run();
  return !!r.meta.changes;
}

async function note(db: D1Database, r: AutoRow, text: string) {
  await db.prepare("UPDATE paper_auto SET last_note = ?, last_at = ? WHERE user = ? AND symbol = ?").bind(text.slice(0, 200), nowS(), r.user, r.symbol).run();
}

// ------------------------------------------------------------------------------------------------ engine
/** Completed 5-minute bars inside our sessions (the forming bar is left out so a signal never vanishes). */
async function completedBars(symbol: string): Promise<Bar[]> {
  const all = (await candles(symbol, "5m", 3)) as Bar[];
  const cutoff = nowS() - 300; // a 5-minute bar is complete once its start is 5 minutes old
  return all.filter((b) => b.time <= cutoff && (isCrypto(symbol) || inSession(b.time))).slice(-300);
}

/** Signals on the LAST completed bar only (strength >= min). */
function lastBarSignals(bars: Bar[], min = 2): Hit[] {
  if (bars.length < 12) return [];
  const hits = Candles().detect(bars, { from: bars.length - 1, trendGate: true });
  return hits.filter((h) => h.index === bars.length - 1 && h.strength >= min);
}

/** One pass for every enabled chart autopilot. Runs each minute from the cron while a session is open. */
export async function runChartAuto(db: D1Database) {
  await ensureAutoChart(db);
  const ny = nyNow();
  const stocksOpen = isTradingDay(ny) && inSession(nowS());
  const active = await activeRules(db);
  const gate = !!(await getSettings(db) as { kronos_gate?: boolean }).kronos_gate || !!active?.rules.require_kronos;
  const rows = (await db.prepare("SELECT * FROM paper_auto WHERE enabled = 1").all<AutoRow>()).results.filter((r) => stocksOpen || isCrypto(r.symbol));
  const barsCache = new Map<string, Bar[]>();
  const barsOf = async (s: string) => { if (!barsCache.has(s)) barsCache.set(s, await completedBars(s)); return barsCache.get(s)!; };
  for (const r of rows) {
    try {
      const acct = await getAccount(db, r.user);
      const pos = await db.prepare("SELECT * FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'open' LIMIT 1").bind(r.user, r.symbol)
        .first<{ id: string; side: Side; source: string; opened_at: number; exit_mode: string | null }>();
      if (pos) {
        // In a trade: the paper engine handles the stop / target. Here: a strong reversal signal against the trade
        // on the last completed bar closes it (automatic exit detection). Multi-day trades (hold) keep to their levels.
        if (pos.exit_mode === "hold") continue;
        const bars = await barsOf(r.symbol);
        const last = bars.at(-1); if (!last || last.time < pos.opened_at - 300) continue;
        const against = lastBarSignals(bars, 2).filter((h) => h.strong && (pos.side === "long" ? h.dir === "bearish" : h.dir === "bullish"));
        if (against.length) {
          const res = await closePosition(db, r.user, pos.id);
          if (!res.error) await note(db, r, `Exit signal: ${against[0].label} against the ${pos.side} → closed at ${res.price ?? "next open"}`);
        }
        continue;
      }
      const ord = await db.prepare("SELECT 1 FROM paper_orders WHERE user = ? AND symbol = ? AND status = 'open' LIMIT 1").bind(r.user, r.symbol).first();
      if (ord) continue; // waiting for the entry
      // Entry guards: per-day cap, re-entry cooldown after an exit, cash.
      const todayN = (await db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE user = ? AND symbol = ? AND source = 'chart' AND day = ?").bind(r.user, r.symbol, ny.date).first<{ n: number }>())?.n ?? 0;
      if (todayN >= MAX_ENTRIES_PER_DAY) continue;
      const lastClose = await db.prepare("SELECT closed_at FROM paper_positions WHERE user = ? AND symbol = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1").bind(r.user, r.symbol).first<{ closed_at: number }>();
      if (lastClose && nowS() - lastClose.closed_at < REENTRY_COOLDOWN_SEC) continue;
      // Hard gate before every entry: kill switch, drawdown guard, stale data, regime (size multiplier).
      const gate = await riskGate(db, r.user, r.symbol);
      if (!gate.ok) { await note(db, r, `Blocked by the risk gate: ${gate.reason}`); continue; }
      const budget = Math.min(r.amount_usd, acct.cash) * gate.size_mult;
      if (budget < 50) { await note(db, r, "Paused: not enough paper cash."); continue; }

      let placed: { symbol: string; side: Side; type: "limit"; price: number; qty: number; stop: number | null; target: number | null; note: string; exit_mode: "hold" | null } | null = null;
      const plan = r.rule === "signal" ? null : await planFor(db, r.user, r.symbol);
      if (plan && (plan.source === "brief" || plan.source === "deep")) {
        const blocked = active ? ruleBlocks(active.rules, { score: plan.score ?? null, setup: plan.setup, slot: plan.source === "brief" ? undefined : null, symbol: r.symbol, created_at: nowS() }) : null;
        if (blocked) { await note(db, r, `Plan skipped by strategy v${active!.version}: ${blocked}`); continue; }
        let last: number; try { last = await latestPrice(r.symbol); } catch { continue; }
        const t1 = plan.targets[0] ?? null, stop = plan.stop;
        // Skip once the price is already through the stop or past the first target (the setup is gone).
        const gone = plan.side === "long" ? (stop !== null && last <= stop) || (t1 !== null && last >= t1) : (stop !== null && last >= stop) || (t1 !== null && last <= t1);
        if (!gone && stop !== null) {
          const qty = isCrypto(r.symbol) ? Math.round((budget / plan.entry) * 1e6) / 1e6 : Math.floor(budget / plan.entry);
          if (qty > 0 && (isCrypto(r.symbol) || qty >= 1)) placed = { symbol: r.symbol, side: plan.side, type: "limit", price: plan.entry, qty, stop, target: t1, exit_mode: plan.source === "deep" ? "hold" : null,
            note: `Chart auto (${plan.source === "deep" ? `Deep Analysis ${plan.rating}` : plan.label || "recommendation"}): ${plan.setup}`.slice(0, 300) };
        }
      }
      if (!placed && r.rule !== "plan") {
        const bars = await barsOf(r.symbol);
        const hits = lastBarSignals(bars, 2).filter((h) => h.strong && (acct.s.auto_side === "both" || (acct.s.auto_side === "long") === (h.dir === "bullish")));
        // Patterns this symbol has proven unreliable (pattern_stats, walk-forward) are skipped.
        const allowed: Hit[] = [];
        for (const h of hits) { const a = await patternAllowed(db, r.symbol, h.pattern, "5m"); if (a.ok) allowed.push(h); else await note(db, r, `Skipped ${h.label}: ${a.row?.win_rate}% wins over ${a.row?.n} past signals on this chart`); }
        if (allowed.length) {
          const h = allowed.sort((a, b) => b.strength - a.strength)[0], last = bars.at(-1)!;
          const patt = bars.slice(bars.length - h.bars);
          const side: Side = h.dir === "bullish" ? "long" : "short";
          // Optional: a fresh Kronos forecast that disagrees with the direction vetoes the entry.
          if (gate && (await kronosAgrees(db, r.symbol, side)) === false) { await note(db, r, `Skipped ${h.label}: the Kronos forecast disagrees with a ${side}`); continue; }
          const entry = last.close;
          const lo = Math.min(...patt.map((b) => b.low)), hi = Math.max(...patt.map((b) => b.high)), pad = (hi - lo) * 0.1;
          const stop = r2(side === "long" ? lo - pad : hi + pad), risk = Math.abs(entry - stop);
          if (risk > 0 && risk / entry <= 0.05) {
            const target = r2(side === "long" ? entry + 2 * risk : entry - 2 * risk);
            const qty = isCrypto(r.symbol) ? Math.round((budget / entry) * 1e6) / 1e6 : Math.floor(budget / entry);
            if (qty > 0 && (isCrypto(r.symbol) || qty >= 1)) placed = { symbol: r.symbol, side, type: "limit", price: r2(entry), qty, stop, target, exit_mode: null, note: `Chart auto (signal): ${h.label}${h.volume ? " on volume" : ""} after a ${h.trend} · stop ${stop} · target 2R ${target}` };
          }
        }
      }
      if (!placed) continue;
      const res = await placeOrder(db, r.user, { ...placed, source: "chart" });
      await note(db, r, res.error ? `Could not enter: ${res.error}` : `${res.position ? "Entered" : "Entry order placed"}: ${placed.side} ${placed.qty} @ ${placed.price} (${placed.note.slice(0, 80)})`);
    } catch (e) { console.error("chart auto", r.symbol, e); }
  }
}
