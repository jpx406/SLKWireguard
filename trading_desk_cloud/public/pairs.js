// Quant Terminal · Pairs view. Four building blocks, each with its own panel:
// Engle-Granger (is it cointegrated), Ornstein-Uhlenbeck (how fast it reverts), Kalman filter (is the hedge ratio
// still right) and the z-score rule (fade the extremes, exit near the mean). Analysis and signals only: no orders.
state.pairs = { a: "KO", b: "PEP", entry: 2, exit: 0.5, data: null, scan: null, err: null, busy: false, scanBusy: false, key: "" };

function qViewToggle() {
  const w = qEl("span", "q-view"); w.setAttribute("role", "group"); w.setAttribute("aria-label", "Quant view");
  for (const [id, label] of [["terminal", "TERMINAL"], ["pairs", "PAIRS"]]) { const b = qEl("button", (state.quant.view || "terminal") === id ? "on" : "", label); b.type = "button"; b.setAttribute("aria-pressed", String((state.quant.view || "terminal") === id)); b.onclick = () => { if ((state.quant.view || "terminal") === id) return; state.quant.view = id; try { localStorage.setItem("quantView", id); } catch { /* private mode */ } loadQuant(); }; w.append(b); }
  return w;
}
try { state.quant.view = localStorage.getItem("quantView") === "pairs" ? "pairs" : "terminal"; } catch { state.quant.view = "terminal"; }

async function loadPairs(force) {
  const P = state.pairs, key = `${P.a}|${P.b}|${P.entry}|${P.exit}`;
  if (!P.scan && !P.scanBusy) { P.scanBusy = true; api("/api/pairs/scan").then((s) => { P.scan = s; }).catch((e) => { P.scan = { rows: [], error: e.message }; }).finally(() => { P.scanBusy = false; if (state.quant.view === "pairs" && sectionVisible("quant")) renderPairs(); }); }
  if (!force && P.key === key && (P.data || P.err)) { renderPairs(); return; }
  P.busy = true; renderPairs();
  try { P.data = await api(`/api/pairs?a=${encodeURIComponent(P.a)}&b=${encodeURIComponent(P.b)}&entry=${P.entry}&exit=${P.exit}`); P.err = null; } catch (e) { P.data = null; P.err = e.message; }
  P.busy = false; P.key = key; if (state.quant.view === "pairs") renderPairs();
}

