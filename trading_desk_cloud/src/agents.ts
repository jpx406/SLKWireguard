// The Six: a council of six rule-based analysts, each with one job, voting on a symbol from its price bars, plus the
// market radar that ranks every symbol by how clean it is to trade right now (liquidity, tight ranges, flow, trend).
// Inspired by multi-agent "vortex" terminals and "watch every market, trade the cleanest" bots; here each agent is
// plain arithmetic on real bars (free, instant, reproducible), not a separate language model, and the page says so.
//   NOVA finds the ceiling   - room to resistance and support (where the trade can run, where it is capped)
//   ORIN prices the tail     - how bad the bad cases are (bootstrap 10th percentile against the stop)
//   VESK holds the trend     - direction and persistence (EMA 20/50, trend in sigmas)
//   LUMA reads the flow      - buying against selling volume and relative volume
//   KIRA cuts losers early   - exit pressure: reversal candles, loss of VWAP / EMA 9
//   DASH scales the open     - the session's opening drive and gap
import "../public/candles.js";
import { candles, isCrypto } from "./market";
import { bootstrapForecast } from "./kronos";

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Hit = { index: number; pattern: string; label: string; dir: "bullish" | "bearish"; strength: number; strong: boolean };
const Candles = () => (globalThis as unknown as { TDCandles: { detect(bars: Bar[], opts?: Record<string, unknown>): Hit[] } }).TDCandles;
export type AgentVote = { id: string; name: string; role: string; vote: number; confidence: number; text: string };
export type Council = { symbol: string; interval: string; at: number; last: number; agents: AgentVote[]; consensus: number; label: string; agree: number;
  radar: { score: number; liquidity_usd: number; range_pct: number; rvol: number; buy_share: number; trend_sigma: number } };

