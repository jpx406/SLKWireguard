// Pairs trading: is the pair really cointegrated, how fast does it revert, and is the hedge ratio still right?
// Four building blocks, all on daily log prices:
//   1. Engle-Granger   regress log A on log B for the hedge ratio, then test the residual (the spread) for
//                      stationarity with an augmented Dickey-Fuller test against cointegration critical values.
//   2. Ornstein-Uhlenbeck  fit the spread as a mean-reverting process: speed, long-run mean, noise, half-life.
//   3. Kalman filter   let the hedge ratio drift: a two-state filter (slope, intercept) updated one bar at a time.
//   4. Z-score rule    fade the extremes of the spread and exit near its mean, tested with next-bar fills and costs.
// Everything that produces a trade is causal: a bar's signal uses that bar and earlier ones only.
import { candles, isCrypto } from "./market";

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Row = { day: string; time: number; a: number; b: number; ao: number; bo: number };
const r2 = (v: number) => Math.round(v * 100) / 100, r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / Math.max(v.length, 1);
const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(v.length - 1, 1)); };

/** Bars of two symbols on the days both traded. */
export function align(A: Bar[], B: Bar[]): Row[] {
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10), m = new Map(B.map((x) => [day(x.time), x])), out: Row[] = [];
  for (const x of A) { const y = m.get(day(x.time)); if (y && x.close > 0 && y.close > 0) out.push({ day: day(x.time), time: x.time, a: Math.log(x.close), b: Math.log(y.close), ao: x.open, bo: y.open }); }
  return out;
}

/** Least squares with a few regressors (normal equations, Gaussian elimination). Returns coefficients, their standard errors and the residuals. */
export function ols(y: number[], X: number[][]): { beta: number[]; se: number[]; resid: number[] } {
  const n = y.length, k = X[0].length, A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < n; i++) for (let p = 0; p < k; p++) { A[p][k] += X[i][p] * y[i]; for (let q = 0; q < k; q++) A[p][q] += X[i][p] * X[i][q]; }
  const M = A.map((r) => r.slice()), inv = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  for (let c = 0; c < k; c++) { let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; [M[c], M[piv]] = [M[piv], M[c]]; [inv[c], inv[piv]] = [inv[piv], inv[c]]; const d = M[c][c] || 1e-12;
    for (let j = 0; j <= k; j++) M[c][j] /= d; for (let j = 0; j < k; j++) inv[c][j] /= d;
    for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j <= k; j++) M[r][j] -= f * M[c][j]; for (let j = 0; j < k; j++) inv[r][j] -= f * inv[c][j]; } }
  const beta = M.map((r) => r[k]), resid = y.map((v, i) => v - X[i].reduce((s, x, p) => s + x * beta[p], 0)), s2 = resid.reduce((s, e) => s + e * e, 0) / Math.max(n - k, 1);
  return { beta, se: inv.map((r, i) => Math.sqrt(Math.max(s2 * r[i], 0))), resid };
}

/** Augmented Dickey-Fuller t-statistic on a zero-mean series (no constant, `lags` lagged differences). More negative = more stationary. */
export function adf(u: number[], lags = 1): number {
  const y: number[] = [], X: number[][] = [];
  for (let t = lags + 1; t < u.length; t++) { y.push(u[t] - u[t - 1]); const row = [u[t - 1]]; for (let l = 1; l <= lags; l++) row.push(u[t - l] - u[t - l - 1]); X.push(row); }
  if (y.length < 30) return NaN; const f = ols(y, X); return f.se[0] ? f.beta[0] / f.se[0] : NaN;
}
// Critical values for the residual of a two-variable cointegrating regression with a constant (MacKinnon, asymptotic).
export const EG_CRIT = { p01: -3.9, p05: -3.34, p10: -3.04 };
const verdictOf = (t: number) => (Number.isNaN(t) ? "not enough data" : t <= EG_CRIT.p01 ? "cointegrated (1% level)" : t <= EG_CRIT.p05 ? "cointegrated (5% level)" : t <= EG_CRIT.p10 ? "weak evidence (10% level)" : "not cointegrated");

