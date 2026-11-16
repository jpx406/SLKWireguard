// Strategy tester: the 23 classic rule-based strategies that ship as built-ins on TradingView, written from their
// published rules, and a bar-by-bar backtester in the same spirit as its Strategy Tester.
// How a test runs: a strategy looks at bars 0..i (never further) and leaves orders for bar i+1. A market order fills
// at that bar's open; a stop order fills when the bar trades through its price (at the worse of the price and the
// open). A long entry while short closes the short first, and the other way round. The whole account is put into
// each trade, and a commission is charged on every fill.
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type P = Record<string, number>;
type Ord = { type: "market" | "stop"; price?: number };
type Out = { long?: Ord | null; short?: Ord | null; exit?: { stop?: number; limit?: number } | null; close?: boolean };
type Ctx = { pos: -1 | 0 | 1; entry: number };
export type ParamDef = { key: string; label: string; def: number; min: number; max: number; step: number };
type Def = { id: string; name: string; kind: string; how: string; adapted?: string; params: ParamDef[]; make: (b: Bar[], p: P) => (i: number, c: Ctx) => Out };

// ---------------------------------------------------------------------------------------------- indicators
const N = NaN;
const sma = (v: number[], n: number) => { const o = new Array<number>(v.length).fill(N); let s = 0, run = 0; for (let i = 0; i < v.length; i++) { if (Number.isNaN(v[i])) { s = 0; run = 0; continue; } s += v[i]; run++; if (run > n) { s -= v[i - n]; run = n; } if (run === n) o[i] = s / n; } return o; }; // a gap (NaN) restarts the window
const ema = (v: number[], n: number) => { const o = new Array<number>(v.length).fill(N), k = 2 / (n + 1); let e = N; for (let i = 0; i < v.length; i++) { if (Number.isNaN(v[i])) continue; e = Number.isNaN(e) ? v[i] : v[i] * k + e * (1 - k); o[i] = e; } return o; };
const rma = (v: number[], n: number) => { const o = new Array<number>(v.length).fill(N); let e = N, s = 0, c = 0; for (let i = 0; i < v.length; i++) { if (Number.isNaN(v[i])) continue; if (c < n) { s += v[i]; c++; if (c === n) { e = s / n; o[i] = e; } } else { e = (e * (n - 1) + v[i]) / n; o[i] = e; } } return o; };
const trueRange = (b: Bar[]) => b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
const highest = (v: number[], n: number) => v.map((_, i) => { if (i < n - 1) return N; let m = -Infinity; for (let k = i - n + 1; k <= i; k++) if (v[k] > m) m = v[k]; return m; });
const lowest = (v: number[], n: number) => v.map((_, i) => { if (i < n - 1) return N; let m = Infinity; for (let k = i - n + 1; k <= i; k++) if (v[k] < m) m = v[k]; return m; });
const stdev = (v: number[], n: number) => { const m = sma(v, n); return v.map((_, i) => { if (i < n - 1) return N; let s = 0; for (let k = i - n + 1; k <= i; k++) s += (v[k] - m[i]) ** 2; return Math.sqrt(s / n); }); };
const rsiOf = (c: number[], n: number) => { const up = c.map((v, i) => (i ? Math.max(v - c[i - 1], 0) : N)), dn = c.map((v, i) => (i ? Math.max(c[i - 1] - v, 0) : N)), u = rma(up, n), d = rma(dn, n); return c.map((_, i) => (Number.isNaN(u[i]) ? N : d[i] === 0 ? 100 : 100 - 100 / (1 + u[i] / d[i]))); };
const crossUp = (a: number[], b: number[] | number, i: number) => { const b0 = typeof b === "number" ? b : b[i], b1 = typeof b === "number" ? b : b[i - 1]; return i > 0 && a[i] > b0 && a[i - 1] <= b1; };
const crossDn = (a: number[], b: number[] | number, i: number) => { const b0 = typeof b === "number" ? b : b[i], b1 = typeof b === "number" ? b : b[i - 1]; return i > 0 && a[i] < b0 && a[i - 1] >= b1; };
const C = (b: Bar[]) => b.map((x) => x.close), H = (b: Bar[]) => b.map((x) => x.high), L = (b: Bar[]) => b.map((x) => x.low);
const MKT: Ord = { type: "market" };
const stop = (price: number): Ord | null => (Number.isFinite(price) ? { type: "stop", price } : null);
const tickOf = (b: Bar[]) => { const p = b[b.length - 1]?.close || 1; return p >= 1 ? 0.01 : p / 1e4; };

