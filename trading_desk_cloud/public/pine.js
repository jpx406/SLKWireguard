"use strict";
/* Pine runner (inside TV Strategies): runs Pine Script on the desk's own bars, in the browser.
   The engine is PineTS (LuxAlgo, AGPL-3.0). It runs inside /tv/pine-sandbox.html, an iframe with no access to the
   desk (no cookies, no storage, no network): this page only sends it bars and a script, and draws what comes back. */

state.pine = { frame: null, ready: null, seq: 0, wait: new Map(), res: null, err: null, busy: false, charts: [], source: "", name: "" };
const PINE_TF = { "5m": "5", "15m": "15", "60m": "60", "1d": "D" }, PINE_STEP = { "5m": 300, "15m": 900, "60m": 3600, "1d": 86400 };
const PINE_SAMPLES = [["01_rsi.pine", "RSI with bands (indicator)"], ["02_supertrend.pine", "Supertrend (indicator, signals)"], ["03_ma_strategy.pine", "MA Cross (strategy)"], ["04_bb_squeeze.pine", "Squeeze Momentum (indicator)"], ["05_var_pivots.pine", "Pivot levels (indicator)"], ["06_strategy_stops.pine", "RSI mean reversion with stops (strategy)"], ["07_arrays_loop.pine", "Rolling z-score (indicator)"]];
const PINE_PALETTE = ["#2962FF", "#FF6D00", "#00897B", "#D81B60", "#8E24AA", "#6D4C41", "#43A047", "#F9A825"];
const pineColor = (c, i) => (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c || "") || /^rgba?\([\d\s.,%]+\)$/i.test(c || "") ? c : PINE_PALETTE[i % PINE_PALETTE.length]);

function pineFrame() {
  const P = state.pine; if (P.ready) return P.ready;
  P.ready = new Promise((resolve, reject) => {
    const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("aria-hidden", "true"); f.tabIndex = -1; f.title = "Pine sandbox"; f.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    const t = setTimeout(() => reject(new Error("The Pine sandbox did not start.")), 15000);
    window.addEventListener("message", (e) => {
      if (e.source !== f.contentWindow || !e.data) return;
      if (e.data.type === "ready") { clearTimeout(t); resolve(f); }
      if (e.data.type === "result") { const w = P.wait.get(e.data.id); if (w) { P.wait.delete(e.data.id); w(e.data); } }
    });
    f.src = "/tv/pine-sandbox.html"; document.body.append(f); P.frame = f;
  });
  P.ready.catch(() => { P.ready = null; });
  return P.ready;
}
/** Run a script in the sandbox; a script still running after 25 seconds is stopped. */
async function pineExec(source, candles, symbol, interval) {
  const P = state.pine, f = await pineFrame(), id = ++P.seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { P.wait.delete(id); f.contentWindow.postMessage({ type: "stop" }, "*"); resolve({ ok: false, error: "Stopped: the script was still running after 25 seconds." }); }, 25000);
    P.wait.set(id, (d) => { clearTimeout(timer); resolve(d); });
    f.contentWindow.postMessage({ type: "run", id, source, candles, symbol, timeframe: PINE_TF[interval] || "D" }, "*");
  });
}

async function pineRun() {
  const P = state.pine, S = state.strat, src = $("#pineSrc").value;
  if (!src.trim()) { P.err = "Paste a Pine script, pick an example, or open one from Scripts."; P.res = null; pineRender(); return; }
  P.busy = true; P.err = null; pineRender();
  try {
    P.source = src; try { localStorage.setItem("td.pine.src", src.slice(0, 200000)); localStorage.setItem("td.pine.name", P.name || ""); } catch { /* storage may be off */ }
    if (!S.symbol) S.symbol = state.symbol || "SPY";
    const raw = await api(`/api/candles/${encodeURIComponent(S.symbol)}?interval=${S.interval}&days=${ST_DAYS[S.interval]}`), step = PINE_STEP[S.interval], now = Date.now() / 1000;
    const seen = new Set(), bars = raw.filter((b) => b.open != null && !seen.has(b.time) && seen.add(b.time) && now >= b.time + step).slice(-3000); // finished bars only
    if (bars.length < 50) throw new Error(`Not enough ${S.interval} bars for ${S.symbol}.`);
    const r = await pineExec(src, bars.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, openTime: b.time * 1000, closeTime: (b.time + step) * 1000 - 1 })), S.symbol, S.interval);
    if (!r.ok) throw new Error(r.error);
    P.res = { ...r.result, candles: bars, symbol: S.symbol, interval: S.interval };
  } catch (e) { P.err = e.message; P.res = null; }
  P.busy = false; pineRender();
}

