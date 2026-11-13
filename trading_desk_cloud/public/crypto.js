"use strict";
/* Crypto desk: a per-user list of pairs (Yahoo notation, e.g. BTC-USD) handled like the Monitor (grid layout, bar
   size, signals, pop-out windows), with Kronos forecasts, the Crypto scan, 24/7 paper trading, the chart autopilot
   and a link to the FOMO app, plus its own Dashboard view (crypto P&L, movers, forecasts, scan picks, outcomes).
   FOMO is a mobile, self-custodial app without a public API: the desk analyses, the trade is tapped in FOMO. */

state.crypto = { watchlist: [], quotes: {}, forecasts: {}, positions: [], auto: {}, charts: [], fomo: "https://fomo.family/", view: "desk", dash: null };

async function loadCrypto() {
  let d;
  try { d = await api("/api/crypto"); } catch (e) { $("#crypto").innerHTML = ""; $("#crypto").append(el("div", "msg err", e.message)); return; }
  state.crypto.watchlist = d.watchlist; state.crypto.quotes = Object.fromEntries((d.quotes || []).map((q) => [q.symbol, q])); state.crypto.forecasts = d.forecasts || {};
  state.crypto.positions = d.positions || []; state.crypto.auto = d.auto || {}; state.crypto.fomo = d.fomo_link || state.crypto.fomo;
  $("#fomoLink").href = state.crypto.fomo || "https://fomo.family/";
  if (state.crypto.view === "dash") { try { state.crypto.dash = await api("/api/crypto/dashboard"); } catch (e) { showBanner(e.message); } }
  renderCrypto();
}

function disposeCryptoCharts() { for (const c of state.crypto.charts) c.mc.dispose(); state.crypto.charts = []; }

function renderCrypto() {
  const host = $("#crypto");
  if (state.crypto.view === "dash") { disposeCryptoCharts(); renderCryptoDashboard(host); return; }
  const cols = +$("#cryptoLayout").value || 2;
  const same = state.crypto.charts.length && state.crypto.charts.every((c, i) => c.symbol === state.crypto.watchlist[i]) && state.crypto.charts.length === state.crypto.watchlist.length && host.querySelector(".cr-grid");
  if (!same) {
    disposeCryptoCharts(); host.innerHTML = "";
    host.append(el("p", "dim small", "Crypto trades around the clock: paper orders fill at any hour (fractions allowed), positions are held to the stop or target, the chart autopilot watches these pairs at weekends too, and the Crypto scan can run every day. Prices and candles from Yahoo Finance (CCC)."));
    if (!state.crypto.watchlist.length) { host.append(el("div", "bd-empty", "Add a pair above (for example BTC-USD, ETH-USD, SOL-USD).")); return; }
    const grid = el("div", "cr-grid"); host.append(grid);
    for (const sym of state.crypto.watchlist) {
      const tile = el("div", "cr-tile"), head = el("div", "cr-head"), box = el("div", "cr-chart"), fcl = el("div", "cr-fc dim"), foot = el("div", "cr-foot");
      const name = el("b", "sym", sym); name.style.cursor = "pointer"; name.title = "Open on the main chart"; name.onclick = () => { setSymbol(sym); navigate("chart"); };
      const px = el("span", "mono", "—"), chg = el("span", "mono small", "");
      const pop = el("button", "icon-btn"); pop.innerHTML = icon("popout"); pop.title = `Open ${sym} in its own window`; pop.setAttribute("aria-label", `Open ${sym} in its own window`); pop.onclick = () => openChartWindow(sym);
      const rm = el("button", "icon-btn"); rm.innerHTML = icon("x"); rm.title = `Remove ${sym}`; rm.setAttribute("aria-label", `Remove ${sym}`); rm.onclick = () => saveCryptoList(state.crypto.watchlist.filter((x) => x !== sym));
      head.append(name, px, chg, el("span", "spacer"), pop, rm);
      const pl = el("div", "mon-plan dim tiny");
      const kr = el("button", "ghost small", "Kronos"); kr.title = "Forecast this pair"; kr.onclick = () => runKronos(sym, $("#cryptoInterval").value === "5m" ? "15m" : $("#cryptoInterval").value, null);
      const dp = el("button", "ghost small", "Deep"); dp.title = "Deep Analysis (TradingAgents) on this pair"; dp.onclick = () => runDeep(sym);
      const buy = el("button", "ghost small", "Paper Buy"); buy.onclick = () => openTicket({ symbol: sym, exit_mode: "hold" });
      const autoCtl = createAutoControl(() => sym, { compact: true });
      const fomo = el("a", "ghost small btn-link", "FOMO"); fomo.href = state.crypto.fomo || "https://fomo.family/"; fomo.target = "_blank"; fomo.rel = "noopener"; fomo.title = "Open the FOMO app (manual execution; no public API)";
      foot.append(kr, dp, buy, autoCtl, fomo);
      tile.append(head, box, fcl, pl, foot); grid.append(tile);
      const iv = $("#cryptoInterval").value;
      const mc = createMiniChart(box, { symbol: sym, interval: iv, range: iv === "1d" ? "1Y" : iv === "5m" ? "1D" : "5D", fontSize: 10, signals: $("#cryptoSignals").checked,
        onQuote: ({ last }) => { px.textContent = fmt(last); },
        onPlanStatus: (text, cls) => { pl.textContent = text; pl.className = `mon-plan tiny ${cls || ""}`; },
        onPlanEvent: (ev) => { pl.textContent = ev.text; pl.className = `mon-plan tiny ${ev.kind === "entry" ? "accent" : ev.kind === "target" ? "up" : "down"}`; if (state.sigNotify) notifyPlanEvent(ev); } });
      state.crypto.charts.push({ symbol: sym, mc, px, chg, fcl, autoCtl });
    }
  }
  const grid = host.querySelector(".cr-grid"); if (grid) grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  for (const c of state.crypto.charts) {
    const q = state.crypto.quotes[c.symbol];
    if (q && q.last != null) c.px.textContent = fmt(q.last);
    if (q && q.change_pct != null) { c.chg.textContent = `${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct)}%`; c.chg.className = `mono small ${q.change_pct > 0 ? "up" : q.change_pct < 0 ? "down" : ""}`; }
    const f = state.crypto.forecasts[c.symbol];
    c.fcl.textContent = f ? forecastText(f) : "No Kronos forecast yet.";
    c.fcl.className = `cr-fc ${f ? (f.prob_up >= 0.6 ? "up" : f.prob_up <= 0.4 ? "down" : "") : "dim"}`;
    if (f && f.id && c.fcId !== f.id) { c.fcId = f.id; api(`/api/kronos/${f.id}`).then((r) => { if (r.data) c.mc.setForecast(r.data); }).catch(() => {}); }
    c.autoCtl.refresh?.();
  }
}

