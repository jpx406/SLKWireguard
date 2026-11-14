// ML engine, part 1: features and labels. Everything here is causal: a feature at bar i uses bars 0..i only,
// and a label at bar i looks only at bars i+1..i+H. The same function builds training rows and the live row,
// so training and inference cannot drift apart.
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

export const FEATURES = [
  "ret1", "ret3", "ret5", "ret10", "ret20", "rsi14", "atr_pct", "ema9_dist", "ema20_dist", "ema50_dist", "ema20_slope", "bb_pos", "vol_ratio",
  "range_pos20", "range_pos60", "body", "upper_wick", "lower_wick", "rv_ratio", "macd_hist", "gap", "streak", "mkt_ret5", "mkt_ret20", "rel_strength20", "mkt_trend",
] as const;
export const FEATURE_HELP: Record<string, string> = {
  ret1: "return over 1 bar", ret3: "return over 3 bars", ret5: "return over 5 bars", ret10: "return over 10 bars", ret20: "return over 20 bars", rsi14: "RSI(14)", atr_pct: "average true range as % of price (volatility)",
  ema9_dist: "distance from EMA 9, in ATRs", ema20_dist: "distance from EMA 20, in ATRs", ema50_dist: "distance from EMA 50, in ATRs", ema20_slope: "slope of EMA 20", bb_pos: "position inside the Bollinger bands",
  vol_ratio: "volume against its 20-bar average", range_pos20: "position inside the 20-bar range", range_pos60: "position inside the 60-bar range", body: "candle body against its range", upper_wick: "upper wick against the range",
  lower_wick: "lower wick against the range", rv_ratio: "5-bar against 20-bar volatility", macd_hist: "MACD histogram, in ATRs", gap: "opening gap, in ATRs", streak: "run of up or down closes",
  mkt_ret5: "market (SPY or BTC) return over 5 bars", mkt_ret20: "market return over 20 bars", rel_strength20: "20-bar return against the market", mkt_trend: "market distance from its EMA 20",
};
export const WARMUP = 61;
export const CLASSES = ["DOWN", "FLAT", "UP"] as const;

const ema = (v: number[], n: number) => { const k = 2 / (n + 1), out = new Array<number>(v.length); let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; out[i] = e; } return out; };
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : Number.isFinite(x) ? x : 0);

export type Row = { i: number; time: number; x: number[]; atr_pct: number; close: number };