function pineDispose() { for (const c of state.pine.charts) { try { c.remove(); } catch { /* gone */ } } state.pine.charts = []; }
function pineCharts(top, bottom, r) {
  pineDispose(); if (!window.LightweightCharts) return;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), LW = LightweightCharts, times = r.candles.map((b) => b.time);
  const base = { autoSize: true, layout: { background: { color: "transparent" }, textColor: css("--dim"), fontSize: 11 }, grid: { vertLines: { color: css("--grid") || css("--line") }, horzLines: { color: css("--grid") || css("--line") } }, rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: r.interval !== "1d", secondsVisible: false }, crosshair: { mode: 0 } };
  const main = LW.createChart(top, base); state.pine.charts.push(main);
  const cs = main.addCandlestickSeries({ upColor: css("--up"), downColor: css("--down"), borderVisible: false, wickUpColor: css("--up"), wickDownColor: css("--down") });
  cs.setData(r.candles.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  // A plot belongs on the price chart when its values live in the price range; otherwise it gets the lower pane.
  const lo = Math.min(...r.candles.map((b) => b.low)) * 0.5, hi = Math.max(...r.candles.map((b) => b.high)) * 1.5, marks = [], lower = [];
  r.plots.forEach((p, i) => {
    const col = pineColor(p.color, i);
    if (p.boolean || /shape|char|arrow/.test(p.style)) { // plotshape / plotchar: a marker on each bar where it is true
      const up = !/above/i.test(p.location) && !/down/i.test(p.shape);
      p.values.forEach((v, k) => { if (v) marks.push({ time: times[k], position: /above/i.test(p.location) ? "aboveBar" : "belowBar", color: col, shape: /down/i.test(p.shape) ? "arrowDown" : /up/i.test(p.shape) ? "arrowUp" : "circle", text: p.title.slice(0, 12), _up: up }); });
      return;
    }
    const vals = p.values.filter((v) => v !== null); if (!vals.length) return;
    const sorted = vals.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    if (med >= lo && med <= hi) { const s = main.addLineSeries({ color: col, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: p.title.slice(0, 18) }); s.setData(p.values.map((v, k) => (v === null ? { time: times[k] } : { time: times[k], value: v }))); }
    else lower.push({ p, col });
  });
  if (r.strategy) for (const t of [...r.strategy.closed, ...r.strategy.open]) {
    const long = t.side === "long"; if (times.includes(t.entry_time)) marks.push({ time: t.entry_time, position: long ? "belowBar" : "aboveBar", color: css(long ? "--up" : "--down"), shape: long ? "arrowUp" : "arrowDown", text: long ? "Long" : "Short" });
    if (t.exit_time && times.includes(t.exit_time)) marks.push({ time: t.exit_time, position: long ? "aboveBar" : "belowBar", color: css("--dim"), shape: "circle", text: "exit" });
  }
  cs.setMarkers(marks.sort((a, b) => a.time - b.time).slice(-600).map(({ _up, ...m }) => m));
  const n = r.candles.length, range = n > 320 ? { from: n - 320, to: n + 4 } : null; if (range) main.timeScale().setVisibleLogicalRange(range);
  if (!lower.length) { bottom.classList.add("hidden"); return; }
  bottom.classList.remove("hidden");
  const sub = LW.createChart(bottom, base); state.pine.charts.push(sub);
  for (const { p, col } of lower.slice(0, 8)) {
    const hist = /hist|column/.test(p.style), s = hist ? sub.addHistogramSeries({ color: col, priceLineVisible: false, lastValueVisible: false, title: p.title.slice(0, 18) }) : sub.addLineSeries({ color: col, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: p.title.slice(0, 18) });
    s.setData(p.values.map((v, k) => (v === null ? { time: times[k] } : hist ? { time: times[k], value: v, color: pineColor(p.colors[k] || p.color, 0) } : { time: times[k], value: v })));
  }
  if (range) sub.timeScale().setVisibleLogicalRange(range);
  // Keep the two panes on the same bars.
  let lock = false; const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange((rg) => { if (lock || !rg) return; lock = true; try { b.timeScale().setVisibleLogicalRange(rg); } catch { /* disposed */ } lock = false; });
  link(main, sub); link(sub, main);
}