const r2 = (n: number) => Math.round(n * 100) / 100, clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const ema = (v: number[], n: number) => { const k = 2 / (n + 1); let p = v[0]; return v.map((x) => (p = x * k + p * (1 - k))); };
const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/** All six votes (-1 bearish .. +1 bullish) from completed bars. `side`/`stop` sharpen ORIN and KIRA when a plan exists. */
export function council(symbol: string, interval: string, bars: Bar[], plan?: { side: "long" | "short"; stop: number | null } | null): Council | null {
  const b = bars.slice(-400); if (b.length < 60) return null;
  const c = b.map((x) => x.close), n = c.length, last = c[n - 1];
  const rets = c.slice(1).map((v, i) => Math.log(v / c[i]));
  const atr = b.slice(-20).reduce((a, x) => a + (x.high - x.low), 0) / 20 || last * 0.001;
  // NOVA: where is the price inside its recent range, and how much room is left to the 60-bar high / low (in ATRs).
  const hi = Math.max(...b.slice(-60).map((x) => x.high)), lo = Math.min(...b.slice(-60).map((x) => x.low));
  const roomUp = (hi - last) / atr, roomDn = (last - lo) / atr, breakout = last >= hi - atr * 0.15;
  const nova = breakout ? 0.6 : clamp((roomUp - roomDn) / 6);
  // VESK: EMA 20 against EMA 50 and the 20-bar move in sigmas.
  const e20 = ema(c, 20), e50 = ema(c, 50), sig = (Math.log(last / c[Math.max(0, n - 21)])) / ((sd(rets.slice(-20)) || 1e-9) * Math.sqrt(20));
  const vesk = clamp(0.5 * Math.sign(e20[n - 1] - e50[n - 1]) * Math.min(1, Math.abs(e20[n - 1] - e50[n - 1]) / atr) + 0.5 * clamp(sig / 2));
  // LUMA: buy share of the last 20 bars (close position inside the bar) and relative volume.
  const flow = b.slice(-20).reduce((a, x) => { const rng = x.high - x.low || 1e-9, buy = x.volume * ((x.close - x.low) / rng); return { buy: a.buy + buy, all: a.all + x.volume }; }, { buy: 0, all: 0 });
  const buyShare = flow.all ? flow.buy / flow.all : 0.5;
  const v20 = b.slice(-20).reduce((a, x) => a + x.volume, 0) / 20, v100 = b.slice(-120, -20).reduce((a, x) => a + x.volume, 0) / Math.max(1, Math.min(100, b.length - 20)) || v20 || 1;
  const rvol = v20 / v100, luma = clamp((buyShare - 0.5) * 4 * Math.min(1.5, Math.max(0.5, rvol)));
  // ORIN: the 10th-percentile path of a bootstrap of the symbol's own returns, 24 bars ahead, against the stop (or 2 ATR).
  const fc = bootstrapForecast(symbol, interval, b, 24, 200);
  const tailDn = fc ? (fc.p10[fc.p10.length - 1] - last) / last : -0.02, tailUp = fc ? (fc.p90[fc.p90.length - 1] - last) / last : 0.02;
  const stopDist = plan?.stop != null ? Math.abs(last - plan.stop) / last : (2 * atr) / last;
  const long = plan?.side !== "short";
  const adverse = long ? -tailDn : tailUp, favourable = long ? tailUp : -tailDn;
  const orin = clamp((favourable - adverse) / Math.max(1e-6, adverse + favourable)) * (adverse > stopDist * 1.5 ? 0.5 : 1) * (long ? 1 : -1);
  // KIRA: exit pressure against the trade's side (or against the trend when there is no plan).
  let hits: Hit[] = []; try { hits = Candles().detect(b, { from: n - 3, trendGate: true }).filter((h) => h.strong && h.strength >= 2); } catch { hits = []; }
  let pv = 0, vv = 0; for (const x of b.slice(-78)) { pv += ((x.high + x.low + x.close) / 3) * x.volume; vv += x.volume; }
  const vwap = vv ? pv / vv : last, e9 = ema(c, 9)[n - 1];
  const bear = hits.filter((h) => h.dir === "bearish").length, bull = hits.filter((h) => h.dir === "bullish").length;
  const kira = clamp((bull - bear) * 0.5 + (last > vwap ? 0.25 : -0.25) + (last > e9 ? 0.25 : -0.25));
  // DASH: the session's opening drive (first 6 bars of the latest session) and the gap from the previous close.
  const dayOf = (t: number) => Math.floor((t - (isCrypto(symbol) ? 0 : 13.5 * 3600)) / 86400);
  const today = dayOf(b[n - 1].time), sess = b.filter((x) => dayOf(x.time) === today), prev = b.filter((x) => dayOf(x.time) < today);
  let dash = 0, dashText = "no session open in the bars";
  if (sess.length >= 3) {
    const open = sess[0].open, first = sess.slice(0, Math.min(6, sess.length)), drive = (first[first.length - 1].close - open) / atr;
    const gap = prev.length ? (open - prev[prev.length - 1].close) / atr : 0, held = last >= Math.max(...first.map((x) => x.high)) ? 1 : last <= Math.min(...first.map((x) => x.low)) ? -1 : 0;
    dash = clamp(drive / 3 + gap / 6 + held * 0.4);
    dashText = `opening drive ${drive >= 0 ? "+" : ""}${r2(drive)} ATR${gap ? `, gap ${gap >= 0 ? "+" : ""}${r2(gap)} ATR` : ""}${held ? `, ${held > 0 ? "above" : "below"} the opening range` : ", inside the opening range"}`;
  }
  const mk = (id: string, name: string, role: string, vote: number, text: string): AgentVote => ({ id, name, role, vote: r2(vote), confidence: r2(Math.abs(vote)), text });
  const agents = [
    mk("nova", "NOVA", "finds the ceiling", nova, breakout ? `at the 60-bar high ${r2(hi)}: breakout zone` : `${r2(roomUp)} ATR of room up to ${r2(hi)}, ${r2(roomDn)} ATR down to ${r2(lo)}`),
    mk("orin", "ORIN", "prices the tail", orin, `bad case ${r2(tailDn * 100)}%, good case +${r2(tailUp * 100)}% over 24 bars${adverse > stopDist * 1.5 ? "; the bad case runs past the stop" : ""}`),
    mk("vesk", "VESK", "holds the trend", vesk, `EMA 20 ${e20[n - 1] >= e50[n - 1] ? "above" : "below"} EMA 50, 20-bar move ${sig >= 0 ? "+" : ""}${r2(sig)} sigma`),
    mk("luma", "LUMA", "reads the flow", luma, `buyers ${Math.round(buyShare * 100)}% of the last 20 bars' volume, volume ${r2(rvol)}x normal`),
    mk("kira", "KIRA", "cuts losers early", kira, `${bear ? `${bear} bearish reversal signal${bear > 1 ? "s" : ""}` : bull ? `${bull} bullish signal${bull > 1 ? "s" : ""}` : "no fresh reversal"}, price ${last > vwap ? "above" : "below"} VWAP and ${last > e9 ? "above" : "below"} EMA 9`),
    mk("dash", "DASH", "scales the open", dash, dashText),
  ];
  const consensus = Math.round((agents.reduce((a, x) => a + x.vote, 0) / agents.length) * 100);
  const agree = agents.filter((x) => Math.sign(x.vote) === Math.sign(consensus) && Math.abs(x.vote) >= 0.15).length;
  const label = consensus >= 35 ? "Bullish" : consensus >= 12 ? "Leaning up" : consensus <= -35 ? "Bearish" : consensus <= -12 ? "Leaning down" : "Split";
  // Radar: how clean is this market to trade now? Liquidity (dollar volume per bar), tight bars, active volume, one-sided flow, trend.
  const liq = v20 * last, rangePct = (atr / last) * 100;
  const liqS = clamp(Math.log10(Math.max(1, liq)) / 7, 0, 1), tightS = clamp(1 - rangePct / (isCrypto(symbol) ? 1.5 : 0.8), 0, 1), flowS = Math.min(1, Math.abs(buyShare - 0.5) * 4), trendS = Math.min(1, Math.abs(sig) / 2), rvS = clamp((rvol - 0.5) / 1.5, 0, 1);
  const score = Math.round((0.3 * liqS + 0.15 * tightS + 0.2 * flowS + 0.2 * trendS + 0.15 * rvS) * 100);
  return { symbol, interval, at: Math.floor(Date.now() / 1000), last, agents, consensus, label, agree, radar: { score, liquidity_usd: Math.round(liq), range_pct: r2(rangePct), rvol: r2(rvol), buy_share: r2(buyShare), trend_sigma: r2(sig) } };
}

