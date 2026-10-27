"use strict";
/* Trading Desk front end — chart, watchlist, Claude copilot, skill runner, risk, journal. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  let r;
  try { r = await fetch(path, { headers: { "Content-Type": "application/json" }, redirect: "manual", ...opts }); }
  catch { throw new Error("Can't reach the server. Your login may have expired: reload the page."); }
  if (r.type === "opaqueredirect" || r.status === 0) throw new Error("Your Cloudflare login expired: reload the page.");
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    if (r.status === 401 && err.login) { showLogin(); throw new Error("Please log in."); }
    throw new Error(err.detail || `${r.status} ${r.statusText}`);
  }
  if (!ct.includes("json")) throw new Error(`Unexpected response from ${path} (not JSON). Reload the page; if it persists, the Worker is not handling /api.`);
  return r.json();
};
function showLogin() {
  const d = document.getElementById("loginDlg");
  if (d.open) return;
  document.getElementById("banner").classList.add("hidden");
  d.showModal();
}
document.getElementById("loginDlg").addEventListener("cancel", (e) => e.preventDefault()); // can't dismiss with Esc
document.getElementById("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const err = document.getElementById("loginErr"); err.textContent = "";
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: document.getElementById("loginUser").value, password: document.getElementById("loginPw").value }) }).catch(() => null);
  if (r?.ok) { location.reload(); return; }
  err.textContent = r ? (await r.json().catch(() => ({}))).detail || "Login failed." : "Can't reach the server.";
};
function showBanner(msg) {
  if (msg === "Please log in.") return;
  const b = document.getElementById("banner"); b.innerHTML = "";
  const t = document.createElement("span"); t.innerHTML = "<b>Problem:</b> "; t.append(document.createTextNode(msg));
  const x = document.createElement("button"); x.className = "ghost small"; x.textContent = "dismiss"; x.onclick = () => b.classList.add("hidden");
  b.append(t, x); b.classList.remove("hidden");
}
const fmt = (n, d = 2) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const state = {
  settings: null, status: null, symbol: "SPY", interval: "5m", candles: [], quotes: {},
  ind: { vwap: true, ema9: true, ema20: true, levels: true }, sessionId: null, busy: false,
  workflows: [], skills: [], levelLines: [], range: "1D", mainPlan: null,
};

/* ------------------------------------------------------------------ time & sessions */
const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ryFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function nyParts(date) {
  const p = Object.fromEntries(nyFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: +p.hour * 60 + +p.minute, hms: `${p.hour}:${p.minute}:${p.second}` };
}
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
// Official sessions: pre-market 04:00, open 09:30, close 16:00 (13:00 on early-close days), after-hours to 20:00 (17:00).
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const isTradingDate = (day, wd) => WEEKDAYS.includes(wd) && !(state.status?.calendar?.holidays || []).includes(day);
function sessionTimes(day) {
  const early = (state.status?.calendar?.early_closes || []).includes(day);
  return { pre: 240, open: 570, close: early ? 780 : 960, postEnd: early ? 1020 : 1200 };
}
function marketState(now = new Date()) {
  const ny = nyParts(now);
  const t = sessionTimes(ny.day), td = isTradingDate(ny.day, ny.wd);
  let s = "closed", target = null, label = "";
  if (td && ny.min >= t.open && ny.min < t.close) { s = "open"; target = t.close; label = "to close"; }
  else if (td && ny.min >= t.pre && ny.min < t.open) { s = "pre"; target = t.open; label = "to open"; }
  else if (td && ny.min >= t.close && ny.min < t.postEnd) { s = "after"; target = t.postEnd; label = "to AH end"; }
  let mins;
  if (target != null) mins = target - ny.min;
  else { // minutes until the next trading day's 04:00 pre-market
    const d = new Date(`${ny.day}T12:00:00Z`); let days = 0;
    if (!(td && ny.min < t.pre)) { do { d.setUTCDate(d.getUTCDate() + 1); days++; } while (days < 14 && !isTradingDate(d.toISOString().slice(0, 10), DAY_NAMES[d.getUTCDay()])); }
    mins = days * 1440 + 240 - ny.min; label = "to pre-market";
  }
  return { s, ny, countdown: `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m ${label}` };
}
function tickClock() {
  const now = new Date(), m = marketState(now);
  $("#clkRiyadh").textContent = ryFmt.format(now);
  $("#clkNY").textContent = m.ny.hms;
  const st = $("#mktState");
  st.textContent = { open: "MARKET OPEN", pre: "PRE-MARKET", after: "AFTER-HOURS", closed: "CLOSED" }[m.s];
  st.className = `state ${m.s}`;
  $("#mktCountdown").textContent = m.countdown;
}

