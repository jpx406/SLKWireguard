// ML engine, part 3: dataset, the time-ordered split, training both models, and the honest scorecard.
// Rules enforced here (not left to whoever calls it):
//  1. The split is by TIME across all symbols: everything before the cut trains, everything after validates. Rows
//     are never shuffled across that line, and training rows whose label window reaches past the cut are dropped
//     (an embargo), so no future price leaks into training.
//  2. The scaler is fitted on the training rows only and stored with the model.
//  3. Both models train on the same rows; early stopping and probability calibration use a slice held out of the
//     TRAINING period, never the validation period, so the validation numbers are untouched until the final score.
//  4. A model may drive trades only if its confident calls beat the base rate by a margin on enough validation
//     signals and made money after costs. Otherwise it is shown but marked as having no proven edge.
import { CLASSES, FEATURES, SIGNAL_EXTRA, WARMUP, featureRows, labelAt, type Bar, type LabelSpec } from "./features";
import { K, fitTemperature, gbdtLogits, gbdtPredict, mlpLogits, mlpPredict, trainGbdt, trainMlp, type GbdtJson, type MlpJson } from "./models";

export type Profile = { id: "swing" | "intraday"; interval: "1d" | "60m"; days: number; label: LabelSpec; title: string };
export const PROFILES: Record<string, Profile> = {
  swing: { id: "swing", interval: "1d", days: 1500, label: { horizon: 5, atr_mult: 1, min_pct: 0.01 }, title: "Swing (daily bars, next 5 days)" },
  intraday: { id: "intraday", interval: "60m", days: 700, label: { horizon: 5, atr_mult: 1.5, min_pct: 0.005 }, title: "Intraday (1-hour bars, next 5 hours)" },
};
export const COST = 0.0008; // round-trip cost assumed per trade (8 basis points), for the "made money after costs" test

export type Sample = { t: number; end: number; sym: string; x: number[]; y: number; fwd: number };
export function buildSamples(sym: string, bars: Bar[], market: Bar[] | null, spec: LabelSpec): Sample[] {
  const out: Sample[] = [];
  for (const r of featureRows(bars, market)) { const l = labelAt(bars, r.i, r.atr_pct, spec); if (l) out.push({ t: r.time, end: bars[r.i + spec.horizon].time, sym, x: r.x, y: l.y, fwd: l.fwd }); }
  return out;
}

export type Scaler = { mean: number[]; std: number[] };
export function fitScaler(X: number[][]): Scaler { const F = X[0].length, mean = new Array(F).fill(0), std = new Array(F).fill(0); for (const r of X) for (let f = 0; f < F; f++) mean[f] += r[f] / X.length; for (const r of X) for (let f = 0; f < F; f++) std[f] += (r[f] - mean[f]) ** 2 / X.length; return { mean, std: std.map((v) => Math.sqrt(v) || 1) }; }
export const scale = (s: Scaler, x: number[]) => x.map((v, f) => { const z = (v - s.mean[f]) / s.std[f]; return z > 5 ? 5 : z < -5 ? -5 : z; });

export type ModelJson = { features: string[]; scaler: Scaler; mlp: MlpJson; gbdt: GbdtJson; winner: "mlp" | "gbdt" | "ensemble"; threshold: number };
/** Probabilities [DOWN, FLAT, UP] from the deployed model for one raw feature row. */
export function predict(m: ModelJson, x: number[], which: ModelJson["winner"] = m.winner): number[] {
  const z = scale(m.scaler, x);
  if (which === "mlp") return mlpPredict(m.mlp, z); if (which === "gbdt") return gbdtPredict(m.gbdt, z);
  const a = mlpPredict(m.mlp, z), b = gbdtPredict(m.gbdt, z); return a.map((v, k) => (v + b[k]) / 2);
}
/** The decision rule: BUY or SELL only above the confidence threshold, otherwise HOLD. */
export function decide(p: number[], threshold: number): { decision: "BUY" | "SELL" | "HOLD"; confidence: number } {
  if (p[2] >= threshold && p[2] > p[0]) return { decision: "BUY", confidence: p[2] };
  if (p[0] >= threshold && p[0] > p[2]) return { decision: "SELL", confidence: p[0] };
  return { decision: "HOLD", confidence: Math.max(p[0], p[2]) };
}

