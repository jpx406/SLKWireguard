// Auto Trader: the one-screen control panel for automatic paper trading, for stocks and for crypto.
// For every symbol on the watchlist and in the latest recommendations it combines what the desk knows (the plan from
// the scans, the Deep Analysis rating, the Kronos forecast, the market regime, the active strategy rules, the price
// against the plan's levels) into one plain-language verdict a beginner can act on: Buy setup / Worth a look / Wait /
// Avoid, with the reasons. Three presets decide what the master switch turns on. Paper only.
import { quotes, isCrypto } from "./market";
import { getSetting, getSettings, setSetting } from "./db";
import { nyNow } from "./briefs";
import { latestRatings } from "./deep";
import { latestForecasts } from "./kronos";
import { listAuto, planFor, setAuto, type Plan } from "./autochart";
import { activeRules, ruleBlocks } from "./strategy";
import { marketRegime, kellyRead } from "./risk";
import { getAccount } from "./paper";

export type Preset = "conservative" | "balanced" | "active";
export const PRESETS: Record<Preset, { label: string; text: string; min: number; rule: "plan" | "both"; max: number }> = {
  conservative: { label: "Conservative", text: "Only the strongest setups (verdict 70+), entries from the plan only, at most 3 at a time.", min: 70, rule: "plan", max: 3 },
  balanced: { label: "Balanced", text: "Good setups (verdict 60+), entries from the plan or a strong candle signal, at most 5 at a time.", min: 60, rule: "both", max: 5 },
  active: { label: "Active", text: "Every reasonable setup (verdict 50+), plan or candle signals, at most 8 at a time.", min: 50, rule: "both", max: 8 },
};
export type Verdict = { score: number; action: "buy" | "consider" | "wait" | "avoid"; label: string; side: "long" | "short" | null; reasons: string[]; strategist: string };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** One verdict from everything known about a symbol. Reasons are written for a beginner. */
export function verdictFor(x: { symbol: string; last: number | null; plan: Plan | null; rating: string | null; forecast: { prob_up: number; exp_move_pct: number } | null; regime: { regime: string; size_mult: number }; blocked: string | null }): Verdict {
  const reasons: string[] = []; let score = 50; const p = x.plan, side = p ? p.side : null, long = side !== "short";
  if (x.regime.size_mult <= 0) return { score: 0, action: "avoid", label: "Avoid", side, reasons: [`The market is in a ${x.regime.regime.replace("_", " ").toLowerCase()} state: the desk stays out.`], strategist: "Wait for the market to calm down before starting new trades." };
  if (x.blocked) return { score: 20, action: "avoid", label: "Avoid", side, reasons: [`Your approved strategy rules exclude this one (${x.blocked}).`], strategist: "Skip it: this kind of trade has lost money in your own track record." };
  if (!p) {
    reasons.push("No plan from today's scans yet.");
    if (x.rating) { const up = /Buy|Overweight/.test(x.rating); score += up ? 8 : /Sell|Underweight/.test(x.rating) ? -8 : 0; reasons.push(`Deep Analysis rates it ${x.rating}.`); }
    if (x.forecast) { score += (x.forecast.prob_up - 0.5) * 30; reasons.push(`Kronos gives a ${Math.round(x.forecast.prob_up * 100)}% chance of closing higher.`); }
    score = Math.round(Math.max(0, Math.min(100, score)));
    return { score, action: "wait", label: "Wait", side: null, reasons, strategist: "Run a scan (or a Deep Analysis) to get an entry, a stop and a target. With Auto on, the desk can still trade strong candle signals here." };
  }
  if (p.source === "position") { reasons.push(`You are already in this trade from ${p.entry}.`); return { score: 60, action: "consider", label: "In trade", side, reasons, strategist: "Manage it: move the stop or target below, or sell now." }; }
  if (p.score != null) { score += (p.score - 50) * 0.6; reasons.push(`The scan scored this setup ${Math.round(p.score)}/100${p.setup ? `: ${p.setup}` : ""}.`); }
  else if (p.source === "deep") { score += 8; reasons.push("The plan comes from a Deep Analysis."); }
  if (x.rating) {
    const s = { Buy: 15, Overweight: 8, Hold: 0, Underweight: -8, Sell: -15 }[x.rating] ?? 0; score += long ? s : -s;
    reasons.push(`Deep Analysis rates it ${x.rating}${(long ? s : -s) < 0 ? ", against this trade" : (long ? s : -s) > 0 ? ", which supports it" : ""}.`);
  }
  if (x.forecast) { const pr = long ? x.forecast.prob_up : 1 - x.forecast.prob_up; score += (pr - 0.5) * 30; reasons.push(`Kronos forecast: ${Math.round(x.forecast.prob_up * 100)}% chance of closing higher${pr < 0.45 ? ", against this trade" : ""}.`); }
  if (x.regime.size_mult < 1) { score -= 5; reasons.push(`Market is ${x.regime.regime.replace("_", " ").toLowerCase()}: sizes are cut to ${x.regime.size_mult * 100}%.`); }
  const t1 = p.targets[0] ?? null;
  if (x.last != null && p.stop != null) {
    const rr = t1 != null ? Math.abs(t1 - p.entry) / Math.max(1e-9, Math.abs(p.entry - p.stop)) : null;
    if (rr != null) { score += rr >= 2 ? 5 : rr < 1 ? -10 : 0; reasons.push(`Reward is ${r2(rr)} times the risk.`); }
    const gone = long ? x.last <= p.stop || (t1 != null && x.last >= t1) : x.last >= p.stop || (t1 != null && x.last <= t1);
    if (gone) return { score: 25, action: "wait", label: "Missed", side, reasons: [...reasons, `The price (${x.last}) is already past the ${long ? (x.last <= p.stop ? "stop" : "target") : (x.last >= p.stop ? "stop" : "target")}: the setup is over.`], strategist: "Do not chase it. Wait for the next scan." };
    const ready = long ? x.last <= p.entry : x.last >= p.entry;
    reasons.push(ready ? `The price (${x.last}) is at or better than the entry ${p.entry}: it would ${long ? "buy" : "short"} now.` : `Waiting for the price (${x.last}) to come to the entry ${p.entry}.`);
  }
  score = Math.round(Math.max(0, Math.min(100, score)));
  const action = score >= 65 ? "buy" : score >= 55 ? "consider" : "wait";
  const label = action === "buy" ? (long ? "Buy setup" : "Short setup") : action === "consider" ? "Worth a look" : "Wait";
  const strategist = action === "buy" ? `Turn Auto on: it ${long ? "buys" : "shorts"} at ${p.entry}, exits at the stop ${p.stop ?? "—"} or the target ${t1 ?? "—"}.` : action === "consider" ? "A fair setup. Use a smaller amount, or wait for a Deep Analysis to confirm." : "Not convincing yet. Leave Auto off for this one.";
  return { score, action, label, side, reasons, strategist };
}

