// One settings source of truth for everything automatic. Every entry path (scan routines, chart autopilot, copy
// desk, Deep Analysis, strategy auto-trader) reads its limits and switches from this object, and every page that
// shows a threshold renders it from here (GET /api/config), so two screens can no longer disagree.
// Stored once for the desk (admin edits it). Per-account settings may be stricter, never looser.
import { getSetting, setSetting } from "./db";

export type DeskConfig = {
  // --- risk gate (automatic entries only; manual trades are never blocked by it)
  max_trades_per_day: number;            // automatic entries per account per day, all sources together
  max_concurrent: number;                // open positions + working orders
  max_entries_per_symbol_per_day: number;
  cooldown_after_stop_min: number;       // minutes before the same symbol may be entered again after a stop
  daily_loss_halt_pct: number;           // today's P&L at -x% of equity: no new automatic entries today (positions kept)
  weekly_loss_halt_pct: number;          // this week's P&L at -x% of equity: none for the rest of the week
  sources_off: string[];                 // per-source kill switch: "routine" | "copy" | "chart_signal" | "chart_plan" | "deep" | "strategy"
  // --- switches that default to OFF until their own results earn them back
  kronos_gate: boolean;
  crypto_autotrade: boolean;
  candle_grades_allowed: string[];       // ML filter grades the chart autopilot may trade
  candle_patterns_blocked: string[];     // never traded
  candle_patterns_research: string[];    // traded without a grade, as a small research bucket
  signal_blackout_ny: string[];          // "HH:MM-HH:MM" New York windows with no candle-signal entries
  // --- order engine
  confirm_minutes: number;               // stop_on_close: bar size that must CLOSE beyond the trigger
  max_chase_atr: number;                 // no fill when price is already beyond the trigger by more than this × daily ATR(14)
  risk_min_pct: number;                  // a trade risking less than this % of equity is not worth its costs: skip
  max_notional_pct: number;              // cap a position at this % of equity
  signal_min_stop_atr: number;           // candle signals: pattern stop must be at least this × ATR(14) of the chart…
  signal_min_stop_pct: number;           // …and this % of price, otherwise the signal is rejected
  stop_slippage_pct: number;             // a stop fills this much worse than its price
  commission_per_share: number;
  max_bar_age_min: number;               // no automatic entry when the newest bar is older than this while the market trades
  exit_model: "fixed" | "scale";         // scale = half off at +1R, stop to break-even, trail the rest by 1 × ATR
  copy_stop_atr: number; copy_min_rr: number; copy_hold_days: number; // insider / 13F plans are swing trades
};
export const DEFAULT_DESK: DeskConfig = {
  max_trades_per_day: 10, max_concurrent: 5, max_entries_per_symbol_per_day: 2, cooldown_after_stop_min: 30, daily_loss_halt_pct: 1, weekly_loss_halt_pct: 3, sources_off: [],
  kronos_gate: false, crypto_autotrade: false, candle_grades_allowed: ["A"], candle_patterns_blocked: ["piercingLine", "threeOutsideUp"], candle_patterns_research: ["morningStar", "bullishKicker"], signal_blackout_ny: ["09:30-10:30"],
  confirm_minutes: 5, max_chase_atr: 0.3, risk_min_pct: 0.25, max_notional_pct: 20, signal_min_stop_atr: 1, signal_min_stop_pct: 0.5, stop_slippage_pct: 0.05, commission_per_share: 0, max_bar_age_min: 2,
  exit_model: "scale", copy_stop_atr: 1.5, copy_min_rr: 3, copy_hold_days: 10,
};
export const SOURCES = ["routine", "copy", "chart_signal", "chart_plan", "deep", "strategy"] as const;
export const SOURCE_LABEL: Record<string, string> = { routine: "Scan routines", copy: "Winners / copy desk", chart_signal: "Chart autopilot: candle signals", chart_plan: "Chart autopilot: plans", deep: "Deep Analysis", strategy: "TV strategy auto-trader", manual: "Manual" };
const B: Record<string, [number, number]> = { max_trades_per_day: [1, 200], max_concurrent: [1, 50], max_entries_per_symbol_per_day: [1, 20], cooldown_after_stop_min: [0, 1440], daily_loss_halt_pct: [0, 20], weekly_loss_halt_pct: [0, 50], confirm_minutes: [1, 60], max_chase_atr: [0, 5], risk_min_pct: [0, 5], max_notional_pct: [1, 100], signal_min_stop_atr: [0, 10], signal_min_stop_pct: [0, 10],
  stop_slippage_pct: [0, 2], commission_per_share: [0, 1], max_bar_age_min: [1, 120], copy_stop_atr: [0.5, 6], copy_min_rr: [1, 10], copy_hold_days: [2, 60] };