function dmi(b: Bar[], n: number, smooth: number) {
  const tr = trueRange(b), up = b.map((x, i) => (i ? x.high - b[i - 1].high : N)), dn = b.map((x, i) => (i ? b[i - 1].low - x.low : N));
  const pdm = up.map((u, i) => (Number.isNaN(u) ? N : u > dn[i] && u > 0 ? u : 0)), mdm = dn.map((d, i) => (Number.isNaN(d) ? N : d > up[i] && d > 0 ? d : 0));
  const atr = rma(tr.map((v, i) => (i ? v : N)), n), ps = rma(pdm, n), ms = rma(mdm, n), plus = ps.map((v, i) => (100 * v) / atr[i]), minus = ms.map((v, i) => (100 * v) / atr[i]);
  const dx = plus.map((p, i) => (Number.isNaN(p) || Number.isNaN(minus[i]) ? N : (100 * Math.abs(p - minus[i])) / (p + minus[i] || 1)));
  return { adx: rma(dx, smooth), plus, minus };
}
function supertrend(b: Bar[], n: number, factor: number) {
  const atr = rma(trueRange(b), n), dir = new Array<number>(b.length).fill(0), line = new Array<number>(b.length).fill(N); let ub = N, lb = N;
  for (let i = 0; i < b.length; i++) {
    if (Number.isNaN(atr[i])) continue; const hl2 = (b[i].high + b[i].low) / 2, bu = hl2 + factor * atr[i], bl = hl2 - factor * atr[i], pc = i ? b[i - 1].close : b[i].close;
    const nlb = Number.isNaN(lb) || bl > lb || pc < lb ? bl : lb, nub = Number.isNaN(ub) || bu < ub || pc > ub ? bu : ub;
    dir[i] = !dir[i - 1] ? 1 : dir[i - 1] === -1 ? (b[i].close > ub ? 1 : -1) : b[i].close < lb ? -1 : 1; // 1 = up-trend (price above the line)
    lb = nlb; ub = nub; line[i] = dir[i] === 1 ? lb : ub;
  }
  return { dir, line };
}
function psar(b: Bar[], start: number, inc: number, max: number) {
  const sar = new Array<number>(b.length).fill(N), up = new Array<boolean>(b.length).fill(true); if (b.length < 2) return { next: sar, up };
  let rising = b[1].close >= b[0].close, s = rising ? b[0].low : b[0].high, ep = rising ? b[1].high : b[1].low, af = start; const next = sar.slice();
  for (let i = 1; i < b.length; i++) {
    if (rising) { if (b[i].low < s) { rising = false; s = ep; ep = b[i].low; af = start; } else if (b[i].high > ep) { ep = b[i].high; af = Math.min(max, af + inc); } }
    else if (b[i].high > s) { rising = true; s = ep; ep = b[i].high; af = start; } else if (b[i].low < ep) { ep = b[i].low; af = Math.min(max, af + inc); }
    sar[i] = s; up[i] = rising; let n = s + af * (ep - s);
    if (rising) n = Math.min(n, b[i].low, b[i - 1].low); else n = Math.max(n, b[i].high, b[i - 1].high);
    next[i] = n; s = n;
  }
  return { next, up };
}
/** A pivot high confirmed at bar i: the high `right` bars ago is the highest of the `left` bars before it and the `right` after it. */
const pivotHigh = (h: number[], i: number, left: number, right: number) => { const c = i - right; if (c - left < 0) return N; for (let k = c - left; k <= i; k++) if (k !== c && h[k] >= h[c]) return N; return h[c]; };
const pivotLow = (l: number[], i: number, left: number, right: number) => { const c = i - right; if (c - left < 0) return N; for (let k = c - left; k <= i; k++) if (k !== c && l[k] <= l[c]) return N; return l[c]; };