/** Lines on one canvas. series: [{v:[numbers|null], color, width, dash}], hl: [{y, color, label, dash}], vl: {i, label}, marks: [{i, y, color}] */
function qPlot(host, series, o = {}) {
  host.innerHTML = ""; const { g, w, h } = qCanvas(host), n = Math.max(...series.map((s) => s.v.length)), padL = 4, padR = 46, padT = 8, padB = 14;
  let lo = Infinity, hi = -Infinity; for (const s of series) for (const v of s.v) if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const l of o.hl || []) if (l.fit !== false) { lo = Math.min(lo, l.y); hi = Math.max(hi, l.y); }
  if (!isFinite(lo)) { qText(g, "NO DATA", w / 2, h / 2, QC.dim, "center"); return; } if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const X = (i) => padL + (i / Math.max(n - 1, 1)) * (w - padL - padR), Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  if (o.band) { g.fillStyle = o.band.color; g.fillRect(padL, Y(o.band.hi), w - padL - padR, Y(o.band.lo) - Y(o.band.hi)); }
  if (o.vl && o.vl.i > 0) { g.fillStyle = "rgba(245,184,46,.05)"; g.fillRect(X(o.vl.i), padT, w - padR - X(o.vl.i), h - padT - padB); g.setLineDash([2, 3]); qLine(g, [[X(o.vl.i), padT], [X(o.vl.i), h - padB]], QC.amber, 1); g.setLineDash([]); qText(g, o.vl.label, X(o.vl.i) + 4, padT + 8, QC.amber); }
  for (const l of o.hl || []) { if (l.y < lo || l.y > hi) continue; g.setLineDash(l.dash === false ? [] : [3, 3]); qLine(g, [[padL, Y(l.y)], [w - padR, Y(l.y)]], l.color || QC.line, 1); g.setLineDash([]); if (l.label) qText(g, l.label, w - padR + 3, Y(l.y) + 3, l.color || QC.dim); }
  for (const s of series) { g.setLineDash(s.dash ? [4, 3] : []); let seg = []; const flush = () => { if (seg.length > 1) qLine(g, seg, s.color, s.width || 1.3); seg = []; }; s.v.forEach((v, i) => { if (v == null || !isFinite(v)) flush(); else seg.push([X(i), Y(v)]); }); flush(); g.setLineDash([]); }
  for (const m of o.marks || []) { g.fillStyle = m.color; g.beginPath(); g.arc(X(m.i), Y(m.y), 3, 0, Math.PI * 2); g.fill(); }
  if (o.x) { qText(g, o.x[0], padL, h - 2, QC.dim); qText(g, o.x[1], w - padR, h - 2, QC.dim, "right"); }
}
/** The test statistic on a scale: further left = stronger evidence the spread is stationary. */
function qGauge(host, eg) {
  host.innerHTML = ""; const { g, w, h } = qCanvas(host), lo = -6, hi = 0, X = (v) => 8 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (w - 16), y = h / 2 + 4, c = eg.critical;
  const zone = (a, b, col) => { g.fillStyle = col; g.fillRect(X(a), y - 7, X(b) - X(a), 14); };
  zone(lo, c.p01, "rgba(46,229,157,.55)"); zone(c.p01, c.p05, "rgba(46,229,157,.3)"); zone(c.p05, c.p10, "rgba(245,184,46,.3)"); zone(c.p10, hi, "rgba(255,59,74,.25)");
  for (const [v, t, al] of [[c.p01, "1%", "right"], [c.p05, "5%", "center"], [c.p10, "10%", "left"]]) { qLine(g, [[X(v), y - 11], [X(v), y + 11]], QC.text, 1); qText(g, t, X(v) + (al === "right" ? -3 : al === "left" ? 3 : 0), y + 22, QC.dim, al); }
  const mark = (v, col, label, up) => { if (v == null || isNaN(v)) return; g.fillStyle = col; g.beginPath(); g.moveTo(X(v), y - 9); g.lineTo(X(v) - 5, y - 18); g.lineTo(X(v) + 5, y - 18); g.closePath(); g.fill(); qText(g, label, X(v), y - (up ? 32 : 21), col, "center"); };
  mark(eg.first_half_t, QC.dim, "1ST", true); mark(eg.second_half_t, QC.dim, "2ND", true); mark(eg.t, eg.passes ? QC.green : QC.red, `ALL ${eg.t}`);
  qText(g, "STATIONARY", 8, h - 2, QC.green); qText(g, "RANDOM WALK", w - 8, h - 2, QC.red, "right");
}