/* ------------------------------------------------------------------ chart */
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const chart = LightweightCharts.createChart($("#chart"), {
  autoSize: true,
  layout: { background: { color: css("--panel") }, textColor: css("--dim"), fontFamily: css("--font") },
  grid: { vertLines: { color: "#161c27" }, horzLines: { color: "#161c27" } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: css("--line") },
  timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, rightOffset: 6 },
});
const candleS = chart.addCandlestickSeries({ upColor: css("--up"), downColor: css("--down"), borderVisible: false, wickUpColor: css("--up"), wickDownColor: css("--down") });
const volS = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
const lineOpts = (c) => ({ color: c, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const vwapS = chart.addLineSeries(lineOpts(css("--vwap")));
const ema9S = chart.addLineSeries(lineOpts(css("--ema9")));
const ema20S = chart.addLineSeries(lineOpts(css("--ema20")));
$("#chart").append($("#legend")); // keep the O/H/L/C legend inside the chart pane, clear of the toolbar
// Trade-plan overlay (risk/reward zones, levels, replay markers); see plan.js.
const mainLayer = createPlanLayer(chart, candleS, $("#chart"), {
  shift: (t) => t - new Date(t * 1000).getTimezoneOffset() * 60,
  actions: (a, p) => {
    const t = el("button", "primary small", p.side === "long" ? "📝 Paper buy" : "📝 Paper short");
    t.onclick = () => openTicketFromPick({ ...p.raw, symbol: p.symbol, bias: p.side, entry: p.entry, stop: p.stop, targets: p.targets });
    const x = el("button", "ghost small", "✕ clear plan"); x.onclick = () => { state.mainPlan = null; mainLayer.clear(); };
    a.append(t, x);
  },
});
/** Open a recommendation on the main chart with its entry/exit visualization. */
function showPlanOnMain(p, time) {
  state.mainPlan = makePlan(p, time);
  // Pick a range that includes when the plan was made.
  const age = time ? (Date.now() / 1000 - time) / 86400 : 0;
  state.range = age < 1.5 ? "1D" : age < 6 ? "5D" : "1M";
  if (!RANGES[state.range].allow.includes(state.interval)) state.interval = RANGES[state.range].def;
  syncRangeButtons(); showTab("center", "chart");
  if (state.symbol === state.mainPlan.symbol) { state.candles = []; loadChart(); } else setSymbol(state.mainPlan.symbol);
}

// Display bars in the PC's local time (lightweight-charts renders UTC).
const shift = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
const intraday = () => !["1d", "1wk"].includes(state.interval);

// Range = how much history is shown; each range allows a set of bar sizes. `days` is the calendar
// lookback fetched (a little extra so EMAs/VWAP are warmed up); `sessions`/`cal` set the visible window.
const RANGES = {
  "1D": { days: 4, def: "5m", allow: ["1m", "5m", "15m"], sessions: 1 },
  "5D": { days: 9, def: "15m", allow: ["1m", "5m", "15m", "60m"], sessions: 5 },
  "1M": { days: 45, def: "60m", allow: ["5m", "15m", "60m", "1d"], cal: 31 },
  "3M": { days: 130, def: "1d", allow: ["60m", "1d"], cal: 92 },
  "1Y": { days: 420, def: "1d", allow: ["1d"], cal: 365 },
};
function syncRangeButtons() {
  const r = RANGES[state.range];
  $$("#ranges button").forEach((b) => b.classList.toggle("on", b.dataset.r === state.range));
  $$("#intervals button").forEach((b) => { const ok = r.allow.includes(b.dataset.i); b.disabled = !ok; b.classList.toggle("on", b.dataset.i === state.interval); });
}
/** Show the chosen range: the last N sessions (intraday) or the last N calendar days. */
function applyRangeView(data) {
  const r = RANGES[state.range];
  if (!data.length) return;
  let from = 0;
  if (r.sessions) {
    const days = [...new Set(data.map((b) => nyParts(new Date(b.time * 1000)).day))];
    const firstDay = days[Math.max(0, days.length - r.sessions)];
    from = data.findIndex((b) => nyParts(new Date(b.time * 1000)).day === firstDay);
  } else {
    const cut = Date.now() / 1000 - r.cal * 86400;
    from = Math.max(0, data.findIndex((b) => b.time >= cut));
  }
  chart.timeScale().setVisibleLogicalRange({ from: from - 0.5, to: data.length + 5 });
  // Dashed separators at each session start when more than one day of intraday bars is shown.
  const seps = [];
  if (intraday() && state.range !== "1D") { let d = null; for (const b of data) { const day = nyParts(new Date(b.time * 1000)).day; if (day !== d) { d = day; seps.push(shift(b.time)); } } }
  mainLayer.setSeparators(seps);
}

function ema(data, n) {
  const k = 2 / (n + 1); let prev = null;
  return data.map((b) => { prev = prev == null ? b.close : b.close * k + prev * (1 - k); return { time: shift(b.time), value: prev }; });
}
function vwap(data) {
  let day = null, pv = 0, vol = 0; const out = [];
  for (const b of data) {
    const d = nyParts(new Date(b.time * 1000)).day;
    const fresh = d !== day && day !== null;
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; vol += b.volume;
    // Hide the segment joining two sessions (no vertical jump between days).
    if (fresh && out.length) out[out.length - 1].color = "rgba(0,0,0,0)";
    if (vol > 0) out.push({ time: shift(b.time), value: pv / vol, ...(fresh ? { color: "rgba(0,0,0,0)" } : {}) });
  }
  return out;
}
function prevDayLevels(data) {
  const days = new Map();
  for (const b of data) {
    const p = nyParts(new Date(b.time * 1000));
    if (p.min < 570 || p.min >= 960) continue; // regular session only
    const d = days.get(p.day) || { h: -Infinity, l: Infinity, c: null };
    d.h = Math.max(d.h, b.high); d.l = Math.min(d.l, b.low); d.c = b.close; days.set(p.day, d);
  }
  const keys = [...days.keys()].sort();
  const today = nyParts(new Date()).day;
  const prev = keys.filter((k) => k < today).pop();
  return prev ? days.get(prev) : null;
}
function drawIndicators() {
  const d = state.candles, on = state.ind;
  vwapS.setData(on.vwap && intraday() ? vwap(d) : []);
  ema9S.setData(on.ema9 ? ema(d, 9) : []);
  ema20S.setData(on.ema20 ? ema(d, 20) : []);
  state.levelLines.forEach((l) => candleS.removePriceLine(l)); state.levelLines = [];
  if (on.levels && intraday()) {
    const lv = prevDayLevels(d);
    if (lv) for (const [p, t] of [[lv.h, "PDH"], [lv.l, "PDL"], [lv.c, "PDC"]])
      state.levelLines.push(candleS.createPriceLine({ price: p, color: "#64748b", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: t }));
  }
}
const barData = (b) => ({ time: shift(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
const volData = (b) => ({ time: shift(b.time), value: b.volume, color: b.close >= b.open ? "rgba(34,197,94,.35)" : "rgba(239,68,68,.35)" });

async function loadChart(keepView = false) {
  const sym = state.symbol, iv = state.interval;
  $("#chartMsg").textContent = keepView ? "" : "loading…";
  try {
    const rg = state.range;
    const data = await api(`/api/candles/${encodeURIComponent(sym)}?interval=${iv}&days=${RANGES[rg].days}`);
    if (sym !== state.symbol || iv !== state.interval || rg !== state.range) return;
    if (keepView && state.candles.length && data.length) {
      const lastT = state.candles[state.candles.length - 1].time;
      for (const b of data.filter((b) => b.time >= lastT)) { candleS.update(barData(b)); volS.update(volData(b)); }
    } else {
      candleS.setData(data.map(barData)); volS.setData(data.map(volData));
      applyRangeView(data);
    }
    state.candles = data;
    if (state.mainPlan && state.mainPlan.symbol === sym) mainLayer.set(state.mainPlan, data, paperMarkers(sym, data, shift));
    else candleS.setMarkers(paperMarkers(sym, data, shift));
    drawIndicators(); updateLegend();
    $("#chartMsg").textContent = data.length ? "" : "no data";
  } catch (e) { $("#chartMsg").textContent = `⚠ ${e.message}`; }
}
function updateLegend(param) {
  const b = param?.seriesData?.get(candleS) || (state.candles.length ? barData(state.candles[state.candles.length - 1]) : null);
  if (!b) { $("#legend").textContent = ""; return; }
  const src = state.candles.find((c) => shift(c.time) === b.time);
  const cls = b.close >= b.open ? "up" : "down";
  $("#legend").innerHTML = `<b>${state.symbol}</b> · ${state.range} · ${state.interval} &nbsp; O <b>${fmt(b.open)}</b> H <b>${fmt(b.high)}</b> L <b>${fmt(b.low)}</b> C <b class="${cls}">${fmt(b.close)}</b> V <b>${src ? fmt(src.volume, 0) : "—"}</b>` +
    ` &nbsp;<span style="color:${css("--vwap")}">VWAP</span> <span style="color:${css("--ema9")}">EMA9</span> <span style="color:${css("--ema20")}">EMA20</span>`;
}
chart.subscribeCrosshairMove(updateLegend);

function setSymbol(sym) {
  sym = sym.trim().toUpperCase(); if (!sym) return;
  if (state.mainPlan && state.mainPlan.symbol !== sym) { state.mainPlan = null; mainLayer.clear(); }
  state.symbol = sym; $("#symInput").value = sym; state.candles = [];
  renderWatchlist(); renderActiveQuote(); loadChart(); refreshQuotes([sym]);
}

/* ------------------------------------------------------------------ watchlist & quotes */
function renderWatchlist() {
  const box = $("#watchlist"); box.innerHTML = "";
  for (const sym of state.settings.watchlist) {
    const q = state.quotes[sym] || {}; const cls = q.change_pct > 0 ? "up" : q.change_pct < 0 ? "down" : "";
    const row = el("div", `w-row${sym === state.symbol ? " active" : ""}`);
    row.append(el("span", "w-sym", sym), el("span", "w-px", fmt(q.last)), el("span", "w-chg " + cls, q.change_pct == null ? "" : `${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct)}%`));
    const del = el("button", "w-del", "×"); del.title = "Remove";
    del.onclick = (e) => { e.stopPropagation(); saveSettings({ watchlist: state.settings.watchlist.filter((s) => s !== sym) }); };
    row.append(del); row.onclick = () => setSymbol(sym);
    box.append(row);
  }
}
function renderActiveQuote() {
  const q = state.quotes[state.symbol] || {};
  $("#qLast").textContent = fmt(q.last);
  const c = $("#qChg"); c.className = `mono ${q.change_pct > 0 ? "up" : q.change_pct < 0 ? "down" : ""}`;
  c.textContent = q.change_pct == null ? "" : `${q.last - q.prev >= 0 ? "+" : ""}${fmt(q.last - q.prev)} (${fmt(q.change_pct)}%)`;
}
async function refreshQuotes(only) {
  const syms = only || [...new Set([...state.settings.watchlist, state.symbol])];
  if (!syms.length) return;
  try {
    for (const q of await api(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`)) if (!q.error) state.quotes[q.symbol] = q;
    renderWatchlist(); renderActiveQuote();
  } catch { /* transient */ }
}

/* ------------------------------------------------------------------ tabs */
function showTab(group, tab) {
  if (group === "center") document.querySelector(".center").classList.toggle("board-mode", tab === "board" || tab === "paper");
  $$(`.tabs[data-group=${group}] button[data-tab]`).forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$(`.tab-body[data-group=${group}]`).forEach((b) => b.classList.toggle("hidden", b.dataset.tab !== tab));
}
$$(".tabs button[data-tab]").forEach((b) => (b.onclick = () => showTab(b.parentElement.dataset.group, b.dataset.tab)));

/* ------------------------------------------------------------------ Claude copilot */
function deskContext() {
  const q = state.quotes[state.symbol] || {}, m = marketState();
  return `[Desk context — ${ryFmt.format(new Date())} Riyadh, US market ${m.s}] Active chart: ${state.symbol} ${state.interval}, last ${fmt(q.last)} (${fmt(q.change_pct)}%). Watchlist: ${state.settings.watchlist.join(", ")}.`;
}
function fillTemplate(s) {
  const q = state.quotes[state.symbol] || {};
  return s.replaceAll("{symbol}", state.symbol).replaceAll("{interval}", state.interval)
    .replaceAll("{price}", q.last ? fmt(q.last) : "current price").replaceAll("{watchlist}", state.settings.watchlist.join(", "))
    .replaceAll("{format}", state.resultFormat || "");
}
function renderWorkflows() {
  const box = $("#workflows"); box.innerHTML = "";
  for (const w of state.workflows) {
    const b = el("button", null, fillTemplate(w.label)); b.title = fillTemplate(w.prompt);
    b.onclick = () => sendChat(fillTemplate(w.prompt), fillTemplate(w.label));
    box.append(b);
  }
}
function chatAdd(cls, text, html) {
  const m = el("div", `msg ${cls}`); if (html != null) { m.classList.add("md"); m.innerHTML = html; } else m.textContent = text;
  $("#chat").append(m); $("#chat").scrollTop = $("#chat").scrollHeight; return m;
}
async function sendChat(prompt, label) {
  if (state.busy || !prompt.trim()) return;
  state.busy = true; $("#btnSend").disabled = true;
  chatAdd("user", label ? `▶ ${label}` : prompt);
  const full = $("#ctxToggle").checked ? `${deskContext()}\n\n${prompt}` : prompt;
  const thinking = chatAdd("sys typing", state.sessionId ? "Claude is working" : "Starting a cloud session (first reply takes a little longer)");
  consoleWrite(`\n━━ ${new Date().toLocaleTimeString()} ${label || prompt.slice(0, 80)}\n`);
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: full, session_id: state.sessionId }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        thinking.remove(); $("#chat").append(thinking);
        if (ev.kind === "init") {
          if (state.sessionId !== ev.session_id) { state.sessionId = ev.session_id; state.trace = ev.trace; renderTrace(); remember(); }
          thinking.textContent = "Claude is working";
        } else if (ev.kind === "text") {
          const { text, result } = splitResult(ev.text);
          const m = chatAdd("bot", null, md(text));
          if (result) { const v = el("div", "chat-board"); renderMini(v, result); m.append(v); }
        }
        else if (ev.kind === "tool") { chatAdd("tool", `⚙ ${ev.name}: ${ev.detail}`); consoleWrite(`\n$ [${ev.name}] ${ev.detail}\n`); }
        else if (ev.kind === "tool_result") consoleWrite(`${ev.is_error ? "[error] " : ""}${ev.text}\n`);
        else if (ev.kind === "usage") state.cost = ev.cost;
        else if (ev.kind === "error") chatAdd("err", ev.text);
        else if (ev.kind === "done") {
          if (ev.failed) { state.sessionId = null; remember(); }
          chatAdd("meta", ev.cost ? `session cost so far: ${formatCost(ev.cost)}` : "");
        }
      }
    }
  } catch (e) { chatAdd("err", e.message); }
  thinking.remove(); state.busy = false; $("#btnSend").disabled = false;
}
function formatCost(c) { const [amt, cur] = String(c).split(" "); return cur === "USD" ? `$${(Number(amt) / 100).toFixed(2)}` : c; }
function renderTrace() {
  const old = $("#traceLink"); if (old) old.remove();
  if (!state.trace) return;
  const m = el("div", "msg sys"); m.id = "traceLink";
  const a = el("a", null, "Open this session's full trace in the Claude Console ↗"); a.href = state.trace; a.target = "_blank"; a.rel = "noopener";
  m.append(a); $("#chat").append(m);
}
$("#chatForm").onsubmit = (e) => { e.preventDefault(); const v = $("#chatInput").value; $("#chatInput").value = ""; sendChat(v); };
$("#chatInput").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#chatForm").requestSubmit(); };
function remember() { try { localStorage.setItem("desk.session", JSON.stringify({ id: state.sessionId, trace: state.trace })); } catch { /* storage unavailable */ } }
function restoreSession() {
  try { const s = JSON.parse(localStorage.getItem("desk.session") || "null"); if (s?.id) { state.sessionId = s.id; state.trace = s.trace; chatAdd("sys", "Continuing your last Copilot session. Click \"new session\" to start fresh."); renderTrace(); } } catch { /* ignore */ }
}
$("#btnNewChat").onclick = () => { state.sessionId = null; state.trace = null; remember(); $("#chat").innerHTML = ""; chatAdd("sys", "New session. Your next message starts a fresh cloud sandbox."); };

/* ------------------------------------------------------------------ skills */
function consoleWrite(text, reset) {
  const c = $("#console"); if (reset) c.textContent = ""; c.textContent += text;
  if (c.textContent.length > 400000) c.textContent = c.textContent.slice(-300000);
  c.scrollTop = c.scrollHeight;
}
function renderSkills() {
  const box = $("#skills"), f = $("#skillFilter").value.toLowerCase(); box.innerHTML = "";
  if (!state.skills.length) { box.append(el("div", "dim pad", state.status?.agent_ready ? "No skills attached to the agent. Run setup/setup-agent.mjs on your PC." : "The Claude agent is not configured yet. See the README (setup-agent step).")); return; }
  for (const s of state.skills) {
    if (f && !`${s.name} ${s.description}`.toLowerCase().includes(f)) continue;
    const d = el("details", "skill"), sum = el("summary");
    sum.append(el("div", "skill-name", s.name), el("div", "skill-desc", s.description));
    const body = el("div", "skill-body");
    const ask = el("button", "primary small", `Ask Claude to use ${s.name}`);
    ask.onclick = () => { showTab("side", "copilot"); const t = $("#chatInput"); t.value = `Use the ${s.name} skill for ${state.symbol}: `; t.focus(); };
    const run = el("div", "skill-run"), inp = el("input"); inp.placeholder = "run a tool, e.g. scan {symbol} --json";
    const go = el("button", "small", "Run");
    const exec = () => { if (!inp.value.trim()) return; showTab("side", "copilot"); showTab("bottom", "console");
      sendChat(`Using the ${s.name} skill, run its Python tool for: ${fillTemplate(inp.value)}\nShow the raw output, then a short summary.`, `${s.name}: ${fillTemplate(inp.value)}`); };
    go.onclick = exec; inp.onkeydown = (e) => { if (e.key === "Enter") exec(); };
    const list = el("button", "ghost small", "list its tools");
    list.onclick = () => { showTab("side", "copilot"); sendChat(`List the Python tools in the ${s.name} skill with their arguments (run each with --help). Keep it short.`, `${s.name}: list tools`); };
    run.append(inp, go); body.append(ask, run, list); d.append(sum, body); box.append(d);
  }
}
$("#skillFilter").oninput = renderSkills;
$("#btnClearConsole").onclick = () => consoleWrite("", true);

/* ------------------------------------------------------------------ risk */
const num = (id) => parseFloat($(id).value);
function calcRisk() {
  const acct = num("#rAcct"), pct = num("#rPct"), entry = num("#rEntry"), stop = num("#rStop"), maxPos = num("#rMaxPos");
  const side = $("#rSide").value, out = $("#riskOut"); out.innerHTML = "";
  const kv = (k, v, cls = "") => out.append(el("span", "k", k), el("span", cls, v));
  if (!(acct > 0 && pct > 0 && entry > 0 && stop > 0)) { out.append(el("span", "k", "Enter account, risk %, entry and stop.")); return null; }
  const perShare = Math.abs(entry - stop), dir = side === "long" ? 1 : -1;
  if ((entry - stop) * dir <= 0) { out.append(el("span", "warn", `Stop must be ${side === "long" ? "below" : "above"} entry for a ${side}.`)); return null; }
  const riskUsd = (acct * pct) / 100;
  let shares = Math.floor(riskUsd / perShare); const cap = maxPos > 0 ? Math.floor((acct * maxPos) / 100 / entry) : Infinity;
  const capped = shares > cap; shares = Math.min(shares, cap);
  const targets = [1, 2, 3].map((r) => entry + dir * perShare * r);
  kv("Shares", fmt(shares, 0)); kv("Risk $", `${fmt(shares * perShare)}  (${fmt(perShare, 3)}/sh)`);
  kv("Position $", `${fmt(shares * entry)}  (${fmt((shares * entry * 100) / acct, 1)}% of acct)`);
  targets.forEach((t, i) => kv(`${i + 1}R target`, `${fmt(t)}  (+$${fmt(shares * perShare * (i + 1))})`, "up"));
  if (capped) out.append(el("span", "warn", "Size capped by max position % — the stop is tight relative to account."));
  return { entry, stop, targets, shares, side };
}
$$("#rAcct,#rPct,#rEntry,#rStop,#rMaxPos,#rSide").forEach((i) => (i.oninput = calcRisk));
$("#btnUseLast").onclick = () => { const q = state.quotes[state.symbol]; if (q?.last) { $("#rEntry").value = q.last.toFixed(2); calcRisk(); } };
$("#btnClearPlan").onclick = () => { state.mainPlan = null; mainLayer.clear(); };
$("#btnDrawPlan").onclick = () => {
  const p = calcRisk(); if (!p) return;
  state.mainPlan = makePlan({ symbol: state.symbol, side: p.side, entry: p.entry, stop: p.stop, targets: p.targets, setup: `${p.shares} shares (Risk tab)` }, null);
  mainLayer.set(state.mainPlan, state.candles, paperMarkers(state.symbol, state.candles, shift));
};
$("#btnAskSize").onclick = () => {
  const p = calcRisk(); if (!p) return; showTab("side", "copilot");
  sendChat(`Use my trader-* skills to verify this plan against my trader/config.json limits and every pre-trade check: ${p.side} ${p.shares} ${state.symbol}, entry ${p.entry}, stop ${p.stop}, targets ${p.targets.map((t) => t.toFixed(2)).join(" / ")}. Say clearly if it is allowed. Do not place any orders.`, `Verify ${p.side} ${p.shares} ${state.symbol}`);
};
function prefillRiskFromConfig(cfg) {
  if (!cfg) return;
  const flat = {}; (function walk(o, pre) { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${pre}${k}.`); else flat[`${pre}${k}`.toLowerCase()] = v; } })(cfg, "");
  const find = (re) => Object.entries(flat).find(([k, v]) => re.test(k) && typeof v === "number")?.[1];
  const acct = find(/(account|equity|capital|balance|budget)(_size|_usd)?$/);
  const pct = find(/risk.*(pct|percent)/);
  if (acct) $("#rAcct").value = acct;
  if (pct) $("#rPct").value = pct < 0.05 ? pct * 100 : pct; // 0.005 is a fraction, 0.5 is already a percent
}

/* ------------------------------------------------------------------ journal */
async function loadJournal() {
  const rows = await api("/api/journal"), tb = $("#journalTable tbody"); tb.innerHTML = "";
  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  for (const t of rows) {
    const tr = el("tr");
    const cells = [t.date, t.symbol, t.side, t.qty, fmt(t.entry), fmt(t.stop), fmt(t.exit), t.pnl == null ? "open" : fmt(t.pnl), t.r == null ? "" : fmt(t.r), t.setup || "", t.notes || ""];
    cells.forEach((c, i) => { const td = el("td", i >= 3 && i <= 8 ? "num" : "", c ?? ""); if (i === 7 && t.pnl != null) td.classList.add(t.pnl >= 0 ? "up" : "down"); tr.append(td); });
    const x = el("button", "x", "×"); x.title = "Delete";
    x.onclick = async () => { if (confirm(`Delete ${t.symbol} ${t.date}?`)) { await api(`/api/journal/${t.id}`, { method: "DELETE" }); loadJournal(); } };
    const td = el("td"); td.append(x); tr.append(td); tb.append(tr);
  }
  const closed = rows.filter((t) => t.pnl != null), wins = closed.filter((t) => t.pnl > 0);
  const total = closed.reduce((a, t) => a + t.pnl, 0), rs = closed.filter((t) => t.r != null);
  const today = new Date().toISOString().slice(0, 10), todayPnl = closed.filter((t) => t.date === today).reduce((a, t) => a + t.pnl, 0);
  $("#journalStats").innerHTML = "";
  for (const [k, v, c] of [["Trades", closed.length], ["Win rate", closed.length ? `${fmt((wins.length / closed.length) * 100, 0)}%` : "—"],
    ["Total P&L", fmt(total), total >= 0 ? "up" : "down"], ["Today", fmt(todayPnl), todayPnl >= 0 ? "up" : "down"],
    ["Avg R", rs.length ? fmt(rs.reduce((a, t) => a + t.r, 0) / rs.length) : "—"]]) {
    const s = el("span", null, `${k} `); const b = el("b", c || "", String(v)); s.append(b); $("#journalStats").append(s);
  }
}
$("#tradeForm").onsubmit = async (e) => {
  e.preventDefault(); const f = new FormData(e.target), t = Object.fromEntries(f.entries());
  await api("/api/journal", { method: "POST", body: JSON.stringify({ trade: t }) });
  e.target.reset(); e.target.date.value = new Date().toISOString().slice(0, 10); loadJournal();
};

/* ------------------------------------------------------------------ settings & status */
async function saveSettings(patch) {
  state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ settings: patch }) });
  renderWatchlist(); refreshQuotes(); renderWorkflows();
}
$("#btnSettings").onclick = () => {
  const f = $("#settingsForm"), s = state.settings;
  f.watchlist.value = s.watchlist.join(", "); f.session_budget_usd.value = s.session_budget_usd; f.trader_config.value = s.trader_config || "";
  f.data_source.value = s.data_source || "auto"; $("#dataTestOut").textContent = "";
  $("#settingsErr").textContent = ""; $("#settingsDlg").showModal();
};
$("#btnSettingsCancel").onclick = () => $("#settingsDlg").close();
$("#btnTestData").onclick = async () => {
  const out = $("#dataTestOut"); out.textContent = "testing…"; out.className = "small dim";
  try {
    const r = await api("/api/market/test");
    out.textContent = `IEX: ${r.iex.ok ? "✓" : "✗"} ${r.iex.detail} · SIP: ${r.sip.ok ? "✓" : "✗"} ${r.sip.detail}`;
    out.className = `small ${r.iex.ok ? "up" : "down"}`;
  } catch (e) { out.textContent = e.message; out.className = "small down"; }
};
$("#btnLogout").onclick = async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); };
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, list = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const raw = f.trader_config.value;
  if (raw.trim()) {
    let cfg;
    try { cfg = JSON.parse(raw); } catch (err) { $("#settingsErr").textContent = `config.json is not valid JSON: ${err.message}`; return; }
    if (!secUserAgent(cfg) && !confirm('Your config has no "sec_user_agent" (Name + email). The SEC-based skills will refuse to run without it. Save anyway?')) return;
  }
  try {
    await saveSettings({ watchlist: list(f.watchlist.value.toUpperCase()), session_budget_usd: +f.session_budget_usd.value, trader_config: raw, data_source: f.data_source.value });
    $("#settingsDlg").close(); await loadStatus();
  } catch (err) { $("#settingsErr").textContent = err.message; }
};
/** The SEC asks every client to identify itself as "Name email"; the skills read it from the config. */
function secUserAgent(cfg) {
  let found = null;
  (function walk(o) { for (const [k, v] of Object.entries(o || {})) { if (/user.?agent/i.test(k) && typeof v === "string" && v.trim()) found = v; else if (v && typeof v === "object") walk(v); } })(cfg);
  return found && /@/.test(found) ? found : null;
}
async function loadStatus() {
  const st = (state.status = await api("/api/status"));
  const b = $("#modeBadge");
  if (st.paper === true) { b.className = "badge paper"; b.textContent = "PAPER"; }
  else if (st.paper === false) { b.className = "badge live"; b.textContent = "LIVE MONEY"; }
  else { b.className = "badge muted"; b.textContent = st.config_error ? "CONFIG ERROR" : "NO CONFIG"; }
  b.title = "trader/config.json — edit in Settings";
  $("#claudeDot").className = `dot ${st.agent_ready ? "ok" : "bad"}`;
  if (st.market) {
    const mk = st.market, dl = $("#dataLabel");
    dl.textContent = `Data: ${mk.label}${mk.last_error ? ` — Alpaca error, using Yahoo: ${mk.last_error}` : ""}${mk.sip_denied ? " (SIP not in your plan, using IEX)" : ""}. Not for execution.`;
    dl.className = `tiny pad ${mk.last_error ? "down" : mk.active.startsWith("alpaca") ? "up" : "dim"}`;
  }
  $("#configView").textContent = st.config ? JSON.stringify(st.config, null, 2) : st.config_error || "Not set. Paste your trader/config.json in Settings ⚙.";
  const ua = secUserAgent(st.config);
  if (st.config && !ua) showBanner('trader/config.json has no "sec_user_agent", so the SEC-based skills (analyst, copycat, filings) will refuse to run. Open Settings ⚙ and add e.g. "sec_user_agent": "Your Name you@email.com".');
  prefillRiskFromConfig(st.config);
}
async function loadSkills() {
  try { state.skills = await api("/api/skills"); } catch (e) { state.skills = []; }
  $("#skillsCount").textContent = `· ${state.skills.length} skills`; renderSkills();
}
async function loadGuide() {
  const g = await api("/api/guide");
  $("#guide").innerHTML = g.markdown ? md(g.markdown) : `<p class="dim">No guide yet. Upload your GUIDE.md above.</p>`;
}
$("#guideFile").onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  await api("/api/guide", { method: "PUT", body: JSON.stringify({ markdown: await file.text() }) });
  e.target.value = ""; loadGuide();
};