/** The crypto-only dashboard: P&L of crypto paper trades, movers, forecasts and their track record, the latest scan. */
function renderCryptoDashboard(host) {
  host.innerHTML = "";
  const d = state.crypto.dash; if (!d) { host.append(el("div", "dim", "Loading…")); return; }
  const cards = el("div", "bd-indices dash-kpis");
  const total = d.realized + d.unrealized;
  cards.append(stat("Crypto P&L", money(total), pnlCls(total), `${money(d.realized)} closed · ${money(d.unrealized)} open`),
    stat("Open positions", String(d.positions.length), "", d.positions.map((p) => p.symbol).join(", ") || "none"),
    stat("Win rate", d.closed ? `${fmt((d.wins / d.closed) * 100, 0)}%` : "—", "", `${d.closed} closed trades`),
    stat("Autopilots", String(d.auto.filter((a) => a.enabled).length), "", d.auto.filter((a) => a.enabled).map((a) => a.symbol).join(", ") || "none on"),
    stat("Kronos hit rate", d.forecast_score.hit_rate == null ? "—" : `${fmt(d.forecast_score.hit_rate, 0)}%`, (d.forecast_score.hit_rate ?? 0) > 55 ? "up" : "", `${d.forecast_score.n} forecasts scored`),
    stat("Last scan", d.scan ? d.scan.day : "—", "", d.scan?.market?.regime ? `regime ${d.scan.market.regime}` : "run Scan for a market view"));
  host.append(cards);
  const grid = el("div", "bd-grid");
  // Movers on the list
  const mv = section("Pairs (24h)"); const qs = Object.values(state.crypto.quotes).filter((q) => q.last != null).sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
  mv.append(qs.length ? table(["Pair", "Last", "24h", "Kronos", "Plan"], qs.map((q) => { const tr = el("tr"); const f = d.forecasts[q.symbol]; const s = td(q.symbol, "sym"); s.style.cursor = "pointer"; s.onclick = () => { setSymbol(q.symbol); navigate("chart"); };
    tr.append(s, liveTag(td(fmt(q.last), "num"), q.symbol), td(q.change_pct == null ? "—" : `${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct)}%`, `num ${pnlCls(q.change_pct)}`), td(f ? `${Math.round(f.prob_up * 100)}% up · ${f.exp_move_pct >= 0 ? "+" : ""}${fmt(f.exp_move_pct)}%` : "—", f ? (f.prob_up >= 0.6 ? "up" : f.prob_up <= 0.4 ? "down" : "") : "dim"),
      td((d.scan?.picks || []).find((p) => p.symbol === q.symbol) ? `${(d.scan.picks.find((p) => p.symbol === q.symbol)).bias} · score ${(d.scan.picks.find((p) => p.symbol === q.symbol)).score}` : "—", "small")); return tr; })) : el("div", "dim small", "No quotes yet."));
  grid.append(mv);
  // Crypto equity
  const eq = section("Crypto paper P&L by trade");
  eq.append(d.curve.length >= 2 ? equityChart([{ day: "start", equity: 0 }, ...d.curve]) : el("div", "dim small", "Appears after two closed crypto trades."));
  grid.append(eq);
  host.append(grid);
  // Scan picks
  const sc = section(d.scan ? `Crypto scan · ${d.scan.day}` : "Crypto scan", el("span", "dim small", d.scan?.market?.summary ? `  ${d.scan.market.summary}` : "  the daily crypto scan plans the best pairs (Scan button)"));
  if (d.scan && d.scan.picks.length) sc.append(picksTable(d.scan.picks, { time: Math.floor(Date.parse(String(d.scan.created_at).replace(" ", "T") + "Z") / 1000) }));
  else sc.append(el("div", "dim small", "No crypto scan yet. Click Scan, or turn on the Crypto scan routine in Briefs & Autopilot (08:30 New York, every day)."));
  host.append(sc);
  // Outcomes of crypto plans
  if (d.outcomes.length) {
    const oc = section("Crypto plan outcomes (walk-forward)");
    oc.append(table(["Day", "Pair", "Side", "Score", "Result", "R"], d.outcomes.slice(0, 20).map((o) => { const tr = el("tr"); const cls = o.status === "win" ? "up" : o.status === "loss" ? "down" : "dim"; tr.append(td(o.day, "mono small"), td(o.symbol, "sym"), td(o.side, o.side === "long" ? "up" : "down"), td(o.score ?? "—", "num"), td(o.status.replace("_", " "), cls), td(o.r_result == null ? "—" : fmtR(o.r_result), `num ${cls}`)); return tr; })));
    host.append(oc);
  }
}

