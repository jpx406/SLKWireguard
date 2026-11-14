// ML engine, part 4: the app side. Fetches history, trains, stores the models in D1, runs live inference and
// re-checks an old model on the bars that arrived after it was trained (its real out-of-sample record).
//
// Two tasks, each for stocks and for crypto:
//   direction  BUY / SELL / HOLD on daily bars: will the price reach +t before -t in the next 5 days?
//              BUY or SELL only above the confidence threshold (0.70 by default), otherwise HOLD.
//   filter     grades the desk's own candle signals (A, B, C, skip) by how such signals fared before.
// A model drives anything only after it proved itself on data it never saw; until then it is display-only.
import type { Env } from "../env";
import { candles, isCrypto } from "../market";
import { getSetting, getSettings, setSetting } from "../db";
import { backtestSignals } from "../learn";
import { FEATURES, FEATURE_HELP, featureRows, signalVector, type Bar } from "./features";
import { PROFILES, buildSamples, decide, filterScore, gradeOf, outcomeClass, predict, score, trainAll, trainFilter, type FilterModel, type FilterReport, type FilterSample, type ModelJson, type Report, type Sample } from "./train";

export type Task = "direction" | "filter";
export type Market = "stocks" | "crypto";
const STOCKS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX", "JPM", "XOM", "BAC", "WMT", "KO", "DIS", "INTC", "CSCO", "PFE", "BA", "CAT", "V", "UNH", "HD", "CRM", "ORCL", "COST", "PLTR", "SOFI"];
const CRYPTO = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD"];
const FILTER_IV: Record<Market, { interval: string; days: number; hold: number }> = { stocks: { interval: "5m", days: 59, hold: 24 }, crypto: { interval: "60m", days: 700, hold: 12 } };
const Patterns = () => (globalThis as unknown as { TDCandles: { PATTERNS: string[] } }).TDCandles.PATTERNS;