/* ------------------------------------------------------------------ autopilot briefs */
const nyMinFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ryMinFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const mins = (f) => { const [h, m] = f.format(new Date()).split(":").map(Number); return h * 60 + m; };
function etToRiyadh(et) {
  const diff = (mins(ryMinFmt) - mins(nyMinFmt) + 1440) % 1440;
  const t = (+et.slice(0, 2) * 60 + +et.slice(3, 5) + diff) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
state.seenBriefs = null;
async function loadBriefs() {
  let d;
  try { d = await api("/api/briefs"); } catch (e) { $("#briefList").innerHTML = ""; $("#briefList").append(el("div", "msg err", e.message)); return; }
  state.briefData = d;
  $("#apEnabled").checked = d.autopilot.enabled;
  $("#apNote").textContent = !d.agent_ready ? "agent not configured" : !d.trading_day ? "market closed today" : d.autopilot.enabled ? "runs automatically on market days" : "off";
  const slots = $("#apSlots"); slots.innerHTML = "";
  for (const s of d.slots) {
    const row = el("div", "ap-slot"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!d.autopilot.slots[s.id];
    cb.onchange = () => api("/api/autopilot", { method: "PUT", body: JSON.stringify({ slots: { [s.id]: cb.checked } }) }).catch((e) => showBanner(e.message));
    const run = el("button", "ghost small", "run now");
    run.onclick = async () => { run.disabled = true; try { await api("/api/briefs/run", { method: "POST", body: JSON.stringify({ slot: s.id }) }); await loadBriefs(); } catch (e) { showBanner(e.message); } run.disabled = false; };
    row.append(cb, el("span", null, s.label), el("span", "t", `${s.et} NY · ${etToRiyadh(s.et)} Riyadh`), run);
    slots.append(row);
  }
  state.resultFormat = d.result_format || "";
  renderWorkflows();
  const list = $("#briefList"); list.innerHTML = "";
  if (!d.briefs.length) list.append(el("div", "dim small", "No briefs yet. They start automatically at the times above on market days, or click \"run now\"."));
  for (const b of d.briefs) list.append(renderBrief(b));
  updateBoard(d.briefs);
  // Poll faster while something is running.
  clearTimeout(state.briefTimer);
  if (d.briefs.some((b) => b.status === "running" || b.status === "starting")) state.briefTimer = setTimeout(loadBriefs, 20000);
  // Notify about briefs that finished since the last poll.
  const done = new Set(d.briefs.filter((b) => b.status === "done").map((b) => b.id));
  if (state.seenBriefs) for (const b of d.briefs) if (b.status === "done" && !state.seenBriefs.has(b.id)) notify(b);
  state.seenBriefs = done;
}
function renderBrief(b) {
  const box = el("div", "brief"), h = el("div", "brief-h");
  const when = new Date(b.created_at.replace(" ", "T") + "Z");
  h.append(el("b", null, b.label || b.slot), el("span", `pill ${b.status}`, b.status === "running" || b.status === "starting" ? "working…" : b.status),
    el("span", "dim tiny", `${b.day} · ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`));
  if (b.cost) h.append(el("span", "dim tiny", formatCost(b.cost)));
  const open = el("button", "ghost small", "open board ↗"); open.style.marginLeft = "auto";
  open.onclick = () => { state.boardId = b.id; updateBoard(state.briefData.briefs, true); showTab("center", "board"); };
  h.append(open);
  box.append(h);
  if (b.error) box.append(el("div", "msg err small", b.error));
  const mini = el("div", "brief-mini"); renderMini(mini, b.data || { picks: b.picks }, briefTime(b)); box.append(mini);
  return box;
}
/** Center "Market board": the chosen brief, else the latest finished full scan, else the latest brief. */
function updateBoard(briefs, force) {
  const sel = $("#boardPick");
  const options = briefs.filter((b) => b.status !== "error" || b.content);
  sel.innerHTML = "";
  for (const b of options) {
    const o = el("option", null, `${b.label} · ${b.day} ${new Date(b.created_at.replace(" ", "T") + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${b.status === "done" ? "" : ` (${b.status})`}`);
    o.value = b.id; sel.append(o);
  }
  sel.classList.toggle("hidden", !options.length);
  const pick = options.find((b) => b.id === state.boardId)
    || options.find((b) => b.slot === "fullscan" && b.status === "done") || options.find((b) => b.status === "done") || options[0];
  if (pick) sel.value = pick.id;
  const sig = pick ? `${pick.id}:${pick.status}` : "none";
  if (!force && sig === state.boardSig) return; // don't wipe open rows on every poll
  state.boardSig = sig; renderBoard($("#board"), pick);
}
$("#boardPick").onchange = (e) => { state.boardId = e.target.value; updateBoard(state.briefData.briefs, true); };
/* ---- scan filters dialog */
const PRESETS = {
  balanced: {},
  largecap: { min_market_cap: 10e9, min_price: 20, min_avg_volume: 2e6, min_rel_volume: 1.5, min_atr_pct: 1.5 },
  midcap: { min_market_cap: 2e9, max_market_cap: 10e9, min_price: 10, min_avg_volume: 1e6, min_rel_volume: 1.5, min_gap_pct: 2 },
  smallcap: { min_market_cap: 50e6, max_market_cap: 2e9, min_price: 2, max_price: 20, min_avg_volume: 500000, min_rel_volume: 3, min_gap_pct: 5, max_float: 50e6, min_premarket_volume: 500000 },
};
const F_NUM = ["min_market_cap", "max_market_cap", "min_price", "max_price", "min_avg_volume", "min_rel_volume", "min_premarket_volume", "min_gap_pct", "min_atr_pct", "min_float", "max_float", "max_short_float_pct"];
function fillFilters(f) {
  const form = $("#filtersForm");
  for (const k of F_NUM) {
    const inp = form[k], v = f[k] == null ? "" : String(f[k]);
    if (inp.tagName === "SELECT" && v && ![...inp.options].some((o) => o.value === v)) inp.append(new Option(v, v)); // keep custom values
    inp.value = v;
  }
  form.direction.value = f.direction; form.earnings.value = f.earnings; form.max_picks.value = f.max_picks;
  form.include_etfs.checked = !!f.include_etfs; form.notes.value = f.notes || "";
  const checks = (box, all, on) => { box.innerHTML = ""; for (const x of all) { const l = el("label"), c = el("input"); c.type = "checkbox"; c.value = x; c.checked = on.includes(x); l.append(c, document.createTextNode(x)); box.append(l); } };
  checks($("#fSectors"), state.filterMeta.sectors, f.sectors); checks($("#fExchanges"), state.filterMeta.exchanges, f.exchanges);
}
function readFilters() {
  const form = $("#filtersForm"), f = {};
  for (const k of F_NUM) f[k] = form[k].value === "" ? null : Number(form[k].value);
  f.direction = form.direction.value; f.earnings = form.earnings.value; f.max_picks = Number(form.max_picks.value) || 10;
  f.include_etfs = form.include_etfs.checked; f.notes = form.notes.value;
  f.sectors = $$("#fSectors input:checked").map((c) => c.value); f.exchanges = $$("#fExchanges input:checked").map((c) => c.value);
  return f;
}
$("#btnFilters").onclick = async () => {
  try {
    const d = await api("/api/scan-filters");
    state.filterMeta = d; fillFilters(d.filters); $("#filtersErr").textContent = ""; $("#filtersDlg").showModal();
  } catch (e) { showBanner(e.message); }
};
$$("#filtersDlg [data-preset]").forEach((b) => (b.onclick = () => fillFilters({ ...state.filterMeta.defaults, ...PRESETS[b.dataset.preset] })));
$("#btnFiltersReset").onclick = () => fillFilters(state.filterMeta.defaults);
$("#btnFiltersCancel").onclick = () => $("#filtersDlg").close();
$("#filtersForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = readFilters();
  if (f.min_price != null && f.max_price != null && f.min_price > f.max_price) { $("#filtersErr").textContent = "Price min is above price max."; return; }
  if (f.min_market_cap != null && f.max_market_cap != null && f.min_market_cap > f.max_market_cap) { $("#filtersErr").textContent = "Market cap min is above max."; return; }
  if (!f.exchanges.length) { $("#filtersErr").textContent = "Pick at least one exchange."; return; }
  try {
    await api("/api/scan-filters", { method: "PUT", body: JSON.stringify({ filters: f }) });
    $("#filtersDlg").close();
    if (e.submitter?.value === "run") $("#btnFullScan").click();
  } catch (err) { $("#filtersErr").textContent = err.message; }
};
$("#btnFullScan").onclick = async () => {
  const btn = $("#btnFullScan"); btn.disabled = true;
  try {
    const { id } = await api("/api/briefs/run", { method: "POST", body: JSON.stringify({ slot: "fullscan" }) });
    state.boardId = id; showTab("center", "board"); await loadBriefs();
  } catch (e) { showBanner(e.message); }
  btn.disabled = false;
};
function notify(b) {
  const top = (b.picks || []).slice(0, 3).map((p) => p.symbol).join(", ");
  try { if (Notification.permission === "granted") new Notification(`Trading Desk: ${b.label}`, { body: top ? `Top picks: ${top}` : "Brief ready" }); } catch { /* unsupported */ }
  document.title = `● ${b.label} ready — Trading Desk`;
  setTimeout(() => (document.title = "Trading Desk"), 15000);
}
$("#apEnabled").onchange = (e) => api("/api/autopilot", { method: "PUT", body: JSON.stringify({ enabled: e.target.checked }) }).then(loadBriefs).catch((err) => showBanner(err.message));
$("#btnNotify").onclick = async () => {
  try { const p = await Notification.requestPermission(); $("#btnNotify").textContent = p === "granted" ? "🔔 on" : "🔕 blocked"; } catch { $("#btnNotify").textContent = "not supported"; }
};

/* ------------------------------------------------------------------ wiring */
$("#symForm").onsubmit = (e) => { e.preventDefault(); setSymbol($("#symInput").value); };
$("#addSymForm").onsubmit = (e) => {
  e.preventDefault(); const v = $("#addSym").value.trim().toUpperCase(); $("#addSym").value = "";
  if (v && !state.settings.watchlist.includes(v)) saveSettings({ watchlist: [...state.settings.watchlist, v] });
};
$$("#intervals button").forEach((b) => (b.onclick = () => {
  if (b.disabled) return;
  state.interval = b.dataset.i; syncRangeButtons(); state.candles = []; loadChart(); renderWorkflows();
}));
$$("#ranges button").forEach((b) => (b.onclick = () => {
  state.range = b.dataset.r;
  if (!RANGES[state.range].allow.includes(state.interval)) state.interval = RANGES[state.range].def;
  syncRangeButtons(); state.candles = []; loadChart(); renderWorkflows();
}));
syncRangeButtons();
$$("#indicators button").forEach((b) => (b.onclick = () => { state.ind[b.dataset.ind] = !state.ind[b.dataset.ind]; b.classList.toggle("on"); drawIndicators(); }));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { e.preventDefault(); $("#symInput").select(); }
});

