// ML engine, part 2: the two models, written out in full so they run anywhere the app runs (no Python, no GPU).
//  - Mlp: a multi-layer perceptron (neural network) with ReLU, dropout, weight decay and Adam, trained by backpropagation.
//  - Gbdt: gradient-boosted decision trees with a softmax objective (the XGBoost recipe: second-order gains,
//    shrinkage, row and column subsampling, histogram splits).
// Both stop early on a time-ordered slice held out of the training data, and both are plain JSON once trained.
export const K = 3; // classes: DOWN, FLAT, UP

/** Small seeded generator, so a retrain on the same data gives the same model. */
export function rng(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const softmax = (z: number[] | Float64Array, T = 1) => { let m = -Infinity; for (let k = 0; k < K; k++) if (z[k] > m) m = z[k]; let s = 0; const p = new Array<number>(K); for (let k = 0; k < K; k++) { p[k] = Math.exp((z[k] - m) / T); s += p[k]; } for (let k = 0; k < K; k++) p[k] /= s; return p; };
export const logLoss = (P: number[][], y: number[]) => { let s = 0; for (let i = 0; i < y.length; i++) s -= Math.log(Math.max(P[i][y[i]], 1e-9)); return s / Math.max(y.length, 1); };

/** Inverse-frequency class weights, capped, so the model is not rewarded for always saying FLAT. */
export function classWeights(y: number[]) { const c = new Array(K).fill(0); for (const v of y) c[v]++; return c.map((n) => Math.min(4, y.length / (K * Math.max(n, 1)))); }

// ------------------------------------------------------------------------------------------------ neural network
export type MlpJson = { kind: "mlp"; sizes: number[]; W: number[][]; b: number[][]; T: number };
export function mlpLogits(m: MlpJson, x: number[]): number[] {
  let a = x;
  for (let l = 0; l < m.W.length; l++) { const nin = m.sizes[l], nout = m.sizes[l + 1], W = m.W[l], z = new Array<number>(nout); for (let o = 0; o < nout; o++) { let s = m.b[l][o]; const off = o * nin; for (let i = 0; i < nin; i++) s += W[off + i] * a[i]; z[o] = l < m.W.length - 1 ? (s > 0 ? s : 0) : s; } a = z; }
  return a;
}
export const mlpPredict = (m: MlpJson, x: number[]) => softmax(mlpLogits(m, x), m.T);

export function trainMlp(X: number[][], y: number[], Xv: number[][], yv: number[], o: { hidden?: number[]; epochs?: number; lr?: number; dropout?: number; decay?: number; batch?: number; patience?: number; seed?: number; weighted?: boolean } = {}): { model: MlpJson; epochs: number; val_loss: number } {
  const F = X[0].length, sizes = [F, ...(o.hidden ?? [32, 16]), K], L = sizes.length - 1, rand = rng(o.seed ?? 7), lr = o.lr ?? 0.002, drop = o.dropout ?? 0.2, decay = o.decay ?? 1e-4, B = o.batch ?? 64;
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const W = sizes.slice(0, L).map((nin, l) => Float64Array.from({ length: nin * sizes[l + 1] }, () => gauss() * Math.sqrt(2 / nin))), b = sizes.slice(1).map((n) => new Float64Array(n));
  const mW = W.map((w) => new Float64Array(w.length)), vW = W.map((w) => new Float64Array(w.length)), mb = b.map((v) => new Float64Array(v.length)), vb = b.map((v) => new Float64Array(v.length));
  const cw = o.weighted ? classWeights(y) : [1, 1, 1], idx = X.map((_, i) => i), snapshot = () => ({ W: W.map((w) => Array.from(w)), b: b.map((v) => Array.from(v)) });
  const evalLoss = () => { const m: MlpJson = { kind: "mlp", sizes, W: W.map((w) => w as unknown as number[]), b: b.map((v) => v as unknown as number[]), T: 1 }; let s = 0; for (let i = 0; i < Xv.length; i++) s -= Math.log(Math.max(softmax(mlpLogits(m, Xv[i]))[yv[i]], 1e-9)); return s / Math.max(Xv.length, 1); };
  let best = Infinity, bestSnap = snapshot(), bad = 0, step = 0, ep = 0;
  const acts: Float64Array[] = sizes.map((n) => new Float64Array(n)), masks = sizes.map((n) => new Float64Array(n)), delta = sizes.map((n) => new Float64Array(n));
  const gW = W.map((w) => new Float64Array(w.length)), gb = b.map((v) => new Float64Array(v.length));
  for (ep = 1; ep <= (o.epochs ?? 60); ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; } // shuffles rows INSIDE the training split only
    for (let s = 0; s < idx.length; s += B) {
      const end = Math.min(s + B, idx.length); for (const g of gW) g.fill(0); for (const g of gb) g.fill(0);
      for (let q = s; q < end; q++) {
        const r = idx[q]; acts[0].set(X[r]);
        for (let l = 0; l < L; l++) { const nin = sizes[l], nout = sizes[l + 1], a = acts[l], z = acts[l + 1]; for (let oo = 0; oo < nout; oo++) { let v = b[l][oo]; const off = oo * nin; for (let i = 0; i < nin; i++) v += W[l][off + i] * a[i]; if (l < L - 1) { const keep = rand() >= drop ? 1 / (1 - drop) : 0; masks[l + 1][oo] = v > 0 ? keep : 0; v = v > 0 ? v * keep : 0; } z[oo] = v; } }
        const p = softmax(acts[L]); for (let k = 0; k < K; k++) delta[L][k] = (p[k] - (k === y[r] ? 1 : 0)) * cw[y[r]];
        for (let l = L - 1; l >= 0; l--) { const nin = sizes[l], nout = sizes[l + 1], a = acts[l], d = delta[l + 1], dp = delta[l]; if (l > 0) dp.fill(0); for (let oo = 0; oo < nout; oo++) { const dv = d[oo]; if (dv === 0) continue; const off = oo * nin; gb[l][oo] += dv; for (let i = 0; i < nin; i++) { gW[l][off + i] += dv * a[i]; if (l > 0) dp[i] += dv * W[l][off + i]; } } if (l > 0) for (let i = 0; i < nin; i++) dp[i] *= masks[l][i]; }
      }
      step++; const n = end - s, c1 = 1 - Math.pow(0.9, step), c2 = 1 - Math.pow(0.999, step);
      for (let l = 0; l < L; l++) {
        for (let i = 0; i < W[l].length; i++) { const g = gW[l][i] / n + decay * W[l][i]; mW[l][i] = 0.9 * mW[l][i] + 0.1 * g; vW[l][i] = 0.999 * vW[l][i] + 0.001 * g * g; W[l][i] -= (lr * (mW[l][i] / c1)) / (Math.sqrt(vW[l][i] / c2) + 1e-8); }
        for (let i = 0; i < b[l].length; i++) { const g = gb[l][i] / n; mb[l][i] = 0.9 * mb[l][i] + 0.1 * g; vb[l][i] = 0.999 * vb[l][i] + 0.001 * g * g; b[l][i] -= (lr * (mb[l][i] / c1)) / (Math.sqrt(vb[l][i] / c2) + 1e-8); }
      }
    }
    const v = evalLoss(); if (v < best - 1e-4) { best = v; bestSnap = snapshot(); bad = 0; } else if (++bad >= (o.patience ?? 8)) break;
  }
  return { model: { kind: "mlp", sizes, W: bestSnap.W, b: bestSnap.b, T: 1 }, epochs: ep, val_loss: best };
}

