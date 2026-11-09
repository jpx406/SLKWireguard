"use strict";
/* Dashboard: one screen with the KPIs, a live chart of the current symbol, paper equity against SPY buy-and-hold,
   the signal-rule research heat-map (minimum strength × hold bars), the latest backtest cards and today's plans
   with their live status. Everything on it comes from the other sections; this is the overview. */

state.dash = { data: null, mc: null, sweep: null, bt: null };

async function loadDashboard() {
  let d;
  try { d = await api("/api/dashboard"); } catch (e) { $("#dashboard").innerHTML = ""; $("#dashboard").append(el("div", "msg err", e.message)); return; }
  state.dash.data = d; renderDashboard();
}

function pctLineChart(seriesList) {
  // seriesList: [{label, color, points:[{day,pct}]}]
  const all = seriesList.flatMap((s) => s.points); if (all.length < 2) return el("div", "dim small", "The comparison appears after the first paper trading day.");
  const days = [...new Set(all.map((p) => p.day))].sort(); const W = 560, H = 200, pad = 34;
  const vals = all.map((p) => p.pct), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const x = (day) => pad + (days.indexOf(day) / Math.max(days.length - 1, 1)) * (W - pad * 2), y = (v) => H - 22 - ((v - lo) / (hi - lo || 1)) * (H - 44);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "bd-bars", role: "img" });
  svg("line", { x1: pad, x2: W - pad, y1: y(0), y2: y(0), stroke: cssv("--line"), "stroke-dasharray": "4 3" }, g);
  seriesList.forEach((s, i) => {
    if (s.points.length < 2) return;
    svg("polyline", { points: s.points.map((p) => `${x(p.day)},${y(p.pct)}`).join(" "), fill: "none", stroke: s.color, "stroke-width": 2 }, g);
    const last = s.points.at(-1); svg("text", { x: pad, y: 12 + i * 13, class: "bd-val", fill: s.color }, g).textContent = `${s.label} ${last.pct >= 0 ? "+" : ""}${fmt(last.pct)}%`;
  });
  svg("text", { x: pad, y: H - 6, class: "bd-val" }, g).textContent = `${days[0]} → ${days.at(-1)}`;
  return g;
}