export type EG = { beta: number; alpha: number; t: number; verdict: string; passes: boolean; spread: number[] };
/** Step 1: log A = alpha + beta·log B + spread; then ADF on the spread. */
export function engleGranger(a: number[], b: number[]): EG {
  const f = ols(a, b.map((x) => [1, x])), t = adf(f.resid, 1);
  return { alpha: f.beta[0], beta: f.beta[1], t: Number.isNaN(t) ? NaN : r2(t), verdict: verdictOf(t), passes: t <= EG_CRIT.p05, spread: f.resid };
}

export type OU = { half_life: number | null; theta: number | null; mu: number; sigma: number; sigma_eq: number | null; phi: number };
/** Step 2: spread[t] = c + phi·spread[t-1] + noise. Mean reversion needs 0 < phi < 1; half-life = -ln 2 / ln phi bars. */
export function ornsteinUhlenbeck(s: number[]): OU {
  const f = ols(s.slice(1), s.slice(0, -1).map((x) => [1, x])), phi = f.beta[1], ok = phi > 0 && phi < 1, sig = sd(f.resid);
  return { phi: r4(phi), half_life: ok ? r2(-Math.LN2 / Math.log(phi)) : null, theta: ok ? r4(-Math.log(phi)) : null, mu: ok ? f.beta[0] / (1 - phi) : mean(s), sigma: sig, sigma_eq: ok ? sig / Math.sqrt(1 - phi * phi) : null };
}

/** Step 3: a hedge ratio that drifts. State = [beta, alpha] as a random walk; each bar predicts log A from log B, then learns from the miss.
 *  Returns, per bar, the slope and intercept known BEFORE that bar (so they can be traded on), and the prediction error. */
export function kalman(a: number[], b: number[], delta = 1e-5, alphaShare = 0.02): { beta: number[]; alpha: number[]; err: number[]; sdev: number[] } {
  const n = a.length, warm = Math.min(60, Math.floor(n / 4)), bm = mean(b.slice(0, warm)), init = ols(a.slice(0, warm), b.slice(0, warm).map((x) => [1, x - bm]));
  // log B is centred so that slope and level are learned separately; the level is allowed to move far less than the slope,
  // otherwise the filter explains the spread away as a moving level and leaves nothing to trade.
  let be = init.beta[1], al = init.beta[0], P = [[1e-3, 0], [0, 1e-5]]; const Ve = Math.max(init.resid.reduce((s, e) => s + e * e, 0) / Math.max(warm - 2, 1), 1e-8), qb = delta / (1 - delta), qa = qb * alphaShare;
  const beta: number[] = [], alpha: number[] = [], err: number[] = [], sdev: number[] = [];
  for (let t = 0; t < n; t++) {
    P = [[P[0][0] + qb, P[0][1]], [P[1][0], P[1][1] + qa]]; // the ratio may have moved since yesterday
    const x = b[t] - bm, yhat = be * x + al, e = a[t] - yhat, S = x * x * P[0][0] + 2 * x * P[0][1] + P[1][1] + Ve;
    beta.push(be); alpha.push(al - be * bm); err.push(e); sdev.push(Math.sqrt(S));
    const K0 = (P[0][0] * x + P[0][1]) / S, K1 = (P[1][0] * x + P[1][1]) / S; be += K0 * e; al += K1 * e;
    P = [[P[0][0] - K0 * (x * P[0][0] + P[0][1]), P[0][1] - K0 * (x * P[0][1] + P[1][1])], [P[1][0] - K1 * (x * P[0][0] + P[0][1]), P[1][1] - K1 * (x * P[0][1] + P[1][1])]];
  }
  return { beta, alpha, err, sdev };
}