let ready = false;
async function ensure(db: D1Database) { if (ready) return; await db.prepare("CREATE TABLE IF NOT EXISTS council_cache (symbol TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)").run(); ready = true; }
/** The council for one symbol, cached five minutes. Stocks on 5-minute bars, crypto on hourly bars. */
export async function councilFor(db: D1Database, symbol: string, plan?: { side: "long" | "short"; stop: number | null } | null, force = false): Promise<Council | null> {
  await ensure(db);
  const now = Math.floor(Date.now() / 1000);
  if (!force) { const c = await db.prepare("SELECT at, data FROM council_cache WHERE symbol = ?").bind(symbol).first<{ at: number; data: string }>(); if (c && now - c.at < 300) { try { return JSON.parse(c.data) as Council; } catch { /* recompute */ } } }
  const iv = isCrypto(symbol) ? "60m" : "5m";
  let bars: Bar[] = []; try { bars = (await candles(symbol, iv, iv === "60m" ? 30 : 10)) as Bar[]; } catch { return null; }
  const done = bars.filter((x) => x.time + (iv === "60m" ? 3600 : 300) <= now);
  const res = council(symbol, iv, done, plan);
  if (res) await db.prepare("INSERT INTO council_cache (symbol, at, data) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET at = excluded.at, data = excluded.data").bind(symbol, now, JSON.stringify(res)).run();
  return res;
}
/** Radar: every symbol ranked by its cleanliness score, best first (cached councils; at most `limit` fresh computations per call). */
export async function radar(db: D1Database, symbols: string[], limit = 12) {
  await ensure(db);
  const out: Council[] = []; let fresh = 0; const now = Math.floor(Date.now() / 1000);
  for (const s of symbols) {
    const c = await db.prepare("SELECT at, data FROM council_cache WHERE symbol = ?").bind(s).first<{ at: number; data: string }>();
    if (c && now - c.at < 300) { try { out.push(JSON.parse(c.data) as Council); continue; } catch { /* recompute */ } }
    if (fresh >= limit) { if (c) { try { out.push(JSON.parse(c.data) as Council); } catch { /* skip */ } } continue; }
    fresh++; const r = await councilFor(db, s, null, true); if (r) out.push(r);
  }
  return out.sort((a, b) => b.radar.score - a.radar.score);
}
