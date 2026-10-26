"use strict";
/* Trading Desk front end — chart, watchlist, Claude copilot, skill runner, risk, journal. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};
const fmt = (n, d = 2) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const state = {
  settings: null, status: null, symbol: "SPY", interval: "5m", candles: [], quotes: {},
  ind: { vwap: true, ema9: true, ema20: true, levels: true }, sessionId: null, busy: false,
  workflows: [], skills: [], levelLines: [], planLines: [],
};

/* ------------------------------------------------------------------ time & sessions */
const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ryFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function nyParts(date) {
  const p = Object.fromEntries(nyFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: +p.hour * 60 + +p.minute, hms: `${p.hour}:${p.minute}:${p.second}` };
}
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
function marketState(now = new Date()) {
  const ny = nyParts(now);
  const wk = WEEKDAYS.includes(ny.wd);
  let s = "closed", target = null, label = "";
  if (wk && ny.min >= 570 && ny.min < 960) { s = "open"; target = 960; label = "to close"; }
  else if (wk && ny.min >= 240 && ny.min < 570) { s = "pre"; target = 570; label = "to open"; }
  else if (wk && ny.min >= 960 && ny.min < 1200) { s = "after"; target = 1200; label = "to AH end"; }
  let mins;
  if (target != null) mins = target - ny.min;
  else { // minutes until next weekday 09:30 ET (holidays not modelled)
    const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let i = order.indexOf(ny.wd), days = 0;
    if (!(wk && ny.min < 570)) { do { i = (i + 1) % 7; days++; } while (!WEEKDAYS.includes(order[i])); }
    mins = days * 1440 + 570 - ny.min; label = "to open";
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

// Display bars in the PC's local time (lightweight-charts renders UTC).
const shift = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
const intraday = () => !["1d", "1wk"].includes(state.interval);

function ema(data, n) {
  const k = 2 / (n + 1); let prev = null;
  return data.map((b) => { prev = prev == null ? b.close : b.close * k + prev * (1 - k); return { time: shift(b.time), value: prev }; });
}
function vwap(data) {
  let day = null, pv = 0, vol = 0; const out = [];
  for (const b of data) {
    const d = nyParts(new Date(b.time * 1000)).day;
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; vol += b.volume;
    if (vol > 0) out.push({ time: shift(b.time), value: pv / vol });
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
    const data = await api(`/api/candles/${encodeURIComponent(sym)}?interval=${iv}`);
    if (sym !== state.symbol || iv !== state.interval) return;
    if (keepView && state.candles.length && data.length) {
      const lastT = state.candles[state.candles.length - 1].time;
      for (const b of data.filter((b) => b.time >= lastT)) { candleS.update(barData(b)); volS.update(volData(b)); }
    } else {
      candleS.setData(data.map(barData)); volS.setData(data.map(volData));
      chart.timeScale().fitContent();
      if (intraday() && data.length > 160) chart.timeScale().setVisibleLogicalRange({ from: data.length - 160, to: data.length + 6 });
    }
    state.candles = data;
    drawIndicators(); updateLegend();
    $("#chartMsg").textContent = data.length ? "" : "no data";
  } catch (e) { $("#chartMsg").textContent = `⚠ ${e.message}`; }
}
function updateLegend(param) {
  const b = param?.seriesData?.get(candleS) || (state.candles.length ? barData(state.candles[state.candles.length - 1]) : null);
  if (!b) { $("#legend").textContent = ""; return; }
  const src = state.candles.find((c) => shift(c.time) === b.time);
  const cls = b.close >= b.open ? "up" : "down";
  $("#legend").innerHTML = `<b>${state.symbol}</b> · ${state.interval} &nbsp; O <b>${fmt(b.open)}</b> H <b>${fmt(b.high)}</b> L <b>${fmt(b.low)}</b> C <b class="${cls}">${fmt(b.close)}</b> V <b>${src ? fmt(src.volume, 0) : "—"}</b>` +
    ` &nbsp;<span style="color:${css("--vwap")}">VWAP</span> <span style="color:${css("--ema9")}">EMA9</span> <span style="color:${css("--ema20")}">EMA20</span>`;
}
chart.subscribeCrosshairMove(updateLegend);

function setSymbol(sym) {
  sym = sym.trim().toUpperCase(); if (!sym) return;
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
  $$(`.tabs[data-group=${group}] button[data-tab]`).forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$(`.tab-body[data-group=${group}]`).forEach((b) => b.classList.toggle("hidden", b.dataset.tab !== tab));
}
$$(".tabs button[data-tab]").forEach((b) => (b.onclick = () => showTab(b.parentElement.dataset.group, b.dataset.tab)));

/* ------------------------------------------------------------------ Claude copilot */
function deskContext() {
  const q = state.quotes[state.symbol] || {}, m = marketState();
  return `[Desk context — ${ryFmt.format(new Date())} Riyadh, US market ${m.s}] Active chart: ${state.symbol} ${state.interval}, last ${fmt(q.last)} (${fmt(q.change_pct)}%). Watchlist: ${state.settings.watchlist.join(", ")}. Trading folder: ${state.status?.trading_dir}.`;
}
function fillTemplate(s) {
  const q = state.quotes[state.symbol] || {};
  return s.replaceAll("{symbol}", state.symbol).replaceAll("{interval}", state.interval)
    .replaceAll("{price}", q.last ? fmt(q.last) : "current price").replaceAll("{watchlist}", state.settings.watchlist.join(", "));
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
  const thinking = chatAdd("sys typing", "Claude is working");
  try {
    const r = await fetch("/api/claude", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: full, session_id: state.sessionId }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        thinking.remove(); $("#chat").append(thinking);
        if (ev.kind === "init") state.sessionId = ev.session_id;
        else if (ev.kind === "text") chatAdd("bot", null, md(ev.text));
        else if (ev.kind === "tool") chatAdd("tool", `⚙ ${ev.name}: ${ev.detail}`);
        else if (ev.kind === "log") chatAdd("tool", ev.text);
        else if (ev.kind === "error") chatAdd("err", ev.text);
        else if (ev.kind === "done") {
          if (ev.session_id) state.sessionId = ev.session_id;
          if (ev.denials?.length) chatAdd("err", `Needs your approval, so it was skipped here: ${[...new Set(ev.denials)].join(", ")}. Run that step in Claude Code, or add the tool under Settings → allowed tools (never the broker/order tools).`);
          chatAdd("meta", `${ev.is_error ? "ended with error · " : ""}${ev.cost != null ? `$${ev.cost.toFixed(4)}` : ""}`);
        }
      }
    }
  } catch (e) { chatAdd("err", e.message); }
  thinking.remove(); state.busy = false; $("#btnSend").disabled = false;
}
$("#chatForm").onsubmit = (e) => { e.preventDefault(); const v = $("#chatInput").value; $("#chatInput").value = ""; sendChat(v); };
$("#chatInput").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#chatForm").requestSubmit(); };
$("#btnNewChat").onclick = () => { state.sessionId = null; $("#chat").innerHTML = ""; chatAdd("sys", "New session started."); };

