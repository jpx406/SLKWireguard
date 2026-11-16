// Converted strategies: a small rule language that a Pine strategy is translated into.
// Why a rule language and not code: the server cannot run generated code (and should not run a stranger's), so a
// conversion is DATA: named series built from a fixed list of functions, plus entry, exit, stop and target rules.
// This file checks such a definition and turns it into a strategy the tester and the auto-trader can run.
//
//   spec = { name, how, params: [{key,label,def,min,max,step}], series: { name: expr, ... },
//            long, short, exit_long, exit_short: expr | null,
//            stop, stop_short, target, target_short: { expr, mode: "entry" | "trail" } | null, differences: [text] }
//   expr = number | "close" | "$param" | "seriesName" | ["op", arg, ...]
// A value is a number per bar (NaN = not available); a condition is true when its value is non-zero.
import type { Bar, ParamDef } from "./strategies";

export type Expr = number | string | Expr[];
export type Level = { expr: Expr; mode: "entry" | "trail" };
export type Spec = {
  name: string; how: string; params: ParamDef[]; series: Record<string, Expr>;
  long: Expr | null; short: Expr | null; exit_long: Expr | null; exit_short: Expr | null;
  stop: Level | null; stop_short: Level | null; target: Level | null; target_short: Level | null; differences: string[];
};
type A = Float64Array;
type Out = { long?: { type: "market" } | null; short?: { type: "market" } | null; exit?: { stop?: number; limit?: number } | null; close?: boolean };

const ATOMS = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "tr", "bar_index"];
// op -> [min args, max args, indexes of arguments that must be whole-number lengths known up front]
const OPS: Record<string, [number, number, number[]]> = {
  "+": [2, 8, []], "-": [2, 2, []], "*": [2, 8, []], "/": [2, 2, []], neg: [1, 1, []], abs: [1, 1, []], min: [2, 8, []], max: [2, 8, []], pow: [2, 2, []], sqrt: [1, 1, []], log: [1, 1, []],
  ">": [2, 2, []], "<": [2, 2, []], ">=": [2, 2, []], "<=": [2, 2, []], "==": [2, 2, []], "!=": [2, 2, []], and: [2, 8, []], or: [2, 8, []], not: [1, 1, []], if: [3, 3, []],
  prev: [1, 2, [1]], nz: [1, 2, []], na: [1, 1, []],
  sma: [2, 2, [1]], ema: [2, 2, [1]], rma: [2, 2, [1]], wma: [2, 2, [1]], vwma: [2, 2, [1]], stdev: [2, 2, [1]], highest: [2, 2, [1]], lowest: [2, 2, [1]], sum: [2, 2, [1]], linreg: [2, 3, [1, 2]],
  rsi: [2, 2, [1]], atr: [1, 1, [0]], change: [1, 2, [1]], roc: [2, 2, [1]], mom: [2, 2, [1]], rising: [2, 2, [1]], falling: [2, 2, [1]],
  crossover: [2, 2, []], crossunder: [2, 2, []], cross: [2, 2, []], barssince: [1, 1, []], valuewhen: [2, 2, []],
  macd_line: [3, 3, [1, 2]], macd_signal: [4, 4, [1, 2, 3]], macd_hist: [4, 4, [1, 2, 3]], stoch_k: [1, 1, [0]], cci: [1, 1, [0]], adx: [1, 2, [0, 1]], plus_di: [1, 1, [0]], minus_di: [1, 1, [0]],
  supertrend_dir: [2, 2, [1]], supertrend_line: [2, 2, [1]],
};
export const DSL_REFERENCE = `Atoms: ${ATOMS.join(", ")}; a number; "$key" for a parameter; the name of a series defined in "series".
Arithmetic: ["+",a,b,...] ["-",a,b] ["*",a,b,...] ["/",a,b] ["neg",a] ["abs",a] ["min",a,b,...] ["max",a,b,...] ["pow",a,b] ["sqrt",a] ["log",a]
Conditions (1 = true, 0 = false): [">",a,b] ["<",a,b] [">=",a,b] ["<=",a,b] ["==",a,b] ["!=",a,b] ["and",a,b,...] ["or",a,b,...] ["not",a] ["if",cond,a,b]
History: ["prev",x,n] is x[n] in Pine (n defaults to 1); ["nz",x,alt] ; ["na",x] ; ["change",x,n] ; ["roc",x,n] ; ["mom",x,n] ; ["rising",x,n] ; ["falling",x,n] ; ["barssince",cond] ; ["valuewhen",cond,x] (most recent occurrence only)
Averages and ranges over n bars: ["sma",x,n] ["ema",x,n] ["rma",x,n] ["wma",x,n] ["vwma",x,n] ["stdev",x,n] ["highest",x,n] ["lowest",x,n] ["sum",x,n] ["linreg",x,n,offset]
Indicators: ["rsi",x,n] ["atr",n] ["macd_line",x,fast,slow] ["macd_signal",x,fast,slow,signal] ["macd_hist",x,fast,slow,signal] ["stoch_k",n] (raw %K from high/low/close; smooth it with sma) ["cci",n] ["adx",diLength,smoothing] ["plus_di",n] ["minus_di",n]
  ["supertrend_line",factor,atrLength] and ["supertrend_dir",factor,atrLength]: NOTE direction here is +1 in an UP-trend and -1 in a down-trend (the opposite sign of Pine's ta.supertrend direction).
Crosses: ["crossover",a,b] ["crossunder",a,b] ["cross",a,b]
Every length (n, fast, slow, signal, atrLength, offset) must be a whole number or a "$param": it cannot change from bar to bar.`;

