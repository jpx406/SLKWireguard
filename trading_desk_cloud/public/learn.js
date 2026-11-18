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
  s.append(table([keyLabel, "Plans", "Triggered", "Wins", "Win %", "Avg R", "Likely range", "Total R", "PF"], groups.map((g) => {
    const tr = el("tr");
    // Judged by the average result, not the win rate: red only when 20+ trades lost even at the optimistic end of the range; green when the group made money.
    const cls = g.n >= (state.learn.data.learn_min_n || 10) ? (g.n >= 20 && g.r_high != null && g.r_high < 0 ? "down" : g.sum_r > 0 ? "up" : "") : "dim";
    tr.append(td(g.key, cls), td(g.total, "num"), td(g.n, "num"), td(g.wins, "num"), td(pctTxt(g.win_rate), "num"), td(fmtR(g.avg_r), `num ${cls}`), td(g.r_low == null ? "—" : `${fmtR(g.r_low)} to ${fmtR(g.r_high)}`, "num dim small"), td(fmtR(g.sum_r), `num ${cls}`), td(g.profit_factor == null ? "—" : g.profit_factor >= 99 ? "∞" : fmt(g.profit_factor, 2), "num"));
    tr.title = `${g.key}: ${g.total} plans, ${g.no_trigger} never triggered. Likely range = where the true average result per trade probably lies (average ± 1.96 × its standard error${g.se_r == null ? "" : `, ${fmt(g.se_r, 2)}R`}). A group counts as losing only when the whole range is below zero on 20 or more trades. PF = gross wins / gross losses in R.`;
    return tr;
  })));
  return s;
}

/* Score calibration: does a higher plan score go with a better result? Realized R by score group, and the rank
   correlation between score and R over the last 100 settled plans. Under 0.1 the score threshold is not used. */