export type PairTrade = { side: "long spread" | "short spread"; entry_day: string; exit_day: string; days: number; z_in: number; pct: number; reason: string };
export type PairTest = { trades: number; win_rate: number | null; total_pct: number; avg_pct: number | null; max_dd_pct: number; sharpe: number | null; avg_days: number | null; in_market_pct: number; list: PairTrade[]; equity: number[]; open: { side: string; since: string; z_in: number } | null };
/** Step 4: the z-score rule. z[t] is the spread against its own rolling mean and deviation (bars up to t only).
 *  Long the spread (buy A, short beta·B) below -entry, short it above +entry, close inside ±exit, give up beyond ±stop.
 *  A signal on a close is filled at the next bar's open on both legs; `fee` is charged per leg per fill. */
export function zscoreTest(rows: Row[], beta: number[], z: (number | null)[], from: number, o: { entry: number; exit: number; stop: number; fee_pct: number; max_days: number }): PairTest {
  const fee = o.fee_pct / 100; let pos = 0, hb = 0, ea = 0, eb = 0, ei = 0, zin = 0, eq = 1, peak = 1, dd = 0, inBars = 0, blocked = false;
  const list: PairTrade[] = [], equity: number[] = [], daily: number[] = [];
  const close = (i: number, pa: number, pb: number, reason: string) => { const g = pos * ((pa / ea - 1) - hb * (pb / eb - 1)) / (1 + Math.abs(hb)) - 2 * fee; list.push({ side: pos === 1 ? "long spread" : "short spread", entry_day: rows[ei].day, exit_day: rows[i].day, days: i - ei, z_in: r2(zin), pct: r2(g * 100), reason }); pos = 0; };
  for (let i = from; i < rows.length; i++) {
    const A = Math.exp(rows[i].a), B = Math.exp(rows[i].b), pA = Math.exp(rows[i - 1].a), pB = Math.exp(rows[i - 1].b), zp = z[i - 1];
    let ret = 0;
    // act at this bar's open on what the previous close said
    if (pos !== 0 && zp !== null) { const out = pos === 1 ? zp >= -o.exit : zp <= o.exit, // back to the mean, including a jump straight through it
      stop = Math.abs(zp) >= o.stop, old = i - ei >= o.max_days;
      if (out || stop || old) { ret += pos * ((rows[i].ao / pA - 1) - hb * (rows[i].bo / pB - 1)) / (1 + Math.abs(hb)) - fee; close(i, rows[i].ao, rows[i].bo, stop ? "stop: spread kept widening" : old ? "time limit" : "back near the mean"); if (stop) blocked = true; daily.push(ret); eq *= 1 + ret; equity.push(eq); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); continue; } }
    if (blocked && zp !== null && Math.abs(zp) < o.entry) blocked = false; // after a stop, wait for the spread to come back inside before trading it again
    if (pos === 0 && !blocked && zp !== null && Math.abs(zp) >= o.entry && Math.abs(zp) < o.stop && Number.isFinite(beta[i - 1])) {
      pos = zp < 0 ? 1 : -1; hb = beta[i - 1]; ea = rows[i].ao; eb = rows[i].bo; ei = i; zin = zp;
      ret += pos * ((A / ea - 1) - hb * (B / eb - 1)) / (1 + Math.abs(hb)) - fee; // from the open to today's close, less the entry cost
    } else if (pos !== 0) ret += pos * ((A / pA - 1) - hb * (B / pB - 1)) / (1 + Math.abs(hb));
    if (pos !== 0) inBars++;
    daily.push(ret); eq *= 1 + ret; equity.push(eq); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
  }
  const wins = list.filter((t) => t.pct > 0).length, sdd = sd(daily), every = Math.max(1, Math.ceil(equity.length / 240));
  return { trades: list.length, win_rate: list.length ? r4(wins / list.length) : null, total_pct: r2((eq - 1) * 100), avg_pct: list.length ? r2(mean(list.map((t) => t.pct))) : null, max_dd_pct: r2(dd * 100), sharpe: sdd > 0 && daily.length > 20 ? r2((mean(daily) / sdd) * Math.sqrt(252)) : null,
    avg_days: list.length ? r2(mean(list.map((t) => t.days))) : null, in_market_pct: r2((inBars / Math.max(daily.length, 1)) * 100), list: list.slice(-60), equity: equity.filter((_, i) => i % every === 0 || i === equity.length - 1).map(r4),
    open: pos ? { side: pos === 1 ? "long spread" : "short spread", since: rows[ei].day, z_in: r2(zin) } : null };
}
/** z of a series against its trailing window (the bar itself included, nothing after it). */
export function rollingZ(s: number[], w: number): (number | null)[] { return s.map((v, i) => { if (i < w - 1) return null; const win = s.slice(i - w + 1, i + 1), d = sd(win); return d > 0 ? (v - mean(win)) / d : null; }); }

