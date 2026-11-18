"use strict";
/* Quant terminal: a dense, terminal-style view of the desk. Every panel is computed from real data the desk already
   has (paper account, settled plan outcomes in R, candles of the selected symbol, watchlist quotes, the risk layer):
     account + equity curve + drawdown heat · live candles · plan grid · excursion survival (MFE / MAE) · analog matcher
     (k-NN on z-scored windows) · Bayesian update of the win probability · portfolio risk (VaR / ES) and correlation.
     Paper only. */

state.quant = { data: null, bars: [], chart: null, series: null, vol: null, timers: [], sym: null };
const QC = { bg: "#05070a", panel: "#0a0d12", line: "#1b2330", amber: "#f5b82e", green: "#2ee59d", red: "#ff3b4a", cyan: "#36d6e7", pink: "#ff3fa4", text: "#c8d2e0", dim: "#5b6678", violet: "#8f7bff" };
const qEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const qFmt = (n, d = 2) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

function qCanvas(host) {
  const c = document.createElement("canvas"); host.append(c);
  const dpr = window.devicePixelRatio || 1, w = Math.max(50, host.clientWidth), h = Math.max(40, host.clientHeight);
  c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.font = "10px ui-monospace, Menlo, Consolas, monospace";
  return { g, w, h };
}
function qPanel(title, sub, tags = []) {
  const p = qEl("section", "q-panel"), head = qEl("div", "q-head");
  head.append(qEl("span", "q-tick"), qEl("b", null, title)); if (sub) head.append(qEl("span", "q-sub", `· ${sub}`));
  head.append(qEl("span", "q-sp"));
  for (const [t, cls] of tags) head.append(qEl("span", `q-tag ${cls || ""}`, t));
  const body = qEl("div", "q-body"); p.append(head, body); p.body = body; p.head = head; return p;
}
const qStat = (label, value, cls = "") => { const d = qEl("div", "q-stat"); d.append(qEl("span", "q-lbl", label), qEl("span", `q-val ${cls}`, value)); return d; };

async function loadQuant() {
  if (state.quant.view === "pairs" && typeof loadPairs === "function") return loadPairs();
  const sym = state.symbol;
  try {
    const [d, bars] = await Promise.all([api(`/api/quant?symbol=${encodeURIComponent(sym)}`), api(`/api/candles/${encodeURIComponent(sym)}?interval=5m&days=30`).catch(() => [])]);
    if (sym !== state.symbol) return;
    state.quant.data = d; state.quant.bars = bars; state.quant.sym = sym; renderQuant();
  } catch (e) { $("#quant").innerHTML = ""; $("#quant").append(qEl("div", "msg err", e.message)); }
}

/* ---------- maths ---------- */
function qZ(arr) { const m = arr.reduce((a, b) => a + b, 0) / arr.length, s = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) || 1e-9; return arr.map((v) => (v - m) / s); }
/** k-NN analog matcher: the current window of closes (z-scored) against every earlier window; what the nearest ones did next. */
function qAnalogs(bars, win = 64, fwd = 26, k = 6) {
  const c = bars.map((b) => b.close); if (c.length < win * 3 + fwd) return null;
  const cur = qZ(c.slice(-win)), out = [];
  for (let i = 0; i + win + fwd < c.length - win; i += 2) {
    const w = qZ(c.slice(i, i + win)); let d = 0; for (let j = 0; j < win; j++) d += (w[j] - cur[j]) ** 2;
    out.push({ i, d: Math.sqrt(d / win) });
  }
  out.sort((a, b) => a.d - b.d);
  const picked = []; for (const o of out) { if (picked.every((p) => Math.abs(p.i - o.i) > win / 2)) picked.push(o); if (picked.length >= k) break; }
  const paths = picked.map((p) => { const base = c[p.i + win - 1]; return { d: p.d, path: c.slice(p.i + win - 1, p.i + win + fwd).map((v) => ((v - base) / base) * 100) }; });
  const finals = paths.map((p) => p.path.at(-1)).sort((a, b) => a - b);
  return { cur, paths, up: finals.filter((v) => v > 0).length, down: finals.filter((v) => v <= 0).length, median: finals.length ? finals[Math.floor(finals.length / 2)] : 0, match: paths.length ? Math.max(0, 1 - paths[0].d / 2) : 0, scanned: out.length, win, fwd };
}
function qBeta(x, a, b) { const lg = (z) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953]; let y = z, t = z + 5.5; t -= (z + 0.5) * Math.log(t); let s = 1.000000000190015; for (const k of c) s += k / ++y; return -t + Math.log(2.5066282746310005 * s / z); }; return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - (lg(a) + lg(b) - lg(a + b))); }