function heatmap(sw) {
  const wrap = el("div"); if (!sw) { wrap.append(el("div", "dim small", "Click Run sweep to test the candle-signal rule over minimum strength × hold bars on this symbol.")); return wrap; }
  const grid = el("div", "heat"); grid.style.gridTemplateColumns = `auto repeat(${sw.holds.length}, minmax(0, 1fr))`;
  grid.append(el("div", "lbl", "strength \\ hold")); for (const h of sw.holds) grid.append(el("div", "lbl", `${h} bars`));
  const vals = sw.grid.flat().map((c) => c.avg_r).filter((v) => v != null), m = Math.max(0.05, ...vals.map((v) => Math.abs(v)));
  sw.grid.forEach((row, i) => {
    grid.append(el("div", "lbl", `${"★".repeat(sw.strengths[i])}`));
    for (const c of row) {
      const cell = el("div", "cell"); const v = c.avg_r;
      const t = v == null ? 0 : Math.max(-1, Math.min(1, v / m));
      cell.style.background = v == null ? "var(--panel-2)" : t >= 0 ? `rgba(34,197,94,${0.25 + 0.65 * t})` : `rgba(239,68,68,${0.25 + 0.65 * -t})`;
      cell.textContent = v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, 2)}R`; cell.title = `${c.n} trades · total ${fmtR(c.total_r)} · OOS ${fmtR(c.oos_avg_r)} · PF ${c.profit_factor == null ? "—" : c.profit_factor >= 99 ? "∞" : fmt(c.profit_factor, 2)}`;
      cell.append(el("div", "tiny", `n=${c.n}`)); grid.append(cell);
    }
  });
  wrap.append(el("div", "dim tiny", `${sw.symbol} ${sw.interval} · ${sw.bars} bars · average R per trade, hover for details`), grid);
  return wrap;
}

function renderDashboard() {
  const host = $("#dashboard"), d = state.dash.data; host.innerHTML = "";
  const a = d.account, l = d.learn || {};
  const k = el("div", "bd-indices dash-kpis");
  k.append(stat("Paper equity", money(a.equity), pnlCls(a.total_pnl), `${a.total_pct >= 0 ? "+" : ""}${fmt(a.total_pct)}% total`),
    stat("Today", money(a.today_realized + a.unrealized), pnlCls(a.today_realized + a.unrealized), `${a.today_trades} closed · ${d.positions.length} open`),
    stat("Win rate (90d plans)", l.all?.win_rate == null ? "—" : `${fmt(l.all.win_rate, 0)}%`, (l.all?.win_rate ?? 0) >= 50 ? "up" : "", `${l.settled ?? 0} settled of ${l.picks ?? 0}`),
    stat("Avg R / plan", fmtR(l.all?.avg_r), (l.all?.avg_r ?? 0) > 0 ? "up" : (l.all?.avg_r ?? 0) < 0 ? "down" : "", `total ${fmtR(l.total_r)} · DD ${fmtR(l.max_drawdown_r)}`),
    stat("Strategy", d.active_rules ? `v${d.active_rules.version}` : "baseline", d.active_rules ? "up" : "", d.active_rules ? "rules enforced" : "no rules active"),
    stat("Plans today", String(d.plans_today.length), "", `${d.plans_today.filter((p) => p.status === "win").length} won · ${d.plans_today.filter((p) => p.status === "loss").length} lost`));
  host.append(k);

  const grid = el("div", "dash-grid");
  // Live chart of the current symbol
  const cs = section(`${state.symbol} live`, el("span", "dim small", "  5m · signals and plan monitor · click to open the full chart"));
  const box = el("div", "dash-chart"); cs.append(box); box.style.cursor = "pointer"; box.onclick = () => navigate("chart");
  grid.append(cs);
  // Strategy performance vs benchmark
  const sp = section("Strategy performance", el("span", "dim small", "  paper equity vs SPY buy-and-hold, % since the first trade"));
  sp.append(pctLineChart([{ label: "Paper account", color: cssv("--accent"), points: d.equity }, { label: "SPY buy & hold", color: cssv("--dim"), points: d.benchmark }]));
  if (d.forecasts && Object.keys(d.forecasts).length) sp.append(el("div", "dim tiny", `Kronos: ${Object.entries(d.forecasts).slice(0, 4).map(([s, f]) => `${s} ${Math.round(f.prob_up * 100)}% up`).join(" · ")}`));
  grid.append(sp);
  // Research heat-map
  const rs = section("Strategy research", el("span", "dim small", "  candle-signal rule: minimum strength × hold bars"));
  const form = el("div", "row gap"); const iv = el("select", "small"); for (const x of ["5m", "15m", "60m", "1d"]) iv.append(new Option(x, x)); iv.value = state.dash.iv || "5m";
  const run = el("button", "ghost small", "Run sweep"); form.append(el("span", "small", state.symbol), iv, run); rs.append(form);
  const heat = el("div"); heat.append(heatmap(state.dash.sweep && state.dash.sweep.symbol === state.symbol ? state.dash.sweep : null)); rs.append(heat);
  run.onclick = async () => { run.disabled = true; heat.innerHTML = ""; heat.append(el("div", "dim small", "Sweeping…")); try { state.dash.iv = iv.value; state.dash.sweep = await api("/api/learn/sweep", { method: "POST", body: JSON.stringify({ symbol: state.symbol, interval: iv.value }) }); heat.innerHTML = ""; heat.append(heatmap(state.dash.sweep)); } catch (e) { heat.innerHTML = ""; heat.append(el("div", "msg err small", e.message)); } run.disabled = false; };
  grid.append(rs);
  // Backtest results cards
  const bs = section("Backtest results", el("span", "dim small", "  signal rule, 2-star, on this symbol"));
  const btBox = el("div"); bs.append(btBox);
  const runBt = async () => { btBox.innerHTML = ""; btBox.append(el("div", "dim small", "Backtesting…")); try { const r = await api("/api/learn/backtest", { method: "POST", body: JSON.stringify({ symbol: state.symbol, interval: iv.value, min_strength: 2 }) }); btBox.innerHTML = ""; const cards = el("div", "bd-indices"); cards.append(stat("Total R", fmtR(r.all.total_r), r.all.total_r > 0 ? "up" : r.all.total_r < 0 ? "down" : ""), stat("Win rate", r.all.win_rate == null ? "—" : `${fmt(r.all.win_rate, 0)}%`), stat("Max drawdown", fmtR(r.all.max_drawdown_r), "down"), stat("Trades", String(r.all.n), "", `OOS ${fmtR(r.out_of_sample.avg_r)} avg`)); btBox.append(cards); if (r.trades.length) btBox.append(rCurve(r.trades.reduce((acc, t) => { acc.push({ day: new Date(t.exit_time * 1000).toLocaleDateString(), r: (acc.at(-1)?.r || 0) + t.r }); return acc; }, []))); } catch (e) { btBox.innerHTML = ""; btBox.append(el("div", "msg err small", e.message)); } };
  const bb = el("button", "ghost small", "Run backtest"); bb.onclick = runBt; bs.append(bb);
  grid.append(bs);
  host.append(grid);

  // Paper trading table: open positions + today's plans with status
  const pt = section("Paper trading", el("span", "dim small", "  open positions and today's plans"));
  const rows = [];
  for (const p of d.positions) { const tr = el("tr"); tr.append(td(p.symbol, "sym"), td(p.side === "long" ? "Long" : "Short", p.side === "long" ? "up" : "down"), td(fmt(p.entry), "num"), td(fmt(p.last), "num"), td(money(p.unrealized), `num ${pnlCls(p.unrealized)}`), td("open position", "pill running"), td(p.source)); rows.push(tr); }
  for (const p of d.plans_today) { const tr = el("tr"); const cls = p.status === "win" ? "up" : p.status === "loss" ? "down" : "dim"; tr.append(td(p.symbol, "sym"), td(p.side === "long" ? "Buy" : "Sell", p.side === "long" ? "up" : "down"), td(fmt(p.entry), "num"), td(fmt(p.stop), "num down"), td(p.r_result == null ? "—" : fmtR(p.r_result), `num ${cls}`), td(p.status.replace("_", " "), cls), td(`${p.slot} · ${p.score ?? "—"}`)); rows.push(tr); }
  pt.append(rows.length ? table(["Symbol", "Signal", "Entry", "Last / Stop", "P&L / R", "Status", "Source"], rows) : el("div", "dim small", "No open positions and no plans today yet."));
  host.append(pt);

  // Live mini chart
  if (state.dash.mc) state.dash.mc.dispose();
  state.dash.mc = createMiniChart(box, { symbol: state.symbol, interval: "5m", range: "1D", fontSize: 10, signals: true });
}

document.addEventListener("section", (e) => {
  if (e.detail === "dashboard") loadDashboard();
  else if (state.dash.mc && !sectionVisible("dashboard")) { state.dash.mc.dispose(); state.dash.mc = null; }
});
