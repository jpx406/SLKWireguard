"use strict";
/* Crypto desk: a per-user list of pairs (Yahoo notation, e.g. BTC-USD), live charts with candle signals and the plan
   monitor, Kronos forecasts, 24/7 paper trading and the chart autopilot, and a link to the FOMO app. FOMO is a
   mobile, self-custodial trading app without a public API, so execution there stays manual: the desk does the
   analysis, FOMO does the trade. Nothing here can move real money. */

state.crypto = { watchlist: [], quotes: {}, forecasts: {}, positions: [], auto: {}, charts: [], fomo: "https://fomo.family/" };

async function loadCrypto() {
  let d;
  try { d = await api("/api/crypto"); } catch (e) { $("#crypto").innerHTML = ""; $("#crypto").append(el("div", "msg err", e.message)); return; }
  state.crypto.watchlist = d.watchlist; state.crypto.quotes = Object.fromEntries((d.quotes || []).map((q) => [q.symbol, q])); state.crypto.forecasts = d.forecasts || {};
  state.crypto.positions = d.positions || []; state.crypto.auto = d.auto || {}; state.crypto.fomo = d.fomo_link || state.crypto.fomo;
  $("#fomoLink").href = state.crypto.fomo || "https://fomo.family/";
  renderCrypto();
}

function renderCrypto() {
  const host = $("#crypto");
  // Rebuild only when the list changed; otherwise refresh the headers in place (charts keep running).
  const same = state.crypto.charts.length && state.crypto.charts.every((c, i) => c.symbol === state.crypto.watchlist[i]) && state.crypto.charts.length === state.crypto.watchlist.length;
  if (!same) {
    for (const c of state.crypto.charts) c.mc.dispose(); state.crypto.charts = []; host.innerHTML = "";
    host.append(el("p", "dim small", "Crypto trades around the clock: paper orders fill at any hour, positions are held to the stop or target (no end-of-day close), and the chart autopilot watches these pairs at weekends too. Prices and candles come from Yahoo Finance (CCC). Kronos was trained on crypto K-lines among others; Forecast All runs it on every pair."));
    if (!state.crypto.watchlist.length) { host.append(el("div", "bd-empty", "Add a pair above (for example BTC-USD, ETH-USD, SOL-USD).")); return; }
    const grid = el("div", "cr-grid"); host.append(grid);
    for (const sym of state.crypto.watchlist) {
      const tile = el("div", "cr-tile"), head = el("div", "cr-head"), box = el("div", "cr-chart"), fcl = el("div", "cr-fc dim"), foot = el("div", "cr-foot");
      const name = el("b", "sym", sym); name.style.cursor = "pointer"; name.title = "Open on the main chart"; name.onclick = () => { setSymbol(sym); navigate("chart"); };
      const px = el("span", "mono", "—"), chg = el("span", "mono small", ""), rm = el("button", "icon-btn"); rm.innerHTML = icon("x"); rm.title = `Remove ${sym}`; rm.setAttribute("aria-label", `Remove ${sym}`);
      rm.onclick = () => saveCryptoList(state.crypto.watchlist.filter((x) => x !== sym));
      head.append(name, px, chg, el("span", "spacer"), rm);
      const pl = el("div", "mon-plan dim tiny");
      const kr = el("button", "ghost small", "Kronos"); kr.title = "Forecast this pair"; kr.onclick = () => runKronos(sym, $("#cryptoInterval").value, null);
      const buy = el("button", "ghost small", "Paper Buy"); buy.onclick = () => openTicket({ symbol: sym, exit_mode: "hold" });
      const autoCtl = createAutoControl(() => sym, { compact: true });
      const fomo = el("a", "ghost small btn-link", "FOMO"); fomo.href = state.crypto.fomo || "https://fomo.family/"; fomo.target = "_blank"; fomo.rel = "noopener"; fomo.title = "Open the FOMO app (manual execution; no public API)";
      foot.append(kr, buy, autoCtl, fomo);
      tile.append(head, box, fcl, pl, foot); grid.append(tile);
      const mc = createMiniChart(box, { symbol: sym, interval: $("#cryptoInterval").value, range: $("#cryptoInterval").value === "1d" ? "1Y" : "5D", fontSize: 10, signals: true,
        onQuote: ({ last }) => { px.textContent = fmt(last); },
        onPlanStatus: (text, cls) => { pl.textContent = text; pl.className = `mon-plan tiny ${cls || ""}`; },
        onPlanEvent: (ev) => { pl.textContent = ev.text; pl.className = `mon-plan tiny ${ev.kind === "entry" ? "accent" : ev.kind === "target" ? "up" : "down"}`; if (state.sigNotify) notifyPlanEvent(ev); } });
      state.crypto.charts.push({ symbol: sym, mc, px, chg, fcl, autoCtl });
    }
  }
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
$("#cryptoInterval").onchange = () => { for (const c of state.crypto.charts) c.mc.dispose(); state.crypto.charts = []; renderCrypto(); };
$("#cryptoForecastAll").onclick = async () => {
  const b = $("#cryptoForecastAll"); b.disabled = true;
  try { const r = await api("/api/crypto/forecast", { method: "POST", body: JSON.stringify({ interval: $("#cryptoInterval").value }) }); const errs = Object.entries(r).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`); if (errs.length) showBanner(errs.join(" · ")); else showBanner(`Kronos is forecasting ${Object.keys(r).length} pairs; results appear here and under Kronos in a few minutes.`); }
  catch (e) { showBanner(e.message); }
  b.disabled = false;
};
document.addEventListener("section", (e) => {
  if (e.detail === "crypto") { loadCrypto(); clearInterval(state.crypto.timer); state.crypto.timer = setInterval(() => { if (sectionVisible("crypto")) loadCrypto(); }, 60000); }
  else if (state.crypto.charts.length && !sectionVisible("crypto")) { for (const c of state.crypto.charts) c.mc.dispose(); state.crypto.charts = []; clearInterval(state.crypto.timer); }
});
