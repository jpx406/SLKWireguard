"use strict";
/* Performance: the learning loop. Every recommendation is replayed on the bars that followed it (walk-forward),
   scored in R, grouped by what it shares with others, and turned into a playbook the scans read; candle
   patterns get a reliability table per chart (in-sample / out-of-sample) and a backtester for the signal rule. */

state.learn = { data: null, days: 90, patt: null, bt: null };
const fmtR = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, 2)}R`);
const pctTxt = (v) => (v == null ? "—" : `${fmt(v, 0)}%`);

async function loadLearn() {
  let d;
  try { d = await api(`/api/learn?days=${state.learn.days}`); } catch (e) { $("#learn").innerHTML = ""; $("#learn").append(el("div", "msg err", e.message)); return; }
  state.learn.data = d; renderLearn();
}

function groupTable(title, groups, keyLabel, help) {
  const s = section(title, help ? el("span", "dim small", `  ${help}`) : null);
  if (!groups.length) { s.append(el("div", "dim small", "No settled trades in this group yet.")); return s; }
  s.append(table([keyLabel, "Plans", "Triggered", "Wins", "Win %", "CI low", "Avg R", "Total R", "PF"], groups.map((g) => {
    const tr = el("tr");
    const cls = g.n >= (state.learn.data.learn_min_n || 10) ? (g.avg_r >= 0.25 ? "up" : g.avg_r <= -0.15 ? "down" : "") : "dim";
    tr.append(td(g.key, cls), td(g.total, "num"), td(g.n, "num"), td(g.wins, "num"), td(pctTxt(g.win_rate), `num ${cls}`), td(pctTxt(g.ci_low), "num dim"), td(fmtR(g.avg_r), `num ${cls}`), td(fmtR(g.sum_r), "num"), td(g.profit_factor == null ? "—" : g.profit_factor >= 99 ? "∞" : fmt(g.profit_factor, 2), "num"));
    tr.title = `${g.key}: ${g.total} plans, ${g.no_trigger} never triggered. CI low = Wilson 95% lower bound of the win rate (what the sample can promise). PF = gross wins / gross losses in R.`;
    return tr;
  })));
  return s;
}

function rCurve(points) {
  if (points.length < 2) return el("div", "dim small", "The R curve appears after a few settled trades.");
  const W = 560, H = 160, pad = 28, vals = points.map((p) => p.r), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const x = (i) => pad + (i / Math.max(points.length - 1, 1)) * (W - pad * 2), y = (v) => H - 18 - ((v - lo) / (hi - lo || 1)) * (H - 36);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "bd-bars", role: "img" });
  svg("line", { x1: pad, x2: W - pad, y1: y(0), y2: y(0), stroke: cssv("--line"), "stroke-dasharray": "4 3" }, g);
  const up = vals.at(-1) >= 0;
  svg("polyline", { points: points.map((p, i) => `${x(i)},${y(p.r)}`).join(" "), fill: "none", stroke: up ? cssv("--up") : cssv("--down"), "stroke-width": 2 }, g);
  svg("text", { x: pad, y: 12, class: "bd-val" }, g).textContent = `${fmtR(hi)} peak`;
  svg("text", { x: pad, y: H - 4, class: "bd-val" }, g).textContent = `${points[0].day} → ${points.at(-1).day} · ${points.length} trades · ${fmtR(vals.at(-1))}`;
  return g;
}

function renderLearn() {
  const host = $("#learn"), d = state.learn.data; host.innerHTML = "";
  host.append(el("p", "dim small", "Every recommendation is replayed on the 5-minute bars that came after it (walk-forward, no look-ahead): did the entry trigger, then target or stop (stop first when one bar touches both), or a time exit at the session close (day) or after 10 sessions (swing). Results are in R (1R = the distance from entry to stop). Groups need enough settled trades before they count, and the win rate's 95% lower bound says what the sample can promise."));
  const a = d.all || {};
  const cards = el("div", "bd-indices");
  cards.append(stat("Plans", String(d.picks), "", `${d.settled} settled · ${d.open} open · ${d.pending} pending`),
    stat("Triggered", d.picks ? pctTxt(((d.picks - d.no_trigger) / d.picks) * 100) : "—", "", `${d.no_trigger} never reached the entry`),
    stat("Win rate", pctTxt(a.win_rate), (a.win_rate ?? 0) >= 50 ? "up" : "", a.ci_low == null ? "" : `95% CI low ${pctTxt(a.ci_low)}`),
    stat("Avg R / trade", fmtR(a.avg_r), (a.avg_r ?? 0) > 0 ? "up" : (a.avg_r ?? 0) < 0 ? "down" : "", a.profit_factor == null ? "" : `profit factor ${a.profit_factor >= 99 ? "∞" : fmt(a.profit_factor, 2)}`),
    stat("Total R", fmtR(d.total_r), d.total_r > 0 ? "up" : d.total_r < 0 ? "down" : "", `worst drawdown ${fmtR(d.max_drawdown_r)}`),
    stat("Sharpe / trade", d.sharpe_per_trade == null ? "—" : fmt(d.sharpe_per_trade, 2), "", `${d.tests} groups examined`));
  host.append(cards);

  // Playbook
  const pb = section("Playbook (what the scans read before recommending)", el("span", "dim small", d.playbook ? `  rebuilt ${ago(d.playbook.at)}` : ""));
  const pre = el("pre", "playbook small"); pre.textContent = d.playbook?.text || "No playbook yet: it is built from settled trades (after the close, or with Evaluate Now).";
  pb.append(pre);
  const row = el("div", "row gap");
  const ap = el("label", "check small"); const cb = el("input"); cb.type = "checkbox"; cb.checked = d.learn_apply !== false; cb.disabled = state.me?.role !== "admin";
  cb.onchange = async () => { try { await api("/api/settings", { method: "PUT", body: JSON.stringify({ settings: { learn_apply: cb.checked } }) }); } catch (e) { showBanner(e.message); cb.checked = !cb.checked; } };
  ap.append(cb, document.createTextNode(" Scans read the playbook (lessons go into every brief prompt)")); row.append(ap);
  if (d.playbook?.min_score != null) row.append(el("span", "dim small", `Suggested minimum score for auto-trade: ${d.playbook.min_score}`));
  pb.append(row); host.append(pb);

  const grid = el("div", "bd-grid");
  const cv = section("Equity in R (walk-forward, 1R per plan)"); cv.append(rCurve(d.curve)); grid.append(cv);
  const cal = section("Calibration: score → win rate", el("span", "dim small", "  does a higher score mean a better trade?"));
  cal.append(barChart(d.calibration.map((g) => ({ label: `${g.key} (n=${g.n})`, value: g.win_rate ?? 0 })), { unit: "%", signed: false, max: 100 }));
  grid.append(cal); host.append(grid);

  const g = d.groups;
  host.append(groupTable("By scan", g.slot, "Scan"), groupTable("By setup", g.setup, "Setup", "from the setup text"), groupTable("By score", g.score, "Score"),
    groupTable("By horizon and side", [...g.horizon, ...g.side], "Group"), groupTable("By scan hour (New York)", g.hour, "Hour"), groupTable("By followed source (Winners desk)", g.source, "Source"), groupTable("By symbol (3+ trades)", g.symbol, "Symbol"));

  // Paper trades
  const p = d.paper || {};
  const ps = section(`Paper trades (${p.trades || 0} closed)`);
  const pt = (rows, keyLabel) => table([keyLabel, "Trades", "Win %", "CI low", "Avg R", "P&L"], (rows || []).map((r) => { const tr = el("tr"); tr.append(td(r.key), td(r.n, "num"), td(pctTxt(r.win_rate), "num"), td(pctTxt(r.ci_low), "num dim"), td(fmtR(r.avg_r), `num ${(r.avg_r ?? 0) > 0 ? "up" : (r.avg_r ?? 0) < 0 ? "down" : ""}`), td(money(r.pnl), `num ${pnlCls(r.pnl)}`)); return tr; }));
  if ((p.by_source || []).length) { ps.append(el("h4", "small dim", "By source"), pt(p.by_source, "Source")); }
  if ((p.by_signal || []).length) { ps.append(el("h4", "small dim", "Chart autopilot by candle signal"), pt(p.by_signal, "Signal")); }
  if ((p.by_exit || []).length) { ps.append(el("h4", "small dim", "By exit"), pt(p.by_exit, "Exit")); }
  if (!(p.by_source || []).length) ps.append(el("div", "dim small", "No closed paper trades in this window."));
  host.append(ps);

  // Recent outcomes
  const rc = section("Recent plans");
  rc.append(table(["Day", "Scan", "Symbol", "Side", "Horizon", "Score", "Entry", "Stop", "T1", "Result", "R", "MFE", "MAE"], (d.recent || []).map((o) => {
    const tr = el("tr"); const sym = td(o.symbol, "sym"); sym.style.cursor = "pointer"; sym.onclick = () => { setSymbol(o.symbol); navigate("chart"); };
    const cls = o.status === "win" ? "up" : o.status === "loss" ? "down" : o.status === "timed" ? ((o.r_result ?? 0) >= 0 ? "up" : "down") : "dim";
    tr.append(td(o.day, "mono small"), td(o.slot, "small"), sym, td(o.side, o.side === "long" ? "up" : "down"), td(o.horizon), td(o.score ?? "—", "num"), td(fmt(o.entry), "num"), td(fmt(o.stop), "num down"), td(fmt(o.target), "num up"),
      td(o.status.replace("_", " "), cls), td(fmtR(o.r_result), `num ${cls}`), td(fmtR(o.mfe_r), "num dim"), td(fmtR(o.mae_r), "num dim"));
    return tr;
  })));
  host.append(rc);

  // Pattern reliability + backtest for the current chart symbol
  const pr = section(`Candle patterns on ${state.symbol}`, el("span", "dim small", "  the chart autopilot skips patterns marked bad on this chart"));
  const form = el("div", "row gap wrap");
  const iv = el("select", "small"); for (const k of ["5m", "15m", "60m", "1d"]) iv.append(new Option(k, k)); iv.value = state.learn.iv || "5m";
  const ms = el("select", "small"); for (const [v, l] of [["1", "any strength"], ["2", "2+ stars (autopilot rule)"], ["3", "3 stars"]]) ms.append(new Option(l, v)); ms.value = "2";
  const run = el("button", "ghost small", "Backtest signal rule"), stats = el("button", "ghost small", "Pattern reliability");
  form.append(el("span", "small", "Bar size"), iv, el("span", "small", "Min strength"), ms, run, stats); pr.append(form);
  const out = el("div"); pr.append(out);
  stats.onclick = async () => { out.innerHTML = ""; out.append(el("div", "dim small", "Computing…")); try { const r = await api(`/api/learn/patterns/${encodeURIComponent(state.symbol)}?interval=${iv.value}&refresh=1`); out.innerHTML = ""; out.append(patternTable(r)); } catch (e) { out.innerHTML = ""; out.append(el("div", "msg err small", e.message)); } };
  run.onclick = async () => { out.innerHTML = ""; out.append(el("div", "dim small", "Backtesting…")); try { const r = await api("/api/learn/backtest", { method: "POST", body: JSON.stringify({ symbol: state.symbol, interval: iv.value, min_strength: +ms.value }) }); out.innerHTML = ""; out.append(backtestView(r)); } catch (e) { out.innerHTML = ""; out.append(el("div", "msg err small", e.message)); } };
  host.append(pr);
}

function patternTable(r) {
  const w = el("div");
  w.append(el("div", "dim small", `${r.rows.length} patterns on ${r.symbol} ${r.interval}${r.bars ? ` over ${r.bars} completed bars` : ""}; entry at the pattern close, stop beyond the pattern, 2R target. OOS = the last 30% of the bars, never used to pick the rule.`));
  w.append(table(["Pattern", "Dir", "n", "Win %", "CI low", "Avg R", "OOS n", "OOS win %", "OOS avg R", "Verdict"], r.rows.map((x) => {
    const tr = el("tr"); const cls = x.verdict === "good" ? "up" : x.verdict === "bad" ? "down" : "dim";
    tr.append(td(x.label), td(x.dir, x.dir === "bullish" ? "up" : "down"), td(x.n, "num"), td(pctTxt(x.win_rate), "num"), td(pctTxt(x.ci_low), "num dim"), td(fmtR(x.avg_r), "num"), td(x.n_oos, "num"), td(pctTxt(x.win_rate_oos), "num"), td(fmtR(x.avg_r_oos), "num"), td(x.verdict, cls));
    return tr;
  })));
  return w;
}
function backtestView(r) {
  const w = el("div");
  const row = (label, s) => `${label}: ${s.n} trades, ${pctTxt(s.win_rate)} wins (CI low ${pctTxt(s.ci_low)}), ${fmtR(s.avg_r)} avg, ${fmtR(s.total_r)} total, PF ${s.profit_factor == null ? "—" : s.profit_factor >= 99 ? "∞" : fmt(s.profit_factor, 2)}, worst drawdown ${fmtR(s.max_drawdown_r)}`;
  w.append(el("div", "small", row("All", r.all)), el("div", "small", row("In-sample (first 70%)", r.in_sample)), el("div", `small ${(r.out_of_sample.avg_r ?? 0) > 0 ? "up" : "down"}`, row("Out-of-sample (last 30%)", r.out_of_sample)));
  if (r.trades.length) w.append(rCurve(r.trades.reduce((acc, t) => { acc.push({ day: new Date(t.exit_time * 1000).toLocaleDateString(), r: (acc.at(-1)?.r || 0) + t.r }); return acc; }, [])));
  w.append(table(["Pattern", "Dir", "n", "Win %", "Avg R", "Total R", "OOS n", "OOS avg R"], r.by_pattern.map((x) => { const tr = el("tr"); tr.append(td(x.label), td(x.dir, x.dir === "bullish" ? "up" : "down"), td(x.n, "num"), td(pctTxt(x.win_rate), "num"), td(fmtR(x.avg_r), `num ${(x.avg_r ?? 0) > 0 ? "up" : "down"}`), td(fmtR(x.total_r), "num"), td(x.oos.n, "num"), td(fmtR(x.oos.avg_r), "num")); return tr; })));
  return w;
}

$("#learnDays").onchange = (e) => { state.learn.days = +e.target.value; loadLearn(); };
$("#learnRun").onclick = async () => { const b = $("#learnRun"); b.disabled = true; try { await api("/api/learn/run", { method: "POST" }); await loadLearn(); } catch (e) { showBanner(e.message); } b.disabled = false; };
document.addEventListener("section", (e) => { if (e.detail === "learn") loadLearn(); });