export const DESK_BOUNDS = B;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeDesk(x: unknown, base: DeskConfig = DEFAULT_DESK): DeskConfig {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>, out = { ...base } as Record<string, unknown>;
  for (const [k, [lo, hi]] of Object.entries(B)) { const n = Number(o[k]); if (o[k] !== undefined && o[k] !== null && o[k] !== "" && Number.isFinite(n)) out[k] = Math.round(Math.min(hi, Math.max(lo, n)) * 1000) / 1000; }
  for (const k of ["kronos_gate", "crypto_autotrade"]) if (typeof o[k] === "boolean") out[k] = o[k];
  const list = (v: unknown, ok: (s: string) => boolean) => (Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim()).filter(ok))].slice(0, 60) : null);
  const a = list(o.candle_grades_allowed, (s) => ["A", "B", "C"].includes(s)); if (a) out.candle_grades_allowed = a;
  for (const k of ["candle_patterns_blocked", "candle_patterns_research"]) { const v = list(o[k], (s) => /^[A-Za-z]{3,40}$/.test(s)); if (v) out[k] = v; }
  const w = list(o.signal_blackout_ny, (s) => HHMM.test(s)); if (w) out.signal_blackout_ny = w;
  const so = list(o.sources_off, (s) => (SOURCES as readonly string[]).includes(s)); if (so) out.sources_off = so;
  if (o.exit_model === "fixed" || o.exit_model === "scale") out.exit_model = o.exit_model;
  return out as DeskConfig;
}
let cache: { at: number; v: DeskConfig } | null = null;
export async function deskConfig(db: D1Database): Promise<DeskConfig> {
  if (cache && Date.now() - cache.at < 5000) return cache.v;
  let v = DEFAULT_DESK; try { v = sanitizeDesk(await getSetting<unknown>(db, "desk_config", null)); } catch { /* defaults */ }
  cache = { at: Date.now(), v }; return v;
}
export async function saveDeskConfig(db: D1Database, patch: unknown, reset = false): Promise<DeskConfig> {
  const next = reset ? DEFAULT_DESK : sanitizeDesk(patch, await deskConfig(db));
  await setSetting(db, "desk_config", next); cache = { at: Date.now(), v: next }; return next;
}
/** Is New York time `minutes` inside one of the blackout windows? */
export const inBlackout = (windows: string[], minutes: number) => windows.some((w) => { const [a, b] = w.split("-").map((x) => +x.slice(0, 2) * 60 + +x.slice(3, 5)); return minutes >= a && minutes < b; });

/** Which part of the desk an order came from, for the per-source kill switch and the per-source results. */
export function sourceOf(o: { source?: string | null; note?: string | null }): string {
  const n = o.note || "";
  if (o.source === "tv") return "strategy";
  if (o.source === "chart") return /^Chart auto \(signal\)/.test(n) ? "chart_signal" : /^Chart auto \(Deep/.test(n) ? "deep" : /^Chart auto \(Winners|copy desk/i.test(n) ? "copy" : "chart_plan";
  if (o.source === "auto") return /^Winners|copy desk/i.test(n) ? "copy" : /Deep Analysis/.test(n) ? "deep" : "routine";
  return "manual";
}

export type EntryType = "limit" | "stop" | "stop_on_close";
/** How a plan's entry is meant to be reached. An explicit entry_type wins; then the words of the setup; then geometry:
 *  a long whose trigger is above the market (or a short whose trigger is below) can only be a breakout. */
export function entryTypeOf(p: { entry_type?: unknown; setup?: string | null; slot?: string | null; side: "long" | "short"; entry: number; last?: number | null }): EntryType {
  const e = String(p.entry_type || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (e === "limit" || e === "stop" || e === "stop_on_close") return e;
  const s = `${p.setup || ""}`.toLowerCase();
  if (/pullback|pull-back|retest|dip|support|reversal|bounce|mean.?reversion|oversold|fade|hammer|engulf|limit/.test(s) && !/break(s|ing)? ?(out|above|below)|close above|close below/.test(s)) return "limit";
  if (/break|orb|opening.?range|gap.?and.?go|close above|close below|above (the )?(pre|pm|pdh|high)|below (the )?(pre|pdl|low)|reclaim|momentum|trigger|new high/.test(s) || p.slot === "winners") return "stop_on_close";
  if (p.last != null && p.last > 0) return (p.side === "long" ? p.entry > p.last * 1.0005 : p.entry < p.last * 0.9995) ? "stop_on_close" : "limit";
  return "limit";
}