let ready = false;
async function ensure(db: D1Database) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ml_models (id TEXT PRIMARY KEY, task TEXT NOT NULL, market TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0,
      report TEXT NOT NULL, model TEXT NOT NULL, live TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ml_signals (task TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL, bar_time INTEGER NOT NULL, at INTEGER NOT NULL, decision TEXT NOT NULL,
      confidence REAL NOT NULL, probs TEXT, price REAL, model_id TEXT, PRIMARY KEY (task, symbol, bar_time))`),
    db.prepare("CREATE TABLE IF NOT EXISTS ml_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, task TEXT, market TEXT, ok INTEGER, note TEXT, ms INTEGER)"),
  ]);
  ready = true;
}
export type MlSettings = { threshold: number; filter: boolean; verdict: boolean; retrain: boolean };
export async function mlSettings(db: D1Database): Promise<MlSettings> { return { threshold: 0.7, filter: false, verdict: true, retrain: true, ...(await getSetting<Partial<MlSettings>>(db, "ml_settings", {})) }; }
export async function saveMlSettings(db: D1Database, p: Partial<MlSettings>) {
  const s = await mlSettings(db);
  if (p.threshold !== undefined) { const t = Number(p.threshold); if (!(t >= 0.5 && t <= 0.95)) return "Confidence threshold: 0.50 to 0.95."; s.threshold = Math.round(t * 100) / 100; }
  for (const k of ["filter", "verdict", "retrain"] as const) if (p[k] !== undefined) s[k] = !!p[k];
  await setSetting(db, "ml_settings", s); cache.clear(); return null;
}

async function universe(db: D1Database, market: Market) {
  const s = await getSettings(db), wl = market === "crypto" ? s.crypto_watchlist : s.watchlist.filter((x) => !isCrypto(x));
  return [...new Set([...(market === "crypto" ? CRYPTO : STOCKS), ...wl.map((x) => x.toUpperCase())])].slice(0, 40);
}
const bench = (market: Market) => (market === "crypto" ? "BTC-USD" : "SPY");
async function bars(symbol: string, interval: string, days: number): Promise<Bar[]> { return (await candles(symbol, interval, days)) as Bar[]; }
/** Drop a bar that is still forming, so features only ever see finished bars. */
function closedBars(b: Bar[], interval: string): Bar[] { if (!b.length) return b; const step = interval === "1d" ? 86400 : interval === "60m" ? 3600 : 300, now = Date.now() / 1000; return now < b[b.length - 1].time + step ? b.slice(0, -1) : b; }

async function directionSamples(db: D1Database, market: Market, since = 0): Promise<{ samples: Sample[]; n: number }> {
  const p = PROFILES.swing, syms = await universe(db, market), mk = await bars(bench(market), p.interval, p.days); let out: Sample[] = [], n = 0;
  for (const s of syms) { try { const b = closedBars(await bars(s, p.interval, p.days), p.interval); if (b.length < 200) continue; n++; out = out.concat(buildSamples(s, b, s === bench(market) ? null : mk, p.label).filter((x) => x.t > since)); } catch { /* a symbol without data is skipped */ } }
  return { samples: out, n };
}
async function filterSamples(db: D1Database, market: Market, patterns: string[], since = 0): Promise<FilterSample[]> {
  const f = FILTER_IV[market], syms = await universe(db, market), mk = await bars(bench(market), f.interval, f.days); const out: FilterSample[] = [];
  for (const s of syms) {
    try {
      const b = closedBars(await bars(s, f.interval, f.days), f.interval); if (b.length < 300) continue;
      const rows = new Map(featureRows(b, s === bench(market) ? null : mk).map((r) => [r.time, r]));
      for (const t of backtestSignals(b, { minStrength: 1, holdBars: f.hold }).trades as { time: number; exit_time: number | null; pattern: string; dir: string; strength: number; r: number }[]) {
        const r = rows.get(t.time); if (!r || t.time <= since) continue;
        out.push({ t: t.time, end: t.exit_time ?? t.time, sym: s, x: signalVector(r.x, t, patterns), r: t.r, y: outcomeClass(t.r) });
      }
    } catch { /* skipped */ }
  }
  return out;
}

type ModelRow = { id: string; task: Task; market: Market; created_at: number; active: number; report: string; model: string; live: string | null };
const cache = new Map<string, { at: number; row: ModelRow | null }>();
async function activeRow(db: D1Database, task: Task, market: Market): Promise<ModelRow | null> {
  const k = `${task}:${market}`, hit = cache.get(k); if (hit && Date.now() - hit.at < 300_000) return hit.row;
  await ensure(db);
  const row = await db.prepare("SELECT * FROM ml_models WHERE task = ? AND market = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").bind(task, market).first<ModelRow>();
  cache.set(k, { at: Date.now(), row: row ?? null }); return row ?? null;
}

/** Train one task for one market, score the model it replaces on the bars that came after it, and make the new one active. */
export async function trainTask(env: Env, task: Task, market: Market, o: { fast?: boolean } = {}): Promise<{ id?: string; error?: string }> {
  const db = env.DB; await ensure(db); const t0 = Date.now(), s = await mlSettings(db);
  try {
    const old = await db.prepare("SELECT * FROM ml_models WHERE task = ? AND market = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").bind(task, market).first<ModelRow>();
    let report: Report | FilterReport, model: ModelJson | FilterModel, live: unknown = null;
    if (task === "direction") {
      const { samples } = await directionSamples(db, market);
      if (old) { const om = JSON.parse(old.model) as ModelJson, after = samples.filter((x) => x.t > old.created_at); if (after.length >= 30) live = { since: old.created_at, ...score(after.map((x) => predict(om, x.x)), after, s.threshold).gated, n: after.length }; }
      const r = trainAll(PROFILES.swing, samples, { threshold: s.threshold, fast: o.fast, max_train: 16000 }); report = r.report; model = r.model;
    } else {
      const pats = Patterns(), samples = await filterSamples(db, market, pats);
      if (old) { const om = JSON.parse(old.model) as FilterModel, after = samples.filter((x) => x.t > old.created_at); if (after.length >= 30) { const g = after.map((x) => gradeOf(om, filterScore(om, signalVector0(x.x, om, pats)))); const avg = (a: FilterSample[]) => (a.length ? Math.round((a.reduce((q, v) => q + v.r, 0) / a.length) * 1e3) / 1e3 : null); live = { since: old.created_at, n: after.length, skip: { n: g.filter((x) => x === "skip").length, avg_r: avg(after.filter((_, i) => g[i] === "skip")) }, keep: { n: g.filter((x) => x !== "skip").length, avg_r: avg(after.filter((_, i) => g[i] !== "skip")) } }; } }
      const f = FILTER_IV[market], r = trainFilter(`Candle-signal filter (${market}, ${f.interval === "60m" ? "1-hour" : "5-minute"} bars)`, f.interval, samples, pats, { fast: o.fast, max_train: 16000 }); report = r.report; model = r.model;
    }
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16), now = Math.floor(Date.now() / 1000);
    await db.batch([
      ...(old && live ? [db.prepare("UPDATE ml_models SET live = ? WHERE id = ?").bind(JSON.stringify(live), old.id)] : []),
      db.prepare("UPDATE ml_models SET active = 0 WHERE task = ? AND market = ?").bind(task, market),
      db.prepare("INSERT INTO ml_models (id, task, market, created_at, active, report, model) VALUES (?, ?, ?, ?, 1, ?, ?)").bind(id, task, market, now, JSON.stringify(report), JSON.stringify(model)),
      // Keep the last four per task and market; the model column of older ones is the bulk.
      db.prepare("DELETE FROM ml_models WHERE task = ? AND market = ? AND id NOT IN (SELECT id FROM ml_models WHERE task = ? AND market = ? ORDER BY created_at DESC LIMIT 4)").bind(task, market, task, market),
      db.prepare("INSERT INTO ml_runs (at, task, market, ok, note, ms) VALUES (?, ?, ?, 1, ?, ?)").bind(now, task, market, task === "direction" ? (report as Report).edge_reason : (report as FilterReport).reason, Date.now() - t0),
    ]);
    cache.clear(); return { id };
  } catch (e) {
    const note = String((e as Error).message || e).slice(0, 300);
    await db.prepare("INSERT INTO ml_runs (at, task, market, ok, note, ms) VALUES (?, ?, ?, 0, ?, ?)").bind(Math.floor(Date.now() / 1000), task, market, note, Date.now() - t0).run();
    return { error: note };
  }
}
/** An old model's pattern list may differ from today's: re-index the pattern feature by name. */
function signalVector0(x: number[], m: FilterModel, pats: string[]) { const v = x.slice(), pi = FEATURES.length + 1, name = pats[v[pi]]; v[pi] = name ? m.patterns.indexOf(name) : -1; return v; }

export type Live = { symbol: string; decision: "BUY" | "SELL" | "HOLD"; confidence: number; probs: number[]; price: number; bar_time: number; proven: boolean };
/** Today's direction read for some symbols, from the last finished daily bar. Each read is stored once per bar. */
export async function directionNow(db: D1Database, market: Market, symbols: string[]): Promise<Live[]> {
  const row = await activeRow(db, "direction", market); if (!row) return [];
  const m = JSON.parse(row.model) as ModelJson, rep = JSON.parse(row.report) as Report, s = await mlSettings(db), p = PROFILES.swing, out: Live[] = [];
  let mk: Bar[] | null = null; try { mk = await bars(bench(market), p.interval, 400); } catch { mk = null; }
  for (const sym of symbols.slice(0, 40)) {
    try {
      const b = closedBars(await bars(sym, p.interval, 400), p.interval), rows = featureRows(b, sym === bench(market) ? null : mk), last = rows[rows.length - 1]; if (!last) continue;
      const probs = predict(m, last.x), d = decide(probs, s.threshold);
      out.push({ symbol: sym, ...d, confidence: Math.round(d.confidence * 1e3) / 1e3, probs: probs.map((v) => Math.round(v * 1e3) / 1e3), price: last.close, bar_time: last.time, proven: rep.edge });
    } catch { /* skipped */ }
  }
  if (out.length) await db.batch(out.map((o) => db.prepare("INSERT OR IGNORE INTO ml_signals (task, market, symbol, bar_time, at, decision, confidence, probs, price, model_id) VALUES ('direction', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(market, o.symbol, o.bar_time, Math.floor(Date.now() / 1000), o.decision, o.confidence, JSON.stringify(o.probs), o.price, row.id)));
  return out;
}

/** Grade one candle signal on the bars it formed on. `useful` says whether the filter earned the right to veto. */
export async function gradeSignal(db: D1Database, symbol: string, b: Bar[], hit: { time: number; dir: string; strength: number; pattern: string }): Promise<{ grade: "skip" | "C" | "B" | "A"; score: number; useful: boolean; enforce: boolean } | null> {
  const market: Market = isCrypto(symbol) ? "crypto" : "stocks", row = await activeRow(db, "filter", market); if (!row) return null;
  const m = JSON.parse(row.model) as FilterModel, rep = JSON.parse(row.report) as FilterReport, f = FILTER_IV[market];
  let mk: Bar[] | null = null; if (symbol !== bench(market)) { try { mk = await bars(bench(market), f.interval, market === "crypto" ? 30 : 10); } catch { mk = null; } }
  const r = featureRows(b, mk).find((x) => x.time === hit.time); if (!r) return null;
  const sc = filterScore(m, signalVector(r.x, hit, m.patterns));
  return { grade: gradeOf(m, sc), score: Math.round(sc * 1e3) / 1e3, useful: rep.useful, enforce: rep.useful && (await mlSettings(db)).filter };
}

/** Everything the ML screen shows. */
export async function mlView(db: D1Database, user: string) {
  await ensure(db);
  const { results } = await db.prepare("SELECT id, task, market, created_at, active, report, live FROM ml_models ORDER BY created_at DESC LIMIT 16").all<ModelRow>();
  const s = await getSettings(db), wl = await getSetting<string[]>(db, `watchlist:${user}`, s.watchlist);
  const stocks = wl.filter((x) => !isCrypto(x)), cwl = await getSetting<string[]>(db, `crypto_watchlist:${user}`, s.crypto_watchlist);
  let signals: Live[] = []; try { signals = [...(await directionNow(db, "stocks", stocks)), ...(await directionNow(db, "crypto", cwl))]; } catch { signals = []; }
  const { results: runs } = await db.prepare("SELECT at, task, market, ok, note, ms FROM ml_runs ORDER BY id DESC LIMIT 8").all();
  return { settings: await mlSettings(db), models: results.map((r) => ({ id: r.id, task: r.task, market: r.market, created_at: r.created_at, active: !!r.active, report: JSON.parse(r.report), live: r.live ? JSON.parse(r.live) : null })), signals, runs, feature_help: FEATURE_HELP };
}

/** Weekly retrain, one task per cron minute so no single run does all the work: Sunday from 06:00 UTC. */
export async function mlSchedule(env: Env, now = new Date()) {
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== 6) return;
  const plan: [number, Task, Market][] = [[5, "direction", "stocks"], [15, "filter", "stocks"], [25, "direction", "crypto"], [35, "filter", "crypto"]];
  const job = plan.find(([m]) => m === now.getUTCMinutes()); if (!job || !(await mlSettings(env.DB)).retrain) return;
  await trainTask(env, job[1], job[2]);
}

/** One line for the scan prompts: confident, proven direction reads only. */
export async function mlContext(db: D1Database, symbols: string[]): Promise<string> {
  try {
    const row = await activeRow(db, "direction", "stocks"); if (!row || !(JSON.parse(row.report) as Report).edge) return "";
    const live = (await directionNow(db, "stocks", symbols.filter((x) => !isCrypto(x)).slice(0, 12))).filter((x) => x.decision !== "HOLD");
    return live.length ? `Machine-learning direction model (validated out of sample; next 5 days): ${live.map((x) => `${x.symbol} ${x.decision} ${Math.round(x.confidence * 100)}%`).join(", ")}\n\n` : "";
  } catch { return ""; }
}