/** A simplified technical rating, -1 (strong sell) to +1 (strong buy): half moving averages, half oscillators. */
function technicalRating(b: Bar[]) {
  const c = C(b), h = H(b), l = L(b), mas = [10, 20, 30, 50, 100, 200].flatMap((n) => [sma(c, n), ema(c, n)]);
  const rsi = rsiOf(c, 14), hh = highest(h, 14), ll = lowest(l, 14), k = sma(c.map((v, i) => (100 * (v - ll[i])) / (hh[i] - ll[i] || 1)), 3), d = sma(k, 3);
  const tp = b.map((x) => (x.high + x.low + x.close) / 3), tpm = sma(tp, 20), md = tp.map((_, i) => { if (i < 19) return N; let s = 0; for (let q = i - 19; q <= i; q++) s += Math.abs(tp[q] - tpm[i]); return s / 20; }), cci = tp.map((v, i) => (v - tpm[i]) / (0.015 * (md[i] || 1)));
  const { adx, plus, minus } = dmi(b, 14, 14), hl2 = b.map((x) => (x.high + x.low) / 2), ao = sma(hl2, 5).map((v, i) => v - sma(hl2, 34)[i]);
  const macd = ema(c, 12).map((v, i) => v - ema(c, 26)[i]), sig = ema(macd, 9), wr = c.map((v, i) => (-100 * (hh[i] - v)) / (hh[i] - ll[i] || 1));
  const ao5 = sma(hl2, 5), ao34 = sma(hl2, 34); void ao;
  return c.map((_, i) => {
    if (i < 35) return N; let ms = 0, mn = 0; for (const m of mas) if (!Number.isNaN(m[i])) { ms += c[i] > m[i] ? 1 : c[i] < m[i] ? -1 : 0; mn++; }
    const o: number[] = [], a0 = ao5[i] - ao34[i], a1 = ao5[i - 1] - ao34[i - 1];
    o.push(rsi[i] < 30 && rsi[i] > rsi[i - 1] ? 1 : rsi[i] > 70 && rsi[i] < rsi[i - 1] ? -1 : 0);
    o.push(k[i] < 20 && d[i] < 20 && k[i] > d[i] ? 1 : k[i] > 80 && d[i] > 80 && k[i] < d[i] ? -1 : 0);
    o.push(cci[i] < -100 && cci[i] > cci[i - 1] ? 1 : cci[i] > 100 && cci[i] < cci[i - 1] ? -1 : 0);
    o.push(adx[i] > 20 ? (plus[i] > minus[i] ? 1 : -1) : 0);
    o.push(a0 > 0 && a0 > a1 ? 1 : a0 < 0 && a0 < a1 ? -1 : 0);
    o.push(c[i] - c[i - 10] > c[i - 1] - c[i - 11] ? 1 : -1);
    o.push(macd[i] > sig[i] ? 1 : -1);
    o.push(wr[i] < -80 && wr[i] > wr[i - 1] ? 1 : wr[i] > -20 && wr[i] < wr[i - 1] ? -1 : 0);
    return ((mn ? ms / mn : 0) + o.reduce((s, v) => s + v, 0) / o.length) / 2;
  });
}