async function saveCryptoList(list) {
  try { const r = await api("/api/crypto/watchlist", { method: "PUT", body: JSON.stringify({ watchlist: list }) }); state.crypto.watchlist = r.watchlist; await loadCrypto(); }
  catch (e) { showBanner(e.message); }
}
$("#cryptoAdd").onsubmit = (e) => {
  e.preventDefault();
  let v = $("#cryptoSym").value.trim().toUpperCase(); if (!v) return;
  if (!/-(USD|USDT|USDC|EUR|BTC|ETH)$/.test(v)) v += "-USD";
  $("#cryptoSym").value = "";
  if (!state.crypto.watchlist.includes(v)) saveCryptoList([...state.crypto.watchlist, v]);
};
$$("#cryptoView button").forEach((b) => (b.onclick = () => { $$("#cryptoView button").forEach((x) => x.classList.toggle("on", x === b)); state.crypto.view = b.dataset.v; loadCrypto(); }));
$("#cryptoInterval").onchange = () => { disposeCryptoCharts(); renderCrypto(); };
$("#cryptoLayout").onchange = () => renderCrypto();
$("#cryptoSignals").onchange = (e) => { for (const c of state.crypto.charts) c.mc.setSignals(e.target.checked); };
$("#cryptoPopAll").onclick = () => { state.crypto.watchlist.forEach((sym, i) => openChartWindow(sym, { index: i })); };
$("#cryptoScan").onclick = async () => { const b = $("#cryptoScan"); b.disabled = true; try { await api("/api/briefs/run", { method: "POST", body: JSON.stringify({ slot: "cryptoscan" }) }); showBanner("Crypto scan started: results appear under Briefs and on the crypto Dashboard in a few minutes."); } catch (e) { showBanner(e.message); } b.disabled = false; };
$("#cryptoForecastAll").onclick = async () => {
  const b = $("#cryptoForecastAll"); b.disabled = true;
  try { const r = await api("/api/crypto/forecast", { method: "POST", body: JSON.stringify({ interval: $("#cryptoInterval").value === "5m" ? "15m" : $("#cryptoInterval").value }) }); const errs = Object.entries(r).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`); if (errs.length) showBanner(errs.join(" · ")); else showBanner(`Kronos is forecasting ${Object.keys(r).length} pairs; results appear here and under Kronos in a few minutes.`); }
  catch (e) { showBanner(e.message); }
  b.disabled = false;
};
document.addEventListener("section", (e) => {
  if (e.detail === "crypto") { loadCrypto(); clearInterval(state.crypto.timer); state.crypto.timer = setInterval(() => { if (sectionVisible("crypto") && !document.hidden) loadCrypto(); }, 30000); }
  else if (state.crypto.charts.length && !sectionVisible("crypto")) { disposeCryptoCharts(); clearInterval(state.crypto.timer); }
});
