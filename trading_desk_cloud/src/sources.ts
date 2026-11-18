// What every page shows about limits and results comes from here, so two screens cannot disagree:
//  · configView: the desk config plus the thresholds in force for this account, in one object.
//  · sourceStats: closed paper trades grouped by the part of the desk that placed them, with expectancy in R and
//    its lower bound. This is the table the per-source kill switches sit next to.
//  · tradeLog: every closed trade with its source, plan, R and exit reason (the journal's automatic half).
import { getSetting, getSettings } from "./db";
import { DEFAULT_DESK, DESK_BOUNDS, SOURCES, SOURCE_LABEL, deskConfig, sourceOf } from "./deskcfg";
import { getAccount, ensurePaper } from "./paper";
import { PRESETS, type Preset } from "./master";

const r2 = (n: number) => Math.round(n * 100) / 100;
export async function configView(db: D1Database, user: string) {
  const cfg = await deskConfig(db), a = await getAccount(db, user), s = (await getSettings(db)) as unknown as Record<string, unknown>;
  const preset = await getSetting<Preset>(db, `master_preset:${user}`, "balanced"), P = PRESETS[preset] ?? PRESETS.balanced;
  const eff = {
    min_score: a.s.auto_min_score, verdict_min: P.min, preset: P.label, deep_min_score: Number(s.deep_min_score) || 0, risk_pct: a.s.risk_pct,
    max_trades_per_day: Math.min(a.s.auto_max_trades_day, cfg.max_trades_per_day), max_concurrent: Math.min(a.s.auto_max_positions, cfg.max_concurrent), max_armed: P.max,
  };
  return { config: cfg, defaults: DEFAULT_DESK, bounds: DESK_BOUNDS, sources: SOURCES.map((id) => ({ id, label: SOURCE_LABEL[id], off: cfg.sources_off.includes(id) })), effective: eff,
    // The one sentence every page shows.
    summary: `Automatic trading: scan picks scoring ${eff.min_score}+ and Auto Trader verdicts ${eff.verdict_min}+ (${eff.preset}); at most ${eff.max_trades_per_day} entries a day, ${eff.max_concurrent} open at once, ${cfg.max_entries_per_symbol_per_day} per symbol; ${eff.risk_pct}% of equity at risk per trade; new entries stop at -${cfg.daily_loss_halt_pct}% on the day or -${cfg.weekly_loss_halt_pct}% on the week. Deep Analysis runs on picks scoring ${eff.deep_min_score}+.` };
}

type Row = { id: string; symbol: string; side: string; qty: number; entry: number; stop: number | null; exit: number | null; pnl: number | null; source: string; note: string | null; exit_reason: string | null;
  opened_at: number; closed_at: number | null; src: string | null; init_stop: number | null; qty0: number | null; day_closed: string | null };
export const rOf = (t: Row) => { const st = t.init_stop ?? t.stop, q = t.qty0 ?? t.qty, risk = st != null ? Math.abs(t.entry - st) * q : 0; return risk > 0 && t.pnl != null ? t.pnl / risk : null; };
export function statOf(ts: Row[]) {
  const n = ts.length, wins = ts.filter((t) => (t.pnl ?? 0) > 0).length, pnl = ts.reduce((a, t) => a + (t.pnl ?? 0), 0), gp = ts.filter((t) => (t.pnl ?? 0) > 0).reduce((a, t) => a + (t.pnl ?? 0), 0), gl = -ts.filter((t) => (t.pnl ?? 0) <= 0).reduce((a, t) => a + (t.pnl ?? 0), 0);
  const rs = ts.map(rOf).filter((x): x is number => x !== null), avg = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const se = rs.length > 1 && avg !== null ? Math.sqrt(rs.reduce((a, b) => a + (b - avg) ** 2, 0) / (rs.length - 1) / rs.length) : null;
  return { trades: n, wins, win_pct: n ? r2((wins / n) * 100) : null, pnl: r2(pnl), profit_factor: gl > 0 ? r2(gp / gl) : n && gp > 0 ? 99 : null, avg_r: avg === null ? null : r2(avg), r_n: rs.length,
    r_low: avg !== null && se !== null ? r2(avg - 1.96 * se) : null, r_high: avg !== null && se !== null ? r2(avg + 1.96 * se) : null };
}
async function closed(db: D1Database, user: string, days: number): Promise<Row[]> {
  await ensurePaper(db);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return (await db.prepare("SELECT id, symbol, side, qty, entry, stop, exit, pnl, source, note, exit_reason, opened_at, closed_at, src, init_stop, qty0, day_closed FROM paper_positions WHERE user = ? AND status = 'closed' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 2000").bind(user, since).all<Row>()).results;
}
/** Results per part of the desk. `verdict` says what the numbers allow: a source is "earning" only on 30+ trades with a positive lower bound. */
export async function sourceStats(db: D1Database, user: string, days = 90) {
  const cfg = await deskConfig(db), ts = await closed(db, user, days), by = new Map<string, Row[]>();
  for (const t of ts) { const k = t.src || sourceOf(t); by.set(k, [...(by.get(k) || []), t]); }
  const order = ["manual", ...SOURCES];
  const rows = order.filter((k) => by.has(k) || k !== "manual").map((k) => { const st = statOf(by.get(k) || []);
    const verdict = st.trades < 30 ? "too few trades to judge" : st.r_low !== null && st.r_low > 0 ? "earning: positive beyond chance" : st.r_high !== null && st.r_high < 0 ? "losing beyond chance" : st.pnl > 0 ? "positive, not yet proven" : "negative, not yet proven";
    return { id: k, label: SOURCE_LABEL[k] || k, off: cfg.sources_off.includes(k), switchable: k !== "manual", ...st, verdict }; });
  return { days, rows, all: statOf(ts), note: "Trade-level results from closed paper trades. R uses the stop the trade started with. A source should run automatically only when it shows 30+ trades with a positive lower bound." };
}
export async function tradeLog(db: D1Database, user: string, days = 120) {
  const ts = await closed(db, user, days);
  let notes: Record<string, string> = {}; try { notes = (await getSetting<Record<string, string>>(db, `trade_notes:${user}`, {})) || {}; } catch { notes = {}; }
  return { days, trades: ts.slice(0, 500).map((t) => { const r = rOf(t); return { id: t.id, symbol: t.symbol, side: t.side, qty: t.qty0 ?? t.qty, entry: t.entry, exit: t.exit, pnl: t.pnl, r: r === null ? null : r2(r), source: t.src || sourceOf(t), source_label: SOURCE_LABEL[t.src || sourceOf(t)] || t.source,
    plan: (t.note || "").slice(0, 200), exit_reason: t.exit_reason, opened_at: t.opened_at, closed_at: t.closed_at, day: t.day_closed, note: notes[t.id] || "" }; }), stats: statOf(ts) };
}