function scoreCalibration(c) {
  const s = section("Score calibration", el("span", "dim small", "  does a higher score mean a better result?"));
  if (!c) { s.append(el("div", "dim small", "Not available yet.")); return s; }
  s.append(el("div", `msg small ${c.use_score ? "" : "err"}`, c.text));
  if (!c.n) return s;
  s.append(table([c.kind === "decile" ? "Score (ten equal groups)" : "Score band", "Plans", "Avg R", "Total R", "Win %"], c.bins.map((b) => { const tr = el("tr"), cls = b.avg_r > 0 ? "up" : b.avg_r < 0 ? "down" : "";
    tr.append(td(b.label), td(b.n, "num"), td(fmtR(b.avg_r), `num ${cls}`), td(fmtR(b.n ? b.sum_r : null), "num"), td(pctTxt(b.win_rate), "num")); return tr; })));
  s.append(el("div", "dim small", `Rank correlation ${c.spearman == null ? "—" : fmt(c.spearman, 2)} over the last ${c.n} settled plans that had a score (1 = higher scores always did better, 0 = no link). Each group holds only a few plans, so single rows are noisy; the correlation is the test. Below 0.10 the minimum score is ignored and the allow-list of groups that made money is used instead.`));
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
  host.append(el("p", "dim small", "Every recommendation is replayed on the 5-minute bars that came after it (walk-forward, no look-ahead): did the entry trigger, then target or stop (stop first when one bar touches both), or a time exit at the session close (day) or after the swing time limit (20 sessions unless you change it below). Results are in R (1R = the distance from entry to stop). Groups are judged by their average result per trade, not by how often they win: a group that wins one time in three with winners twice the size of its losers makes money. A group is called a loser only when it has 20 or more trades and even the optimistic end of its likely range is below zero."));
  const a = d.all || {};
  const cards = el("div", "bd-indices");
  cards.append(stat("Plans", String(d.picks), "", `${d.settled} settled · ${d.open} open · ${d.pending} pending`),
    stat("Triggered", d.picks ? pctTxt(((d.picks - d.no_trigger) / d.picks) * 100) : "—", "", `${d.no_trigger} never reached the entry`),
    stat("Win rate", pctTxt(a.win_rate), (a.win_rate ?? 0) >= 50 ? "up" : "", a.ci_low == null ? "" : `95% CI low ${pctTxt(a.ci_low)}`),
    stat("Avg R / trade", fmtR(a.avg_r), (a.avg_r ?? 0) > 0 ? "up" : (a.avg_r ?? 0) < 0 ? "down" : "", a.profit_factor == null ? "" : `profit factor ${a.profit_factor >= 99 ? "∞" : fmt(a.profit_factor, 2)}`),
    stat("Total R", fmtR(d.total_r), d.total_r > 0 ? "up" : d.total_r < 0 ? "down" : "", `worst drawdown ${fmtR(d.max_drawdown_r)}`),
    stat("Sharpe / trade", d.sharpe_per_trade == null ? "—" : fmt(d.sharpe_per_trade, 2), "", `${d.tests} groups examined`));
  host.append(cards);

  // Self-improving loop (filled by loadStrategy)
  const sbox = el("div"); sbox.id = "strategyBox"; const ssec = section("Self-improving loop", el("span", "dim small", "  observe → analyze failures → reason → validate → update, with approval and versions")); ssec.append(sbox); host.append(ssec); loadStrategy();
  // Exit engine (filled by loadExits)
  const xbox = el("div"); xbox.id = "exitBox"; const xsec = section("Exit engine: stops, targets and the losing-streak guard", el("span", "dim small", "  code sets the minimum stop distance; it re-fits it from the desk's own results")); xsec.append(xbox); host.append(xsec); loadExits();
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
  host.append(scoreCalibration(d.score_calibration));

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

/* ---------------------------------------------------------------- self-improving loop (observe -> analyze -> reason -> validate -> update) */
state.strategy = { failures: [], versions: [], active: null };
const RULE_LABELS = { min_score: "min score", avoid_setups: "avoid setups", avoid_hours: "avoid hours (NY)", avoid_slots: "avoid scans", avoid_sources: "avoid sources", avoid_regimes: "avoid regimes", avoid_symbols: "avoid symbols", allow_hours: "allow hours (NY)", allow_slots: "allow scans", allow_setups: "allow setups", max_trades_day: "max trades/day", require_kronos: "Kronos must agree" };
function rulesText(r) {
  const parts = [];
  for (const [k, v] of Object.entries(r || {})) { if (v === null || v === false || (Array.isArray(v) && !v.length)) continue; parts.push(`${RULE_LABELS[k] || k}: ${Array.isArray(v) ? v.join(", ") : v === true ? "yes" : v}`); }
  return parts.length ? parts.join(" · ") : "no rules (baseline)";
}
async function loadStrategy() {
  try { const d = await api(`/api/strategy?days=${state.learn.days}`); state.strategy = d; } catch (e) { showBanner(e.message); return; }
  renderStrategy();
  if (state.strategy.versions.some((v) => v.status === "thinking")) { clearTimeout(state.strategy.timer); state.strategy.timer = setTimeout(loadStrategy, 20000); }
}
function renderStrategy() {
  const host = $("#strategyBox"); if (!host) return; host.innerHTML = "";
  const st = state.strategy, admin = state.me?.role === "admin";
  const steps = el("div", "loop-steps");
  for (const [k, t] of [["Observe", `${state.learn.data?.picks ?? 0} plans replayed`], ["Analyze", `${st.failures.length} failure${st.failures.length === 1 ? "" : "s"} found`], ["Reason", `${st.versions.filter((v) => v.status === "proposed" || v.status === "thinking").length} proposal${st.versions.filter((v) => v.status === "proposed").length === 1 ? "" : "s"} open`], ["Validate", "in-sample / out-of-sample"], ["Update", st.active ? (st.active.version ? `v${st.active.version} active` : "automatic allow-list") : "baseline active"]]) {
    const c = el("div", "loop-step"); c.append(el("b", null, k), el("span", "dim tiny", t)); steps.append(c);
  }
  host.append(steps);
  const act = el("div", "msg small " + (st.active ? "up" : "dim")); const sa = st.active;
  act.textContent = !sa ? "No active rules: everything the scans recommend is eligible. Approve a validated proposal below to start enforcing rules."
    : `${sa.version ? `Active strategy v${sa.version}` : "No approved version; rules in force"}: ${rulesText(sa.rules)}. Scans read these rules; auto-trade and the chart autopilot skip plans that break them.${sa.auto ? " The allow-list was set automatically from the groups that made money, because the plan score is not ranking trades (see Score calibration below); it has not been validated out of sample. A plan must match at least one allow-list." : ""}${sa.note && !sa.auto ? ` ${sa.note}` : ""}`;
  if (st.active && st.active.version && admin) { const off = el("button", "ghost small", "Retire"); off.style.marginLeft = "8px"; off.onclick = async () => { if (await askConfirm({ title: "Retire the active rules?", message: "The desk goes back to the baseline (no rules). History is kept.", confirm: "Retire", destructive: true })) { await api("/api/strategy/retire", { method: "POST" }); loadStrategy(); } }; act.append(off); }
  host.append(act);
  // Failure analyzer
  const fs = section("Failure analyzer", el("span", "dim small", "  what went wrong, with evidence"));
  fs.append(el("div", "dim small", "A group is listed as losing only with 20 or more trades and an average result that is below zero even at the optimistic end of its likely range. A low win rate alone is never a failure."));
  if (!st.failures.length) fs.append(el("div", "dim small", "Nothing with enough trades to call a failure yet."));
  else for (const f of st.failures) { const row = el("div", "fail-row"); row.append(el("span", `pill ${f.severity === "high" ? "error" : f.severity === "medium" ? "running" : "done"}`, f.severity), el("b", "small", f.type.replace("_", " ")), el("span", "small", f.text)); if (f.rule) row.append(el("span", "dim tiny", `→ rule: ${rulesText(f.rule)}`)); fs.append(row); }
  const keep = st.keep || [];
  if (keep.length) { fs.append(el("h4", "small dim", "Making money (kept)")); const DIM = { slot: "scan", hour: "hour", setup: "setup", score: "score", horizon: "horizon", side: "side", source: "source", symbol: "symbol", regime: "market" };
    fs.append(table(["Group", "Trades", "Avg R", "Likely range", "Total R", "Allow-list"], keep.slice(0, 14).map((k) => { const tr = el("tr"); tr.append(td(`${DIM[k.dimension] || k.dimension} ${k.key}`), td(k.n, "num"), td(fmtR(k.avg_r), "num up"), td(k.r_low == null ? "—" : `${fmtR(k.r_low)} to ${fmtR(k.r_high)}`, "num dim small"), td(fmtR(k.sum_r), "num up"), td(k.listed ? "yes" : "—", k.listed ? "up" : "dim")); return tr; })));
    fs.append(el("div", "dim small", "A positive total is not proof: when the likely range still reaches below zero, the group may only have been lucky so far. It is kept because there is no evidence against it.")); }
  host.append(fs);
  // Proposals and versions
  const vs = section("Strategy versions", el("span", "dim small", "  proposals are validated on the past before you approve them"));
  const bar = el("div", "row gap wrap");
  const b1 = el("button", "ghost small", "Propose from statistics"); b1.onclick = async () => { b1.disabled = true; try { await api("/api/strategy/propose", { method: "POST", body: JSON.stringify({ mode: "stats" }) }); await loadStrategy(); } catch (e) { showBanner(e.message); } b1.disabled = false; };
  const b2 = el("button", "primary small", "Ask Claude to reason"); b2.title = "Claude reads the failure report and the statistics and proposes rules (one short session)"; b2.onclick = async () => { b2.disabled = true; try { await api("/api/strategy/propose", { method: "POST", body: JSON.stringify({ mode: "claude" }) }); await loadStrategy(); } catch (e) { showBanner(e.message); } b2.disabled = false; };
  bar.append(b1, b2); vs.append(bar);
  if (!st.versions.length) vs.append(el("div", "dim small", "No versions yet."));
  else vs.append(table(["v", "Status", "Source", "Rules", "Out-of-sample: baseline → with rules", "Verdict", ""], st.versions.flatMap((v) => {
    const tr = el("tr"); const val = v.validation, o = val?.out_of_sample;
    const cmp = o ? `${o.baseline.n} trades ${fmtR(o.baseline.avg_r)} → ${o.filtered.n} trades ${fmtR(o.filtered.avg_r)} (keeps ${o.filtered.kept_pct ?? "—"}%) · DD ${fmtR(o.baseline.max_drawdown_r)} → ${fmtR(o.filtered.max_drawdown_r)}` : v.status === "thinking" ? "Claude is reasoning…" : "—";
    const verdict = val?.verdict || (v.status === "thinking" ? "…" : "—"), vcls = verdict === "improves" ? "up" : verdict === "worse" ? "down" : "dim";
    tr.append(td(`v${v.version}`, "mono"), td(v.status, `pill ${v.status === "active" ? "done" : v.status === "proposed" ? "running" : v.status === "thinking" ? "running" : v.status === "error" ? "error" : ""}`), td(v.source), td(rulesText(v.rules), "wrap small"), td(cmp, "small"), td(verdict, vcls));
    const a = el("td");
    if (v.status === "proposed" && admin) { const ap = el("button", "primary small", "Approve"); ap.onclick = async () => { try { await api(`/api/strategy/${v.id}/approve`, { method: "POST" }); loadStrategy(); } catch (e) { showBanner(e.message); } }; const rj = el("button", "ghost small", "Reject"); rj.onclick = async () => { try { await api(`/api/strategy/${v.id}/reject`, { method: "POST" }); loadStrategy(); } catch (e) { showBanner(e.message); } }; a.append(ap, rj); }
    if (v.status === "retired" && admin && !rulesEmptyUi(v.rules)) { const re = el("button", "ghost small", "Re-activate"); re.onclick = async () => { try { await api(`/api/strategy/${v.id}/approve`, { method: "POST" }); loadStrategy(); } catch (e) { showBanner(e.message); } }; a.append(re); }
    tr.append(a);
    if (!v.error && !v.rationale) return [tr];
    const sub = el("tr", "win-detail"); const c = el("td", "small wrap"); c.colSpan = 7;
    if (v.error) c.append(el("div", "down", v.error)); if (v.rationale) c.append(el("div", "dim", v.rationale)); sub.append(c); return [tr, sub];
  })));
  host.append(vs);
}
const rulesEmptyUi = (r) => !r || Object.values(r).every((v) => v === null || v === false || (Array.isArray(v) && !v.length));

/* ---------------------------------------------------------------- exit engine (stop distance, targets, time limit, edge guard) */
async function loadExits() { try { state.exits = await api("/api/exits"); } catch (e) { const h = $("#exitBox"); if (h) { h.innerHTML = ""; h.append(el("div", "msg err", e.message)); } return; } renderExits(); }
function renderExits() {
  const host = $("#exitBox"); if (!host) return; host.innerHTML = "";
  const d = state.exits, p = d.policy, admin = state.me?.role === "admin";
  host.append(el("p", "small", "Why this exists: on 12,000 real 5-minute signals, a stop just beyond the pattern was hit 57% of the time; the same entries with the stop at 0.35 of the daily ATR were hit 18% of the time and lost a quarter as much. A stop inside the stock's normal noise does not protect a trade, it ends it. So every automatic entry gets a stop no closer than the distance below, and the position is made smaller so the dollars at risk stay the same."));
  for (const h of ["day", "swing"]) { const e = d.edge[h], row = el("div", `msg ${e.paused ? "err" : "ok"} small`); row.append(el("b", null, e.paused ? "PAUSED · " : "Guard · "), e.text); host.append(row); }
  const f = el("form", "exit-form"); f.setAttribute("aria-label", "Exit policy");
  const num = (name, label, val, step, hint) => { const l = el("label", "field small"); l.append(el("span", null, label)); const i = el("input"); i.type = "number"; i.name = name; i.step = step; i.value = val; i.min = d.bounds[name][0]; i.max = d.bounds[name][1]; i.disabled = !admin; i.inputMode = "decimal"; l.append(i, el("span", "dim", hint)); return l; };
  const chk = (name, label, val) => { const l = el("label", "check small"); const i = el("input"); i.type = "checkbox"; i.name = name; i.checked = val; i.disabled = !admin; l.append(i, el("span", null, ` ${label}`)); return l; };
  f.append(num("day_stop_atr", "Day trade: stop at least", p.day_stop_atr, "0.05", `× daily ATR · ${p.source.day}`), num("day_min_rr", "Day trade: target at least", p.day_min_rr, "0.25", "× the risk"),
    num("swing_stop_atr", "Swing: stop at least", p.swing_stop_atr, "0.25", `× daily ATR · ${p.source.swing}`), num("swing_min_rr", "Swing: target at least", p.swing_min_rr, "0.25", "× the risk"), num("swing_hold_days", "Swing: close after", p.swing_hold_days, "1", "sessions"),
    chk("swing_long_only", "Swing entries on the long side only (shorts lost money over 6 years of daily data)", p.swing_long_only), chk("edge_guard", "Pause automatic entries of a type that is losing beyond chance", p.edge_guard), chk("auto_learn", "Let the desk re-fit the two stop distances from its own settled plans", p.auto_learn));
  if (admin) { const save = el("button", "primary small", "Save"); save.type = "submit"; const reset = el("button", "ghost small", "Back to defaults"); reset.type = "button"; const cal = el("button", "ghost small", "Re-fit now"); cal.type = "button";
    reset.onclick = async () => { try { state.exits = await api("/api/exits", { method: "PUT", body: JSON.stringify({ reset: true }) }); renderExits(); } catch (e) { showBanner(e.message); } };
    cal.onclick = async () => { cal.disabled = true; try { state.exits = await api("/api/exits/calibrate", { method: "POST", body: "{}" }); renderExits(); } catch (e) { showBanner(e.message); cal.disabled = false; } };
    const bar = el("div", "row"); bar.append(save, reset, cal); f.append(bar);
    f.onsubmit = async (ev) => { ev.preventDefault(); const q = (n) => f.querySelector(`input[name="${n}"]`), pol = {}; for (const k of ["day_stop_atr", "day_min_rr", "swing_stop_atr", "swing_min_rr", "swing_hold_days"]) pol[k] = Number(q(k).value); for (const k of ["swing_long_only", "edge_guard", "auto_learn"]) pol[k] = q(k).checked;
      try { state.exits = await api("/api/exits", { method: "PUT", body: JSON.stringify({ policy: pol }) }); renderExits(); } catch (e) { showBanner(e.message); } }; }
  host.append(f);
  for (const [h, title] of [["day", "Day trades"], ["swing", "Swing trades"]]) { const fit = d.learned?.[h]; const box = el("div"); box.append(el("div", "small", `${title}: the same plans replayed with each stop distance`));
    if (!fit || !fit.table?.some((r) => r.n)) box.append(el("div", "dim small", "No settled plans replayed yet. Each plan is replayed with every distance when it settles; the table fills in as plans finish."));
    else { box.append(table(["Stop", "Plans", "Stopped out", "Win %", "Avg R", "Avg R, recent 30%"], fit.table.map((r) => { const tr = el("tr"); const cur = r.mult === (h === "day" ? p.day_stop_atr : p.swing_stop_atr); tr.append(td(r.mult === 0 ? "as recommended" : `${r.mult} × ATR${cur ? " (in force)" : ""}`, cur ? "up" : ""), td(r.n, "num"), td(`${r.stopped_pct}%`, "num"), td(`${r.win_pct}%`, "num"), td(fmtR(r.avg_r), `num ${r.avg_r > 0 ? "up" : r.avg_r < 0 ? "down" : ""}`), td(r.avg_r_recent == null ? "—" : fmtR(r.avg_r_recent), "num")); return tr; })), el("div", "dim small", fit.reason)); }
    host.append(box); }
  host.append(el("div", "dim small", "Day trades placed by the desk also sell half at +1R, move the stop to the entry and trail the rest (Desk limits, Change). On 12,000 real signals that was equal to a fixed target for day trades and halved the result of swing longs, so swing trades keep a fixed stop and target. A wider stop does not make a losing idea win; it stops noise and costs from deciding the outcome."));
}