// ---------------------------------------------------------------------------------------------- the strategies
const pr = (key: string, label: string, def: number, min: number, max: number, step = 1): ParamDef => ({ key, label, def, min, max, step });
export const STRATEGIES: Def[] = [
  { id: "bar_updn", name: "Bar Up/Down", kind: "Price action", how: "Buys after an up bar that also opened above the previous close; sells short after a down bar that opened below it.", params: [],
    make: (b) => (i) => (i < 1 ? {} : b[i].close > b[i].open && b[i].open > b[i - 1].close ? { long: MKT } : b[i].close < b[i].open && b[i].open < b[i - 1].close ? { short: MKT } : {}) },
  { id: "bollinger", name: "Bollinger Bands", kind: "Mean reversion", how: "When the close climbs back above the lower band it places a buy at the lower band; when it drops back under the upper band, a short at the upper band.", params: [pr("length", "Length", 20, 5, 100), pr("mult", "Band width (std dev)", 2, 0.5, 4, 0.1)],
    make: (b, p) => { const c = C(b), m = sma(c, p.length), sd = stdev(c, p.length), up = m.map((v, i) => v + p.mult * sd[i]), lo = m.map((v, i) => v - p.mult * sd[i]); return (i) => (crossUp(c, lo, i) ? { long: stop(lo[i]) } : crossDn(c, up, i) ? { short: stop(up[i]) } : {}); } },
  { id: "bollinger_dir", name: "Bollinger Bands (directed)", kind: "Mean reversion", how: "The Bollinger Bands strategy restricted to one side: set the Direction control above to long only or short only.", params: [pr("length", "Length", 20, 5, 100), pr("mult", "Band width (std dev)", 2, 0.5, 4, 0.1)],
    make: (b, p) => { const c = C(b), m = sma(c, p.length), sd = stdev(c, p.length), up = m.map((v, i) => v + p.mult * sd[i]), lo = m.map((v, i) => v - p.mult * sd[i]); return (i) => (crossUp(c, lo, i) ? { long: stop(lo[i]) } : crossDn(c, up, i) ? { short: stop(up[i]) } : {}); } },
  { id: "channel_breakout", name: "Channel Break Out", kind: "Breakout", how: "Keeps a buy order just above the highest high of the last few bars and a short order just below the lowest low: it always follows the latest breakout.", params: [pr("length", "Length", 5, 2, 100)],
    make: (b, p) => { const hh = highest(H(b), p.length), ll = lowest(L(b), p.length), t = tickOf(b); return (i) => ({ long: stop(hh[i] + t), short: stop(ll[i] - t) }); } },
  { id: "consecutive", name: "Consecutive Up/Down", kind: "Momentum", how: "Buys after a run of higher closes and sells short after a run of lower closes.", params: [pr("up", "Up closes to buy", 3, 1, 10), pr("down", "Down closes to short", 3, 1, 10)],
    make: (b, p) => { const c = C(b); let u = 0, d = 0, at = -1; return (i) => { if (i < 1 || i <= at) return {}; at = i; u = c[i] > c[i - 1] ? u + 1 : 0; d = c[i] < c[i - 1] ? d + 1 : 0; return u >= p.up ? { long: MKT } : d >= p.down ? { short: MKT } : {}; }; } },
  { id: "greedy", name: "Greedy", kind: "Gap", how: "Buys when a bar opens above the previous high (a gap up) and sells short on a gap down, then takes profit or cuts the loss at a fixed distance.", adapted: "The original measures its exits in ticks and adds to winners; here exits are in ATRs and there is no adding.", params: [pr("tp", "Take profit (ATRs)", 1, 0.2, 10, 0.1), pr("sl", "Stop loss (ATRs)", 1, 0.2, 10, 0.1)],
    make: (b, p) => { const atr = rma(trueRange(b), 14); return (i, c) => { if (i < 14) return {}; const o: Out = {}; if (b[i].open > b[i - 1].high) o.long = MKT; else if (b[i].open < b[i - 1].low) o.short = MKT; if (c.pos) o.exit = { limit: c.entry + c.pos * p.tp * atr[i], stop: c.entry - c.pos * p.sl * atr[i] }; return o; }; } },
  { id: "inside_bar", name: "Inside Bar", kind: "Price action", how: "After a bar that stays inside the previous bar's range, it buys if that bar closed up and sells short if it closed down.", params: [],
    make: (b) => (i) => (i < 1 || !(b[i].high < b[i - 1].high && b[i].low > b[i - 1].low) ? {} : b[i].close > b[i].open ? { long: MKT } : b[i].close < b[i].open ? { short: MKT } : {}) },
  { id: "keltner", name: "Keltner Channels", kind: "Breakout", how: "When the close crosses above the upper channel it places a buy just above that bar's high, and the mirror image below the lower channel. The order is dropped if price falls back to the middle line.", params: [pr("length", "Length", 20, 5, 100), pr("mult", "Channel width (ranges)", 1, 0.5, 4, 0.1)],
    make: (b, p) => { const c = C(b), ma = ema(c, p.length), rg = ema(trueRange(b), p.length), up = ma.map((v, i) => v + rg[i] * p.mult), lo = ma.map((v, i) => v - rg[i] * p.mult), t = tickOf(b); let bp = N, sp = N, bOn = false, sOn = false;
      return (i) => { if (crossUp(c, up, i)) { bp = b[i].high + t; bOn = true; } else if (bOn && (c[i] < ma[i] || b[i].high >= bp)) bOn = false; if (crossDn(c, lo, i)) { sp = b[i].low - t; sOn = true; } else if (sOn && (c[i] > ma[i] || b[i].low <= sp)) sOn = false; return { long: bOn ? stop(bp) : null, short: sOn ? stop(sp) : null }; }; } },
  { id: "macd", name: "MACD", kind: "Trend", how: "Buys when the MACD line crosses above its signal line and sells short when it crosses below.", params: [pr("fast", "Fast length", 12, 2, 50), pr("slow", "Slow length", 26, 5, 100), pr("signal", "Signal length", 9, 2, 50)],
    make: (b, p) => { const c = C(b), f = ema(c, p.fast), s = ema(c, p.slow), m = f.map((v, i) => v - s[i]), sg = ema(m.map((v, i) => (i < p.slow - 1 ? N : v)), p.signal), d = m.map((v, i) => v - sg[i]); return (i) => (crossUp(d, 0, i) ? { long: MKT } : crossDn(d, 0, i) ? { short: MKT } : {}); } },
  { id: "momentum", name: "Momentum", kind: "Momentum", how: "While price is higher than it was a few bars ago and that gain is still growing, it keeps a buy order just above the last high; the mirror image for shorts.", params: [pr("length", "Length", 12, 2, 100)],
    make: (b, p) => { const c = C(b), t = tickOf(b); return (i) => { if (i < p.length + 1) return {}; const m0 = c[i] - c[i - p.length], m1 = m0 - (c[i - 1] - c[i - 1 - p.length]); return m0 > 0 && m1 > 0 ? { long: stop(b[i].high + t) } : m0 < 0 && m1 < 0 ? { short: stop(b[i].low - t) } : {}; }; } },
  { id: "ma2_cross", name: "Moving Average 2-Line Cross", kind: "Trend", how: "Buys when the fast moving average crosses above the slow one and sells short when it crosses below.", params: [pr("fast", "Fast length", 9, 2, 100), pr("slow", "Slow length", 18, 3, 300)],
    make: (b, p) => { const c = C(b), f = sma(c, p.fast), s = sma(c, p.slow); return (i) => (crossUp(f, s, i) ? { long: MKT } : crossDn(f, s, i) ? { short: MKT } : {}); } },
  { id: "ma_cross", name: "Moving Average Cross", kind: "Trend", how: "Buys once the close has stayed above its moving average for the set number of bars, and sells short once it has stayed below.", params: [pr("length", "Length", 9, 2, 300), pr("confirm", "Bars to confirm", 1, 1, 10)],
    make: (b, p) => { const c = C(b), m = sma(c, p.length); let u = 0, d = 0, at = -1; return (i) => { if (Number.isNaN(m[i]) || i <= at) return {}; at = i; u = c[i] > m[i] ? u + 1 : 0; d = c[i] < m[i] ? d + 1 : 0; return u === p.confirm ? { long: MKT } : d === p.confirm ? { short: MKT } : {}; }; } },
  { id: "outside_bar", name: "Outside Bar", kind: "Price action", how: "After a bar that engulfs the previous bar's whole range, it buys if that bar closed up and sells short if it closed down.", params: [],
    make: (b) => (i) => (i < 1 || !(b[i].high > b[i - 1].high && b[i].low < b[i - 1].low) ? {} : b[i].close > b[i].open ? { long: MKT } : b[i].close < b[i].open ? { short: MKT } : {}) },
  { id: "psar", name: "Parabolic SAR", kind: "Trend", how: "Always in the market: it places its reversing order at the Parabolic SAR dot, so it flips from long to short (or back) whenever price touches the dot.", params: [pr("start", "Start", 0.02, 0.005, 0.2, 0.005), pr("inc", "Increment", 0.02, 0.005, 0.2, 0.005), pr("max", "Maximum", 0.2, 0.05, 1, 0.05)],
    make: (b, p) => { const s = psar(b, p.start, p.inc, p.max); return (i) => (i < 2 ? {} : s.up[i] ? { short: stop(s.next[i]) } : { long: stop(s.next[i]) }); } },
  { id: "pivot_ext", name: "Pivot Extension", kind: "Mean reversion", how: "Buys when a swing low has just been confirmed and sells short when a swing high has: it trades the turn, not the breakout.", params: [pr("left", "Bars to the left", 4, 1, 20), pr("right", "Bars to the right", 2, 1, 20)],
    make: (b, p) => { const h = H(b), l = L(b); return (i) => (!Number.isNaN(pivotLow(l, i, p.left, p.right)) ? { long: MKT } : !Number.isNaN(pivotHigh(h, i, p.left, p.right)) ? { short: MKT } : {}); } },
  { id: "pivot_rev", name: "Pivot Reversal", kind: "Breakout", how: "After a swing high forms it keeps a buy order just above it until price gets there; after a swing low, a short order just below it.", params: [pr("left", "Bars to the left", 4, 1, 20), pr("right", "Bars to the right", 2, 1, 20)],
    make: (b, p) => { const h = H(b), l = L(b), t = tickOf(b); let hp = N, lp = N, le = false, se = false; return (i) => { const ph = pivotHigh(h, i, p.left, p.right), pl = pivotLow(l, i, p.left, p.right); if (!Number.isNaN(ph)) { hp = ph; le = true; } else if (le && b[i].high > hp) le = false; if (!Number.isNaN(pl)) { lp = pl; se = true; } else if (se && b[i].low < lp) se = false; return { long: le ? stop(hp + t) : null, short: se ? stop(lp - t) : null }; }; } },
  { id: "price_channel", name: "Price Channel", kind: "Breakout", how: "The classic channel system: buy a new 20-bar high, sell short a new 20-bar low, and stay in until the opposite signal.", params: [pr("length", "Length", 20, 5, 200)],
    make: (b, p) => { const hh = highest(H(b), p.length), ll = lowest(L(b), p.length); return (i) => (i < p.length ? {} : { long: stop(hh[i]), short: stop(ll[i]) }); } },
  { id: "adx_breakout", name: "Rob Booker ADX Breakout", kind: "Breakout", how: "Waits for a quiet market (low ADX), then trades the break of the recent range. The target and the stop are fractions of that range's height.", params: [pr("adx", "ADX length", 14, 5, 50), pr("level", "ADX must be below", 18, 5, 40), pr("box", "Range lookback", 20, 5, 100), pr("pt", "Target (range heights)", 1, 0.25, 5, 0.25), pr("sl", "Stop (range heights)", 0.5, 0.1, 3, 0.1)],
    make: (b, p) => { const a = dmi(b, p.adx, p.adx).adx, hh = highest(H(b), p.box), ll = lowest(L(b), p.box); let w = N; return (i, c) => { if (i < p.box + 1 || Number.isNaN(a[i])) return {}; const up = hh[i - 1], lo = ll[i - 1], o: Out = {}; if (!c.pos && a[i] < p.level) { if (b[i].close > up) { o.long = MKT; w = up - lo; } else if (b[i].close < lo) { o.short = MKT; w = up - lo; } } if (c.pos && w > 0) o.exit = { limit: c.entry + c.pos * w * p.pt, stop: c.entry - c.pos * w * p.sl }; return o; }; } },
  { id: "rsi", name: "RSI", kind: "Mean reversion", how: "Buys when RSI climbs back above the oversold level and sells short when it drops back under the overbought level.", params: [pr("length", "Length", 14, 2, 50), pr("oversold", "Oversold", 30, 5, 50), pr("overbought", "Overbought", 70, 50, 95)],
    make: (b, p) => { const r = rsiOf(C(b), p.length); return (i) => (crossUp(r, p.oversold, i) ? { long: MKT } : crossDn(r, p.overbought, i) ? { short: MKT } : {}); } },
  { id: "stoch_slow", name: "Stochastic Slow", kind: "Mean reversion", how: "Buys when the stochastic %K line crosses above %D while both are in the oversold zone, and sells short on the opposite cross in the overbought zone.", params: [pr("length", "Length", 14, 3, 50), pr("ob", "Overbought", 80, 50, 95), pr("os", "Oversold", 20, 5, 50), pr("k", "%K smoothing", 3, 1, 10), pr("d", "%D smoothing", 3, 1, 10)],
    make: (b, p) => { const c = C(b), hh = highest(H(b), p.length), ll = lowest(L(b), p.length), k = sma(c.map((v, i) => (100 * (v - ll[i])) / (hh[i] - ll[i] || 1)), p.k), d = sma(k, p.d); return (i) => (crossUp(k, d, i) && k[i] < p.os ? { long: MKT } : crossDn(k, d, i) && k[i] > p.ob ? { short: MKT } : {}); } },
  { id: "supertrend", name: "Supertrend", kind: "Trend", how: "Long while price is above the Supertrend line and short while it is below: it flips when the line flips.", params: [pr("atr", "ATR length", 10, 2, 50), pr("factor", "Factor", 3, 1, 10, 0.5)],
    make: (b, p) => { const s = supertrend(b, p.atr, p.factor); return (i) => (i < 1 || !s.dir[i - 1] ? {} : s.dir[i] === 1 && s.dir[i - 1] === -1 ? { long: MKT } : s.dir[i] === -1 && s.dir[i - 1] === 1 ? { short: MKT } : {}); } },
  { id: "tech_ratings", name: "Technical Ratings", kind: "Composite", how: "Scores a dozen moving averages and eight oscillators from strong sell to strong buy, buys on a strong buy and sells short on a strong sell.", adapted: "Uses a shorter list of indicators than the original rating.", params: [pr("level", "Strong level", 0.5, 0.1, 0.9, 0.05)],
    make: (b, p) => { const r = technicalRating(b); return (i) => (Number.isNaN(r[i]) ? {} : r[i] > p.level ? { long: MKT } : r[i] < -p.level ? { short: MKT } : {}); } },
  { id: "volty_expan", name: "Volty Expan Close", kind: "Breakout", how: "A volatility breakout: every bar it places a buy order a fraction of the average range above the close and a short order the same distance below.", params: [pr("length", "Length", 5, 2, 50), pr("atrs", "Distance (average ranges)", 0.75, 0.1, 5, 0.05)],
    make: (b, p) => { const a = sma(trueRange(b), p.length); return (i) => (Number.isNaN(a[i]) ? {} : { long: stop(b[i].close + a[i] * p.atrs), short: stop(b[i].close - a[i] * p.atrs) }); } },
];
export const catalog = () => STRATEGIES.map((s) => ({ id: s.id, name: s.name, kind: s.kind, how: s.how, adapted: s.adapted ?? null, params: s.params }));

