"use strict";
/* Deep Analysis section: TradingAgents runs (one ticker, four analysts, bull/bear debate, trader, risk desk,
   portfolio manager) started from here, from a recommendation, or by the autopilot after any brief (score threshold). */

const RATING_CLS = { Buy: "up", Overweight: "up", Hold: "", Underweight: "down", Sell: "down" };
state.deep = { runs: [], ratings: {}, open: null, ready: false };

function ratingBadge(rating, { small = true } = {}) {
  const b = el("span", `rating ${RATING_CLS[rating] || ""}${small ? " small" : ""}`, rating || "—");
  b.title = "TradingAgents portfolio-manager rating (Buy / Overweight / Hold / Underweight / Sell)";
  return b;
}

async function loadDeep() {
  let d;
  try { d = await api("/api/deep"); } catch (e) { $("#deep").innerHTML = ""; $("#deep").append(el("div", "msg err", e.message)); return; }
  state.deep.runs = d.runs; state.deep.ratings = d.ratings || {}; state.deep.ready = d.ready;
  $("#deepNote").textContent = !d.ready ? (d.vault ? "Agent not configured." : "Needs setup: run setup/setup-agent.mjs again to add the sandbox credential (VAULT_ID).")
    : d.deep_min_score ? `Autopilot: every pick scoring ≥ ${d.deep_min_score} after any brief (max ${d.deep_max_per_brief} per brief)` : "On demand";
  state.deep.scorecard = d.scorecard || null;
  renderDeep();
  if (d.runs.some((r) => r.status === "running" || r.status === "starting")) { clearTimeout(state.deep.timer); state.deep.timer = setTimeout(loadDeep, 30000); }
}

function renderDeep() {
  const host = $("#deep"); host.innerHTML = "";
  const intro = el("p", "dim small", "TradingAgents (TauricResearch, MIT) runs four analysts (market, news, fundamentals, sentiment), a bull-vs-bear debate, a trader, a risk desk and a portfolio manager on one ticker, and ends with a 5-tier rating. It is a slower, multi-day second opinion; your trader-* skills stay the intraday desk. A run takes 5-15 minutes and about 15 model calls.");
  host.append(intro);
  // Scorecard: were the ratings right 5, 10 and 20 sessions later? It decides how much weight a Deep Analysis plan gets.
  const sc = state.deep.scorecard;
  if (sc) {
    const box = el("section", "deep-score"); box.append(el("h3", "small", `Scorecard: ${sc.scored} of ${sc.runs} ratings checked so far`));
    const g = el("div", `msg ${sc.gate.mult >= 1 ? "ok" : sc.gate.mult <= 0 ? "err" : "sys"} small`); g.append(el("b", null, sc.gate.mult >= 1 ? "Full size · " : sc.gate.mult <= 0 ? "Not auto-traded · " : "Half size · "), sc.gate.text); box.append(g);
    if (sc.by.length) { const t = el("table", "grid small"); t.setAttribute("aria-label", "Hit rate by rating"); const h = el("tr"); for (const x of ["Rating", "Runs", "Right after 5 sessions", "after 10", "after 20", "Average move after 5"]) h.append(el("th", null, x)); t.append(h);
      const cell = (c) => (c.n ? `${c.hit_pct}% of ${c.n}` : "—");
      for (const r of sc.by) { const tr = el("tr"); tr.append(el("td", null, r.rating), el("td", "num", String(r.runs)), el("td", "num", cell(r.d5)), el("td", "num", cell(r.d10)), el("td", "num", cell(r.d20)), el("td", `num ${r.d5.avg_pct > 0 ? "up" : r.d5.avg_pct < 0 ? "down" : ""}`, r.d5.avg_pct == null ? "—" : `${r.d5.avg_pct > 0 ? "+" : ""}${r.d5.avg_pct}%`)); t.append(tr); }
      const w = el("div", "table-wrap"); w.style.overflowX = "auto"; w.append(t); box.append(w); }
    box.append(el("div", "dim small", `${sc.note} An order from a rating also needs the manager and the trader to agree: "Sell" closes or blocks a long and is a short only when the trader says Short and the manager does not say cash.`));
    host.append(box);
  }
  if (!state.deep.runs.length) { host.append(el("div", "bd-empty", "No deep analyses yet. Type a symbol above and click Run Deep Analysis, or use the Deep Analysis button on a recommendation.")); return; }
  const sec = section(`Runs (${state.deep.runs.length})`);
  sec.append(table(["Symbol", "Date", "Rating", "Conf.", "Trader", "Entry", "Stop", "Targets", "Days", "Status", "Cost", ""], state.deep.runs.flatMap((r) => {
    let extra = null;
    const d = r.data || {}, tr = el("tr", "pick-row"); tr.style.cursor = "pointer";
    const sym = td(r.symbol, "sym"); sym.onclick = (e) => { e.stopPropagation(); setSymbol(r.symbol); navigate("chart"); };
    const rt = el("td"); rt.append(r.status === "done" ? ratingBadge(r.rating) : el("span", `pill ${r.status}`, r.status === "error" ? "error" : "working…"));
    tr.append(sym, td(r.day, "mono small"), rt, td(d.confidence || "—"), td(d.trader_action || "—", d.trader_action === "Buy" ? "up" : d.trader_action === "Sell" ? "down" : ""),
      td(fmt(d.entry), "num"), td(fmt(d.stop), "num down"), td((d.targets || []).map((t) => fmt(t)).join(" / ") || "—", "num up"), td(d.horizon_days ?? "—", "num"),
      td(r.status === "done" ? "done" : r.status, r.status === "error" ? "down" : "dim"), td(r.cost ? formatCost(r.cost) : "—", "num dim"));
    const act = el("td"); if (r.status === "done" && r.rating) { const pt = el("button", "ghost small", /Sell|Underweight/.test(r.rating) ? "Paper Short" : "Paper Buy"); pt.onclick = (e) => { e.stopPropagation(); openTicket({ symbol: r.symbol, side: /Sell|Underweight/.test(r.rating) ? "short" : "long", type: d.entry ? "limit" : "market", price: d.entry, stop: d.stop, target: (d.targets || [])[0], note: `Deep analysis ${r.rating}: ${(d.summary || "").slice(0, 120)}`, exit_mode: "hold" }); }; act.append(pt); }
    tr.append(act);
    tr.onclick = () => openDeepRun(r.id);
    if (r.error) { const er = el("tr"); const c = el("td", "small down"); c.colSpan = 12; c.textContent = r.error; er.append(c); extra = er; }
    return extra ? [tr, extra] : [tr];
  })));
  host.append(sec);
  const det = el("div"); det.id = "deepDetail"; host.append(det);
  if (state.deep.open) openDeepRun(state.deep.open, true);
}