const sClip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const NAME = /^[a-z][a-z0-9_]{0,30}$/i;

/** Check a definition coming from the model (or anywhere). Returns a cleaned spec or the first thing wrong with it. */
export function validateSpec(raw: unknown): { spec?: Spec; error?: string } {
  const o = raw as Record<string, unknown>; if (!o || typeof o !== "object") return { error: "The definition is not an object." };
  const params: ParamDef[] = [];
  for (const p of (Array.isArray(o.params) ? o.params : []).slice(0, 12) as Record<string, unknown>[]) {
    const key = sClip(p.key, 31), def = Number(p.def); if (!NAME.test(key) || !Number.isFinite(def)) return { error: `Bad parameter "${key}".` };
    const min = Number.isFinite(Number(p.min)) ? Number(p.min) : Math.min(def, 0), max = Number.isFinite(Number(p.max)) ? Number(p.max) : Math.max(def * 10, 100);
    if (params.some((x) => x.key === key)) return { error: `Parameter "${key}" appears twice.` };
    params.push({ key, label: sClip(p.label, 50) || key, def, min: Math.min(min, def), max: Math.max(max, def), step: Number(p.step) > 0 ? Number(p.step) : Number.isInteger(def) ? 1 : 0.1 });
  }
  const series: Record<string, Expr> = {}, sr = (o.series && typeof o.series === "object" ? o.series : {}) as Record<string, unknown>;
  if (Object.keys(sr).length > 60) return { error: "Too many series (60 at most)." };
  for (const [k, v] of Object.entries(sr)) { if (!NAME.test(k) || ATOMS.includes(k) || k in OPS) return { error: `Bad series name "${sClip(k, 40)}".` }; series[k] = v as Expr; }
  let nodes = 0;
  const check = (e: unknown, depth: number): string | null => {
    if (++nodes > 900) return "The definition is too large."; if (depth > 30) return "The definition is nested too deeply.";
    if (typeof e === "number") return Number.isFinite(e) ? null : "A number is not finite.";
    if (typeof e === "string") { if (ATOMS.includes(e) || e in series) return null; if (e.startsWith("$")) return params.some((p) => p.key === e.slice(1)) ? null : `Unknown parameter ${sClip(e, 40)}.`; return `Unknown name "${sClip(e, 40)}".`; }
    if (!Array.isArray(e) || typeof e[0] !== "string") return "An expression must be a number, a name or [op, ...].";
    const d = OPS[e[0]]; if (!d) return `Unknown function "${sClip(e[0], 30)}".`;
    const n = e.length - 1; if (n < d[0] || n > d[1]) return `"${e[0]}" takes ${d[0] === d[1] ? d[0] : `${d[0]} to ${d[1]}`} arguments, not ${n}.`;
    for (let i = 1; i < e.length; i++) {
      if (d[2].includes(i - 1)) { const a = e[i]; if (!(typeof a === "number" && Number.isFinite(a)) && !(typeof a === "string" && a.startsWith("$") && params.some((p) => p.key === a.slice(1)))) return `In "${e[0]}", the length must be a number or a parameter.`; continue; }
      const r = check(e[i], depth + 1); if (r) return r;
    }
    return null;
  };
  for (const [k, v] of Object.entries(series)) { const r = check(v, 0); if (r) return { error: `Series "${k}": ${r}` }; }
  const rule = (k: string): { v: Expr | null; err?: string } => { const v = o[k]; if (v === null || v === undefined || v === false) return { v: null }; const r = check(v, 0); return r ? { v: null, err: `Rule "${k}": ${r}` } : { v: v as Expr }; };
  const level = (k: string): { v: Level | null; err?: string } => { const v = o[k] as Record<string, unknown> | null | undefined; if (!v || typeof v !== "object") return { v: null }; const r = check(v.expr, 0); return r ? { v: null, err: `"${k}": ${r}` } : { v: { expr: v.expr as Expr, mode: v.mode === "trail" ? "trail" : "entry" } }; };
  const L = rule("long"), S = rule("short"), XL = rule("exit_long"), XS = rule("exit_short"), st = level("stop"), ss = level("stop_short"), tg = level("target"), ts = level("target_short");
  for (const x of [L, S, XL, XS, st, ss, tg, ts]) if (x.err) return { error: x.err };
  if (!L.v && !S.v) return { error: "The definition has no entry rule." };
  const spec: Spec = { name: sClip(o.name, 80) || "Converted strategy", how: sClip(o.how, 400), params, series, long: L.v, short: S.v, exit_long: XL.v, exit_short: XS.v, stop: st.v, stop_short: ss.v, target: tg.v, target_short: ts.v,
    differences: (Array.isArray(o.differences) ? o.differences : []).slice(0, 10).map((d) => sClip(d, 300)).filter(Boolean) };
  // A series may only use series that do not lead back to itself; a dry run on made-up bars catches that and anything else.
  try { const b: Bar[] = []; let p = 100; for (let i = 0; i < 260; i++) { const c = p * (1 + Math.sin(i * 0.37) * 0.01 + Math.cos(i * 0.11) * 0.006); b.push({ time: 1e9 + i * 60, open: p, high: Math.max(p, c) * 1.002, low: Math.min(p, c) * 0.998, close: c, volume: 1000 + (i % 7) * 100 }); p = c; }
    const step = compileSpec(spec)(b, Object.fromEntries(params.map((q) => [q.key, q.def]))); for (let i = 0; i < b.length; i++) step(i, { pos: 0, entry: 0 }); }
  catch (e) { return { error: String((e as Error).message || e).slice(0, 200) }; }
  return { spec };
}