// ---------------------------------------------------------------------------------------------- the tester
export type Trade = { side: "long" | "short"; entry_time: number; entry: number; exit_time: number; exit: number; pct: number; bars: number; reason: string };
export type Part = { net_pct: number; trades: number; win_rate: number | null; profit_factor: number | null; max_dd_pct: number; avg_trade_pct: number | null };
export type Result = Part & {
  id: string; name: string; symbol?: string; interval?: string; bars: number; from: number; to: number; buy_hold_pct: number; avg_bars: number | null; exposure_pct: number; long: { trades: number; net_pct: number }; short: { trades: number; net_pct: number };
  in_sample: Part; out_sample: Part; equity: { t: number; e: number; bh: number; dd: number }[]; list: Trade[]; perf: { all: Perf; long: Perf; short: Perf }; periods: { label: string; pct: number }[]; hist: { from: number; to: number; n: number }[]; sequence: number[]; open: { side: "long" | "short"; entry: number; since: number } | null; params: P; direction: string; commission_pct: number;
};
const r2 = (v: number) => Math.round(v * 100) / 100, r4 = (v: number) => Math.round(v * 1e4) / 1e4;
export type Perf = { trades: number; winners: number; losers: number; win_rate: number | null; net_pct: number; gross_profit: number; gross_loss: number; profit_factor: number | null; avg_trade: number | null; avg_win: number | null; avg_loss: number | null; payoff: number | null; largest_win: number | null; largest_loss: number | null; avg_bars: number | null; max_losing_streak: number };
function perfOf(t: Trade[]): Perf {
  const w = t.filter((x) => x.pct > 0), l = t.filter((x) => x.pct <= 0), sum = (a: Trade[]) => a.reduce((q, x) => q + x.pct, 0), gp = sum(w), gl = -sum(l); let streak = 0, worst = 0;
  for (const x of t) { streak = x.pct <= 0 ? streak + 1 : 0; if (streak > worst) worst = streak; }
  const aw = w.length ? gp / w.length : null, al = l.length ? -gl / l.length : null;
  return { trades: t.length, winners: w.length, losers: l.length, win_rate: t.length ? r4(w.length / t.length) : null, net_pct: r2(gp - gl), gross_profit: r2(gp), gross_loss: r2(-gl), profit_factor: gl > 0 ? r2(gp / gl) : gp > 0 ? 99 : null, avg_trade: t.length ? r2((gp - gl) / t.length) : null,
    avg_win: aw == null ? null : r2(aw), avg_loss: al == null ? null : r2(al), payoff: aw != null && al ? r2(aw / -al) : null, largest_win: w.length ? r2(Math.max(...w.map((x) => x.pct))) : null, largest_loss: l.length ? r2(Math.min(...l.map((x) => x.pct))) : null,
    avg_bars: t.length ? r2(t.reduce((q, x) => q + x.bars, 0) / t.length) : null, max_losing_streak: worst };
}
function part(trades: Trade[], eq: number[]): Part {
  let peak = eq[0] ?? 1, dd = 0; for (const e of eq) { if (e > peak) peak = e; dd = Math.max(dd, (peak - e) / peak); }
  const win = trades.filter((t) => t.pct > 0), gp = win.reduce((s, t) => s + t.pct, 0), gl = -trades.filter((t) => t.pct <= 0).reduce((s, t) => s + t.pct, 0);
  return { net_pct: eq.length ? r2((eq[eq.length - 1] / eq[0] - 1) * 100) : 0, trades: trades.length, win_rate: trades.length ? r4(win.length / trades.length) : null, profit_factor: gl > 0 ? r2(gp / gl) : gp > 0 ? 99 : null, max_dd_pct: r2(dd * 100), avg_trade_pct: trades.length ? r2(trades.reduce((s, t) => s + t.pct, 0) / trades.length) : null };
}