function renderPairs() {
  const host = $("#quant"), P = state.pairs, d = P.data; for (const t of state.quant.timers) clearInterval(t); state.quant.timers = [];
  if (state.quant.chart) { try { state.quant.chart.remove(); } catch { /* gone */ } state.quant.chart = null; }
  const keep = document.activeElement && host.contains(document.activeElement) ? document.activeElement.name : null;
  host.innerHTML = ""; const root = qEl("div", "q-root"); host.append(root);
  const top = qEl("div", "q-top"); top.append(qEl("span", "q-logo", "Q"), qEl("b", "q-title", "CLAUDE × QUANT"), qEl("span", "q-sub", `PAIRS · ${d ? `${d.a} / ${d.b}` : `${P.a} / ${P.b}`}`), qEl("span", "q-sp"), qViewToggle(), qEl("span", "q-tag amber", "SIGNALS ONLY · NO ORDERS")); root.append(top);
  // Pair picker
  const f = qEl("form", "q-pform"); f.setAttribute("aria-label", "Pair to analyse");
  const inp = (name, label, val, attrs = {}) => { const l = qEl("label", "q-fld"); l.append(qEl("span", "q-lbl", label)); const i = qEl("input", "q-in"); i.name = name; i.value = val; Object.assign(i, attrs); l.append(i); return l; };
  const go = qEl("button", "q-go", P.busy ? "TESTING…" : "TEST PAIR"); go.type = "submit"; go.disabled = P.busy;
  f.append(inp("a", "Leg A", P.a, { maxLength: 12, autocapitalize: "characters", spellcheck: false }), inp("b", "Leg B", P.b, { maxLength: 12, autocapitalize: "characters", spellcheck: false }), inp("entry", "Enter at |z| ≥", P.entry, { type: "number", step: "0.25", min: "0.5", max: "4", inputMode: "decimal" }), inp("exit", "Exit at |z| ≤", P.exit, { type: "number", step: "0.25", min: "0", max: "3", inputMode: "decimal" }), go);
  f.onsubmit = (e) => { e.preventDefault(); const q = (n) => f.querySelector(`input[name="${n}"]`).value.trim(); P.a = q("a").toUpperCase() || P.a; P.b = q("b").toUpperCase() || P.b; P.entry = Math.min(4, Math.max(0.5, +q("entry") || 2)); P.exit = Math.min(P.entry - 0.25, Math.max(0, +q("exit") || 0)); loadPairs(true); };
  root.append(f);
  if (P.err) root.append(qEl("div", "msg err", P.err));
  if (!d) { if (!P.err) root.append(qEl("div", "q-note", P.busy ? "Testing the pair on up to three years of daily bars…" : "Choose two symbols.")); }
  else {
    const eg = d.engle_granger, ou = d.ou, kf = d.kalman, T = d.tests, S = d.series, pass = eg.passes && d.hedged, good = pass && eg.stable && d.tradable;
    const strip = qEl("div", `q-strip q-verdict ${good ? "ok" : pass ? "mid" : "bad"}`); strip.append(qEl("span", good ? "green" : pass ? "amber" : "red", good ? "▲ TRADABLE PAIR" : pass ? "■ CAUTION" : "▼ NOT A PAIR"), qEl("span", "q-vtext", d.verdict)); root.append(strip);
    if (d.swapped) root.append(qEl("div", "q-note", `Shown as ${d.a} against ${d.b}: the test is stronger that way round.`));
    const sig = qEl("div", `q-signal ${d.signal.action === "long spread" ? "green" : d.signal.action === "short spread" ? "red" : ""}`); sig.append(qEl("b", null, d.signal.action.toUpperCase()), qEl("span", null, d.signal.text)); root.append(sig);
    const grid = qEl("div", "q-grid q-pairs"); root.append(grid);
    const fmtT = (v) => (v == null || isNaN(v) ? "—" : qFmt(v, 2)), pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${qFmt(v, 2)}%`), cls = (v) => (v > 0 ? "green" : v < 0 ? "red" : "");

    // 1 Engle-Granger
    const p1 = qPanel("1 · ENGLE-GRANGER", "is it really cointegrated?", [[eg.verdict, eg.passes ? "green" : "red"]]);
    const s1 = qEl("div", "q-stats"); s1.append(qStat("Test statistic", fmtT(eg.t), eg.passes ? "green" : "red"), qStat("Needs (5%)", `≤ ${eg.critical.p05}`), qStat("Hedge ratio (beta)", qFmt(eg.beta, 3)), qStat("Return correlation", d.corr == null ? "—" : qFmt(d.corr, 2)));
    const g1 = qEl("div", "q-cv q-gauge"); p1.body.append(s1, g1, qEl("div", "q-note", `log ${d.a} = ${qFmt(eg.alpha, 3)} + ${qFmt(eg.beta, 3)} × log ${d.b} + spread. The spread is then tested for a unit root. First half ${fmtT(eg.first_half_t)}, second half ${fmtT(eg.second_half_t)}: ${eg.stable ? "holds in both halves." : "does not hold in both halves."} A high correlation is not cointegration.`));
    // 2 OU
    const p2 = qPanel("2 · ORNSTEIN-UHLENBECK", "how fast does it revert?", [[ou.half_life == null ? "NO REVERSION" : `HALF-LIFE ${qFmt(ou.half_life, 1)}D`, ou.half_life != null && ou.half_life >= 2 && ou.half_life <= 60 ? "green" : "amber"]]);
    const s2 = qEl("div", "q-stats"); s2.append(qStat("Half-life", ou.half_life == null ? "—" : `${qFmt(ou.half_life, 1)} d`), qStat("Pull per day", ou.theta == null ? "—" : qFmt(ou.theta, 3)), qStat("Typical gap", ou.sigma_eq == null ? "—" : `${qFmt(ou.sigma_eq * 100, 2)}%`), qStat("Z window", `${ou.window} d`));
    const g2 = qEl("div", "q-cv q-mid"); p2.body.append(s2, g2, qEl("div", "q-note", `${ou.note} The spread over ${d.days} days with its long-run mean and a band of two typical gaps either side.`));
    // 3 Kalman
    const p3 = qPanel("3 · KALMAN FILTER", "is the hedge ratio still right?", [[`DRIFT ${pct(kf.drift_pct)}`, Math.abs(kf.drift_pct) > 15 ? "amber" : "green"]]);
    const s3 = qEl("div", "q-stats"); s3.append(qStat("Beta now", qFmt(kf.beta_now, 3), "cyan"), qStat("Beta, fixed", qFmt(kf.beta_formation, 3)), qStat("Range", `${qFmt(kf.min, 2)}–${qFmt(kf.max, 2)}`), qStat("Hedge per $1", `$${qFmt(Math.abs(kf.beta_now), 2)}`));
    const g3 = qEl("div", "q-cv q-mid"); p3.body.append(s3, g3, qEl("div", "q-note", `${kf.note} Cyan: ratio updated one day at a time. Dashed: fixed ratio from the first 60% of the history.`));
    // 4 Z-score rule
    const p4 = qPanel("4 · Z-SCORE RULE", "fade the extremes, exit near the mean", [[`Z ${d.z_now == null ? "—" : qFmt(d.z_now, 2)}`, Math.abs(d.z_now || 0) >= d.rule.entry ? "amber" : "dim"]]);
    const g4 = qEl("div", "q-cv q-mid"), g5 = qEl("div", "q-cv q-mid");
    const tbl = qEl("table", "q-ptbl"); tbl.setAttribute("aria-label", "Z-score rule results");
    const row = (cells, th) => { const tr = qEl("tr"); cells.forEach((c, i) => { const td = qEl(th || i === 0 ? "th" : "td", Array.isArray(c) ? c[1] : null, Array.isArray(c) ? c[0] : c); tr.append(td); }); return tr; };
    tbl.append(row(["", "Trades", "Win", "Total", "Avg", "Max DD", "Sharpe", "Days"], true));
    for (const [name, t] of [["Fixed ratio · unseen 40%", T.static_oos], ["Kalman ratio · unseen 40%", T.kalman_oos], ["Kalman ratio · whole run", T.kalman_all]]) tbl.append(row([name, String(t.trades), t.win_rate == null ? "—" : `${Math.round(t.win_rate * 100)}%`, [pct(t.total_pct), cls(t.total_pct)], [pct(t.avg_pct), cls(t.avg_pct)], `${qFmt(t.max_dd_pct, 1)}%`, t.sharpe == null ? "—" : qFmt(t.sharpe, 2), t.avg_days == null ? "—" : qFmt(t.avg_days, 0)]));
    const wrap = qEl("div", "q-scroll"); wrap.append(tbl);
    p4.body.append(g4, qEl("div", "q-note", `Z of the Kalman spread. Enter beyond ±${d.rule.entry}, exit inside ±${d.rule.exit}, give up beyond ±${d.rule.stop} or after ${d.rule.max_days} days. Shaded: the unseen 40% (from ${T.oos_from}).`), wrap, g5,
      qEl("div", "q-note", `Growth of 1 on the unseen 40%: cyan Kalman, amber fixed ratio. Fills at the next day's open on both legs, ${d.rule.fee_pct}% per leg per fill, return on the gross capital of both legs. No borrow cost for the short leg.`));
    if (T.kalman_oos.open) p4.body.append(qEl("div", "q-note amber", `The test is still in a trade: ${T.kalman_oos.open.side} since ${T.kalman_oos.open.since} (entered at z ${T.kalman_oos.open.z_in}).`));
    const last = T.kalman_oos.list.slice(-8).reverse();
    if (last.length) { const lt = qEl("table", "q-ptbl"); lt.setAttribute("aria-label", "Latest pair trades in the test"); lt.append(row(["Side", "In", "Out", "Days", "Z in", "Result", "Why closed"], true)); for (const t of last) lt.append(row([t.side, t.entry_day, t.exit_day, String(t.days), qFmt(t.z_in, 2), [pct(t.pct), cls(t.pct)], t.reason])); const w2 = qEl("div", "q-scroll"); w2.append(lt); p4.body.append(w2); }
    grid.append(p1, p2, p3, p4);
    requestAnimationFrame(() => {
      const xr = [d.from, d.to], cut = { i: S.cut_index, label: "UNSEEN" };
      qGauge(g1, eg);
      const mu = ou.mu, se = ou.sigma_eq; qPlot(g2, [{ v: S.spread, color: QC.cyan }], { x: xr, hl: [{ y: mu, color: QC.text, label: "MEAN", dash: false }, ...(se ? [{ y: mu + 2 * se, color: QC.red, label: "+2 SD" }, { y: mu - 2 * se, color: QC.green, label: "−2 SD" }] : [])], band: se ? { lo: mu - se, hi: mu + se, color: "rgba(54,214,231,.06)" } : null });
      qPlot(g3, [{ v: S.beta, color: QC.cyan, width: 1.6 }], { x: xr, vl: cut, hl: [{ y: kf.beta_formation, color: QC.amber, label: `FIX ${qFmt(kf.beta_formation, 2)}` }] });
      const r = d.rule; qPlot(g4, [{ v: S.z, color: QC.cyan }], { x: xr, vl: cut, hl: [{ y: 0, color: QC.dim, dash: false }, { y: r.entry, color: QC.red, label: `+${r.entry}` }, { y: -r.entry, color: QC.green, label: `−${r.entry}` }, { y: r.exit, color: QC.line, fit: false }, { y: -r.exit, color: QC.line, fit: false }], band: { lo: -r.exit, hi: r.exit, color: "rgba(200,210,224,.05)" }, marks: S.z.at(-1) != null ? [{ i: S.z.length - 1, y: S.z.at(-1), color: QC.amber }] : [] });
      qPlot(g5, [{ v: T.static_oos.equity, color: QC.amber, dash: true }, { v: T.kalman_oos.equity, color: QC.cyan, width: 1.6 }], { x: [T.oos_from, d.to], hl: [{ y: 1, color: QC.dim, label: "1.00", dash: false }] });
    });
  }
  // Scanner
  const sc = P.scan, ps = qPanel("PAIR SCANNER", "classic pairs and your watchlist, strongest test first", sc && sc.rows ? [[`${sc.rows.filter((r) => r.tradable).length} OF ${sc.rows.length} TRADABLE`, sc.rows.some((r) => r.tradable) ? "green" : "amber"]] : []);
  ps.classList.add("q-scan");
  if (!sc) ps.body.append(qEl("div", "q-note", "Testing the candidate pairs…"));
  else if (sc.error) ps.body.append(qEl("div", "msg err", sc.error));
  else if (!sc.rows.length) ps.body.append(qEl("div", "q-note", "No pair had enough shared history to test."));
  else {
    const t = qEl("table", "q-ptbl q-scan-t"); t.setAttribute("aria-label", "Scanned pairs"); const hr = qEl("tr"); for (const h of ["Pair", "Test", "Verdict", "Both halves", "Half-life", "Beta now", "Beta drift", "Z now", "Signal", "Rule, unseen 40%"]) hr.append(qEl("th", null, h)); t.append(hr);
    for (const r of sc.rows) { const tr = qEl("tr", r.tradable ? "ok" : ""); tr.tabIndex = 0; tr.setAttribute("role", "button"); tr.setAttribute("aria-label", `Test ${r.a} against ${r.b}`);
      const cell = (v, c) => tr.append(qEl("td", c || null, v));
      const th = qEl("th", null, `${r.a} / ${r.b}`); tr.append(th); cell(qFmt(r.t, 2), r.passes ? "green" : "red"); cell(r.verdict, r.passes ? "green" : "dim"); cell(r.stable ? "yes" : "no", r.stable ? "green" : "dim"); cell(r.half_life == null ? "—" : `${qFmt(r.half_life, 1)} d`); cell(qFmt(r.beta, 2)); cell(`${r.drift_pct > 0 ? "+" : ""}${qFmt(r.drift_pct, 0)}%`, Math.abs(r.drift_pct) > 15 ? "amber" : ""); cell(r.z == null ? "—" : qFmt(r.z, 2), Math.abs(r.z || 0) >= 2 ? "amber" : ""); cell(r.action, r.action === "long spread" ? "green" : r.action === "short spread" ? "red" : "dim"); cell(`${r.oos_pct > 0 ? "+" : ""}${qFmt(r.oos_pct, 1)}% · ${r.oos_trades} trades`, r.oos_pct > 0 ? "green" : r.oos_pct < 0 ? "red" : "");
      const open = () => { P.a = r.a; P.b = r.b; loadPairs(true); host.scrollIntoView({ block: "start", behavior: "smooth" }); }; tr.onclick = open; tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }; t.append(tr); }
    const w = qEl("div", "q-scroll"); w.append(t); ps.body.append(w, qEl("div", "q-note", `${sc.tested} pairs tested. Testing many pairs finds some that pass by chance (about 1 in 20 at the 5% level), so a pair counts as tradable only when it passes on the whole history and in both halves and its half-life is 2 to 60 days. Select a row to open it.`));
  }
  root.append(ps);
  const foot = qEl("div", "q-foot"); foot.append(qEl("span", null, "PAIRS"), qEl("span", null, "Daily log prices, up to 3 years"), qEl("span", null, "Analysis only: no orders are placed"), qEl("span", null, "Research, not advice")); root.append(foot);
  if (keep) { const el = host.querySelector(`input[name="${keep}"]`); if (el) el.focus(); }
}