/* ------------------------------------------------------------------ skills */
function consoleWrite(text, reset) {
  const c = $("#console"); if (reset) c.textContent = ""; c.textContent += text; c.scrollTop = c.scrollHeight;
}
async function runTool(folder, script, args) {
  showTab("bottom", "console"); consoleWrite("", true);
  try {
    const r = await fetch("/api/skills/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, script, args }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; consoleWrite(dec.decode(value, { stream: true })); }
    consoleWrite("\n[done]\n");
  } catch (e) { consoleWrite(`\n⚠ ${e.message}\n`); }
}
function renderSkills() {
  const box = $("#skills"), f = $("#skillFilter").value.toLowerCase(); box.innerHTML = "";
  if (!state.skills.length) { box.append(el("div", "dim pad", `No skills found in ${state.status?.skills_dir}. Fix the folder in Settings ⚙.`)); return; }
  for (const s of state.skills) {
    if (f && !`${s.name} ${s.description}`.toLowerCase().includes(f)) continue;
    const d = el("details", "skill"), sum = el("summary");
    sum.append(el("div", "skill-name", s.name), el("div", "skill-desc", s.description));
    const body = el("div", "skill-body");
    const ask = el("button", "primary small", `Ask Claude to use ${s.name}`);
    ask.onclick = () => { showTab("side", "copilot"); const t = $("#chatInput"); t.value = `Use the ${s.name} skill for ${state.symbol}: `; t.focus(); };
    body.append(ask);
    for (const t of s.tools) {
      const row = el("div", "tool-row"), ctl = el("div", "tctl");
      const inp = el("input"); inp.placeholder = "args, e.g. {symbol} --json"; inp.value = "";
      const run = el("button", "primary small", "Run"), help = el("button", "ghost small", "--help");
      const go = (a) => runTool(s.folder, t, fillTemplate(a));
      run.onclick = () => go(inp.value); help.onclick = () => go("--help");
      inp.onkeydown = (e) => { if (e.key === "Enter") go(inp.value); };
      ctl.append(inp, run, help); row.append(el("div", "tname", t), ctl); body.append(row);
    }
    if (!s.tools.length) body.append(el("div", "dim small", "No Python tools — this skill is instructions-only; use it through Claude."));
    const docs = el("div", "skill-md md"); docs.innerHTML = md(s.body); body.append(docs);
    d.append(sum, body); box.append(d);
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
function clearPlan() { state.planLines.forEach((l) => candleS.removePriceLine(l)); state.planLines = []; }
$("#btnClearPlan").onclick = clearPlan;
$("#btnDrawPlan").onclick = () => {
  const p = calcRisk(); if (!p) return; clearPlan();
  const add = (price, color, title, style = 0) => state.planLines.push(candleS.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
  add(p.entry, css("--accent"), `ENTRY ${p.shares}`); add(p.stop, css("--down"), "STOP");
  p.targets.forEach((t, i) => add(t, css("--up"), `${i + 1}R`, 2));
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
  for (const k of ["skills_dir", "skill_prefix", "trading_dir", "guide_path", "claude_command", "claude_model", "tool_timeout_sec"]) f[k].value = s[k] ?? "";
  f.claude_allowed_tools.value = (s.claude_allowed_tools || []).join(", "); f.watchlist.value = s.watchlist.join(", ");
  $("#settingsDlg").showModal();
};
$("#settingsDlg").addEventListener("close", async () => {
  if ($("#settingsDlg").returnValue !== "save") return;
  const f = $("#settingsForm"), list = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
  await saveSettings({
    skills_dir: f.skills_dir.value.trim(), skill_prefix: f.skill_prefix.value.trim(), trading_dir: f.trading_dir.value.trim(),
    guide_path: f.guide_path.value.trim(), claude_command: f.claude_command.value.trim() || "claude", claude_model: f.claude_model.value.trim(),
    claude_allowed_tools: list(f.claude_allowed_tools.value), watchlist: list(f.watchlist.value.toUpperCase()), tool_timeout_sec: +f.tool_timeout_sec.value || 300,
  });
  await loadStatus(); await loadSkills(); loadGuide();
});
async function loadStatus() {
  const st = (state.status = await api("/api/status"));
  const b = $("#modeBadge");
  if (st.paper === true) { b.className = "badge paper"; b.textContent = "PAPER"; }
  else if (st.paper === false) { b.className = "badge live"; b.textContent = "LIVE MONEY"; }
  else { b.className = "badge muted"; b.textContent = st.config_error ? "CONFIG ERROR" : "NO CONFIG"; }
  b.title = st.config_path;
  $("#claudeDot").className = `dot ${st.claude_found ? "ok" : "bad"}`;
  $("#skillsCount").textContent = `· ${st.skills_count} skills`;
  $("#configView").textContent = st.config ? JSON.stringify(st.config, null, 2) : st.config_error || `Not found: ${st.config_path}`;
  prefillRiskFromConfig(st.config);
}
async function loadSkills() { state.skills = await api("/api/skills"); renderSkills(); }
async function loadGuide() {
  const g = await api("/api/guide");
  $("#guide").innerHTML = g.markdown ? md(g.markdown) : `<p class="dim">GUIDE.md not found in the trading folder. Set its path in Settings ⚙.</p>`;
}

/* ------------------------------------------------------------------ wiring */
$("#symForm").onsubmit = (e) => { e.preventDefault(); setSymbol($("#symInput").value); };
$("#addSymForm").onsubmit = (e) => {
  e.preventDefault(); const v = $("#addSym").value.trim().toUpperCase(); $("#addSym").value = "";
  if (v && !state.settings.watchlist.includes(v)) saveSettings({ watchlist: [...state.settings.watchlist, v] });
};
$$("#intervals button").forEach((b) => (b.onclick = () => {
  $$("#intervals button").forEach((x) => x.classList.toggle("on", x === b)); state.interval = b.dataset.i; state.candles = []; loadChart(); renderWorkflows();
}));
$$("#indicators button").forEach((b) => (b.onclick = () => { state.ind[b.dataset.ind] = !state.ind[b.dataset.ind]; b.classList.toggle("on"); drawIndicators(); }));
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { e.preventDefault(); $("#symInput").select(); }
});

(async function init() {
  marked.setOptions({ gfm: true, breaks: true });
  tickClock(); setInterval(tickClock, 1000);
  state.settings = await api("/api/settings");
  state.symbol = state.settings.watchlist[0] || "SPY"; $("#symInput").value = state.symbol;
  $("#tradeForm").date.value = new Date().toISOString().slice(0, 10);
  state.workflows = await api("/api/workflows");
  renderWatchlist(); renderWorkflows(); loadChart();
  await Promise.allSettled([loadStatus(), loadSkills(), loadGuide(), loadJournal(), refreshQuotes()]);
  renderWorkflows();
  setInterval(refreshQuotes, 15000);
  setInterval(() => { if (intraday() && marketState().s !== "closed") loadChart(true); }, 20000);
  setInterval(() => loadStatus().catch(() => {}), 60000);
})();