export async function masterView(db: D1Database, user: string, kind: "stocks" | "crypto") {
  const s = await getSettings(db), ny = nyNow();
  const crypto = kind === "crypto";
  const wl = crypto ? await getSetting<string[]>(db, `crypto_watchlist:${user}`, s.crypto_watchlist) : await getSetting<string[]>(db, `watchlist:${user}`, s.watchlist);
  // Recommendations: today's picks (the last 3 days for swings and crypto), newest first.
  let recs: { symbol: string }[] = [];
  try { recs = (await db.prepare("SELECT DISTINCT symbol FROM pick_outcomes WHERE symbol != '-' AND created_at >= ? ORDER BY created_at DESC LIMIT 60").bind(Math.floor(Date.now() / 1000) - 3 * 86400).all<{ symbol: string }>()).results; } catch { recs = []; }
  const autos = await listAuto(db, user);
  const symbols = [...new Set([...wl, ...recs.map((r) => r.symbol), ...autos.map((a) => a.symbol)].map((x) => x.toUpperCase()))].filter((x) => isCrypto(x) === crypto).slice(0, 40);
  const [qs, ratings, fcs, regime, active, acct] = await Promise.all([quotes(symbols), latestRatings(db), latestForecasts(db, symbols), marketRegime(db, crypto), activeRules(db), getAccount(db, user)]);
  const qmap = new Map(qs.map((q) => [q.symbol, q as { symbol: string; last?: number | null; change_pct?: number | null }]));
  const amap = new Map(autos.map((a) => [a.symbol, a]));
  const rows = [];
  for (const sym of symbols) {
    const plan = await planFor(db, user, sym), q = qmap.get(sym), last = q?.last ?? null;
    const blocked = active && plan && plan.source === "brief" ? ruleBlocks(active.rules, { score: plan.score ?? null, setup: plan.setup, symbol: sym }) : null;
    const v = verdictFor({ symbol: sym, last, plan, rating: ratings[sym]?.rating ?? null, forecast: fcs[sym] ?? null, regime, blocked });
    const a = amap.get(sym) as (Record<string, unknown> & { enabled: boolean }) | undefined;
    rows.push({ symbol: sym, last, change_pct: q?.change_pct ?? null, plan, rating: ratings[sym]?.rating ?? null, forecast: fcs[sym] ?? null, verdict: v, auto: a ?? null, in_watchlist: wl.includes(sym) });
  }
  rows.sort((x, y) => Number(!!y.auto?.enabled) - Number(!!x.auto?.enabled) || y.verdict.score - x.verdict.score);
  const preset = await getSetting<Preset>(db, `master_preset:${user}`, "balanced"), amount = await getSetting<number>(db, `master_amount:${user}`, 500);
  return { kind, day: ny.date, rows, regime, preset, presets: PRESETS, amount, cash: r2(acct.cash), kill_switch: acct.s.kill_switch, kill_reason: acct.s.kill_reason, strategy: active ? active.version : null, kelly: await kellyRead(db),
    on: rows.filter((r) => r.auto?.enabled).length, in_trade: rows.filter((r) => (r.auto as { position?: unknown } | null)?.position).length };
}