/* ---------- drawing ---------- */
function qLine(g, pts, color, width = 1.2) { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
function qArea(g, pts, base, color) { g.fillStyle = color; g.beginPath(); g.moveTo(pts[0][0], base); for (const [x, y] of pts) g.lineTo(x, y); g.lineTo(pts.at(-1)[0], base); g.closePath(); g.fill(); }
function qText(g, t, x, y, color = QC.dim, align = "left") { g.fillStyle = color; g.textAlign = align; g.fillText(t, x, y); }

function drawEquity(host, d) {
  const { g, w, h } = qCanvas(host); const pts = [d.account.starting_cash, ...d.curve.map((c) => c.equity), d.account.equity];
  const lo = Math.min(...pts), hi = Math.max(...pts), X = (i) => 4 + (i / Math.max(1, pts.length - 1)) * (w - 8), Y = (v) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 14);
  qArea(g, pts.map((v, i) => [X(i), Y(v)]), h, "rgba(245,184,46,.10)"); qLine(g, pts.map((v, i) => [X(i), Y(v)]), QC.amber, 1.6);
}
function drawSurvival(host, d) {
  const { g, w, h } = qCanvas(host); const o = d.outcomes; if (o.length < 5) { qText(g, "needs settled plans", 8, 16); return; }
  const xs = Array.from({ length: 41 }, (_, i) => i / 10), X = (x) => 28 + (x / 4) * (w - 36), Y = (p) => h - 14 - p * (h - 24);
  const fav = xs.map((x) => o.filter((t) => (t.mfe ?? 0) >= x).length / o.length), adv = xs.map((x) => o.filter((t) => -(t.mae ?? 0) >= x / 4).length / o.length);
  for (const p of [0, 0.5, 1]) { g.strokeStyle = QC.line; g.beginPath(); g.moveTo(28, Y(p)); g.lineTo(w - 8, Y(p)); g.stroke(); qText(g, `${p * 100}%`, 2, Y(p) + 3); }
  qArea(g, xs.map((x, i) => [X(x), Y(fav[i])]), Y(0), "rgba(46,229,157,.18)"); qLine(g, xs.map((x, i) => [X(x), Y(fav[i])]), QC.green, 1.5);
  qArea(g, xs.map((x, i) => [X(x), Y(adv[i])]), Y(0), "rgba(255,59,74,.14)"); qLine(g, xs.map((x, i) => [X(x), Y(adv[i])]), QC.red, 1.2);
  for (const x of [1, 2, 3]) qText(g, `+${x}R`, X(x), h - 2, QC.dim, "center");
  qText(g, "reached +xR", w - 8, 12, QC.green, "right"); qText(g, "went -x/4 R against", w - 8, 24, QC.red, "right");
}
function drawAnalog(host, an) {
  const { g, w, h } = qCanvas(host); if (!an) { qText(g, "needs more history (5m bars)", 8, 16); return; }
  const split = w * 0.6, cur = an.cur, lo = Math.min(...cur), hi = Math.max(...cur), Yc = (v) => h - 16 - ((v - lo) / (hi - lo || 1)) * (h - 32);
  qLine(g, cur.map((v, i) => [4 + (i / (cur.length - 1)) * (split - 8), Yc(v)]), QC.violet, 1.6);
  g.strokeStyle = QC.amber; g.lineWidth = 1; g.beginPath(); g.moveTo(split, 4); g.lineTo(split, h - 4); g.stroke(); g.fillStyle = QC.amber; g.fillRect(split - 14, 2, 28, 12); qText(g, "NOW", split, 11, "#000", "center");
  const all = an.paths.flatMap((p) => p.path), m = Math.max(0.05, ...all.map(Math.abs)), y0 = Yc(cur.at(-1)), Yf = (v) => y0 - (v / m) * (h * 0.38);
  an.paths.forEach((p) => qLine(g, p.path.map((v, i) => [split + (i / (p.path.length - 1)) * (w - split - 6), Yf(v)]), p.path.at(-1) > 0 ? "rgba(46,229,157,.7)" : "rgba(255,59,74,.7)", 1.1));
  qText(g, `current window · ${an.win} bars · z-scored`, 6, 12); qText(g, "what happened next →", split + 20, 12, QC.dim);
}
function drawBayes(host, wins, losses) {
  const { g, w, h } = qCanvas(host); const xs = Array.from({ length: 99 }, (_, i) => (i + 1) / 100), pr = xs.map((x) => qBeta(x, 2, 2)), po = xs.map((x) => qBeta(x, 2 + wins, 2 + losses));
  const m = Math.max(...po, ...pr), X = (x) => 6 + x * (w - 12), Y = (v) => h - 14 - (v / m) * (h - 26);
  qArea(g, xs.map((x, i) => [X(x), Y(pr[i])]), Y(0), "rgba(91,102,120,.25)"); g.setLineDash([3, 3]); qLine(g, xs.map((x, i) => [X(x), Y(pr[i])]), QC.dim, 1); g.setLineDash([]);
  qArea(g, xs.map((x, i) => [X(x), Y(po[i])]), Y(0), "rgba(46,229,157,.35)"); qLine(g, xs.map((x, i) => [X(x), Y(po[i])]), QC.green, 1.6);
  const mean = (2 + wins) / (4 + wins + losses); qLine(g, [[X(mean), Y(0)], [X(mean), 8]], QC.amber, 1);
  for (const x of [0, 0.25, 0.5, 0.75, 1]) qText(g, `${x * 100}%`, X(Math.min(0.97, Math.max(0.03, x))), h - 2, QC.dim, "center");
  return mean;
}

