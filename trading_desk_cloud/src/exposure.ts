// Exposure-adjusted benchmark for the dashboard. "Paper vs SPY" compares an account that is mostly in cash with an
// index that is always fully invested, which says little. The fair line is SPY's return over the same period scaled
// by how much of the account was actually in the market on average.
// Average exposure is an ESTIMATE: every paper position's cost (shares it started with × entry price) is counted for
// the clock time it was open, summed, and divided by (length of the period × average equity). Nights and weekends
// count on both sides, as they do in SPY's return. Positions that scaled out are counted at full size until closed.

export type ExpPos = { qty: number; qty0: number | null; entry: number; opened_at: number; closed_at: number | null };
export type Exposure = { avg_exposure_pct: number; spy_pct: number | null; spy_adjusted_pct: number | null; from: string; days: number; positions: number; method: string };

export const EXPOSURE_METHOD = "Estimated from the paper positions: each position's cost (starting shares × entry price) for the time it was open, divided by the average equity over the period. Clock time, nights and weekends included.";

/** Time-weighted invested fraction of equity between startSec and endSec (0..n; above 1 would mean leverage). Pure. */
export function avgExposure(positions: ExpPos[], startSec: number, endSec: number, avgEquity: number): number {
  const span = endSec - startSec;
  if (!(span > 0) || !(avgEquity > 0)) return 0;
  let dollarSeconds = 0;
  for (const p of positions) {
    const from = Math.max(p.opened_at, startSec), to = Math.min(p.closed_at ?? endSec, endSec), notional = Math.abs((p.qty0 ?? p.qty) * p.entry);
    if (to > from && Number.isFinite(notional)) dollarSeconds += notional * (to - from);
  }
  return dollarSeconds / (span * avgEquity);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/** firstDay: the first day of the equity curve (YYYY-MM-DD) or null when there is no history yet. */
export async function exposureFor(db: D1Database, user: string, firstDay: string | null | undefined, equities: number[], bench: { day: string; pct: number }[], nowSec = Math.floor(Date.now() / 1000)): Promise<(Exposure & { benchmark_adjusted: { day: string; pct: number }[] }) | null> {
  if (!firstDay) return null;
  const start = Math.floor(Date.parse(`${firstDay}T00:00:00Z`) / 1000);
  if (!Number.isFinite(start) || nowSec <= start) return null;
  let rows: ExpPos[] = [];
  try { rows = (await db.prepare("SELECT qty, qty0, entry, opened_at, closed_at FROM paper_positions WHERE user = ? AND opened_at < ? AND (closed_at IS NULL OR closed_at > ?) LIMIT 5000").bind(user, nowSec, start).all<ExpPos>()).results; } catch { return null; }
  const eqs = equities.filter((x) => x > 0), avgEq = eqs.length ? eqs.reduce((a, b) => a + b, 0) / eqs.length : 0;
  const f = avgExposure(rows, start, nowSec, avgEq), spy = bench.length ? bench[bench.length - 1].pct : null;
  return { avg_exposure_pct: r2(f * 100), spy_pct: spy, spy_adjusted_pct: spy === null ? null : r2(spy * f), from: firstDay, days: Math.max(1, Math.round((nowSec - start) / 86400)), positions: rows.length, method: EXPOSURE_METHOD,
    benchmark_adjusted: bench.map((b) => ({ day: b.day, pct: r2(b.pct * f) })) };
}