async function openDeepRun(id, keep = false) {
  state.deep.open = id;
  const det = $("#deepDetail"); if (!det) return;
  det.innerHTML = ""; det.append(el("div", "dim small", "Loading report…"));
  let r;
  try { r = await api(`/api/deep/${id}`); } catch (e) { det.innerHTML = ""; det.append(el("div", "msg err", e.message)); return; }
  det.innerHTML = "";
  const d = r.data || {};
  const head = el("div", "bd-head"); head.append(el("h2", null, `${r.symbol} · ${r.day}`), ratingBadge(r.rating, { small: false }));
  if (d.confidence) head.append(el("span", "dim small", `${d.confidence} confidence`));
  if (r.cost) head.append(el("span", "dim small", formatCost(r.cost)));
  const close = el("button", "ghost small", "Close"); close.style.marginLeft = "auto"; close.onclick = () => { state.deep.open = null; det.innerHTML = ""; }; head.append(close);
  det.append(head);
  if (d.summary) det.append(el("p", "bd-summary", d.summary));
  const grid = el("div", "bd-grid");
  const bull = section("Bull case"), bear = section("Bear case");
  bull.append(el("p", "small", d.bull_case || "—")); bear.append(el("p", "small", d.bear_case || "—")); grid.append(bull, bear); det.append(grid);
  const plan = section("Trader's plan");
  const kv = (k, v) => { if (v == null || v === "" || (Array.isArray(v) && !v.length)) return; const x = el("div", "small"); x.append(el("span", "dim", `${k}: `), document.createTextNode(Array.isArray(v) ? v.map((t) => (typeof t === "number" ? fmt(t) : t)).join(" · ") : typeof v === "number" ? fmt(v) : String(v))); plan.append(x); };
  kv("Trader", d.trader_action); kv("Entry", d.entry); kv("Stop", d.stop); kv("Targets", d.targets); kv("Horizon (sessions)", d.horizon_days); kv("Risks", d.risks); kv("Analysts", d.analysts_run);
  det.append(plan);
  if (r.content) { const full = el("details", "bd-sec"); const sm = el("summary", null, "Full report (every agent's section)"); const body = el("div", "md small"); body.innerHTML = md(r.content); full.append(sm, body); det.append(full); }
  if (!keep) det.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function runDeep(symbol) {
  symbol = String(symbol || "").trim().toUpperCase(); if (!symbol) return;
  try { await api("/api/deep/run", { method: "POST", body: JSON.stringify({ symbol }) }); navigate("deep"); loadDeep(); }
  catch (e) { showBanner(e.message); }
}
$("#deepForm").onsubmit = (e) => { e.preventDefault(); runDeep($("#deepSym").value); $("#deepSym").value = ""; };
document.addEventListener("section", (e) => { if (e.detail === "deep") loadDeep(); });
// Ratings for badges elsewhere (board, watchlist), refreshed every few minutes.
async function loadRatings() { try { state.deep.ratings = await api("/api/ratings"); } catch { /* later */ } }
loadRatings(); setInterval(loadRatings, 180000);