/** Turn a checked definition into the tester's per-bar step function. */
export function compileSpec(spec: Spec): (b: Bar[], p: Record<string, number>) => (i: number, c: { pos: -1 | 0 | 1; entry: number }) => Out {
  return (b, p) => {
    const N = b.length, memo = new Map<string, A>(), busy = new Set<string>();
    const arr = (f: (i: number) => number) => { const a = new Float64Array(N); for (let i = 0; i < N; i++) a[i] = f(i); return a; };
    const len = (e: Expr) => { const v = typeof e === "number" ? e : p[String(e).slice(1)]; const n = Math.round(v); if (!(n >= 0 && n <= 5000)) throw new Error("A length is out of range (0 to 5000)."); return n; };
    const tr = arr((i) => (i ? Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close)) : b[i].high - b[i].low));
    const roll = (x: A, n: number, f: (w: number[]) => number) => arr((i) => { if (n < 1 || i < n - 1) return NaN; const w: number[] = []; for (let k = i - n + 1; k <= i; k++) { if (Number.isNaN(x[k])) return NaN; w.push(x[k]); } return f(w); });
    const smaA = (x: A, n: number) => { const o = new Float64Array(N).fill(NaN); let s = 0, run = 0; for (let i = 0; i < N; i++) { if (Number.isNaN(x[i])) { s = 0; run = 0; continue; } s += x[i]; run++; if (run > n) { s -= x[i - n]; run = n; } if (run === n) o[i] = s / n; } return o; };
    const emaA = (x: A, n: number, alpha = 2 / (n + 1)) => { const o = new Float64Array(N).fill(NaN); let e = NaN, s = 0, c = 0; for (let i = 0; i < N; i++) { if (Number.isNaN(x[i])) continue; if (c < n) { s += x[i]; c++; if (c === n) { e = s / n; o[i] = e; } } else { e = x[i] * alpha + e * (1 - alpha); o[i] = e; } } return o; }; // seeded with the simple average, as Pine does
    const rmaA = (x: A, n: number) => emaA(x, n, 1 / n);
    const dmi = (n: number) => { const pdm = arr((i) => { if (!i) return NaN; const u = b[i].high - b[i - 1].high, d = b[i - 1].low - b[i].low; return u > d && u > 0 ? u : 0; }), mdm = arr((i) => { if (!i) return NaN; const u = b[i].high - b[i - 1].high, d = b[i - 1].low - b[i].low; return d > u && d > 0 ? d : 0; });
      const a = rmaA(arr((i) => (i ? tr[i] : NaN)), n), ps = rmaA(pdm, n), ms = rmaA(mdm, n); return { plus: arr((i) => (100 * ps[i]) / a[i]), minus: arr((i) => (100 * ms[i]) / a[i]) }; };
    const supertrend = (factor: number, n: number) => { const atr = rmaA(tr, n), dir = new Float64Array(N).fill(NaN), line = new Float64Array(N).fill(NaN); let ub = NaN, lb = NaN, d = 0;
      for (let i = 0; i < N; i++) { if (Number.isNaN(atr[i])) continue; const hl2 = (b[i].high + b[i].low) / 2, bu = hl2 + factor * atr[i], bl = hl2 - factor * atr[i], pc = i ? b[i - 1].close : b[i].close;
        const nlb = Number.isNaN(lb) || bl > lb || pc < lb ? bl : lb, nub = Number.isNaN(ub) || bu < ub || pc > ub ? bu : ub; d = !d ? -1 : d === -1 ? (b[i].close > ub ? 1 : -1) : b[i].close < lb ? -1 : 1; lb = nlb; ub = nub; dir[i] = d; line[i] = d === 1 ? lb : ub; }
      return { dir, line }; };
    const ev = (e: Expr): A => {
      if (typeof e === "number") return arr(() => e);
      const key = typeof e === "string" ? e : JSON.stringify(e), hit = memo.get(key); if (hit) return hit;
      let r: A;
      if (typeof e === "string") {
        if (e.startsWith("$")) r = arr(() => p[e.slice(1)]);
        else if (e in spec.series) { if (busy.has(e)) throw new Error(`Series "${e}" refers to itself.`); busy.add(e); r = ev(spec.series[e]); busy.delete(e); }
        else r = e === "open" ? arr((i) => b[i].open) : e === "high" ? arr((i) => b[i].high) : e === "low" ? arr((i) => b[i].low) : e === "close" ? arr((i) => b[i].close) : e === "volume" ? arr((i) => b[i].volume) : e === "hl2" ? arr((i) => (b[i].high + b[i].low) / 2)
          : e === "hlc3" ? arr((i) => (b[i].high + b[i].low + b[i].close) / 3) : e === "ohlc4" ? arr((i) => (b[i].open + b[i].high + b[i].low + b[i].close) / 4) : e === "tr" ? tr : arr((i) => i);
      } else {
        const op = e[0] as string, a = (k: number) => ev(e[k]), has = (k: number) => e.length > k, T = (v: number) => (v && !Number.isNaN(v) ? 1 : 0), every = (f: (v: number[]) => number) => { const xs = e.slice(1).map((x) => ev(x)); return arr((i) => f(xs.map((x) => x[i]))); };
        switch (op) {
          case "+": r = every((v) => v.reduce((s, x) => s + x, 0)); break; case "*": r = every((v) => v.reduce((s, x) => s * x, 1)); break;
          case "-": { const x = a(1), y = a(2); r = arr((i) => x[i] - y[i]); break; } case "/": { const x = a(1), y = a(2); r = arr((i) => (y[i] === 0 ? NaN : x[i] / y[i])); break; }
          case "neg": { const x = a(1); r = arr((i) => -x[i]); break; } case "abs": { const x = a(1); r = arr((i) => Math.abs(x[i])); break; } case "sqrt": { const x = a(1); r = arr((i) => Math.sqrt(x[i])); break; } case "log": { const x = a(1); r = arr((i) => Math.log(x[i])); break; }
          case "pow": { const x = a(1), y = a(2); r = arr((i) => Math.pow(x[i], y[i])); break; }
          case "min": r = every((v) => (v.some(Number.isNaN) ? NaN : Math.min(...v))); break; case "max": r = every((v) => (v.some(Number.isNaN) ? NaN : Math.max(...v))); break;
          case ">": case "<": case ">=": case "<=": case "==": case "!=": { const x = a(1), y = a(2); r = arr((i) => (Number.isNaN(x[i]) || Number.isNaN(y[i]) ? 0 : (op === ">" ? x[i] > y[i] : op === "<" ? x[i] < y[i] : op === ">=" ? x[i] >= y[i] : op === "<=" ? x[i] <= y[i] : op === "==" ? x[i] === y[i] : x[i] !== y[i]) ? 1 : 0)); break; }
          case "and": r = every((v) => (v.every(T) ? 1 : 0)); break; case "or": r = every((v) => (v.some(T) ? 1 : 0)); break; case "not": { const x = a(1); r = arr((i) => (T(x[i]) ? 0 : 1)); break; }
          case "if": { const c = a(1), x = a(2), y = a(3); r = arr((i) => (T(c[i]) ? x[i] : y[i])); break; }
          case "prev": { const x = a(1), n = has(2) ? len(e[2]) : 1; r = arr((i) => (i >= n ? x[i - n] : NaN)); break; }
          case "nz": { const x = a(1), y = has(2) ? a(2) : null; r = arr((i) => (Number.isNaN(x[i]) ? (y ? y[i] : 0) : x[i])); break; } case "na": { const x = a(1); r = arr((i) => (Number.isNaN(x[i]) ? 1 : 0)); break; }
          case "sma": r = smaA(a(1), len(e[2])); break; case "ema": r = emaA(a(1), len(e[2])); break; case "rma": r = rmaA(a(1), len(e[2])); break;
          case "wma": { const n = len(e[2]); r = roll(a(1), n, (w) => w.reduce((s, x, k) => s + x * (k + 1), 0) / ((n * (n + 1)) / 2)); break; }
          case "vwma": { const x = a(1), n = len(e[2]), pv = smaA(arr((i) => x[i] * b[i].volume), n), v = smaA(arr((i) => b[i].volume), n); r = arr((i) => pv[i] / v[i]); break; }
          case "stdev": r = roll(a(1), len(e[2]), (w) => { const m = w.reduce((s, x) => s + x, 0) / w.length; return Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / w.length); }); break;
          case "highest": r = roll(a(1), len(e[2]), (w) => Math.max(...w)); break; case "lowest": r = roll(a(1), len(e[2]), (w) => Math.min(...w)); break; case "sum": r = roll(a(1), len(e[2]), (w) => w.reduce((s, x) => s + x, 0)); break;
          case "linreg": { const n = len(e[2]), off = has(3) ? len(e[3]) : 0; r = roll(a(1), n, (w) => { const mx = (n - 1) / 2, my = w.reduce((s, x) => s + x, 0) / n; let sxy = 0, sxx = 0; w.forEach((y, k) => { sxy += (k - mx) * (y - my); sxx += (k - mx) ** 2; }); const slope = sxx ? sxy / sxx : 0; return my - slope * mx + slope * (n - 1 - off); }); break; }
          case "rsi": { const x = a(1), n = len(e[2]), u = rmaA(arr((i) => (i ? Math.max(x[i] - x[i - 1], 0) : NaN)), n), d = rmaA(arr((i) => (i ? Math.max(x[i - 1] - x[i], 0) : NaN)), n); r = arr((i) => (Number.isNaN(u[i]) ? NaN : d[i] === 0 ? 100 : 100 - 100 / (1 + u[i] / d[i]))); break; }
          case "atr": r = rmaA(tr, len(e[1])); break;
          case "change": { const x = a(1), n = has(2) ? len(e[2]) : 1; r = arr((i) => (i >= n ? x[i] - x[i - n] : NaN)); break; } case "mom": { const x = a(1), n = len(e[2]); r = arr((i) => (i >= n ? x[i] - x[i - n] : NaN)); break; }
          case "roc": { const x = a(1), n = len(e[2]); r = arr((i) => (i >= n ? (100 * (x[i] - x[i - n])) / x[i - n] : NaN)); break; }
          case "rising": case "falling": { const x = a(1), n = len(e[2]); r = arr((i) => { if (i < n) return 0; for (let k = i - n + 1; k <= i; k++) if (!(op === "rising" ? x[k] > x[k - 1] : x[k] < x[k - 1])) return 0; return 1; }); break; }
          case "crossover": case "crossunder": case "cross": { const x = a(1), y = a(2); r = arr((i) => { if (!i || [x[i], y[i], x[i - 1], y[i - 1]].some(Number.isNaN)) return 0; const up = x[i] > y[i] && x[i - 1] <= y[i - 1], dn = x[i] < y[i] && x[i - 1] >= y[i - 1]; return (op === "crossover" ? up : op === "crossunder" ? dn : up || dn) ? 1 : 0; }); break; }
          case "barssince": { const c = a(1); let n = NaN; r = arr((i) => { n = T(c[i]) ? 0 : n + 1; return n; }); break; } case "valuewhen": { const c = a(1), x = a(2); let v = NaN; r = arr((i) => { if (T(c[i])) v = x[i]; return v; }); break; }
          case "macd_line": case "macd_signal": case "macd_hist": { const x = a(1), f = emaA(x, len(e[2])), s = emaA(x, len(e[3])), m = arr((i) => f[i] - s[i]); if (op === "macd_line") { r = m; break; } const sg = emaA(m, len(e[4])); r = op === "macd_signal" ? sg : arr((i) => m[i] - sg[i]); break; }
          case "stoch_k": { const n = len(e[1]), hh = roll(arr((i) => b[i].high), n, (w) => Math.max(...w)), ll = roll(arr((i) => b[i].low), n, (w) => Math.min(...w)); r = arr((i) => (hh[i] === ll[i] ? NaN : (100 * (b[i].close - ll[i])) / (hh[i] - ll[i]))); break; }
          case "cci": { const n = len(e[1]), tp = arr((i) => (b[i].high + b[i].low + b[i].close) / 3), m = smaA(tp, n), md = roll(tp, n, (w) => { const mu = w.reduce((s, x) => s + x, 0) / w.length; return w.reduce((s, x) => s + Math.abs(x - mu), 0) / w.length; }); r = arr((i) => (tp[i] - m[i]) / (0.015 * md[i])); break; }
          case "plus_di": r = dmi(len(e[1])).plus; break; case "minus_di": r = dmi(len(e[1])).minus; break;
          case "adx": { const d = dmi(len(e[1])), dx = arr((i) => (Number.isNaN(d.plus[i]) || Number.isNaN(d.minus[i]) ? NaN : (100 * Math.abs(d.plus[i] - d.minus[i])) / (d.plus[i] + d.minus[i] || 1))); r = rmaA(dx, has(2) ? len(e[2]) : len(e[1])); break; }
          case "supertrend_dir": r = supertrend(Number(typeof e[1] === "number" ? e[1] : p[String(e[1]).slice(1)]), len(e[2])).dir; break; case "supertrend_line": r = supertrend(Number(typeof e[1] === "number" ? e[1] : p[String(e[1]).slice(1)]), len(e[2])).line; break;
          default: throw new Error(`Unknown function "${op}".`);
        }
      }
      memo.set(key, r); return r;
    };
    const rule = (e: Expr | null) => (e === null ? null : ev(e)), lvl = (l: Level | null) => (l ? { a: ev(l.expr), trail: l.mode === "trail" } : null);
    const L = rule(spec.long), S = rule(spec.short), XL = rule(spec.exit_long), XS = rule(spec.exit_short), sl = lvl(spec.stop), ss = lvl(spec.stop_short), tl = lvl(spec.target), ts = lvl(spec.target_short);
    const on = (a: A | null, i: number) => !!a && a[i] !== 0 && !Number.isNaN(a[i]);
    let lastPos = 0, pend: { stop: number; limit: number } = { stop: NaN, limit: NaN }, act = { stop: NaN, limit: NaN };
    return (i, c) => {
      if (c.pos !== lastPos) { if (c.pos !== 0) act = { ...pend }; lastPos = c.pos; } // a new position takes the levels fixed on its signal bar
      const o: Out = {}, goL = on(L, i), goS = on(S, i);
      if (goL && !goS && c.pos !== 1) { o.long = { type: "market" }; pend = { stop: sl ? sl.a[i] : NaN, limit: tl ? tl.a[i] : NaN }; }
      else if (goS && !goL && c.pos !== -1) { o.short = { type: "market" }; pend = { stop: ss ? ss.a[i] : NaN, limit: ts ? ts.a[i] : NaN }; }
      if (c.pos === 1) { if (on(XL, i)) o.close = true; const st = sl ? (sl.trail ? sl.a[i] : act.stop) : NaN, lm = tl ? (tl.trail ? tl.a[i] : act.limit) : NaN; if (!Number.isNaN(st) || !Number.isNaN(lm)) o.exit = { ...(Number.isNaN(st) ? {} : { stop: st }), ...(Number.isNaN(lm) ? {} : { limit: lm }) }; }
      if (c.pos === -1) { if (on(XS, i)) o.close = true; const st = ss ? (ss.trail ? ss.a[i] : act.stop) : NaN, lm = ts ? (ts.trail ? ts.a[i] : act.limit) : NaN; if (!Number.isNaN(st) || !Number.isNaN(lm)) o.exit = { ...(Number.isNaN(st) ? {} : { stop: st }), ...(Number.isNaN(lm) ? {} : { limit: lm }) }; }
      return o;
    };
  };
}