/* ---------- page ---------- */
function renderQuant() {
  if (state.quant.view === "pairs" && typeof renderPairs === "function") return renderPairs();
  const host = $("#quant"), d = state.quant.data, bars = state.quant.bars; if (!d) return;
  for (const t of state.quant.timers) clearInterval(t); state.quant.timers = [];
  if (state.quant.chart) { try { state.quant.chart.remove(); } catch { /* gone */ } state.quant.chart = null; }
  host.innerHTML = ""; const root = qEl("div", "q-root"); host.append(root);
  const a = d.account, l = d.learn, all = l.all || {}, o = d.outcomes, wins = o.filter((t) => t.r > 0).length, losses = o.length - wins;
  const avgWin = wins ? o.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0) / wins : null, avgLoss = losses ? -o.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0) / losses : null;
  const heat = d.settings.max_drawdown_pct > 0 ? Math.min(10, (d.drawdown_pct / d.settings.max_drawdown_pct) * 10) : 0, kill = d.settings.kill_switch;
  const lastBar = bars.at(-1), prevClose = bars.length > 80 ? bars[bars.length - 79].close : bars[0]?.close, chg = lastBar && prevClose ? ((lastBar.close - prevClose) / prevClose) * 100 : null;

  // Top bar
  const top = qEl("div", "q-top"); const logo = qEl("span", "q-logo", "Q");
  const killBtn = qEl("button", `q-kill ${kill ? "on" : ""}`, kill ? "KILL SWITCH ON" : "KILL SWITCH"); killBtn.title = kill ? d.settings.kill_reason || "manual" : "Cancel working orders, flatten every paper position and stop automatic entries";
  killBtn.onclick = async () => { if (!kill && !(await askConfirm({ title: "Trip the kill switch?", message: "Working orders are cancelled, every open paper position is closed and automatic entries stop until you re-arm it.", confirm: "Flatten and Stop", destructive: true }))) return; try { await api("/api/paper/kill", { method: "POST", body: JSON.stringify({ on: !kill }) }); loadQuant(); } catch (e) { showBanner(e.message); } };
  const clock = qEl("span", "q-clock", ""); const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour12: false }); }; tick(); state.quant.timers.push(setInterval(tick, 1000));
  top.append(logo, qEl("b", "q-title", "CLAUDE × QUANT"), qEl("span", "q-sub", `HUNTER 05 · ${d.symbol} · PAPER AGENT`), qEl("span", "q-sp"), qEl("span", "q-mode", "REGIME · ANALOG · KELLY"), ...(typeof qViewToggle === "function" ? [qViewToggle()] : []), killBtn, qEl("span", `q-tag ${kill ? "red" : "green"}`, kill ? "HALTED" : "LIVE · PAPER"), clock);
  root.append(top);
  const strip = qEl("div", "q-strip"); const rg = d.regime;
  strip.append(qEl("span", "amber", `▼ REGIME ${rg.regime.replace("_", " ")}`), qEl("span", null, `SIZE ×${rg.size_mult}`), qEl("span", null, `${rg.index} VOL ${qFmt(rg.vol_ann, 1)}%`), qEl("span", null, `TREND ${rg.trend > 0 ? "+" : ""}${qFmt(rg.trend, 2)}σ`),
    qEl("span", d.kelly.quarter != null ? "green" : null, `1/4 KELLY ${d.kelly.quarter == null ? "n/a" : `${qFmt(d.kelly.quarter, 2)}%`}`), qEl("span", null, `STRATEGY ${d.active_rules ? (d.active_rules.version ? `v${d.active_rules.version}` : "ALLOW-LIST") : "BASELINE"}`), qEl("span", null, `PLANS ${l.picks} · SETTLED ${l.settled}`),
    ...(d.watchlist || []).slice(0, 8).map((s) => { const q = state.quotes[s]; return qEl("span", q?.change_pct > 0 ? "green" : q?.change_pct < 0 ? "red" : null, `${s} ${q?.change_pct == null ? "—" : `${q.change_pct > 0 ? "▲" : "▼"} ${qFmt(Math.abs(q.change_pct))}%`}`); }));
  root.append(strip);

  const grid = qEl("div", "q-grid"); root.append(grid);
  // 1. Account
  const p1 = qPanel(`${a.user} · paper account`, null, [[kill ? "HALTED" : "VERIFIED", kill ? "red" : "green"], [`TOTAL P&L · ${a.total_pnl >= 0 ? "+" : ""}${qFmt(a.total_pnl, 0)}`, "amber"]]);
  const big = qEl("div", "q-bigrow"); const today = a.today_realized + a.unrealized;
  big.append(qEl("div", "q-big", `$${qFmt(a.equity, 0)}`), (() => { const b = qEl("div", "q-delta"); b.append(qEl("span", `q-tag ${today >= 0 ? "green" : "red"}`, `${today >= 0 ? "▲ +" : "▼ "}$${qFmt(Math.abs(today), 0)}`), qEl("span", "q-lbl", `today · ${a.total_pct >= 0 ? "+" : ""}${qFmt(a.total_pct)}% total`)); return b; })());
  const stats = qEl("div", "q-stats"); stats.append(qStat("TRADES", String(o.length || a.trades)), qStat("WIN RATE", all.win_rate == null ? "—" : `${qFmt(all.win_rate, 1)}%`, "green"), qStat("AVG R/R", avgWin && avgLoss ? qFmt(avgWin / avgLoss, 2) : "—"), qStat("SHARPE / TRADE", l.sharpe == null ? "—" : qFmt(l.sharpe, 2), "amber"));
  const eqBox = qEl("div", "q-cv q-eq"); const heatRow = qEl("div", "q-heat");
  heatRow.append(qEl("span", "q-lbl", "DD RISK"), qEl("b", heat >= 7 ? "red" : heat >= 4 ? "amber" : "green", qFmt(heat, 1)), qEl("span", "q-lbl", `/10 · ${qFmt(d.drawdown_pct, 1)}% of ${d.settings.max_drawdown_pct}% limit`), (() => { const bar = qEl("div", "q-heatbar"); const f = qEl("i"); f.style.width = `${heat * 10}%`; bar.append(f); return bar; })(), qEl("span", `q-tag ${kill ? "red" : heat >= 7 ? "amber" : "green"}`, kill ? "HALT" : heat >= 7 ? "WARN" : "SAFE"));
  p1.body.append(big, stats, eqBox, heatRow); grid.append(p1);
  // 2. Chart
  const p2 = qPanel(`${d.symbol}`, `5M · ${lastBar ? qFmt(lastBar.close) : "—"}`, [[chg == null ? "—" : `${chg >= 0 ? "▲" : "▼"} ${qFmt(Math.abs(chg))}%`, chg >= 0 ? "green" : "red"], [d.forecast ? `KRONOS ${Math.round(d.forecast.prob_up * 100)}% UP` : "NO FORECAST", "dim"]]);
  const cbox = qEl("div", "q-chart"); p2.body.append(cbox); grid.append(p2);
  // 3. Plan grid
  const p3 = qPanel("RESOLUTION GRID", "LIVE PLANS", [[`SETTLED ${d.plans.filter((p) => ["win", "loss", "timed"].includes(p.status)).length}`, "amber"], [`OPEN ${d.plans.filter((p) => p.status === "open" || p.status === "pending").length}`, "amber"]]);
  const tiles = qEl("div", "q-tiles");
  for (const p of d.plans) { const t = qEl("div", `q-tile ${p.status}`); t.append(qEl("b", null, p.score == null ? "—" : `${Math.round(p.score)}`), qEl("span", null, p.symbol), qEl("i", null, p.status === "win" || p.status === "loss" || p.status === "timed" ? `${p.r_result >= 0 ? "+" : ""}${qFmt(p.r_result, 1)}R` : p.status.replace("_", " "))); t.title = `${p.symbol} ${p.side} · score ${p.score ?? "—"} · ${p.slot} · ${p.status}`; t.onclick = () => { setSymbol(p.symbol); }; tiles.append(t); }
  if (!d.plans.length) tiles.append(qEl("span", "q-lbl", "no plans in the last 3 days: run a scan"));
  p3.body.append(tiles); grid.append(p3);
  // 4. Survival
  const p4 = qPanel("EXCURSION SURVIVAL", "MFE / MAE", [[`N ${o.length}`, "green"], [`+1R ${o.length ? Math.round((o.filter((t) => (t.mfe ?? 0) >= 1).length / o.length) * 100) : 0}%`, "green"], [`STOPPED ${o.length ? Math.round((o.filter((t) => t.r <= -0.9).length / o.length) * 100) : 0}%`, "red"]]);
  const sv = qEl("div", "q-cv"); p4.body.append(sv); grid.append(p4);
  // (The tape-pressure, range-ridge, coherence and Monte Carlo ruin panels were removed: the desk has no order-flow
  // feed and too few settled trades to feed them, so they drew decoration, not information.)
  // Status line
  const agent = qEl("div", "q-agent"); root.append(agent);
  // 5. Analog
  const an = qAnalogs(bars);
  const p9 = qPanel("ANALOG MATCHER", "K-NN · SEEN THIS BEFORE", [[an ? `DTW ${qFmt(an.paths[0]?.d ?? 0, 3)}` : "—", "amber"], [an ? `SCAN ${an.scanned.toLocaleString()}` : "—", "green"]]);
  const anRow = qEl("div", "q-anrow"), ab = qEl("div", "q-cv q-tall"), side = qEl("div", "q-anside");
  if (an) side.append(qStat("MATCH", qFmt(an.match, 2), "cyan"), qStat("UP", String(an.up), "green"), qStat("DOWN", String(an.down), "red"), qStat("MEDIAN FWD", `${an.median >= 0 ? "+" : ""}${qFmt(an.median, 2)}%`, an.median >= 0 ? "green" : "red"), qStat("HORIZON", `${an.fwd} BARS`));
  anRow.append(ab, side); p9.body.append(anRow); grid.append(p9);
  // 10. Bayes
  const p10 = qPanel("BAYESIAN UPDATE", "P(WIN)", [[`EV ${all.avg_r == null ? "—" : `${all.avg_r >= 0 ? "+" : ""}${qFmt(all.avg_r, 2)}R`}`, "amber"], [`EDGE ${wins + losses ? `${((2 + wins) / (4 + wins + losses) - 0.5) * 100 >= 0 ? "+" : ""}${qFmt(((2 + wins) / (4 + wins + losses) - 0.5) * 100, 1)}pp` : "—"}`, "green"]]);
  const by = qEl("div", "q-cv q-tall"), byFoot = qEl("div", "q-note"); p10.body.append(by, byFoot); grid.append(p10);
  // Footer
  // Portfolio risk: value at risk, expected shortfall and how much the holdings move together.
  const pr = d.portfolio_risk;
  if (pr) {
    const g2 = qEl("div", "q-grid"); root.append(g2);
    const p11 = qPanel("PORTFOLIO RISK", pr.basis === "positions" ? "OPEN PAPER POSITIONS" : "WATCHLIST BASKET · IF HELD EQUALLY", [[`${pr.days}D HISTORY`, "dim"], [`VAR 95 ${qFmt(pr.var95_pct)}%`, pr.var95_pct > 3 ? "red" : pr.var95_pct > 1.5 ? "amber" : "green"]]);
    const st = qEl("div", "q-stats"); st.append(qStat("1-day VaR 95%", `-$${Math.abs(pr.var95_usd).toLocaleString()}`, "red"), qStat("Expected shortfall", `-$${Math.abs(pr.es95_usd).toLocaleString()}`, "red"), qStat("VaR 99%", `-${qFmt(pr.var99_pct)}%`), qStat("Worst day", `-${qFmt(pr.worst_day_pct)}%`),
      qStat("Volatility / yr", `${qFmt(pr.vol_ann_pct, 1)}%`), qStat("Beta", pr.beta == null ? "—" : qFmt(pr.beta)), qStat("Max drawdown", `-${qFmt(pr.max_dd_pct, 1)}%`), qStat("Exposure", `$${pr.exposure_usd.toLocaleString()}`));
    p11.body.append(st, qEl("div", "q-note", `On 19 trading days out of 20 this ${pr.basis === "positions" ? "portfolio" : "basket"} would not have lost more than ${qFmt(pr.var95_pct)}% ($${Math.abs(pr.var95_usd).toLocaleString()}) in a day; on the 20th, the average loss was ${qFmt(pr.es95_pct)}%. Read from the last ${pr.days} days of real prices with today's weights, no model assumed. The next year can be worse.`));
    g2.append(p11);
    const c = pr.corr, p12 = qPanel("CORRELATION", "DO THEY MOVE TOGETHER", [[c.together ? "MOVING TOGETHER" : "NORMAL", c.together ? "red" : "green"]]);
    if (c.symbols.length > 1) {
      const t = qEl("table", "q-corr"); t.setAttribute("aria-label", "Correlation of daily returns between holdings");
      const hr = qEl("tr"); hr.append(qEl("th", null, "")); for (const s of c.symbols) hr.append(qEl("th", null, s.replace("-USD", ""))); t.append(hr);
      c.matrix.forEach((row, i) => { const tr = qEl("tr"); tr.append(qEl("th", null, c.symbols[i].replace("-USD", ""))); row.forEach((v, j) => { const td = qEl("td", null, i === j ? "" : v == null || isNaN(v) ? "—" : v.toFixed(2)); if (i !== j && !isNaN(v)) { td.style.background = v >= 0 ? `rgba(255,59,74,${Math.min(0.75, Math.abs(v) * 0.75)})` : `rgba(46,229,157,${Math.min(0.75, Math.abs(v) * 0.75)})`; td.title = `${c.symbols[i]} and ${c.symbols[j]}: ${v.toFixed(2)}`; } tr.append(td); }); t.append(tr); });
      p12.body.append(t);
    }
    p12.body.append(qEl("div", "q-note", `${c.note} 1.00 = always move together, 0 = unrelated, negative = move opposite. Red pairs give no diversification.`));
    g2.append(p12);
  }
  const foot = qEl("div", "q-foot"); root.append(foot);

  // Draw after layout.
  requestAnimationFrame(() => {
    drawEquity(eqBox, d); drawSurvival(sv, d);
    drawAnalog(ab, an);
    const post = drawBayes(by, wins, losses); byFoot.textContent = `PRIOR 50% → POSTERIOR ${qFmt(post * 100, 1)}% · ${wins} wins / ${losses} losses · break-even at ${avgWin && avgLoss ? qFmt((avgLoss / (avgWin + avgLoss)) * 100, 1) : "—"}%`;
    agent.textContent = `> AGENT scan ${d.symbol}/5m · regime ${rg.regime.replace("_", " ")} · analog ${an ? `${an.up}↑ ${an.down}↓` : "n/a"} · ${rg.why} ▮`;
    for (const [t, cls] of [[kill ? "HUNTER · HALTED" : "HUNTER · ONLINE", kill ? "red" : "amber"], [`REGIME SIZING ${d.settings.regime_sizing ? "ON" : "OFF"}`, ""], [`DRAWDOWN GUARD ${d.settings.max_drawdown_pct > 0 ? "ARMED" : "OFF"}`, d.settings.max_drawdown_pct > 0 ? "green" : "red"], [`ANALOG MATCH ${an ? qFmt(an.match, 2) : "—"}`, ""], [`KELLY 1/4 · CAP 2%`, ""], [`AUTO-TRADE ${d.settings.auto_trade ? "ON" : "OFF"}`, ""], [`REGIME CHECK WRONG ${d.regime_accuracy?.wrong_pct == null ? "—" : `${d.regime_accuracy.wrong_pct}%`}`, ""], [`RISK LOG ${d.risk_log.length}`, ""]]) foot.append(qEl("span", cls, t));
    if (d.risk_log.length) foot.title = d.risk_log.map((x) => `${new Date(x.at * 1000).toLocaleTimeString()} ${x.symbol} ${x.action}: ${x.reason}`).join("\n");
    // Candles
    if (bars.length && window.LightweightCharts) {
      const LW = LightweightCharts, sh = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
      const ch = LW.createChart(cbox, { autoSize: true, layout: { background: { color: QC.panel }, textColor: QC.dim, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10 }, grid: { vertLines: { color: "#10151d" }, horzLines: { color: "#10151d" } }, rightPriceScale: { borderColor: QC.line }, timeScale: { borderColor: QC.line, timeVisible: true, secondsVisible: false } });
      const cs = ch.addCandlestickSeries({ upColor: QC.green, downColor: QC.red, borderVisible: false, wickUpColor: QC.green, wickDownColor: QC.red });
      const vs = ch.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "v", lastValueVisible: false, priceLineVisible: false }); ch.priceScale("v").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      const view = bars.slice(-160); cs.setData(view.map((b) => ({ time: sh(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))); vs.setData(view.map((b) => ({ time: sh(b.time), value: b.volume, color: b.close >= b.open ? "rgba(46,229,157,.5)" : "rgba(255,59,74,.5)" })));
      ch.timeScale().fitContent(); state.quant.chart = ch;
    }
  });
}

document.addEventListener("section", (e) => {
  clearInterval(state.quant.poll);
  if (e.detail === "quant") { loadQuant(); state.quant.poll = setInterval(() => { if (sectionVisible("quant") && !document.hidden) loadQuant(); }, 30000); }
  else { for (const t of state.quant.timers) clearInterval(t); state.quant.timers = []; }
});
let _qResize; addEventListener("resize", () => { clearTimeout(_qResize); _qResize = setTimeout(() => { if ((state.quant.data || state.quant.view === "pairs") && sectionVisible("quant")) renderQuant(); }, 250); });