export type PairOptions = { entry?: number; exit?: number; stop?: number; fee_pct?: number; window?: number };
/** The whole analysis of one pair. A is the leg being explained; if the test is stronger the other way round, the legs are swapped and it says so. */
export function analyzePair(symA: string, symB: string, A: Bar[], B: Bar[], opt: PairOptions = {}) {
  let rows = align(A, B); if (rows.length < 250) throw new Error(`Only ${rows.length} days where both ${symA} and ${symB} traded: at least 250 are needed.`);
  rows = rows.slice(-756);
  let a = rows.map((r) => r.a), b = rows.map((r) => r.b), eg = engleGranger(a, b), swapped = false; const other = engleGranger(b, a);
  if (!Number.isNaN(other.t) && (Number.isNaN(eg.t) || other.t < eg.t)) { swapped = true; rows = rows.map((r) => ({ ...r, a: r.b, b: r.a, ao: r.bo, bo: r.ao })); [a, b] = [b, a]; eg = other; [symA, symB] = [symB, symA]; }
  const n = rows.length, half = Math.floor(n / 2), cut = Math.floor(n * 0.6);
  const ou = ornsteinUhlenbeck(eg.spread), hl = ou.half_life, W = Math.round(Math.min(120, Math.max(20, opt.window || (hl ? hl * 2 : 40))));
  const entry = Math.min(4, Math.max(0.5, opt.entry ?? 2)), exit = Math.min(entry - 0.25, Math.max(0, opt.exit ?? 0.5)), stop = Math.max(entry + 0.5, opt.stop ?? 4), fee = Math.min(0.5, Math.max(0, opt.fee_pct ?? 0.02)), max_days = Math.round(Math.min(120, Math.max(10, (hl || 20) * 4)));
  const rule = { entry, exit, stop, fee_pct: fee, max_days };
  // Stability: the same test on each half of the history. A pair that only passes on the whole sample is suspect.
  const e1 = engleGranger(a.slice(0, half), b.slice(0, half)), e2 = engleGranger(a.slice(half), b.slice(half));
  // Static: the ratio is fixed on the first 60% (formation) and traded on the last 40% only (out of sample).
  const form = engleGranger(a.slice(0, cut), b.slice(0, cut)), sStat = a.map((v, i) => v - form.beta * b[i]), zStat = rollingZ(sStat, W), statOOS = zscoreTest(rows, a.map(() => form.beta), zStat, cut, rule);
  // Kalman: the ratio is updated every bar; it is causal throughout, and is reported for the same last 40% and for the whole run.
  const kf = kalman(a, b), sKf = a.map((v, i) => v - kf.beta[i] * b[i] - kf.alpha[i]), zKf = rollingZ(sKf, W), kfOOS = zscoreTest(rows, kf.beta, zKf, cut, rule), kfAll = zscoreTest(rows, kf.beta, zKf, Math.max(W + 1, 80), rule);
  const zFull = rollingZ(eg.spread, W), zn = zKf[n - 1], zs = zStat[n - 1];
  const drift = r4((kf.beta[n - 1] - form.beta) / (Math.abs(form.beta) || 1)), corr = (() => { const ra = a.slice(1).map((v, i) => v - a[i]), rb = b.slice(1).map((v, i) => v - b[i]), ma = mean(ra), mb = mean(rb); let c = 0, va = 0, vb = 0; for (let i = 0; i < ra.length; i++) { c += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; } return va && vb ? r2(c / Math.sqrt(va * vb)) : null; })();
  // A negative ratio means the two legs would both be bought (or both sold): that is a bet on both, not a hedge.
  const hedged = eg.beta > 0 && kf.beta[n - 1] > 0, stable = e1.t <= EG_CRIT.p10 && e2.t <= EG_CRIT.p10, tradable = eg.passes && hedged && hl !== null && hl >= 2 && hl <= 60;
  const signal = zn == null ? { action: "wait", text: "Not enough bars yet." } : !hedged ? { action: "no trade", text: `The hedge ratio is negative (${r2(kf.beta[n - 1])}): over this period ${symA} and ${symB} moved in opposite directions, so one cannot hedge the other.` } : !eg.passes ? { action: "no trade", text: `Spread is ${r2(zn)} deviations from its mean, but the pair fails the cointegration test: there is no reason to expect it to come back.` } : Math.abs(zn) >= stop ? { action: "stand aside", text: `The spread is ${r2(zn)} deviations out: past the stop level, so the relationship may be breaking. Do not enter.` }
    : zn <= -entry ? { action: "long spread", text: `Spread is ${r2(zn)} deviations below its mean: buy ${symA}, short ${symB}, $${r2(Math.abs(kf.beta[n - 1]))} of ${symB} per $1 of ${symA}.` }
    : zn >= entry ? { action: "short spread", text: `Spread is ${r2(zn)} deviations above its mean: short ${symA}, buy ${symB}, $${r2(Math.abs(kf.beta[n - 1]))} of ${symB} per $1 of ${symA}.` }
    : Math.abs(zn) <= exit ? { action: "flat", text: `Spread is at its mean (z ${r2(zn)}): nothing to fade; close any open pair trade.` } : { action: "wait", text: `Spread is ${r2(zn)} deviations from its mean: inside the ±${entry} entry band.` };
  const every = Math.max(1, Math.ceil(n / 260)), pick = <T>(v: T[]) => v.filter((_, i) => i % every === 0 || i === n - 1);
  return {
    a: symA, b: symB, swapped, days: n, from: rows[0].day, to: rows[n - 1].day, corr,
    hedged, engle_granger: { beta: r4(eg.beta), alpha: r4(eg.alpha), t: eg.t, critical: EG_CRIT, verdict: eg.verdict, passes: eg.passes, first_half_t: e1.t, second_half_t: e2.t, stable },
    ou: { half_life: hl, theta: ou.theta, phi: ou.phi, mu: r4(ou.mu), sigma: r4(ou.sigma), sigma_eq: ou.sigma_eq == null ? null : r4(ou.sigma_eq), window: W, note: hl === null ? "The spread does not pull back to a mean (no half-life)." : hl < 2 ? "It reverts within a day or two: too fast to trade on daily bars after costs." : hl > 60 ? "It takes months to revert: capital is tied up too long and the relationship may change first." : `Half of a gap closes in about ${hl} trading days.` },
    kalman: { beta_now: r4(kf.beta[n - 1]), beta_formation: r4(form.beta), beta_full: r4(eg.beta), drift_pct: r2(drift * 100), min: r4(Math.min(...kf.beta.slice(60))), max: r4(Math.max(...kf.beta.slice(60))), note: Math.abs(drift) > 0.15 ? `The hedge ratio has moved ${r2(drift * 100)}% since the formation period: a fixed ratio is no longer right.` : "The hedge ratio has stayed close to its formation value." },
    rule, signal, tradable, z_now: zn == null ? null : r2(zn), z_static_now: zs == null ? null : r2(zs),
    tests: { static_oos: statOOS, kalman_oos: kfOOS, kalman_all: kfAll, oos_from: rows[cut].day },
    series: { day: pick(rows.map((r) => r.day)), spread: pick(eg.spread.map(r4)), z: pick(zKf.map((v) => (v == null ? null : r2(v)))), z_static: pick(zStat.map((v) => (v == null ? null : r2(v)))), z_full: pick(zFull.map((v) => (v == null ? null : r2(v)))), beta: pick(kf.beta.map(r4)), cut_index: Math.floor(cut / every) },
    verdict: !hedged ? `Not a pair to trade: the hedge ratio is negative, so ${symA} and ${symB} have been drifting apart rather than moving together.` : !eg.passes ? `Not a pair to trade: the spread is not stationary (test ${eg.t}, needs ${EG_CRIT.p05} or lower). Two stocks moving together is not enough.` : !stable ? "Passes on the whole history but not in both halves: the relationship may be an accident of the sample. Treat with suspicion." : !tradable ? `Cointegrated, but ${hl === null ? "it does not revert" : hl < 2 ? "it reverts too fast" : "it reverts too slowly"} to trade on daily bars.` : "Cointegrated in the whole history and in both halves, with a tradable half-life.",
  };
}