function pineRender() {
  const host = $("#tvPineOut"), P = state.pine; if (!host) return; pineDispose(); host.innerHTML = "";
  $("#pineRun").disabled = P.busy; $("#pineRun").textContent = P.busy ? "Running…" : "Run";
  if (P.busy) { host.append(el("div", "dim", "Running the script on the desk's bars…")); return; }
  if (P.err) { const m = el("div", "msg err"); m.setAttribute("role", "alert"); m.append(el("b", null, "The script did not run. "), P.err); host.append(m, el("p", "small dim", "Not every Pine feature is supported by the engine. Scripts that draw only with labels, boxes or tables, or that need data from other symbols, are the usual cases.")); return; }
  const r = P.res; if (!r) { host.append(el("div", "dim", "Paste a Pine script on the left, pick an example, or open one from the Scripts view with \"Use on chart\". Then press Run.")); return; }
  const head = el("div", "st-head"); head.append(el("h3", null, r.title || P.name || "Script"), el("span", "badge muted", r.kind), el("span", "small dim", `${r.symbol} · ${r.interval === "60m" ? "1h" : r.interval} · ${r.bars.toLocaleString()} finished bars · ${r.ms} ms`)); host.append(head);
  const top = el("div", "st-chart"), bottom = el("div", "st-chart pine-sub"); host.append(top, bottom);
  const dr = r.drawings, drawn = dr.labels + dr.lines + dr.boxes + dr.tables;
  if (drawn) host.append(el("p", "small dim", `The script also draws ${[dr.labels && `${dr.labels} labels`, dr.lines && `${dr.lines} lines`, dr.boxes && `${dr.boxes} boxes`, dr.tables && `${dr.tables} tables`].filter(Boolean).join(", ")}. Those are not shown here: only plots, shapes and trades are.`));
  if (!r.plots.some((p) => p.any) && !r.strategy) host.append(el("p", "small dim", "The script ran but produced no plots."));
  for (const w of r.warnings) host.append(el("p", "small dim", `Engine note: ${w}`));
  if (r.strategy) {
    const s = r.strategy, pct = (v) => (s.initial_capital ? (v / s.initial_capital) * 100 : 0), k = el("div", "st-kpis"), tile = (label, value, cls = "", sub = "") => { const b = el("div", "st-kpi"); b.append(el("span", "small dim", label), el("b", `mono ${cls}`, String(value))); if (sub) b.append(el("span", "tiny dim", sub)); return b; };
    const pf = s.gross_loss ? Math.abs(s.gross_profit / s.gross_loss) : null, wr = s.trades ? s.wins / s.trades : null;
    k.append(tile("Total P&L", stPct(pct(s.net_profit)), stCls(s.net_profit), s.buy_hold_pct == null ? "" : `buy & hold ${stPct(s.buy_hold_pct)}`), tile("Max drawdown", s.max_drawdown_pct == null ? "—" : stPct(-Math.abs(s.max_drawdown_pct), false), "down"), tile("Total trades", s.trades, "", s.open.length ? `${s.open.length} open` : ""),
      tile("Profitable trades", wr == null ? "—" : `${(wr * 100).toFixed(1)}%`, "", `${s.wins} of ${s.trades}`), tile("Profit factor", pf == null ? "—" : pf.toFixed(2), pf > 1 ? "up" : pf != null ? "down" : ""));
    host.append(k);
    const rows = s.closed.slice().reverse().slice(0, 200).map((t) => { const tr = el("tr"); tr.append(td(t.side, t.side === "long" ? "up" : "down"), td(stDate(t.entry_time, r.interval), "small"), td(fmt(t.entry), "num"), td(stDate(t.exit_time, r.interval), "small"), td(fmt(t.exit), "num"), td(t.profit == null ? "—" : `${t.profit > 0 ? "+" : ""}${t.profit.toFixed(2)}`, `num ${stCls(t.profit)}`), td(t.exit_id || "", "small dim")); return tr; });
    if (rows.length) { const det = el("details"); det.append(el("summary", "small", `List of trades (latest ${rows.length} of ${s.trades})`)); const w = el("div", "bd-table-wrap st-scroll"); w.append(table(["Side", "Entry", "Price", "Exit", "Price", "Profit", "Closed by"], rows)); det.append(w); host.append(det); }
    host.append(el("p", "small dim", "Strategy results come from the engine's own broker emulator, using the script's own settings (starting capital, order size, commission). They can differ from the Strategy tester tab, which uses the desk's rules."));
  }
  const last = r.plots.filter((p) => p.any && !p.boolean).slice(0, 12).map((p) => { const v = p.values.filter((x) => x !== null).pop(); return `${p.title}: ${v == null ? "—" : fmt(v)}`; });
  if (last.length) host.append(el("p", "small mono dim", `Latest values · ${last.join(" · ")}`));
  requestAnimationFrame(() => { if (top.isConnected) pineCharts(top, bottom, r); });
}