(async function init() {
  marked.setOptions({ gfm: true, breaks: true });
  tickClock(); setInterval(tickClock, 1000);
  try { state.settings = await api("/api/settings"); }
  catch (e) {
    showBanner(`${e.message}  (Open /api/status in a new tab for details.)`);
    state.settings = { watchlist: ["SPY", "QQQ"], session_budget_usd: 5, trader_config: "" };
  }
  state.symbol = state.settings.watchlist[0] || "SPY"; $("#symInput").value = state.symbol;
  $("#tradeForm").date.value = new Date().toISOString().slice(0, 10);
  state.workflows = await api("/workflows.json").catch(() => []);
  restoreSession();
  renderWatchlist(); renderWorkflows(); loadChart();
  const results = await Promise.allSettled([loadStatus(), loadSkills(), loadGuide(), loadJournal(), refreshQuotes(), loadBriefs()]);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) showBanner(failed.reason?.message || String(failed.reason));
  renderWorkflows();
  setInterval(refreshQuotes, 15000);
  setInterval(() => { if (intraday() && marketState().s !== "closed") loadChart(true); }, 20000);
  setInterval(loadBriefs, 60000);
  try { if (Notification.permission === "granted") $("#btnNotify").textContent = "🔔 on"; } catch { /* unsupported */ }
})();