// Pairs worth checking: same business, same drivers. Scanning many pairs finds some that pass by luck, which is why each also has to pass in both halves.
const CANDIDATES: [string, string][] = [["KO", "PEP"], ["XOM", "CVX"], ["V", "MA"], ["JPM", "BAC"], ["HD", "LOW"], ["GLD", "GDX"], ["SPY", "QQQ"], ["MSFT", "GOOGL"], ["AMD", "NVDA"], ["WMT", "COST"], ["GS", "MS"], ["UPS", "FDX"], ["T", "VZ"], ["PFE", "MRK"], ["CAT", "DE"], ["SPY", "IWM"], ["XLE", "XOP"], ["EWA", "EWC"], ["BTC-USD", "ETH-USD"], ["ETH-USD", "SOL-USD"]];
let scanCache: { at: number; key: string; rows: unknown[] } | null = null;
/** Rank the candidate pairs and the watchlist's own pairs by the strength of the cointegration test. */
export async function scanPairs(watchlist: string[]) {
  const wl = [...new Set(watchlist.map((s) => s.toUpperCase()))].slice(0, 8), extra: [string, string][] = [];
  for (let i = 0; i < wl.length; i++) for (let j = i + 1; j < wl.length; j++) if (isCrypto(wl[i]) === isCrypto(wl[j])) extra.push([wl[i], wl[j]]);
  // At most 40 symbols are fetched, so one scan stays inside a Worker's request budget.
  const seen = new Set<string>(), syms0 = new Set<string>(), pairs = [...extra, ...CANDIDATES].filter(([x, y]) => { const k = [x, y].sort().join("|"); if (seen.has(k)) return false; const add = [x, y].filter((q) => !syms0.has(q)); if (syms0.size + add.length > 40) return false; seen.add(k); add.forEach((q) => syms0.add(q)); return true; }).slice(0, 48), key = pairs.map((p) => p.join("/")).join(",");
  if (scanCache && scanCache.key === key && Date.now() - scanCache.at < 1800_000) return { rows: scanCache.rows, cached: true, tested: pairs.length };
  const syms = [...new Set(pairs.flat())], bars: Record<string, Bar[]> = {};
  await Promise.all(syms.map(async (s) => { try { bars[s] = (await candles(s, "1d", 1100)) as Bar[]; } catch { bars[s] = []; } }));
  const rows: unknown[] = [];
  for (const [x, y] of pairs) { try { const r = analyzePair(x, y, bars[x], bars[y]); rows.push({ a: r.a, b: r.b, t: r.engle_granger.t, verdict: r.engle_granger.verdict, passes: r.engle_granger.passes && r.hedged, stable: r.engle_granger.stable, tradable: r.tradable && r.engle_granger.stable, half_life: r.ou.half_life, beta: r.kalman.beta_now, drift_pct: r.kalman.drift_pct, z: r.z_now, corr: r.corr, action: r.signal.action, oos_pct: r.tests.kalman_oos.total_pct, oos_trades: r.tests.kalman_oos.trades }); } catch { /* not enough history */ } }
  rows.sort((p, q) => (p as { t: number }).t - (q as { t: number }).t);
  scanCache = { at: Date.now(), key, rows }; return { rows, cached: false, tested: pairs.length };
}
export async function pairDetail(a: string, b: string, opt: PairOptions) {
  const A = (await candles(a, "1d", 1100)) as Bar[], B = (await candles(b, "1d", 1100)) as Bar[];
  return analyzePair(a, b, A, B, opt);
}