export type Score = {
  n: number; accuracy: number; log_loss: number; f1_dir: number; confusion: number[][]; per_class: { cls: string; precision: number; recall: number; f1: number; n: number }[];
  gated: { threshold: number; signals: number; precision: number | null; wrong_way: number | null; avg_return_pct: number | null; buys: number; sells: number };
  sweep: { threshold: number; signals: number; precision: number | null; avg_return_pct: number | null }[];
};
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
function gate(P: number[][], S: Sample[], threshold: number) {
  let n = 0, hit = 0, wrong = 0, ret = 0, buys = 0, sells = 0;
  for (let i = 0; i < S.length; i++) { const d = decide(P[i], threshold); if (d.decision === "HOLD") continue; n++; const up = d.decision === "BUY"; if (up) buys++; else sells++; if (S[i].y === (up ? 2 : 0)) hit++; if (S[i].y === (up ? 0 : 2)) wrong++; ret += (up ? 1 : -1) * S[i].fwd - COST; }
  return { threshold, signals: n, precision: n ? r4(hit / n) : null, wrong_way: n ? r4(wrong / n) : null, avg_return_pct: n ? r4((ret / n) * 100) : null, buys, sells };
}
export function score(P: number[][], S: Sample[], threshold: number): Score {
  const C = Array.from({ length: K }, () => new Array(K).fill(0)); let ok = 0, ll = 0;
  for (let i = 0; i < S.length; i++) { let a = 0; for (let k = 1; k < K; k++) if (P[i][k] > P[i][a]) a = k; C[S[i].y][a]++; if (a === S[i].y) ok++; ll -= Math.log(Math.max(P[i][S[i].y], 1e-9)); }
  const per = CLASSES.map((cls, k) => { const tp = C[k][k], col = C.reduce((s, r) => s + r[k], 0), row = C[k].reduce((s, v) => s + v, 0), p = col ? tp / col : 0, r = row ? tp / row : 0; return { cls, precision: r4(p), recall: r4(r), f1: r4(p + r ? (2 * p * r) / (p + r) : 0), n: row }; });
  return { n: S.length, accuracy: r4(ok / Math.max(S.length, 1)), log_loss: r4(ll / Math.max(S.length, 1)), f1_dir: r4((per[0].f1 + per[2].f1) / 2), confusion: C, per_class: per, gated: gate(P, S, threshold),
    sweep: [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((t) => { const g = gate(P, S, t); return { threshold: t, signals: g.signals, precision: g.precision, avg_return_pct: g.avg_return_pct }; }) };
}

export type Report = {
  profile: string; title: string; trained_at: number; symbols: number; samples: { train: number; inner: number; valid: number }; period: { train_from: number; train_to: number; valid_from: number; valid_to: number };
  base_rate: { down: number; flat: number; up: number }; threshold: number; scores: { mlp: Score; gbdt: Score; ensemble: Score }; winner: ModelJson["winner"]; why_winner: string;
  edge: boolean; edge_reason: string; importance: { feature: string; gbdt_gain: number; mlp_drop: number }[]; mlp_epochs: number; gbdt_rounds: number; train_ms: number;
};

/** Train both models on pooled samples and score them on the untouched last part of the timeline. */
export function trainAll(profile: Profile, samples: Sample[], o: { threshold?: number; valid_share?: number; max_train?: number; seed?: number; fast?: boolean } = {}): { model: ModelJson; report: Report } {
  const t0 = Date.now(), threshold = o.threshold ?? 0.7, S = samples.slice().sort((a, b) => a.t - b.t);
  if (S.length < 600) throw new Error(`Only ${S.length} labelled bars: not enough history to train on.`);
  const cut = S[Math.floor(S.length * (1 - (o.valid_share ?? 0.2)))].t;
  const valid = S.filter((s) => s.t >= cut), pre = S.filter((s) => s.end < cut); // embargo: a training label may not look past the cut
  const cut2 = pre[Math.floor(pre.length * 0.85)].t;
  let train = pre.filter((s) => s.end < cut2); const inner = pre.filter((s) => s.t >= cut2);
  const symbols = new Set(S.map((s) => s.sym)).size;
  if (o.max_train && train.length > o.max_train) train = train.slice(train.length - o.max_train); // keep the most recent rows
  const scaler = fitScaler(train.map((s) => s.x)), Z = (a: Sample[]) => a.map((s) => scale(scaler, s.x)), Y = (a: Sample[]) => a.map((s) => s.y);
  const Xt = Z(train), Xi = Z(inner), Xv = Z(valid), yt = Y(train), yi = Y(inner);
  const nn = trainMlp(Xt, yt, Xi, yi, { seed: o.seed ?? 7, epochs: o.fast ? 12 : 60 }), gb = trainGbdt(Xt, yt, Xi, yi, { seed: (o.seed ?? 7) + 4, rounds: o.fast ? 40 : 200 });
  nn.model.T = fitTemperature(Xi.map((x) => mlpLogits(nn.model, x)), yi); gb.model.T = fitTemperature(Xi.map((x) => gbdtLogits(gb.model, x)), yi);
  const Pm = Xv.map((x) => mlpPredict(nn.model, x)), Pg = Xv.map((x) => gbdtPredict(gb.model, x)), Pe = Pm.map((p, i) => p.map((v, k) => (v + Pg[i][k]) / 2));
  const scores = { mlp: score(Pm, valid, threshold), gbdt: score(Pg, valid, threshold), ensemble: score(Pe, valid, threshold) };
  // Winner: the best precision on confident calls when each has enough of them to judge; otherwise the best F1 on UP and DOWN.
  const names = ["mlp", "gbdt", "ensemble"] as const, enough = names.every((n) => scores[n].gated.signals >= 30);
  const winner = names.slice().sort((a, b) => (enough ? (scores[b].gated.precision ?? 0) - (scores[a].gated.precision ?? 0) : scores[b].f1_dir - scores[a].f1_dir))[0];
  const base = [0, 1, 2].map((k) => valid.filter((s) => s.y === k).length / valid.length), w = scores[winner].gated;
  const mix = w.signals ? (w.buys * base[2] + w.sells * base[0]) / w.signals : 0; // what random calls in the same direction mix would score
  // Beating chance by eye is not enough: the gap must also be more than twice its own sampling error.
  const z = w.signals && mix > 0 && mix < 1 ? ((w.precision ?? 0) - mix) / Math.sqrt((mix * (1 - mix)) / w.signals) : 0;
  const edge = w.signals >= 30 && (w.precision ?? 0) >= mix + 0.08 && z >= 2 && (w.avg_return_pct ?? 0) > 0;
  const pct = (v: number | null) => `${Math.round((v ?? 0) * 100)}%`;
  const edge_reason = w.signals < 30 ? `Only ${w.signals} calls reached ${pct(threshold)} confidence in the validation period: too few to judge, so the model is display-only.`
    : !edge ? `Confident calls were right ${pct(w.precision)} of the time against ${pct(mix)} for chance in the same direction, averaging ${w.avg_return_pct}% per trade after costs: no proven edge, so the model is display-only.`
    : `Confident calls were right ${pct(w.precision)} of the time against ${pct(mix)} for chance, averaging +${w.avg_return_pct}% per trade after costs, on ${w.signals} validation signals.`;
  // What drives it: tree gain, and how much the network's validation accuracy drops when one feature is scrambled.
  const model: ModelJson = { features: [...FEATURES], scaler, mlp: nn.model, gbdt: gb.model, winner, threshold };
  const sub = Xv.length > 1500 ? Xv.filter((_, i) => i % Math.ceil(Xv.length / 1500) === 0) : Xv, subY = valid.length > 1500 ? valid.filter((_, i) => i % Math.ceil(valid.length / 1500) === 0) : valid;
  const acc = (rows: number[][]) => { let ok = 0; for (let i = 0; i < rows.length; i++) { const p = mlpPredict(nn.model, rows[i]); let a = 0; for (let k = 1; k < K; k++) if (p[k] > p[a]) a = k; if (a === subY[i].y) ok++; } return ok / Math.max(rows.length, 1); };
  const baseAcc = acc(sub), importance = FEATURES.map((feature, f) => { const col = sub.map((r) => r[f]); const perm = sub.map((r, i) => { const c = r.slice(); c[f] = col[(i * 7919 + 13) % col.length]; return c; }); return { feature, gbdt_gain: r4(gb.model.gain[f]), mlp_drop: r4(Math.max(0, baseAcc - acc(perm))) }; })
    .sort((a, b) => b.gbdt_gain + b.mlp_drop * 2 - (a.gbdt_gain + a.mlp_drop * 2));
  const report: Report = {
    profile: profile.id, title: profile.title, trained_at: Math.floor(Date.now() / 1000), symbols, samples: { train: train.length, inner: inner.length, valid: valid.length },
    period: { train_from: train[0].t, train_to: train[train.length - 1].t, valid_from: valid[0].t, valid_to: valid[valid.length - 1].t }, base_rate: { down: r4(base[0]), flat: r4(base[1]), up: r4(base[2]) }, threshold, scores, winner,
    why_winner: enough ? "best precision on confident calls" : "best F1 on UP and DOWN (too few confident calls to rank on precision)", edge, edge_reason, importance, mlp_epochs: nn.epochs, gbdt_rounds: gb.rounds, train_ms: Date.now() - t0,
  };
  return { model, report };
}

// ------------------------------------------------------------------------------------------------ signal filter
// Meta-labelling: the desk's candle signals are the primary strategy; the models learn which of them tend to fail.
// A signal's score is P(win) - P(loss). The cut points come from the held-out slice of the training period; how
// the slices actually performed is measured on the validation period. Result in R (multiples of the risk taken).
export type FilterSample = { t: number; end: number; sym: string; x: number[]; r: number; y: number };
export const outcomeClass = (r: number) => (r >= 0.5 ? 2 : r <= -0.5 ? 0 : 1);
export type Slice = { n: number; avg_r: number | null; win_rate: number | null };
export type FilterModel = { features: string[]; patterns: string[]; scaler: Scaler; mlp: MlpJson; gbdt: GbdtJson; winner: ModelJson["winner"]; cuts: { skip: number; good: number; top: number } };
export type FilterReport = {
  title: string; interval: string; trained_at: number; symbols: number; samples: { train: number; inner: number; valid: number }; period: Report["period"];
  all: Slice; skip: Slice; keep: Slice; good: Slice; top: Slice; by_model: Record<string, { skip: Slice; keep: Slice; top: Slice }>; winner: ModelJson["winner"];
  useful: boolean; reason: string; importance: Report["importance"]; mlp_epochs: number; gbdt_rounds: number; train_ms: number;
};
const slice = (a: FilterSample[]): Slice => ({ n: a.length, avg_r: a.length ? r4(a.reduce((s, v) => s + v.r, 0) / a.length) : null, win_rate: a.length ? r4(a.filter((v) => v.r > 0).length / a.length) : null });
export function filterScore(m: FilterModel, x: number[], which: ModelJson["winner"] = m.winner) { const p = predict({ ...m, threshold: 1 } as unknown as ModelJson, x, which); return p[2] - p[0]; }
export function gradeOf(m: FilterModel, score: number): "skip" | "C" | "B" | "A" { return score <= m.cuts.skip ? "skip" : score >= m.cuts.top ? "A" : score >= m.cuts.good ? "B" : "C"; }

export function trainFilter(title: string, interval: string, samples: FilterSample[], patterns: string[], o: { seed?: number; fast?: boolean; max_train?: number } = {}): { model: FilterModel; report: FilterReport } {
  const t0 = Date.now(), S = samples.slice().sort((a, b) => a.t - b.t);
  if (S.length < 500) throw new Error(`Only ${S.length} past signals: not enough to train the filter on.`);
  const cut = S[Math.floor(S.length * 0.8)].t, valid = S.filter((s) => s.t >= cut), pre = S.filter((s) => s.end < cut), cut2 = pre[Math.floor(pre.length * 0.85)].t;
  let train = pre.filter((s) => s.end < cut2); const inner = pre.filter((s) => s.t >= cut2);
  if (o.max_train && train.length > o.max_train) train = train.slice(train.length - o.max_train);
  const scaler = fitScaler(train.map((s) => s.x)), Z = (a: FilterSample[]) => a.map((s) => scale(scaler, s.x)), Y = (a: FilterSample[]) => a.map((s) => s.y);
  const Xt = Z(train), Xi = Z(inner), yt = Y(train), yi = Y(inner);
  const nn = trainMlp(Xt, yt, Xi, yi, { seed: o.seed ?? 7, epochs: o.fast ? 12 : 60 }), gb = trainGbdt(Xt, yt, Xi, yi, { seed: (o.seed ?? 7) + 4, rounds: o.fast ? 40 : 200 });
  nn.model.T = fitTemperature(Xi.map((x) => mlpLogits(nn.model, x)), yi); gb.model.T = fitTemperature(Xi.map((x) => gbdtLogits(gb.model, x)), yi);
  const features = [...FEATURES, ...SIGNAL_EXTRA], base = { features, patterns, scaler, mlp: nn.model, gbdt: gb.model, cuts: { skip: 0, good: 0, top: 0 } };
  const names = ["mlp", "gbdt", "ensemble"] as const, q = (v: number[], f: number) => v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * f))];
  const built = names.map((n) => { const m: FilterModel = { ...base, winner: n, cuts: { skip: 0, good: 0, top: 0 } }; const si = inner.map((s) => filterScore(m, s.x, n)); m.cuts = { skip: q(si, 0.25), good: q(si, 0.5), top: q(si, 0.9) };
    const sepInner = (slice(inner.filter((_, i) => si[i] > m.cuts.skip)).avg_r ?? 0) - (slice(inner.filter((_, i) => si[i] <= m.cuts.skip)).avg_r ?? 0);
    const sv = valid.map((s) => filterScore(m, s.x, n)); return { n, m, sepInner, sv }; });
  const win = built.slice().sort((a, b) => b.sepInner - a.sepInner)[0], sv = win.sv, m = win.m; // chosen on the held-out training slice, judged on validation
  const part = (b: (typeof built)[number]) => ({ skip: slice(valid.filter((_, i) => b.sv[i] <= b.m.cuts.skip)), keep: slice(valid.filter((_, i) => b.sv[i] > b.m.cuts.skip)), top: slice(valid.filter((_, i) => b.sv[i] >= b.m.cuts.top)) });
  const all = slice(valid), w = part(win), good = slice(valid.filter((_, i) => sv[i] >= m.cuts.good));
  // "Useful" needs a gap of at least 0.1R that is also more than 2.5 times its sampling error: random data must not pass.
  const sk = valid.filter((_, i) => sv[i] <= m.cuts.skip), kp = valid.filter((_, i) => sv[i] > m.cuts.skip), varOf = (a: FilterSample[]) => { const mu = a.reduce((q, v) => q + v.r, 0) / Math.max(a.length, 1); return a.reduce((q, v) => q + (v.r - mu) ** 2, 0) / Math.max(a.length - 1, 1); };
  const gap = (w.keep.avg_r ?? 0) - (w.skip.avg_r ?? 0), se = Math.sqrt(varOf(sk) / Math.max(sk.length, 1) + varOf(kp) / Math.max(kp.length, 1)) || 1;
  const useful = w.skip.n >= 40 && w.keep.n >= 40 && gap >= 0.1 && gap / se >= 2.5;
  const R = (v: number | null) => `${(v ?? 0) > 0 ? "+" : ""}${(v ?? 0).toFixed(2)}R`;
  const reason = useful ? `On signals it never saw, the ones it marked "skip" averaged ${R(w.skip.avg_r)} and the ones it kept ${R(w.keep.avg_r)} (all signals: ${R(all.avg_r)}). Skipping the worst quarter is worth ${R((w.keep.avg_r ?? 0) - (all.avg_r ?? 0))} per trade.${(w.keep.avg_r ?? 0) <= 0 ? " The kept signals still lost money on average: the filter makes the candle signals less bad, not profitable." : ""}`
    : `On signals it never saw, "skip" averaged ${R(w.skip.avg_r)} against ${R(w.keep.avg_r)} for the rest: ${gap >= 0.1 ? "a gap that could still be luck on this many signals" : "not a clear enough difference to act on"}, so the filter is display-only.`;
  const Xs = Z(valid).slice(0, 1500), vs = valid.slice(0, 1500), sep = (rows: number[][]) => { const sc = rows.map((x) => { const p = win.n === "gbdt" ? gbdtPredict(gb.model, x) : mlpPredict(nn.model, x); return p[2] - p[0]; }); const k = slice(vs.filter((_, i) => sc[i] > m.cuts.skip)).avg_r ?? 0, s2 = slice(vs.filter((_, i) => sc[i] <= m.cuts.skip)).avg_r ?? 0; return k - s2; };
  const baseSep = sep(Xs), importance = features.map((feature, f) => { const col = Xs.map((r) => r[f]); const perm = Xs.map((r, i) => { const c = r.slice(); c[f] = col[(i * 7919 + 13) % col.length]; return c; }); return { feature, gbdt_gain: r4(gb.model.gain[f]), mlp_drop: r4(Math.max(0, baseSep - sep(perm))) }; }).sort((a, b) => b.gbdt_gain - a.gbdt_gain);
  return { model: m, report: { title, interval, trained_at: Math.floor(Date.now() / 1000), symbols: new Set(S.map((s) => s.sym)).size, samples: { train: train.length, inner: inner.length, valid: valid.length },
    period: { train_from: train[0].t, train_to: train[train.length - 1].t, valid_from: valid[0].t, valid_to: valid[valid.length - 1].t }, all, skip: w.skip, keep: w.keep, good, top: w.top,
    by_model: Object.fromEntries(built.map((b) => [b.n, part(b)])), winner: win.n, useful, reason, importance, mlp_epochs: nn.epochs, gbdt_rounds: gb.rounds, train_ms: Date.now() - t0 } };
}
export { WARMUP };
