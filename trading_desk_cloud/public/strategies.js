"use strict";
/* TV Strategies: the 23 classic rule-based strategies, laid out like a strategy tester: a price chart with the
   trades marked on it, then Overview, Performance, Trades analysis, List of trades, All strategies and Auto trade. */

state.strat = { catalog: null, rank: null, sel: "supertrend", res: null, symbol: null, interval: "1d", dir: "both", fee: 0.02, params: {}, busy: false, tab: "overview", chart: null, series: null, bars: null, barsKey: "", autos: [] };
const stPct = (v, plus = true) => (v == null ? "—" : `${plus && v > 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const stCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "dim");
const stDate = (t, iv) => { const d = new Date(t * 1000); return iv === "1d" ? d.toISOString().slice(0, 10) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
const stQuery = () => `symbol=${encodeURIComponent(state.strat.symbol)}&interval=${state.strat.interval}&dir=${state.strat.dir}&fee=${state.strat.fee}`;
const ST_DAYS = { "5m": 59, "15m": 59, "60m": 700, "1d": 1500 };

async function loadStrat(what = "all") {
  const S = state.strat;
  if (!S.symbol) S.symbol = state.symbol || "SPY";
  $("#stratSym").value = S.symbol;
  try {
    if (!S.catalog) S.catalog = (await api("/api/strategies")).strategies;
    S.busy = true; if (!S.res) renderStrat();
    const jobs = [api(`/api/strategies/run?${stQuery()}&id=${S.sel}&p=${encodeURIComponent(JSON.stringify(S.params[S.sel] || {}))}`)];
    if (what === "all") jobs.push(api(`/api/strategies/rank?${stQuery()}`), api("/api/tvauto").catch(() => []));
    const key = `${S.symbol}|${S.interval}`; if (S.barsKey !== key) jobs.push(api(`/api/candles/${encodeURIComponent(S.symbol)}?interval=${S.interval}&days=${ST_DAYS[S.interval]}`).then((b) => { S.bars = b.candles || b; S.barsKey = key; }));
    const [res, rank, autos] = await Promise.all(jobs);
    S.res = res; if (rank && rank.rows) S.rank = rank; if (Array.isArray(autos)) S.autos = autos;
  } catch (e) { S.busy = false; stratDispose(); $("#strat").innerHTML = ""; $("#strat").append(el("div", "msg err", e.message)); return; }
  S.busy = false; renderStrat();
}
function stratDispose() { const S = state.strat; if (S.chart) { try { S.chart.remove(); } catch { /* gone */ } S.chart = null; S.series = null; } }

/* ---- price chart with the trades on it */
function stratChart(box, r) {
  const S = state.strat; stratDispose();
  if (!window.LightweightCharts || !Array.isArray(S.bars) || !S.bars.length) { box.append(el("div", "dim small", "No price bars to draw.")); return; }
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  S.chart = LightweightCharts.createChart(box, { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--dim"), fontSize: 11 }, grid: { vertLines: { color: css("--grid") || css("--line") }, horzLines: { color: css("--grid") || css("--line") } },
    rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: S.interval !== "1d", secondsVisible: false }, crosshair: { mode: 0 } });
  S.series = S.chart.addCandlestickSeries({ upColor: css("--up"), downColor: css("--down"), borderVisible: false, wickUpColor: css("--up"), wickDownColor: css("--down") });
  const seen = new Set(), data = S.bars.filter((b) => b.open != null && !seen.has(b.time) && seen.add(b.time)).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  S.series.setData(data);
  // Snap each trade to the bar it happened on (the chart's bars and the tester's may differ by a bar at the edges).
  const times = data.map((d) => d.time), snap = (t) => { let lo = 0, hi = times.length - 1; if (!times.length || t < times[0] || t > times[hi] + (times[hi] - times[Math.max(0, hi - 1)] || 0)) return null; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (times[m] <= t) lo = m; else hi = m - 1; } return times[lo]; };
  const marks = [];
  for (const t of r.list) {
    const long = t.side === "long", te = snap(t.entry_time), tx = snap(t.exit_time);
    if (te != null) marks.push({ time: te, position: long ? "belowBar" : "aboveBar", color: css(long ? "--up" : "--down"), shape: long ? "arrowUp" : "arrowDown", text: long ? "Long" : "Short" });
    if (tx != null && t.reason !== "reverse") marks.push({ time: tx, position: long ? "aboveBar" : "belowBar", color: css("--dim"), shape: "circle", text: `${t.pct > 0 ? "+" : ""}${t.pct}%` });
  }
  // The position that is still open has no exit yet: mark where it started.
  if (r.open) { const to = snap(r.open.since), long = r.open.side === "long"; if (to != null && !marks.some((m) => m.time === to && m.shape !== "circle")) marks.push({ time: to, position: long ? "belowBar" : "aboveBar", color: css(long ? "--up" : "--down"), shape: long ? "arrowUp" : "arrowDown", text: long ? "Long" : "Short" }); }
  S.series.setMarkers(marks.sort((a, b) => a.time - b.time));
  if (data.length > 320) S.chart.timeScale().setVisibleLogicalRange({ from: data.length - 320, to: data.length + 4 });
}

/* ---- small SVG graphs */
function stGraph(W, H, label) { const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "bd-bars st-g", role: "img" }); g.setAttribute("aria-label", label); return g; }
function stratEquity(r) {
  const pts = r.equity, W = 720, H = 250, pad = 60, top = 10, eqH = 150, ddTop = 178, ddH = 46; if (pts.length < 2) return el("div", "dim small", "Not enough bars.");
  const all = pts.flatMap((p) => [p.e, p.bh]), lo = Math.min(...all), hi = Math.max(...all), x = (i) => pad + (i / (pts.length - 1)) * (W - pad - 8), y = (v) => top + eqH - ((v - lo) / (hi - lo || 1)) * eqH;
  const g = stGraph(W, H, `Account growth: strategy ${stPct(r.net_pct)}, buy and hold ${stPct(r.buy_hold_pct)}; largest drawdown ${stPct(-r.max_dd_pct, false)}`);
  svg("line", { x1: pad, x2: W - 8, y1: y(1), y2: y(1), stroke: cssv("--line"), "stroke-dasharray": "4 3" }, g);
  svg("polygon", { points: `${x(0)},${y(Math.max(lo, Math.min(1, hi)))} ${pts.map((p, i) => `${x(i)},${y(p.e)}`).join(" ")} ${x(pts.length - 1)},${y(Math.max(lo, Math.min(1, hi)))}`, fill: cssv("--accent"), opacity: 0.12 }, g);
  svg("polyline", { points: pts.map((p, i) => `${x(i)},${y(p.bh)}`).join(" "), fill: "none", stroke: cssv("--dim"), "stroke-width": 1.5, "stroke-dasharray": "5 3" }, g);
  svg("polyline", { points: pts.map((p, i) => `${x(i)},${y(p.e)}`).join(" "), fill: "none", stroke: cssv("--accent"), "stroke-width": 2 }, g);
  const cut = Math.floor(pts.length * 0.7); svg("line", { x1: x(cut), x2: x(cut), y1: top, y2: ddTop + ddH, stroke: cssv("--warn") || "#b45309", "stroke-dasharray": "2 3" }, g);
  svg("text", { x: x(cut) + 4, y: top + 10, class: "bd-val" }, g).textContent = "last 30% →";
  for (const [v, lab] of [[hi, stPct((hi - 1) * 100)], [lo, stPct((lo - 1) * 100)]]) svg("text", { x: pad - 4, y: y(v) + 4, class: "bd-val", "text-anchor": "end" }, g).textContent = lab;
  // Drawdown (underwater) strip
  const mdd = Math.min(...pts.map((p) => p.dd), -0.01), yd = (v) => ddTop + (v / mdd) * ddH;
  svg("polygon", { points: `${x(0)},${ddTop} ${pts.map((p, i) => `${x(i)},${yd(p.dd)}`).join(" ")} ${x(pts.length - 1)},${ddTop}`, fill: cssv("--down"), opacity: 0.35 }, g);
  svg("text", { x: pad - 4, y: ddTop + 4, class: "bd-val", "text-anchor": "end" }, g).textContent = "0%"; svg("text", { x: pad - 4, y: ddTop + ddH, class: "bd-val", "text-anchor": "end" }, g).textContent = `${mdd.toFixed(0)}%`;
  svg("text", { x: pad + 4, y: ddTop + ddH - 4, class: "bd-val" }, g).textContent = "drawdown";
  svg("text", { x: pad, y: H - 4, class: "bd-val" }, g).textContent = `${stDate(r.from, r.interval)} → ${stDate(r.to, r.interval)}`;
  svg("text", { x: W - 8, y: H - 4, class: "bd-val", "text-anchor": "end" }, g).textContent = "— strategy   - - buy & hold";
  return g;
}
function stratBars(values, labels, title, fmtV = (v) => stPct(v)) {
  const W = 720, H = 170, pad = 60, n = values.length; if (!n) return el("div", "dim small", "Nothing to show yet.");
  const hi = Math.max(0, ...values), lo = Math.min(0, ...values), y = (v) => 12 + (H - 44) * (1 - (v - lo) / (hi - lo || 1)), bw = (W - pad - 8) / n, g = stGraph(W, H, title);
  svg("line", { x1: pad, x2: W - 8, y1: y(0), y2: y(0), stroke: cssv("--line") }, g);
  values.forEach((v, i) => { const bwid = Math.min(Math.max(bw * 0.76, 1), 46), r = svg("rect", { x: pad + i * bw + (bw - bwid) / 2, y: Math.min(y(v), y(0)), width: bwid, height: Math.max(Math.abs(y(v) - y(0)), 1), rx: 1.5, fill: cssv(v >= 0 ? "--up" : "--down") }, g); svg("title", {}, r).textContent = `${labels[i]}: ${fmtV(v)}`; });
  svg("text", { x: pad - 4, y: y(hi) + 4, class: "bd-val", "text-anchor": "end" }, g).textContent = fmtV(hi); svg("text", { x: pad - 4, y: y(lo) + 4, class: "bd-val", "text-anchor": "end" }, g).textContent = fmtV(lo);
  svg("text", { x: pad, y: H - 6, class: "bd-val" }, g).textContent = labels[0]; svg("text", { x: W - 8, y: H - 6, class: "bd-val", "text-anchor": "end" }, g).textContent = labels[n - 1];
  return g;
}
function stratVerdict(r) {
  return r.trades < 20 ? `Only ${r.trades} trades: too few to say anything.` : r.in_sample.net_pct > 0 && r.out_sample.net_pct > 0 && r.net_pct > r.buy_hold_pct ? "Profitable in both parts of the history and ahead of buy & hold. Worth watching, not a guarantee."
    : r.in_sample.net_pct > 0 && r.out_sample.net_pct > 0 ? "Profitable in both parts of the history, but simply holding the symbol did better." : r.out_sample.net_pct > 0 ? "Made money in the recent part only: it may be a phase rather than an edge."
    : r.net_pct > 0 ? "Made money overall but lost in the most recent 30%: what worked earlier has not been working lately." : "Lost money on this symbol and bar size with these settings.";
}

/* ---- tabs */
function stratOverview(box, r) {
  const k = el("div", "st-kpis"), tile = (label, value, cls = "", sub = "", title = "") => { const b = el("div", "st-kpi"); b.title = title; b.append(el("span", "small dim", label), el("b", `mono ${cls}`, String(value))); if (sub) b.append(el("span", "tiny dim", sub)); return b; };
  k.append(tile("Total P&L", stPct(r.net_pct), stCls(r.net_pct), `buy & hold ${stPct(r.buy_hold_pct)}`, "Growth of the account over the whole period, after commission"), tile("Max drawdown", stPct(-r.max_dd_pct, false), "down", "", "Largest fall from a peak of the account"),
    tile("Total trades", r.trades, "", `${r.long.trades} long · ${r.short.trades} short`), tile("Profitable trades", r.win_rate == null ? "—" : `${(r.win_rate * 100).toFixed(1)}%`, "", `${r.perf.all.winners} of ${r.trades}`),
    tile("Profit factor", r.profit_factor ?? "—", r.profit_factor > 1 ? "up" : r.profit_factor != null ? "down" : "", "", "Money won divided by money lost. Above 1 is profitable"));
  box.append(k, stratEquity(r));
  const split = el("p", "small"); split.append(el("b", null, "First 70%: "), el("span", stCls(r.in_sample.net_pct), stPct(r.in_sample.net_pct)), ` in ${r.in_sample.trades} trades · `, el("b", null, "last 30%: "), el("span", stCls(r.out_sample.net_pct), stPct(r.out_sample.net_pct)), ` in ${r.out_sample.trades} trades. ${stratVerdict(r)}`);
  box.append(split, el("p", "small dim", `${r.bars.toLocaleString()} bars · commission ${r.commission_pct}% per side · in the market ${Math.round(r.exposure_pct)}% of the time · ${r.open ? `currently ${r.open.side} from ${fmt(r.open.entry)} since ${stDate(r.open.since, r.interval)}` : "currently flat"}.`));
}
function stratPerformance(box, r) {
  const P = r.perf, f = (v, pct = true) => (v == null ? "—" : pct ? stPct(v) : String(v)), row = (label, key, pct = true, color = false, title = "") => { const tr = el("tr"); const h = td(label, "sym"); h.title = title; tr.append(h, ...["all", "long", "short"].map((s) => td(key === "win_rate" ? (P[s].win_rate == null ? "—" : `${(P[s].win_rate * 100).toFixed(1)}%`) : f(P[s][key], pct), `num ${color ? stCls(P[s][key]) : ""}`))); return tr; };
  const rows = [row("Net profit (sum of trades)", "net_pct", true, true), row("Gross profit", "gross_profit", true, true), row("Gross loss", "gross_loss", true, true), row("Profit factor", "profit_factor", false, false, "Gross profit divided by gross loss"), row("Total closed trades", "trades", false),
    row("Winning trades", "winners", false), row("Losing trades", "losers", false), row("Percent profitable", "win_rate"), row("Average trade", "avg_trade", true, true), row("Average winning trade", "avg_win", true, true), row("Average losing trade", "avg_loss", true, true),
    row("Ratio average win / average loss", "payoff", false), row("Largest winning trade", "largest_win", true, true), row("Largest losing trade", "largest_loss", true, true), row("Average bars in a trade", "avg_bars", false), row("Longest losing streak", "max_losing_streak", false)];
  const w = el("div", "bd-table-wrap"); w.append(table(["", "All", "Long", "Short"], rows)); box.append(w);
  box.append(el("p", "small dim", `Compounded account result: ${stPct(r.net_pct)} (max drawdown ${stPct(-r.max_dd_pct, false)}); buy & hold ${stPct(r.buy_hold_pct)}. Trade figures are per trade, in percent of the money in that trade.`));
}
function stratAnalysis(box, r) {
  box.append(el("h4", null, r.interval === "1d" ? "Result by month" : "Result by day"), stratBars(r.periods.map((p) => p.pct), r.periods.map((p) => p.label), "Result per period"));
  box.append(el("h4", null, "Each trade in order (latest 120)"), stratBars(r.sequence, r.sequence.map((_, i) => `trade ${r.trades - r.sequence.length + i + 1}`), "Result of each trade"));
  box.append(el("h4", null, "How trade results are spread"), stratBars(r.hist.map((h) => h.n), r.hist.map((h) => `${h.from}% to ${h.to}%`), "Number of trades per result range", (v) => String(Math.round(v))));
  const hb = box.lastChild; [...hb.querySelectorAll("rect")].forEach((rc, i) => rc.setAttribute("fill", cssv(r.hist[i].to <= 0 ? "--down" : r.hist[i].from >= 0 ? "--up" : "--dim")));
  const a = r.perf.all; if (a.trades) box.append(el("p", "small dim", `Winners average ${stPct(a.avg_win)}, losers ${stPct(a.avg_loss)}. With ${(a.win_rate * 100).toFixed(0)}% winners the strategy needs winners at least ${(((1 - a.win_rate) / (a.win_rate || 1e-9))).toFixed(2)} times the size of losers to break even; they are ${a.payoff ?? "—"} times.`));
}
function stratTrades(box, r) {
  const tl = r.list.slice().reverse().slice(0, 200).map((t, i) => { const tr = el("tr"); tr.append(td(r.trades - i, "num dim"), td(t.side, t.side === "long" ? "up" : "down"), td(stDate(t.entry_time, r.interval), "small"), td(fmt(t.entry), "num"), td(stDate(t.exit_time, r.interval), "small"), td(fmt(t.exit), "num"), td(stPct(t.pct), `num ${stCls(t.pct)}`), td(t.bars, "num dim"), td(t.reason === "reverse" ? "opposite signal" : t.reason, "small dim")); return tr; });
  if (!tl.length) { box.append(el("div", "dim small", "No closed trades.")); return; }
  const tw = el("div", "bd-table-wrap st-scroll"); tw.append(table(["#", "Side", "Entry", "Price", "Exit", "Price", "Result", "Bars", "Closed by"], tl)); box.append(tw);
}
function stratAll(box) {
  const S = state.strat, rows = S.rank?.rows || [];
  box.append(el("p", "small dim", S.rank ? `All 23 on ${S.rank.symbol} with their standard settings, best first by the last 30% of the history (the part most like "now"). Buy & hold: ${stPct(S.rank.buy_hold_pct)}. Click one to test it.` : "Testing all 23…"));
  const trs = rows.map((x) => { const tr = el("tr"); if (x.id === S.sel) tr.classList.add("st-on"); tr.tabIndex = 0; tr.setAttribute("role", "button"); const nm = td(x.name, "sym"); nm.append(el("div", "dim tiny", x.kind));
    tr.append(nm, td(stPct(x.out_net_pct), `num ${stCls(x.out_net_pct)}`), td(stPct(x.net_pct), `num ${stCls(x.net_pct)}`), td(x.profit_factor ?? "—", "num dim"), td(stPct(-x.max_dd_pct, false), "num dim"), td(x.trades, "num dim"), td(x.position, `small ${x.position === "long" ? "up" : x.position === "short" ? "down" : "dim"}`));
    const pick = () => { S.sel = x.id; S.tab = "overview"; loadStrat("one"); }; tr.onclick = pick; tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }; return tr; });
  const w = el("div", "bd-table-wrap"); w.append(table(["Strategy", "Last 30%", "Whole period", "Profit factor", "Max drawdown", "Trades", "Now"], trs)); box.append(w);
}
function stratAuto(box, r, def) {
  const S = state.strat, mine = S.autos.find((a) => a.symbol === S.symbol);
  box.append(el("p", "small", "Let this strategy trade your paper account by itself. Each time a bar finishes the desk checks which way the strategy is positioned; when that changes, it closes the old paper position and opens the new one. It never jumps into a trade already running: it waits for the next change. Paper money only."));
  if (r && (r.net_pct <= 0 || r.out_sample.net_pct <= 0)) box.append(el("div", "msg err", `Careful: in the test above this strategy ${r.net_pct <= 0 ? "lost money over the whole period" : "lost money in the most recent 30%"} on ${S.symbol}. ${stratVerdict(r)}`));
  const f = el("form", "st-auto-form"), amt = el("input", "mono"); amt.type = "number"; amt.min = "50"; amt.step = "50"; amt.value = mine?.amount_usd ?? 1000; amt.setAttribute("aria-label", "Money per trade in dollars");
  const lab = el("label", "small"); lab.append("Money per trade ($) ", amt);
  const go = el("button", "primary small", mine ? `Update: ${def.name} on ${S.symbol}` : `Start auto-trading ${def.name} on ${S.symbol}`);
  f.append(lab, go, el("span", "small dim", `${S.interval === "60m" ? "1h" : S.interval} bars · ${S.dir === "both" ? "long + short" : S.dir + " only"} · settings as tested above`));
  f.onsubmit = async (e) => { e.preventDefault(); go.disabled = true; try { S.autos = await api("/api/tvauto", { method: "PUT", body: JSON.stringify({ symbol: S.symbol, strategy: S.sel, interval: S.interval, params: r?.params || {}, direction: S.dir, amount_usd: +amt.value, enabled: true }) }); } catch (err) { showBanner(err.message); } renderStrat(); };
  box.append(f);
  box.append(el("h4", null, "Your strategy auto-traders"));
  if (!S.autos.length) box.append(el("div", "dim small", "None yet. One strategy per symbol."));
  for (const a of S.autos) {
    const row = el("div", "st-auto"), sw = el("input"); sw.type = "checkbox"; sw.checked = a.enabled; sw.setAttribute("role", "switch"); sw.setAttribute("aria-label", `Auto-trade ${a.symbol}`);
    sw.onchange = async () => { try { S.autos = await api("/api/tvauto", { method: "PUT", body: JSON.stringify({ ...a, enabled: sw.checked }) }); } catch (err) { showBanner(err.message); } renderStrat(); };
    const txt = el("div", "st-auto-txt"); txt.append(el("b", "sym", a.symbol), ` ${a.name} · ${a.interval === "60m" ? "1h" : a.interval} · ${a.direction === "both" ? "long + short" : a.direction + " only"} · $${Math.round(a.amount_usd)}`, el("div", "dim tiny", `${a.last_note || ""}${a.last_at ? ` (${new Date(a.last_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })})` : ""}`));
    const open = el("button", "ghost small", "Open"); open.onclick = () => { S.symbol = a.symbol; S.sel = a.strategy; S.interval = a.interval; S.dir = a.direction; S.params[a.strategy] = a.params; $$("#stratIv button").forEach((x) => x.classList.toggle("on", x.dataset.i === a.interval)); $("#stratDir").value = a.direction; S.rank = null; S.tab = "overview"; loadStrat(); };
    const del = el("button", "ghost small", "Remove"); del.onclick = async () => { if (!(await askConfirm({ title: `Remove the ${a.symbol} auto-trader?`, message: "An open paper position stays open: close it under Paper Trading if you want out.", confirm: "Remove" }))) return; try { S.autos = await api(`/api/tvauto/${encodeURIComponent(a.symbol)}`, { method: "DELETE" }); } catch (err) { showBanner(err.message); } renderStrat(); };
    row.append(sw, txt, open, del); box.append(row);
  }
}

function renderStrat() {
  const host = $("#strat"), S = state.strat; stratDispose(); host.innerHTML = "";
  if (!S.catalog) { host.append(el("div", "dim", "Loading…")); return; }
  const def = S.catalog.find((c) => c.id === S.sel) || S.catalog[0], r = S.res && S.res.id === S.sel ? S.res : null;
  // Chart on top
  const cb = el("div", "st-chart"); host.append(cb);
  // Tester header: strategy picker, what it does, its settings
  const head = el("div", "st-head"), pick = el("select", "st-pick"); pick.setAttribute("aria-label", "Strategy");
  for (const c of S.catalog) pick.append(new Option(c.name, c.id)); pick.value = S.sel; pick.onchange = () => { S.sel = pick.value; loadStrat("one"); };
  head.append(pick, el("span", "badge muted", def.kind)); if (r?.open) head.append(el("span", `badge th-${r.open.side === "long" ? "up" : "down"}`, `now ${r.open.side}`)); else if (r) head.append(el("span", "badge th-muted", "now flat"));
  if (S.autos.some((a) => a.symbol === S.symbol && a.strategy === S.sel && a.enabled)) head.append(el("span", "badge th-up", "auto-trading"));
  host.append(head, el("p", "small st-how", def.how + (def.adapted ? ` (Adapted: ${def.adapted})` : "")));
  if (def.params.length) {
    const f = el("form", "st-params"), cur = S.params[S.sel] || {};
    for (const p of def.params) { const l = el("label", "small"), i = el("input", "mono"); i.type = "number"; i.min = p.min; i.max = p.max; i.step = p.step; i.value = cur[p.key] ?? r?.params?.[p.key] ?? p.def; i.name = p.key; l.append(p.label, i); f.append(l); }
    const go = el("button", "primary small", "Test"), rs = el("button", "ghost small", "Standard settings"); rs.type = "button"; rs.onclick = () => { delete S.params[S.sel]; loadStrat("one"); };
    f.onsubmit = (e) => { e.preventDefault(); S.params[S.sel] = Object.fromEntries(def.params.map((p) => [p.key, +f.querySelector(`input[name="${p.key}"]`).value])); loadStrat("one"); };
    f.append(go, rs); host.append(f);
  }
  // Tabs
  const tabs = el("div", "st-tabs"); tabs.setAttribute("role", "tablist");
  for (const [k, label] of [["overview", "Overview"], ["performance", "Performance"], ["analysis", "Trades analysis"], ["trades", "List of trades"], ["all", "All strategies"], ["auto", `Auto trade${S.autos.length ? ` (${S.autos.filter((a) => a.enabled).length})` : ""}`]]) {
    const b = el("button", S.tab === k ? "on" : "", label); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", S.tab === k ? "true" : "false"); b.onclick = () => { S.tab = k; renderStrat(); }; tabs.append(b);
  }
  const pane = el("div", "st-pane"); host.append(tabs, pane);
  if (!r && S.tab !== "all" && S.tab !== "auto") pane.append(el("div", "dim", S.busy ? "Testing…" : "No result."));
  else if (S.tab === "overview") stratOverview(pane, r); else if (S.tab === "performance") stratPerformance(pane, r); else if (S.tab === "analysis") stratAnalysis(pane, r); else if (S.tab === "trades") stratTrades(pane, r); else if (S.tab === "all") stratAll(pane); else stratAuto(pane, r, def);
  host.append(el("p", "dim tiny", "How a test runs: the strategy sees only finished bars and its orders fill on the next bar (market orders at the open, stop orders when price trades through them). The whole account goes into each trade. A backtest is the past: the best of 23 strategies on old data is partly luck, which is why the most recent 30% is shown on its own. These are the classic public strategy rules; this desk is not affiliated with TradingView. Research, not advice."));
  if (r) requestAnimationFrame(() => { if (cb.isConnected) stratChart(cb, r); }); else cb.append(el("div", "dim small", "Loading the chart…"));
}

$("#stratForm").onsubmit = (e) => { e.preventDefault(); state.strat.symbol = $("#stratSym").value.trim().toUpperCase() || "SPY"; state.strat.rank = null; state.strat.res = null; loadStrat(); };
$$("#stratIv button").forEach((b) => (b.onclick = () => { $$("#stratIv button").forEach((x) => x.classList.toggle("on", x === b)); state.strat.interval = b.dataset.i; state.strat.rank = null; state.strat.res = null; loadStrat(); }));
$("#stratDir").onchange = (e) => { state.strat.dir = e.target.value; state.strat.rank = null; loadStrat(); };
document.addEventListener("section", (e) => { if (e.detail === "strat") { if (!state.strat.symbol) state.strat.symbol = state.symbol; loadStrat(state.strat.rank ? "one" : "all"); } else if (state.strat.chart && !sectionVisible("strat")) stratDispose(); });
