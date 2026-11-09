"use strict";
/* Kronos: probabilistic candlestick forecasts from the open-source foundation model (shiyu-coder/Kronos, AAAI 2026),
   run in the agent's sandbox. A run samples futures from the last ~400 bars and returns the mean path with a 10-90%
   band, the chance of closing higher and the expected move. Forecasts overlay the charts and feed the scans. */

state.kronos = { runs: [], latest: {}, ready: false };

async function loadKronos() {
  let d;
  try { d = await api("/api/kronos"); } catch (e) { $("#kronos").innerHTML = ""; $("#kronos").append(el("div", "msg err", e.message)); return; }
  state.kronos.runs = d.runs; state.kronos.latest = d.latest || {}; state.kronos.ready = d.ready;
  $("#kronosNote").textContent = d.ready ? (d.kronos_gate ? "Gate on: the chart autopilot skips signals that disagree with a fresh forecast" : "") : "Agent not configured.";
  renderKronos();
  if (d.runs.some((r) => r.status === "running" || r.status === "starting")) { clearTimeout(state.kronos.timer); state.kronos.timer = setTimeout(loadKronos, 30000); }
}

function probCell(p) {
  const td = el("td", "num"); if (p == null) { td.textContent = "—"; return td; }
  const pct = Math.round(p * 100); const s = el("span", `kr-prob ${pct >= 60 ? "up" : pct <= 40 ? "down" : ""}`, `${pct}%`); td.append(s); return td;
}

function renderKronos() {
  const host = $("#kronos"); host.innerHTML = "";
  host.append(el("p", "dim small", "Kronos is a decoder-only transformer pre-trained on 12 billion candlesticks from 45 exchanges (MIT licence). It tokenizes OHLCV bars and samples what the next bars could look like. Each run here draws several futures: the dashed line on the chart is their mean, the dotted lines the 10-90% band, and \"up\" is the share of futures that end above the last close. It knows nothing about news or levels, so the desk mixes it in as one more opinion: scans and Deep Analysis read the latest forecasts, and the chart autopilot can be gated by them (Admin Settings)."));
  if (!state.kronos.runs.length) { host.append(el("div", "bd-empty", "No forecasts yet. Type a symbol above (stocks or crypto such as BTC-USD) and click Forecast. The first run in a fresh sandbox also installs torch and downloads the weights (several minutes); later runs take about a minute.")); return; }
  const sec = section(`Forecasts (${state.kronos.runs.length})`, el("span", "dim small", "  click a row to show it on the chart"));
  sec.append(table(["Symbol", "Bars", "Ahead", "Up", "Expected", "Band", "Max up", "Max down", "Status", "Cost", "When", ""], state.kronos.runs.map((r) => {
    const d = r.data || {}, tr = el("tr", "pick-row"); tr.style.cursor = "pointer";
    const h = d.step_sec ? (d.pred_len * d.step_sec) / 3600 : null, hz = h == null ? `${r.pred_len} bars` : h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`;
    const sym = td(r.symbol, "sym");
    tr.append(sym, td(r.interval, "mono"), td(hz), probCell(d.prob_up), td(d.exp_move_pct == null ? "—" : `${d.exp_move_pct >= 0 ? "+" : ""}${fmt(d.exp_move_pct)}%`, `num ${d.exp_move_pct > 0 ? "up" : d.exp_move_pct < 0 ? "down" : ""}`),
      td(d.band_pct == null ? "—" : `${fmt(d.band_pct)}%`, "num dim"), td(d.max_up_pct == null ? "—" : `+${fmt(d.max_up_pct)}%`, "num up"), td(d.max_down_pct == null ? "—" : `${fmt(d.max_down_pct)}%`, "num down"),
      td(r.status === "done" ? "done" : r.status === "error" ? "error" : "working…", r.status === "error" ? "down" : r.status === "done" ? "dim" : ""), td(r.cost ? formatCost(r.cost) : "—", "num dim"),
      td(new Date(String(r.created_at).replace(" ", "T") + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), "dim small"));
    const act = el("td");
    if (r.status === "done") { const b = el("button", "ghost small", "Show on Chart"); b.onclick = (e) => { e.stopPropagation(); showKronos(r); }; act.append(b); }
    tr.append(act);
    tr.onclick = () => { if (r.status === "done") showKronos(r); };
    if (r.error) { const er = el("tr"); const c = el("td", "small down"); c.colSpan = 12; c.textContent = r.error; tr.after(er); er.append(c); }
    return tr;
  })));
  host.append(sec);
}

/** Put a finished forecast on the main chart (switching the symbol and bar size to match). */
function showKronos(r) {
  const fc = r.data; if (!fc) return;
  const iv = fc.interval === "1h" ? "60m" : fc.interval;
  if (RANGES && INTERVAL_SEC[iv]) { state.interval = iv; state.range = iv === "1d" ? "1Y" : iv === "60m" ? "1M" : "5D"; if (!RANGES[state.range].allow.includes(iv)) state.range = Object.keys(RANGES).find((k) => RANGES[k].allow.includes(iv)) || state.range; syncRangeButtons(); }
  if (state.symbol !== r.symbol) setSymbol(r.symbol); else { state.candles = []; loadChart(); }
  showForecastOnMain(fc); navigate("chart");
  const p = $("#planBar"); p.textContent = forecastText(fc); p.className = "plan-bar small accent";
}

async function runKronos(symbol, interval, pred) {
  symbol = String(symbol || "").trim().toUpperCase(); if (!symbol) return;
  try { await api("/api/kronos/run", { method: "POST", body: JSON.stringify({ symbol, interval, pred: pred || null }) }); navigate("kronos"); loadKronos(); }
  catch (e) { showBanner(e.message); }
}
$("#kronosForm").onsubmit = (e) => { e.preventDefault(); runKronos($("#krSym").value || state.symbol, $("#krInterval").value, +$("#krPred").value || null); $("#krSym").value = ""; };
document.addEventListener("section", (e) => { if (e.detail === "kronos") loadKronos(); });
