// Invest: one simple recommendation per symbol, built from everything the desk knows, where each input counts only
// as much as its own track record allows. An input with no proven record is shown, labelled, and not counted.
// What is used:
//   trend      daily price against its 50- and 200-day averages. The one condition that was positive in the desk's
//              six-year test (longs in an up-trend, about 20 sessions, stop 2 ATR away).
//   scan plan  today's recommendation, weighted by the scans' own replayed record (the edge guard).
//   Deep       the multi-analyst rating through the rating mapper, weighted by its scorecard.
//   The Six    the rule-based analysts' consensus (no track record of its own: a small weight).
//   Kronos     counted only after 30 scored forecasts with 55%+ direction hits and Brier under 0.22.
//   ML         counted only when the model has a proven edge.
//   thesis     your own research note for the symbol (shown, not scored).
// Long side only: shorts lost in every test. Research on a paper account, not advice.
import { candles, isCrypto, quotes } from "./market";
import { getSetting, getSettings } from "./db";
import { masterView } from "./master";
import { deepDecision } from "./deepmap";
import { deepScorecard } from "./deepscore";
import { edgeStatus, exitPolicy, atrAsOf } from "./exits";
import { deskConfig } from "./deskcfg";
import { forecastScore } from "./kronos";
import { sourceStats } from "./sources";
import { summary as paperSummary } from "./paper";

type Bar = { time: number; open: number; high: number; low: number; close: number };
const r2 = (n: number) => Math.round(n * 100) / 100, avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
export type Factor = { name: string; says: "for" | "against" | "neutral"; text: string; weight: "counted" | "small" | "not counted"; points: number };
export type Trend = { state: "up" | "mixed" | "down" | "unknown"; above50: boolean | null; above200: boolean | null; stretch_atr: number | null; atr: number | null; ret20_pct: number | null; text: string };

/** Daily trend from closes. Pure. */
export function trendOf(daily: Bar[]): Trend {
  if (daily.length < 60) return { state: "unknown", above50: null, above200: null, stretch_atr: null, atr: null, ret20_pct: null, text: "Not enough daily history to read the trend." };
  const c = daily.map((b) => b.close), last = c[c.length - 1], m20 = avg(c.slice(-20)), m50 = avg(c.slice(-50)), m200 = c.length >= 200 ? avg(c.slice(-200)) : null, atr = atrAsOf(daily);
  const above50 = last > m50, above200 = m200 === null ? null : last > m200, rising = m200 === null ? above50 : m50 > m200;
  const state: Trend["state"] = above50 && rising && above200 !== false ? "up" : !above50 && (above200 === false || !rising) ? "down" : "mixed";
  const stretch = atr ? r2((last - m20) / atr) : null, ret20 = c.length > 21 ? r2((last / c[c.length - 21] - 1) * 100) : null;
  return { state, above50, above200, stretch_atr: stretch, atr: atr ? r2(atr) : null, ret20_pct: ret20,
    text: state === "up" ? `Up-trend: above its 50-day average${m200 === null ? "" : ", which is above the 200-day"}.` : state === "down" ? `Down-trend: below its 50-day average${above200 === false ? " and its 200-day" : ""}.` : "No clear trend: the averages disagree." };
}
/** Combine the factors into one call. Pure, so the rule can be tested. */
export function decide(f: Factor[], o: { regimeOff?: boolean; exitLongs?: boolean } = {}): { score: number; action: "buy" | "consider" | "wait" | "avoid"; label: string } {
  if (o.regimeOff) return { score: 0, action: "avoid", label: "Avoid: the market is in a risk-off state" };
  let score = 50; for (const x of f) score += x.points; score = Math.round(Math.max(0, Math.min(100, score)));
  if (o.exitLongs) return { score: Math.min(score, 30), action: "avoid", label: "Avoid: Deep Analysis says get out" };
  const action = score >= 68 ? "buy" : score >= 58 ? "consider" : score >= 45 ? "wait" : "avoid";
  return { score, action, label: action === "buy" ? "Buy (swing, long)" : action === "consider" ? "Consider a small position" : action === "wait" ? "Wait" : "Avoid" };
}