/** Open a script in the runner (from the Scripts view or the saved library) and run it. */
async function pineOpen(script) {
  const P = state.pine; stratView("pine");
  try {
    let src = script && typeof script.source === "string" ? script.source : null;
    if (!src && script?.scriptId) { $("#pineSrc").value = ""; P.err = null; P.res = null; P.busy = true; pineRender(); const j = await api(`/api/tv/pine/${encodeURIComponent(script.scriptId)}/${script.version || 1}`); src = j.source; }
    if (!src) throw new Error("This script's source is not available (it may not be open source).");
    P.name = script.name || ""; $("#pineSrc").value = src; $("#pineName").textContent = P.name ? `${P.name}${script.author ? ` · by ${script.author}` : ""}` : "";
    P.busy = false; await pineRun();
  } catch (e) { P.busy = false; P.err = e.message; P.res = null; pineRender(); }
}

function pineInit() {
  const sel = $("#pineSample"); if (sel.options.length > 1) return;
  for (const [f, label] of PINE_SAMPLES) sel.append(new Option(label, f));
  sel.onchange = async () => { if (!sel.value) return; try { const t = await (await fetch(`/tv/samples/${sel.value}`)).text(); $("#pineSrc").value = t; state.pine.name = sel.options[sel.selectedIndex].text; $("#pineName").textContent = "Example"; sel.value = ""; pineRun(); } catch (e) { showBanner(e.message); } };
  $("#pineForm").onsubmit = (e) => { e.preventDefault(); pineRun(); };
  $("#pineClear").onclick = () => { $("#pineSrc").value = ""; $("#pineName").textContent = ""; state.pine.name = ""; state.pine.res = null; state.pine.err = null; pineRender(); $("#pineSrc").focus(); };
  try { const s = localStorage.getItem("td.pine.src"); if (s) { $("#pineSrc").value = s; state.pine.name = localStorage.getItem("td.pine.name") || ""; $("#pineName").textContent = state.pine.name; } } catch { /* storage may be off */ }
  pineRender();
}