// ------------------------------------------------------------------------------------------------ boosted trees
type Tree = { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] }; // node arrays; f = -1 marks a leaf
export type GbdtJson = { kind: "gbdt"; trees: Tree[][]; base: number[]; T: number; gain: number[] };
const treeValue = (t: Tree, x: number[]) => { let n = 0; while (t.f[n] >= 0) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n]; return t.v[n]; };
export function gbdtLogits(m: GbdtJson, x: number[]) { const z = m.base.slice(); for (const round of m.trees) for (let k = 0; k < K; k++) z[k] += treeValue(round[k], x); return z; }
export const gbdtPredict = (m: GbdtJson, x: number[]) => softmax(gbdtLogits(m, x), m.T);

export function trainGbdt(X: number[][], y: number[], Xv: number[][], yv: number[], o: { rounds?: number; depth?: number; lr?: number; lambda?: number; subsample?: number; colsample?: number; min_hess?: number; bins?: number; patience?: number; seed?: number; weighted?: boolean } = {}): { model: GbdtJson; rounds: number; val_loss: number } {
  const N = X.length, F = X[0].length, rand = rng(o.seed ?? 11), lr = o.lr ?? 0.08, lam = o.lambda ?? 1, depth = o.depth ?? 3, NB = o.bins ?? 32, minH = o.min_hess ?? 5;
  // Histogram bins: quantile cut points per feature, from the training rows only.
  const cuts: number[][] = [], bin = new Uint8Array(N * F);
  for (let f = 0; f < F; f++) { const v = X.map((r) => r[f]).sort((a, b) => a - b), c: number[] = []; for (let q = 1; q < NB; q++) { const t = v[Math.floor((q * N) / NB)]; if (!c.length || t > c[c.length - 1]) c.push(t); } cuts.push(c); for (let i = 0; i < N; i++) { let lo = 0, hi = c.length; const x = X[i][f]; while (lo < hi) { const mid = (lo + hi) >> 1; if (x <= c[mid]) hi = mid; else lo = mid + 1; } bin[i * F + f] = lo; } }
  // Unweighted by default: the stated probabilities must stay honest for the confidence gate, and early stopping measures plain log-loss.
  const cw = o.weighted ? classWeights(y) : [1, 1, 1], prior = new Array(K).fill(0); for (const v of y) prior[v] += 1 / N; const base = prior.map((p) => Math.log(Math.max(p, 1e-6)));
  const Z = Array.from({ length: N }, () => base.slice()), Zv = Xv.map(() => base.slice()), gain = new Array(F).fill(0), trees: Tree[][] = [];
  const g = new Float64Array(N), h = new Float64Array(N), node = new Int32Array(N);
  let best = Infinity, bestRounds = 0, bad = 0;
  for (let round = 0; round < (o.rounds ?? 200); round++) {
    const P = Z.map((z) => softmax(z)), rows: number[] = []; for (let i = 0; i < N; i++) if (rand() < (o.subsample ?? 0.8)) rows.push(i);
    const cols: number[] = []; for (let f = 0; f < F; f++) if (rand() < (o.colsample ?? 0.8)) cols.push(f); if (!cols.length) cols.push(Math.floor(rand() * F));
    const set: Tree[] = [];
    for (let k = 0; k < K; k++) {
      for (const i of rows) { const p = P[i][k], w = cw[y[i]]; g[i] = (p - (y[i] === k ? 1 : 0)) * w; h[i] = Math.max(p * (1 - p), 1e-6) * w; node[i] = 0; }
      const t: Tree = { f: [-1], t: [0], l: [0], r: [0], v: [0] }; let level = [0];
      for (let d = 0; d <= depth; d++) {
        // One pass builds every open node's histogram for every sampled column.
        const idx = new Map(level.map((n, j) => [n, j])), HG = new Float64Array(level.length * F * NB), HH = new Float64Array(level.length * F * NB), G = new Float64Array(level.length), Hs = new Float64Array(level.length);
        for (const i of rows) { const j = idx.get(node[i]); if (j === undefined) continue; G[j] += g[i]; Hs[j] += h[i]; const o2 = j * F * NB, ib = i * F; for (const f of cols) { const q = o2 + f * NB + bin[ib + f]; HG[q] += g[i]; HH[q] += h[i]; } }
        const next: number[] = [], split = new Map<number, { f: number; b: number }>();
        level.forEach((n, j) => {
          t.v[n] = (-G[j] / (Hs[j] + lam)) * lr;
          if (d === depth) return;
          let bg = 0, bf = -1, bb = 0; const parent = (G[j] * G[j]) / (Hs[j] + lam);
          for (const f of cols) { let gl = 0, hl = 0; const o2 = j * F * NB + f * NB; for (let q = 0; q < cuts[f].length; q++) { gl += HG[o2 + q]; hl += HH[o2 + q]; const gr = G[j] - gl, hr = Hs[j] - hl; if (hl < minH || hr < minH) continue; const gn = (gl * gl) / (hl + lam) + (gr * gr) / (hr + lam) - parent; if (gn > bg) { bg = gn; bf = f; bb = q; } } }
          if (bf < 0 || bg < 1e-6) return;
          const L = t.f.length; t.f.push(-1, -1); t.t.push(0, 0); t.l.push(0, 0); t.r.push(0, 0); t.v.push(0, 0);
          t.f[n] = bf; t.t[n] = cuts[bf][bb]; t.l[n] = L; t.r[n] = L + 1; gain[bf] += bg; split.set(n, { f: bf, b: bb }); next.push(L, L + 1);
        });
        if (!next.length) break;
        for (const i of rows) { const s = split.get(node[i]); if (s) node[i] = bin[i * F + s.f] <= s.b ? t.l[node[i]] : t.r[node[i]]; }
        level = next;
      }
      set.push(t);
    }
    trees.push(set);
    for (let i = 0; i < N; i++) for (let k = 0; k < K; k++) Z[i][k] += treeValue(set[k], X[i]);
    let s = 0; for (let i = 0; i < Xv.length; i++) { for (let k = 0; k < K; k++) Zv[i][k] += treeValue(set[k], Xv[i]); s -= Math.log(Math.max(softmax(Zv[i])[yv[i]], 1e-9)); }
    const v = s / Math.max(Xv.length, 1); if (v < best - 1e-4) { best = v; bestRounds = round + 1; bad = 0; } else if (++bad >= (o.patience ?? 20)) break;
  }
  const tot = gain.reduce((a, b) => a + b, 0) || 1;
  return { model: { kind: "gbdt", trees: trees.slice(0, Math.max(bestRounds, 1)), base, T: 1, gain: gain.map((v) => v / tot) }, rounds: Math.max(bestRounds, 1), val_loss: best };
}

/** Temperature scaling: one number that makes the stated probabilities honest (0.70 should be right about 70% of the time). Fitted on the held-out slice. */
export function fitTemperature(logits: number[][], y: number[]) { let bestT = 1, best = Infinity; for (let T = 0.5; T <= 4.001; T += 0.1) { let s = 0; for (let i = 0; i < y.length; i++) s -= Math.log(Math.max(softmax(logits[i], T)[y[i]], 1e-9)); if (s < best) { best = s; bestT = Math.round(T * 10) / 10; } } return bestT; }