/** The master switch: turn Auto on for every symbol the preset accepts (best verdicts first, up to the preset's cap), or everything off. */
export async function masterApply(db: D1Database, user: string, kind: "stocks" | "crypto", inp: { on?: unknown; preset?: unknown; amount_usd?: unknown }) {
  const preset: Preset = inp.preset === "conservative" || inp.preset === "balanced" || inp.preset === "active" ? inp.preset : await getSetting<Preset>(db, `master_preset:${user}`, "balanced");
  const amount = Number(inp.amount_usd) >= 50 ? Math.min(10_000_000, Number(inp.amount_usd)) : await getSetting<number>(db, `master_amount:${user}`, 500);
  await setSetting(db, `master_preset:${user}`, preset); await setSetting(db, `master_amount:${user}`, amount);
  if (inp.on === undefined) return { ok: true, preset, amount, changed: 0 };
  const view = await masterView(db, user, kind), P = PRESETS[preset];
  let changed = 0; const errors: string[] = [];
  if (inp.on === true) {
    const pick = view.rows.filter((r) => (r.verdict.action === "buy" || r.verdict.action === "consider") && r.verdict.score >= P.min).slice(0, P.max);
    for (const r of pick) { const res = await setAuto(db, user, { symbol: r.symbol, amount_usd: amount, rule: P.rule, enabled: true }); if (res.error) errors.push(`${r.symbol}: ${res.error}`); else changed++; }
  } else {
    for (const r of view.rows.filter((x) => x.auto?.enabled)) { await setAuto(db, user, { symbol: r.symbol, enabled: false }); changed++; }
  }
  return { ok: true, preset, amount, changed, errors };
}
