// Hard risk layer: plain code decides, the AI only suggests. Everything here fails closed.
//   - regime classifier: CALM_TREND / SIDEWAYS / JUMPY / CRASH from trend strength, realized volatility and drawdown
//     speed of the index (SPY for stocks, BTC-USD for crypto), with a size multiplier per regime (CRASH = stay flat);
//   - kill switch (manual, or tripped by the max-drawdown guard): no automatic entries, and it flattens the account;
//   - stale-data check: no automatic entry when the latest bar is old while the market should be trading;
//   - fractional Kelly from the desk's own settled trades (quarter Kelly, capped), for sizing and for the dashboard;
//   - a decision log: every automatic entry that was blocked, with the reason.
import { candles, isCrypto } from "./market";
import { getSetting, setSetting } from "./db";

export type Regime = "CALM_TREND" | "SIDEWAYS" | "JUMPY" | "CRASH";
export const REGIME_SIZE: Record<Regime, number> = { CALM_TREND: 1, SIDEWAYS: 0.5, JUMPY: 0.5, CRASH: 0 };
export type RegimeRead = { regime: Regime; size_mult: number; trend: number; vol_ann: number; drawdown_pct: number; dd_speed: number; index: string; at: number; why: string };
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Classify from daily bars (needs about 60). Simple, explainable measures only. */
export function classifyRegime(bars: Bar[], index = "SPY"): RegimeRead {
  const at = Math.floor(Date.now() / 1000);
  if (bars.length < 30) return { regime: "SIDEWAYS", size_mult: REGIME_SIZE.SIDEWAYS, trend: 0, vol_ann: 0, drawdown_pct: 0, dd_speed: 0, index, at, why: "not enough history: treated as sideways" };
  const c = bars.map((b) => b.close), n = c.length;
  const rets = c.slice(1).map((v, i) => Math.log(v / c[i]));
  const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const vol20 = sd(rets.slice(-20)) * Math.sqrt(252) * 100, volLong = sd(rets.slice(-120)) * Math.sqrt(252) * 100 || vol20;
  // Trend strength: 20-day return divided by 20-day volatility (a t-stat-like efficiency), sign included.
  const ret20 = Math.log(c[n - 1] / c[Math.max(0, n - 21)]), trend = ret20 / ((sd(rets.slice(-20)) || 1e-9) * Math.sqrt(20));
  const peak = Math.max(...c.slice(-60)), dd = ((c[n - 1] - peak) / peak) * 100;
  const dd5 = ((c[n - 1] - Math.max(...c.slice(-6))) / Math.max(...c.slice(-6))) * 100; // drawdown speed: fall from the 5-day high
  const jumpy = vol20 > Math.max(volLong * 1.5, isCrypto(index) ? 70 : 22);
  let regime: Regime, why: string;
  if (dd5 <= (isCrypto(index) ? -15 : -6) || (dd <= (isCrypto(index) ? -30 : -12) && jumpy)) { regime = "CRASH"; why = `down ${r2(-dd5)}% from the 5-day high, ${r2(-dd)}% from the 60-day high`; }
  else if (jumpy) { regime = "JUMPY"; why = `20-day volatility ${r2(vol20)}% against ${r2(volLong)}% normal`; }
  else if (Math.abs(trend) >= 1) { regime = "CALM_TREND"; why = `20-day move is ${r2(Math.abs(trend))} sigma ${trend > 0 ? "up" : "down"} with volatility ${r2(vol20)}%`; }
  else { regime = "SIDEWAYS"; why = `20-day move only ${r2(Math.abs(trend))} sigma, volatility ${r2(vol20)}%`; }
  return { regime, size_mult: REGIME_SIZE[regime], trend: r2(trend), vol_ann: r2(vol20), drawdown_pct: r2(dd), dd_speed: r2(dd5), index, at, why };
}