export async function investView(db: D1Database, user: string) {
  const [mv, pol, cfg, edge, ps, kscore, dsc] = await Promise.all([masterView(db, user, "stocks"), exitPolicy(db), deskConfig(db), edgeStatus(db), paperSummary(db, user), forecastScore(db).catch(() => null), deepScorecard(db).catch(() => null)]);
  const s = (await getSettings(db)) as unknown as { watchlist: string[] }, wl = await getSetting<string[]>(db, `watchlist:${user}`, s.watchlist);
  const eq = ps.account.equity, kb = (kscore as { by_model?: Record<string, { n: number; hit_rate: number; brier: number }> } | null)?.by_model?.Kronos, kronosProven = !!kb && kb.n >= 30 && kb.hit_rate >= 55 && kb.brier < 0.22;
  const scansProven = (h: "day" | "swing") => edge[h].n >= 30 && (edge[h].avg_r ?? 0) > 0 && (edge[h].se ?? 9) > 0 && (edge[h].avg_r! - 2 * edge[h].se!) > 0;
  const rows0 = mv.rows.filter((r) => !isCrypto(r.symbol) && (r.plan || wl.includes(r.symbol))).slice(0, 16), syms = [...new Set(["SPY", ...rows0.map((r) => r.symbol)])];
  const daily = new Map<string, Bar[]>(); await Promise.all(syms.map(async (x) => { try { daily.set(x, (await candles(x, "1d", 420)) as Bar[]); } catch { daily.set(x, []); } }));
  let deep = new Map<string, { rating: string | null; data: Record<string, unknown> }>();
  try { for (const d of (await db.prepare("SELECT symbol, rating, data FROM deep_runs WHERE status = 'done' AND rating IS NOT NULL AND day >= date('now', '-10 days') ORDER BY created_at DESC LIMIT 80").all<{ symbol: string; rating: string | null; data: string | null }>()).results) if (!deep.has(d.symbol)) deep.set(d.symbol, { rating: d.rating, data: JSON.parse(d.data || "{}") }); } catch { deep = new Map(); }
  let theses = new Map<string, string>();
  try { for (const t of (await db.prepare("SELECT symbol, side, data FROM theses WHERE user = ? AND status = 'ready' AND data IS NOT NULL LIMIT 40").bind(user).all<{ symbol: string; side: string; data: string }>()).results) { const d = JSON.parse(t.data) as { call?: { action?: string; text?: string }; aggregate?: { label?: string } }; theses.set(t.symbol, `Your thesis (${t.side}): ${d.aggregate?.label || "tracked"}${d.call?.action ? `, call: ${d.call.action}` : ""}.`); } } catch { theses = new Map(); }
  const spy = trendOf(daily.get("SPY") || []), regimeOff = mv.regime.size_mult <= 0;

  const ideas = rows0.map((r) => {
    const t = trendOf(daily.get(r.symbol) || []), f: Factor[] = [], p = r.plan && (r.plan.source === "brief" || r.plan.source === "deep") ? r.plan : null;
    f.push({ name: "Trend", says: t.state === "up" ? "for" : t.state === "down" ? "against" : "neutral", text: t.text, weight: t.state === "unknown" ? "not counted" : "counted", points: t.state === "up" ? 15 : t.state === "down" ? -15 : 0 });
    if (t.stretch_atr !== null && t.stretch_atr > 2) f.push({ name: "Stretched", says: "against", text: `It is ${t.stretch_atr} ATRs above its 20-day average: buying here is chasing; a pullback is a better entry.`, weight: "counted", points: -8 });
    if (spy.state === "down") f.push({ name: "Market", says: "against", text: "The index is in a down-trend: most stocks follow it.", weight: "counted", points: -10 });
    const d = deep.get(r.symbol); let exitLongs = false;
    if (d) { const dec = deepDecision({ rating: d.rating, trader_action: String(d.data.trader_action || ""), text: `${d.data.summary || ""} ${d.data.position_note || ""}` }), g = dsc?.gate;
      if (dec.flatten_longs) { exitLongs = true; f.push({ name: "Deep Analysis", says: "against", text: `Rated ${d.rating}: ${dec.why}`, weight: "counted", points: -25 }); }
      else if (dec.action === "long") f.push({ name: "Deep Analysis", says: "for", text: `Rated ${d.rating}; ${dec.why} ${g ? g.text : ""}`, weight: g && g.mult >= 1 ? "counted" : g && g.mult <= 0 ? "not counted" : "small", points: g ? Math.round(12 * g.mult) : 6 });
      else f.push({ name: "Deep Analysis", says: "neutral", text: `Rated ${d.rating}: ${dec.why}`, weight: "not counted", points: 0 }); }
    if (p && p.source === "brief") { const hz = p.copy ? "swing" : "day", ok = scansProven(hz as "day" | "swing"), paused = edge[hz as "day" | "swing"].paused, long = p.side !== "short";
      f.push({ name: "Scan plan", says: long ? "for" : "against", text: `${p.label || "A scan"} recommends a ${p.side}${p.score != null ? ` (score ${Math.round(p.score)})` : ""}: ${p.setup}. ${paused ? "The scans' own record is negative beyond chance, so automatic entries of this kind are paused." : ok ? "The scans' replayed record is positive beyond chance." : `The scans' replayed record is not proven yet (${edge[hz as "day" | "swing"].n} settled plans, ${edge[hz as "day" | "swing"].avg_r ?? "—"}R per plan).`}`,
        weight: paused ? "not counted" : ok ? "counted" : "small", points: !long ? -6 : paused ? 0 : ok ? 10 : 3 }); }
    if (r.six) f.push({ name: "The Six", says: r.six.consensus > 0.15 ? "for" : r.six.consensus < -0.15 ? "against" : "neutral", text: `Rule-based analysts: ${r.six.label} (${r.six.agree > 1 ? `${r.six.agree} of 6` : `${Math.round(r.six.agree * 100)}%`} agree). They have no track record of their own, so they can never turn an idea into a buy by themselves.`, weight: "small", points: Math.round(Math.max(-1, Math.min(1, r.six.consensus)) * 2) });
    if (r.forecast) f.push({ name: "Kronos / forecast", says: r.forecast.prob_up > 0.6 ? "for" : r.forecast.prob_up < 0.4 ? "against" : "neutral", text: `Forecast: ${Math.round(r.forecast.prob_up * 100)}% chance of a higher close. ${kronosProven ? "Its record passes the gate." : "Its record does not pass the gate (30 scored, 55% hits, Brier under 0.22), so it is shown for information."}`,
      weight: kronosProven ? "counted" : "not counted", points: kronosProven ? (r.forecast.prob_up > 0.6 ? 6 : r.forecast.prob_up < 0.4 ? -6 : 0) : 0 });
    const th = theses.get(r.symbol); if (th) f.push({ name: "Research", says: "neutral", text: th, weight: "not counted", points: 0 });
    const call = decide(f, { regimeOff, exitLongs });
    // A swing plan the way the desk would place it: stop 2 ATR away, target 3R, sized by risk, capped by the share of equity.
    let trade: Record<string, unknown> | null = null; const last = r.last ?? daily.get(r.symbol)?.at(-1)?.close ?? null;
    if ((call.action === "buy" || call.action === "consider") && last && t.atr) {
      const entry = p && p.side !== "short" && p.entry > 0 ? p.entry : last, risk = pol.swing_stop_atr * t.atr, stop = r2(entry - risk), target = r2(entry + pol.swing_min_rr * risk);
      const riskUsd = eq * ps.settings.risk_pct / 100 * (call.action === "consider" ? 0.5 : 1), sharesByRisk = Math.floor(riskUsd / risk), sharesByCap = Math.floor((eq * cfg.max_notional_pct / 100) / entry), shares = Math.max(0, Math.min(sharesByRisk, sharesByCap));
      trade = { entry: r2(entry), stop, target, hold_sessions: pol.swing_hold_days, shares, amount_usd: r2(shares * entry), risk_usd: r2(shares * risk), risk_pct_of_equity: r2((shares * risk / eq) * 100),
        text: shares > 0 ? `Buy about ${shares} shares ($${Math.round(shares * entry).toLocaleString("en-US")}) near ${r2(entry)}; stop ${stop} (${pol.swing_stop_atr} × ATR), target ${target} (${pol.swing_min_rr}R), give it up to ${pol.swing_hold_days} sessions. That risks $${Math.round(shares * risk)} (${r2((shares * risk / eq) * 100)}% of the account).` : "The account is too small to take this with the minimum sensible stop." };
    }
    return { symbol: r.symbol, last, change_pct: r.change_pct, in_watchlist: r.in_watchlist, ...call, trend: t, factors: f, trade, counted: f.filter((x) => x.weight !== "not counted" && x.points !== 0).length };
  }).sort((a, b) => b.score - a.score);

  const buys = ideas.filter((i) => i.action === "buy"), cons = ideas.filter((i) => i.action === "consider");
  const src = await sourceStats(db, user, 90).catch(() => null), invested = ps.account.equity > 0 ? r2((ps.account.invested / ps.account.equity) * 100) : 0;
  const headline = regimeOff ? `Stay in cash: the market regime is ${mv.regime.regime.replace("_", " ").toLowerCase()}.`
    : spy.state === "down" ? `Be defensive: the index is in a down-trend. ${buys.length ? `${buys.length} idea${buys.length > 1 ? "s" : ""} still qualify, at reduced size.` : "Nothing qualifies today."}`
    : buys.length ? `${buys.length} idea${buys.length > 1 ? "s" : ""} qualif${buys.length > 1 ? "y" : "ies"} today: ${buys.slice(0, 4).map((b) => b.symbol).join(", ")}.${cons.length ? ` ${cons.length} more worth a small position.` : ""}`
    : cons.length ? `Nothing is a clear buy. ${cons.length} idea${cons.length > 1 ? "s are" : " is"} worth a small position: ${cons.slice(0, 4).map((b) => b.symbol).join(", ")}.` : "Nothing qualifies today. Doing nothing is a position too.";
  return {
    day: mv.day, headline, ideas,
    market: { trend: spy, regime: mv.regime.regime, size_mult: mv.regime.size_mult, text: `${spy.text.replace(/^Up-trend|^Down-trend|^No clear trend/, (m) => `S&P 500 (SPY): ${m.toLowerCase()}`)} ${spy.state === "up" ? "In an up-trend, simply holding the index is the benchmark every idea here has to beat; most of the desk's tested strategies did not beat it." : spy.state === "down" ? "In a down-trend, cash is a reasonable position." : ""}` },
    account: { equity: r2(eq), cash: r2(ps.account.cash), invested_pct: invested, open_positions: ps.positions.length, risk_pct: ps.settings.risk_pct, max_position_pct: cfg.max_notional_pct },
    evidence: [
      { name: "Trend rule (long, up-trend, about 20 sessions, stop 2 ATR)", status: "measured", text: "Positive in the desk's six-year test of daily bars on 40 large stocks (+0.15R per trade). That sample is today's large companies in a rising market: read it as 'do not fight the trend', not as a guarantee." },
      { name: "Scan plans (day trades)", status: edge.day.paused ? "losing" : scansProven("day") ? "proven" : "unproven", text: edge.day.text },
      { name: "Scan plans (swing)", status: edge.swing.paused ? "losing" : scansProven("swing") ? "proven" : "unproven", text: edge.swing.text },
      { name: "Deep Analysis ratings", status: dsc?.gate ? (dsc.gate.mult >= 1 ? "proven" : dsc.gate.mult <= 0 ? "losing" : "unproven") : "unproven", text: dsc?.gate?.text || "No ratings checked yet." },
      { name: "Kronos forecasts", status: kronosProven ? "proven" : "unproven", text: kb ? `${kb.n} scored, ${kb.hit_rate}% direction hits, Brier ${kb.brier} (a coin flip is 0.25).` : "No scored forecasts from the model yet." },
      { name: "Automatic trading so far", status: src && src.all.trades >= 30 ? ((src.all.r_low ?? -1) > 0 ? "proven" : (src.all.r_high ?? 1) < 0 ? "losing" : "unproven") : "unproven", text: src ? `${src.all.trades} closed paper trades in 90 days: ${src.all.win_pct ?? "—"}% wins, $${src.all.pnl}, ${src.all.avg_r ?? "—"}R per trade.` : "No closed trades yet." },
    ],
    rules: "Long side only. A Buy needs a score of 68 or more out of 100; 58 to 67 is a small position. Inputs without a proven record are shown but add nothing (or very little) to the score. Sizes use your risk per trade and the desk's position cap.",
    disclaimer: "Research on a paper account, not investment advice. Nothing on this screen places an order.",
  };
}