export function runStrategy(id: string, bars: Bar[], o: { params?: P; direction?: "both" | "long" | "short"; commission_pct?: number } = {}): Result {
  const def = STRATEGIES.find((s) => s.id === id); if (!def) throw new Error("Unknown strategy.");
  if (bars.length < 60) throw new Error("Not enough price history to test on.");
  const p: P = {}; for (const d of def.params) { const v = Number(o.params?.[d.key]); p[d.key] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.def; }
  const dir = o.direction ?? "both", fee = (o.commission_pct ?? 0.02) / 100, step = def.make(bars, p);
  let cash = 1, pos: -1 | 0 | 1 = 0, qty = 0, entry = 0, entryT = 0, entryI = 0, inBars = 0; const eq: number[] = [], trades: Trade[] = []; let pend: Out = {};
  const close = (px: number, i: number, reason: string) => { const gross = pos === 1 ? qty * px : qty * (2 * entry - px), net = gross * (1 - fee); trades.push({ side: pos === 1 ? "long" : "short", entry_time: entryT, entry: r4(entry), exit_time: bars[i].time, exit: r4(px), pct: r2((net / (qty * entry / (1 - fee)) - 1) * 100), bars: i - entryI, reason }); cash = net; pos = 0; qty = 0; };
  const open = (side: 1 | -1, px: number, i: number) => { if (pos === side) return; if (pos) close(px, i, "reverse"); if ((side === 1 && dir === "short") || (side === -1 && dir === "long")) return; qty = (cash * (1 - fee)) / px; entry = px; entryT = bars[i].time; entryI = i; pos = side; cash = 0; };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i > 0) {
      // 1. protective exits of the open position (the stop is assumed to be hit first when both are in the bar)
      if (pos && pend.exit) { const s = pend.exit.stop, l = pend.exit.limit; if (s !== undefined && Number.isFinite(s) && (pos === 1 ? b.low <= s : b.high >= s)) close(pos === 1 ? Math.min(s, b.open) : Math.max(s, b.open), i, "stop"); else if (l !== undefined && Number.isFinite(l) && (pos === 1 ? b.high >= l : b.low <= l)) close(pos === 1 ? Math.max(l, b.open) : Math.min(l, b.open), i, "target"); }
      if (pos && pend.close) close(b.open, i, "exit");
      // 2. entries: market orders at the open, then stop orders in the order the bar most likely reached them
      const fills: { side: 1 | -1; px: number; d: number }[] = [];
      if (pend.long) { if (pend.long.type === "market") fills.push({ side: 1, px: b.open, d: -1 }); else if (pend.long.price !== undefined && b.high >= pend.long.price) fills.push({ side: 1, px: Math.max(b.open, pend.long.price), d: Math.max(0, pend.long.price - b.open) }); }
      if (pend.short) { if (pend.short.type === "market") fills.push({ side: -1, px: b.open, d: -1 }); else if (pend.short.price !== undefined && b.low <= pend.short.price) fills.push({ side: -1, px: Math.min(b.open, pend.short.price), d: Math.max(0, b.open - pend.short.price) }); }
      fills.sort((x, y) => x.d - y.d); for (const f of fills) open(f.side, f.px, i);
    }
    if (pos) inBars++;
    eq.push(pos === 0 ? cash : pos === 1 ? qty * b.close : qty * (2 * entry - b.close));
    pend = step(i, { pos, entry }) || {};
  }
  const cut = Math.floor(bars.length * 0.7), cutT = bars[cut].time, last = bars[bars.length - 1];
  let pk = eq[0]; const ddv = eq.map((e) => { if (e > pk) pk = e; return (e / pk - 1) * 100; });
  const every = Math.max(1, Math.ceil(bars.length / 300)), equity = bars.map((b, i) => ({ t: b.time, e: r4(eq[i]), bh: r4(b.close / bars[0].close), dd: r2(ddv[i]) })).filter((_, i) => i % every === 0 || i === bars.length - 1);
  // Returns per period: per month on daily bars, per day on intraday bars (last 24 periods).
  const span = last.time - bars[0].time, keyOf = (t: number) => new Date(t * 1000).toISOString().slice(0, span > 200 * 86400 ? 7 : 10), per = new Map<string, { a: number; b: number }>();
  bars.forEach((b, i) => { const k = keyOf(b.time), prev = i ? eq[i - 1] : 1, cur = per.get(k); if (cur) cur.b = eq[i]; else per.set(k, { a: prev, b: eq[i] }); });
  const periods = [...per.entries()].slice(-24).map(([label, v]) => ({ label, pct: r2((v.b / v.a - 1) * 100) }));
  // Distribution of trade results in ten buckets.
  const pcts = trades.map((t) => t.pct), lo = Math.min(0, ...pcts), hi = Math.max(0, ...pcts), bw = (hi - lo) / 10 || 1;
  const hist = Array.from({ length: 10 }, (_, k) => ({ from: r2(lo + k * bw), to: r2(lo + (k + 1) * bw), n: 0 })); for (const v of pcts) hist[Math.min(9, Math.floor((v - lo) / bw))].n++;
  const ls = (side: string) => { const t = trades.filter((x) => x.side === side); return { trades: t.length, net_pct: r2(t.reduce((s, x) => s + x.pct, 0)) }; };
  return { id, name: def.name, bars: bars.length, from: bars[0].time, to: last.time, ...part(trades, eq), buy_hold_pct: r2((last.close / bars[0].close - 1) * 100), avg_bars: trades.length ? r2(trades.reduce((s, t) => s + t.bars, 0) / trades.length) : null,
    exposure_pct: r2((inBars / bars.length) * 100), long: ls("long"), short: ls("short"), in_sample: part(trades.filter((t) => t.exit_time <= cutT), eq.slice(0, cut + 1)), out_sample: part(trades.filter((t) => t.entry_time > cutT), eq.slice(cut)),
    equity, list: trades.slice(-400), perf: { all: perfOf(trades), long: perfOf(trades.filter((t) => t.side === "long")), short: perfOf(trades.filter((t) => t.side === "short")) }, periods, hist, sequence: pcts.slice(-120), open: pos ? { side: pos === 1 ? "long" : "short", entry: r4(entry), since: entryT } : null, params: p, direction: dir, commission_pct: o.commission_pct ?? 0.02 };
}

/** Every strategy on the same bars with its default settings. The last 30% of the bars is reported on its own. */
export function rankStrategies(bars: Bar[], o: { direction?: "both" | "long" | "short"; commission_pct?: number } = {}) {
  return STRATEGIES.map((s) => { try { const r = runStrategy(s.id, bars, o); return { id: s.id, name: s.name, kind: s.kind, net_pct: r.net_pct, trades: r.trades, win_rate: r.win_rate, profit_factor: r.profit_factor, max_dd_pct: r.max_dd_pct, buy_hold_pct: r.buy_hold_pct, in_net_pct: r.in_sample.net_pct, out_net_pct: r.out_sample.net_pct, out_trades: r.out_sample.trades, position: r.open?.side ?? "flat" }; } catch { return null; } })
    .filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.out_net_pct - a.out_net_pct);
}