/** One feature row per bar from WARMUP on. `market` is the benchmark's bars (SPY, or BTC-USD for crypto), matched by time. */
export function featureRows(bars: Bar[], market?: Bar[] | null): Row[] {
  const n = bars.length; if (n <= WARMUP) return [];
  const c = bars.map((b) => b.close), e9 = ema(c, 9), e20 = ema(c, 20), e50 = ema(c, 50), e12 = ema(c, 12), e26 = ema(c, 26);
  const macd = c.map((_, i) => e12[i] - e26[i]), sig = ema(macd, 9);
  const tr = bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - c[i - 1]), Math.abs(b.low - c[i - 1])) : b.high - b.low));
  const atr = new Array<number>(n); { let a = tr[0]; for (let i = 0; i < n; i++) { a = i < 14 ? (a * i + tr[i]) / (i + 1) : (a * 13 + tr[i]) / 14; atr[i] = a; } }
  const rsi = new Array<number>(n).fill(50); { let g = 0, l = 0; for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= 14) { g += up / 14; l += dn / 14; } else { g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; } rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
  const r1 = c.map((v, i) => (i ? Math.log(v / c[i - 1]) : 0));
  // Market context, aligned on time (the latest market bar at or before this bar).
  let mk: { t: number[]; c: number[]; e20: number[]; atr: number[] } | null = null;
  if (market && market.length > WARMUP) { const mc = market.map((b) => b.close); const mtr = market.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - mc[i - 1]), Math.abs(b.low - mc[i - 1])) : b.high - b.low)); const ma = ema(mtr, 14); mk = { t: market.map((b) => b.time), c: mc, e20: ema(mc, 20), atr: ma }; }
  const out: Row[] = []; let j = 0;
  for (let i = WARMUP - 1; i < n; i++) {
    const b = bars[i], A = atr[i] || b.close * 0.01, ret = (k: number) => clamp(c[i] / c[i - k] - 1, -0.5, 0.5);
    let s = 0, s2 = 0, vs = 0, hi20 = -Infinity, lo20 = Infinity, hi60 = -Infinity, lo60 = Infinity, q5 = 0, q20 = 0;
    for (let k = i - 19; k <= i; k++) { s += c[k]; s2 += c[k] * c[k]; vs += bars[k].volume; if (bars[k].high > hi20) hi20 = bars[k].high; if (bars[k].low < lo20) lo20 = bars[k].low; q20 += r1[k] * r1[k]; if (k > i - 5) q5 += r1[k] * r1[k]; }
    for (let k = i - 59; k <= i; k++) { if (bars[k].high > hi60) hi60 = bars[k].high; if (bars[k].low < lo60) lo60 = bars[k].low; }
    const sma = s / 20, sd = Math.sqrt(Math.max(s2 / 20 - sma * sma, 0)) || A, range = b.high - b.low || A * 0.1;
    let streak = 0; for (let k = i; k > i - 6 && k > 0; k--) { const up = c[k] > c[k - 1]; if (k === i) streak = up ? 1 : -1; else if ((streak > 0) === up) streak += up ? 1 : -1; else break; }
    let m5 = 0, m20 = 0, mt = 0;
    if (mk) { while (j + 1 < mk.t.length && mk.t[j + 1] <= b.time) j++; if (j >= 20 && mk.t[j] <= b.time) { m5 = clamp(mk.c[j] / mk.c[j - 5] - 1, -0.5, 0.5); m20 = clamp(mk.c[j] / mk.c[j - 20] - 1, -0.5, 0.5); mt = clamp((mk.c[j] - mk.e20[j]) / (mk.atr[j] || mk.c[j] * 0.01), -8, 8); } }
    const r20 = ret(20);
    out.push({ i, time: b.time, close: b.close, atr_pct: A / b.close, x: [
      ret(1), ret(3), ret(5), ret(10), r20, rsi[i] / 100 - 0.5, clamp(A / b.close, 0, 0.3),
      clamp((c[i] - e9[i]) / A, -8, 8), clamp((c[i] - e20[i]) / A, -8, 8), clamp((c[i] - e50[i]) / A, -12, 12), clamp((e20[i] - e20[i - 5]) / A, -6, 6), clamp((c[i] - sma) / (2 * sd), -3, 3),
      clamp(Math.log((b.volume + 1) / (vs / 20 + 1)), -3, 3), clamp((c[i] - lo20) / (hi20 - lo20 || A), 0, 1) - 0.5, clamp((c[i] - lo60) / (hi60 - lo60 || A), 0, 1) - 0.5,
      clamp((b.close - b.open) / range, -1, 1), clamp((b.high - Math.max(b.open, b.close)) / range, 0, 1), clamp((Math.min(b.open, b.close) - b.low) / range, 0, 1),
      clamp(Math.sqrt(q5 / 5) / (Math.sqrt(q20 / 20) || 1e-6), 0, 4), clamp((macd[i] - sig[i]) / A, -4, 4), clamp((b.open - c[i - 1]) / A, -6, 6), streak / 5,
      m5, m20, mk ? clamp(r20 - m20, -0.5, 0.5) : 0, mt,
    ] });
  }
  return out;
}

export type LabelSpec = { horizon: number; atr_mult: number; min_pct: number };
/** Triple-barrier label: UP (2) if price reaches +t before -t within `horizon` bars, DOWN (0) for the reverse, FLAT (1) otherwise.
 *  t = max(min_pct, atr_mult × ATR%), so a "move" means the same thing for a quiet stock and a wild one.
 *  A bar that touches both barriers is FLAT: its order cannot be known from one bar. Returns null when the future is not there yet. */
export function labelAt(bars: Bar[], i: number, atr_pct: number, s: LabelSpec): { y: 0 | 1 | 2; fwd: number; thr: number } | null {
  if (i + s.horizon >= bars.length) return null;
  const p = bars[i].close, thr = Math.max(s.min_pct, s.atr_mult * atr_pct), up = p * (1 + thr), dn = p * (1 - thr);
  let y: 0 | 1 | 2 = 1;
  for (let k = i + 1; k <= i + s.horizon; k++) { const hu = bars[k].high >= up, hd = bars[k].low <= dn; if (hu && hd) break; if (hu) { y = 2; break; } if (hd) { y = 0; break; } }
  return { y, fwd: bars[i + s.horizon].close / p - 1, thr };
}

/** Features of one candle signal, for the signal filter. Directional features are flipped for bearish signals, so
 *  "positive" always means "with the signal"; the wicks swap; then come the signal's own strength, pattern and side. */
export const SIGNAL_EXTRA = ["sig_strength", "sig_pattern", "sig_side"] as const;
const UNSIGNED = new Set([6, 12, 16, 17, 18]); // atr_pct, vol_ratio, wicks, rv_ratio
export function signalVector(x: number[], hit: { dir: string; strength: number; pattern: string }, patterns: string[]): number[] {
  const d = hit.dir === "bullish" ? 1 : -1, v = x.map((val, f) => (UNSIGNED.has(f) ? val : val * d));
  if (d < 0) { const t = v[16]; v[16] = v[17]; v[17] = t; }
  v.push(hit.strength, patterns.indexOf(hit.pattern), d);
  return v;
}