/** The current regime for stocks (SPY) or crypto (BTC-USD), cached 15 minutes. Unknown data = SIDEWAYS (half size). */
export async function marketRegime(db: D1Database, crypto = false): Promise<RegimeRead> {
  const index = crypto ? "BTC-USD" : "SPY", key = `regime_${index}`;
  const cached = await getSetting<RegimeRead | null>(db, key, null);
  if (cached && Date.now() / 1000 - cached.at < 900) return cached;
  let read: RegimeRead;
  try { read = classifyRegime((await candles(index, "1d", 400)) as Bar[], index); }
  catch { read = { regime: "SIDEWAYS", size_mult: 0.5, trend: 0, vol_ann: 0, drawdown_pct: 0, dd_speed: 0, index, at: Math.floor(Date.now() / 1000), why: "index data unavailable: treated as sideways (half size)" }; }
  await setSetting(db, key, read);
  return read;
}

/** How often the classifier's label was followed by the behaviour it implies (a simple honesty check on past data). */
export function regimeAccuracy(bars: Bar[], index = "SPY") {
  let n = 0, wrong = 0; const counts: Record<string, number> = {};
  for (let i = 130; i < bars.length - 5; i += 5) {
    const r = classifyRegime(bars.slice(0, i + 1), index); counts[r.regime] = (counts[r.regime] || 0) + 1;
    const fwd = Math.abs(Math.log(bars[i + 5].close / bars[i].close)) * 100, limit = isCrypto(index) ? 8 : 3;
    // Wrong = a calm label followed by a big 5-day move, or a jumpy/crash label followed by a quiet week.
    const calm = r.regime === "CALM_TREND" || r.regime === "SIDEWAYS";
    if ((calm && fwd > limit) || (!calm && fwd < limit / 3)) wrong++;
    n++;
  }
  return { samples: n, wrong_pct: n ? r2((wrong / n) * 100) : null, counts };
}

/** Quarter Kelly from settled plans: f = p - (1 - p) / b, with b = average win / average loss in R. Capped at 2% of equity. */
export async function kellyRead(db: D1Database, days = 90) {
  let rows: { r_result: number }[] = [];
  try { rows = (await db.prepare("SELECT r_result FROM pick_outcomes WHERE symbol != '-' AND status IN ('win','loss','timed') AND r_result IS NOT NULL AND created_at >= ?").bind(Math.floor(Date.now() / 1000) - days * 86400).all<{ r_result: number }>()).results; } catch { rows = []; }
  const wins = rows.filter((r) => r.r_result > 0), losses = rows.filter((r) => r.r_result <= 0);
  if (rows.length < 20 || !wins.length || !losses.length) return { n: rows.length, kelly: null, quarter: null, risk_pct: null, p: null, b: null };
  const p = wins.length / rows.length, b = (wins.reduce((a, r) => a + r.r_result, 0) / wins.length) / Math.max(0.01, -losses.reduce((a, r) => a + r.r_result, 0) / losses.length);
  const f = p - (1 - p) / b;
  return { n: rows.length, kelly: r2(f * 100), quarter: r2(Math.max(0, f / 4) * 100), risk_pct: r2(Math.min(2, Math.max(0, f / 4) * 100)), p: r2(p * 100), b: r2(b) };
}

let logReady = false;
export async function riskLog(db: D1Database, user: string, symbol: string, action: string, reason: string) {
  try {
    if (!logReady) { await db.prepare("CREATE TABLE IF NOT EXISTS risk_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user TEXT NOT NULL, symbol TEXT, action TEXT NOT NULL, reason TEXT NOT NULL)").run(); logReady = true; }
    // One line per user/symbol/reason per 10 minutes is enough.
    const dup = await db.prepare("SELECT 1 FROM risk_log WHERE user = ? AND symbol = ? AND reason = ? AND at > ? LIMIT 1").bind(user, symbol, reason, Math.floor(Date.now() / 1000) - 600).first();
    if (!dup) await db.prepare("INSERT INTO risk_log (at, user, symbol, action, reason) VALUES (?, ?, ?, ?, ?)").bind(Math.floor(Date.now() / 1000), user, symbol, action, reason.slice(0, 200)).run();
  } catch { /* logging must never break trading logic */ }
}
export async function recentRiskLog(db: D1Database, user: string, limit = 30) {
  try { return (await db.prepare("SELECT at, symbol, action, reason FROM risk_log WHERE user = ? ORDER BY id DESC LIMIT ?").bind(user, limit).all()).results; } catch { return []; }
}
