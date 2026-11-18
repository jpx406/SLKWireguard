"use strict";
/* Live layer: a websocket stream of trades when the desk has one (Alpaca keys + the QuoteHub relay), and a quote
   poll for everything else (every 10 seconds, or every 30 as a safety net while the stream is up); a "last updated"
   indicator in the top bar; and a refresh of the visible screen when the tab comes back.
   Any element tagged with liveTag(node, symbol, "px" | "pxchg") is patched in place and flashes when it changes. */

const LIVE_MS = 10000;

// Every successful GET to the desk's API counts as "data arrived".
(() => {
  const orig = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const r = await orig(...a);
    try {
      const u = typeof a[0] === "string" ? a[0] : a[0]?.url || "", method = (a[1]?.method || "GET").toUpperCase();
      if (r.ok && method === "GET" && u.includes("/api/")) state.live.last = Date.now();
    } catch { /* never break a request */ }
    return r;
  };
})();

function liveIndicator() {
  let box = $("#liveBox");
  if (!box) {
    const bar = $(".top-right"); if (!bar) return;
    box = el("div", "clock live-box"); box.id = "liveBox";
    box.append(el("span", "live-dot"), Object.assign(el("span", "live-txt mono"), { id: "liveTxt" }));
    bar.prepend(box);
  }
  const txt = $("#liveTxt"), age = state.live.last ? Math.round((Date.now() - state.live.last) / 1000) : null;
  const st = state.stream, streaming = st.open && (st.stocks === "live" || st.crypto === "live");
  const src = streaming ? "Live stream" : state.live.source === "alpaca" ? "Real-time" : state.live.source === "yahoo" ? "Yahoo feed" : "Prices";
  const closed = typeof marketState === "function" && marketState().s === "closed";
  let cls = "ok", text;
  if (age == null) { cls = "wait"; text = "Connecting…"; }
  else if (age > 45) { cls = "stale"; text = `No update for ${age < 120 ? age + "s" : Math.round(age / 60) + "m"}`; }
  else text = `${closed ? "Stocks closed" : src} · ${age < 2 ? "just now" : age + "s ago"}`;
  box.className = `clock live-box ${cls}${streaming && cls === "ok" ? " stream" : ""}`; txt.textContent = text;
  box.title = `${streaming ? `Trades are streamed as they happen (Alpaca ${st.feed === "sip" ? "SIP, all exchanges" : "IEX exchange"}${st.streaming.length ? `, ${st.streaming.length} symbols` : ""}); symbols the stream does not carry are re-read every ${LIVE_MS / 1000} seconds.` : `Prices are re-read every ${LIVE_MS / 1000} seconds while this tab is open (not streamed). ${state.live.source === "alpaca" ? "Source: Alpaca, real-time." : "Source: Yahoo, which can lag by up to 15 minutes for stocks; add Alpaca keys in Settings for real-time."}`}${st.detail ? ` Stream: ${st.detail}.` : ""}${closed ? " The US stock market is closed, so stock prices do not move; crypto still does." : ""}`;
}

async function liveTick() {
  if (document.hidden || !state.settings) return;
  // While trades are really arriving for everything on screen, the poll is only a safety net (and refreshes
  // yesterday's close and volume). A quiet stream (market closed) or a symbol the stream does not carry keeps the 10 s poll.
  const sx = state.stream, covered = sx.open && Date.now() - sx.lastTick < 15000 && liveSymbols().every((s) => sx.streaming.includes(s));
  if (covered && Date.now() - (sx.polled || 0) < 29000) return;
  sx.polled = Date.now();
  const tagged = $$("[data-live]").filter((n) => n.offsetParent !== null);
  const syms = [...new Set([...(state.settings.watchlist || []), state.symbol, ...tagged.map((n) => n.dataset.live)].filter(Boolean))];
  if (!syms.length) return;
  let qs;
  try { qs = await api(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`); } catch { return; }
  const by = {};
  for (const q of qs) if (!q.error) { by[q.symbol] = q; if (q.source) state.live.source = q.source; }
  const mine = new Set([...(state.settings.watchlist || []), state.symbol]);
  for (const s of mine) if (by[s]) state.quotes[s] = by[s];
  renderWatchlist(); renderActiveQuote();
  for (const n of tagged) {
    const q = by[n.dataset.live]; if (!q || q.last == null || !n.isConnected) continue;
    const text = n.dataset.liveKind === "pxchg" ? `${fmt(q.last)}${q.change_pct == null ? "" : `  ${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct)}%`}` : fmt(q.last);
    if (n.textContent !== text) n.textContent = text;
    flashEl(n, `t:${n.dataset.live}`, q.last);
  }
  liveIndicator();
}

/** Reload whatever data screen is in front (used when the tab becomes visible again). */
function liveReloadVisible() {
  const loaders = { master: "loadMaster", crypto: "loadCrypto", dashboard: "loadDashboard", quant: "loadQuant", paper: "loadPaper" };
  for (const [sec, fn] of Object.entries(loaders)) if (sectionVisible(sec) && typeof window[fn] === "function") { try { window[fn](); } catch { /* next tick */ } }
}

/* ---- Stream: trades pushed by the desk's relay. The relay holds the one Alpaca connection; this page only tells
   it which symbols are on screen. If the stream is not available the poll above carries on exactly as before. */
state.stream = { ws: null, open: false, stocks: "off", crypto: "off", feed: "iex", detail: "", streaming: [], key: "", retry: 0, timer: null, polled: 0, ticks: 0, lastTick: 0, beat: 0 };
const liveSymbols = () => [...new Set([...(state.settings?.watchlist || []), state.symbol, ...$$("[data-live]").filter((n) => n.offsetParent !== null).map((n) => n.dataset.live)].filter(Boolean))];
function streamSubscribe(force) {
  const st = state.stream; if (!st.open) return;
  const syms = liveSymbols(), key = syms.slice().sort().join(","); if (!force && key === st.key) return;
  st.key = key; try { st.ws.send(JSON.stringify({ subscribe: syms })); } catch { /* the close handler reconnects */ }
}
let _streamPaint = false;
function streamTicks(rows) {
  const st = state.stream; st.ticks += rows.length; st.lastTick = Date.now(); state.live.last = Date.now(); state.live.source = "alpaca";
  for (const [sym, px, ts] of rows) {
    const q = state.quotes[sym] || (state.quotes[sym] = { symbol: sym });
    q.last = px; q.source = "alpaca"; if (q.prev) q.change_pct = ((px - q.prev) / q.prev) * 100;
    if (sym === state.symbol) streamCandle(px, ts);
    // Patch what is on screen in place: rebuilding the watchlist four times a second would break taps and hovers.
    const row = document.querySelector(`#watchlist .w-row[data-sym="${CSS.escape(sym)}"]`);
    if (row) { const a = row.querySelector(".w-px"), c = row.querySelector(".w-chg"); if (a) { a.textContent = fmt(px); flashEl(a, "w:" + sym, px); } if (c && q.change_pct != null) { c.textContent = `${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct)}%`; c.className = `w-chg ${q.change_pct > 0 ? "up" : q.change_pct < 0 ? "down" : ""}`; } }
    for (const n of document.querySelectorAll(`[data-live="${CSS.escape(sym)}"]`)) { const text = n.dataset.liveKind === "pxchg" ? `${fmt(px)}${q.change_pct == null ? "" : `  ${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct)}%`}` : fmt(px); if (n.textContent !== text) n.textContent = text; flashEl(n, `t:${sym}`, px); }
  }
  if (!_streamPaint) { _streamPaint = true; requestAnimationFrame(() => { _streamPaint = false; try { renderActiveQuote(); } catch { /* not on screen */ } }); }
}
/** Move the chart's last candle with the trade (or start the next one), so the chart does not wait for its 20-second reload. */
function streamCandle(px, ts) {
  try {
    if (typeof candleS === "undefined" || !candleS || !state.candles?.length || typeof INTERVAL_SEC === "undefined") return;
    const step = INTERVAL_SEC[state.interval]; if (!step || step >= 86400) return;
    const last = state.candles[state.candles.length - 1], t = Math.floor(ts / 1000 / step) * step;
    if (t < last.time || t > last.time + step * 3) return; // an old print, or a gap the next reload will fill properly
    if (t === last.time) { last.close = px; if (px > last.high) last.high = px; if (px < last.low) last.low = px; candleS.update(barData(last)); }
    else { const b = { time: t, open: px, high: px, low: px, close: px, volume: 0 }; state.candles.push(b); candleS.update(barData(b)); }
  } catch { /* the chart reload corrects it */ }
}
function streamConnect() {
  const st = state.stream; if (st.ws || !state.settings || document.hidden) return;
  let ws; try { ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/stream`); } catch { return; }
  st.ws = ws; let opened = false;
  ws.onopen = () => { opened = true; st.open = true; st.retry = 0; st.key = ""; streamSubscribe(true); };
  ws.onmessage = (e) => { if (e.data === "pong") return; let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "q") streamTicks(m.d); else if (m.t === "status") { Object.assign(st, { stocks: m.stocks, crypto: m.crypto, feed: m.feed, detail: m.detail || "", streaming: m.streaming || [] }); liveIndicator(); } };
  ws.onclose = () => { st.ws = null; st.open = false; st.stocks = "off"; st.crypto = "off"; liveIndicator();
    // Never opened = the desk has no stream (no Alpaca keys, or not deployed): ask again in five minutes. Dropped = come back quickly.
    clearTimeout(st.timer); st.timer = setTimeout(() => { st.timer = null; streamConnect(); }, opened ? Math.min(60000, 2000 * 2 ** Math.min(st.retry++, 5)) : 300000); };
  ws.onerror = () => { try { ws.close(); } catch { /* closed */ } };
}
setInterval(() => { const st = state.stream; if (st.open) { streamSubscribe(false); if (++st.beat % 25 === 0) { try { st.ws.send("ping"); } catch { /* closing */ } } } else if (!st.ws && !st.timer) streamConnect(); }, 1000);
document.addEventListener("visibilitychange", () => { const st = state.stream; if (document.hidden) { if (st.ws) { try { st.ws.close(); } catch { /* closed */ } } } else { clearTimeout(st.timer); st.timer = null; streamConnect(); } });

setInterval(liveIndicator, 1000);
setInterval(liveTick, LIVE_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { liveTick(); liveReloadVisible(); } });

/* ---- New version: a page left open (or kept in memory by the phone) keeps running the old code after a deploy.
   Compare the server's deploy id with the one this page loaded under and ask for a refresh when it changed. */
state.version = { loaded: null, snoozed: 0 };
async function checkVersion() {
  let v;
  try { const r = await fetch("/api/version", { cache: "no-store" }); if (!r.ok) return; v = await r.json(); } catch { return; }
  const foot = document.getElementById("lgVersion");
  if (foot && state.version.loaded == null) foot.textContent = `Version ${v.version}${v.at ? ` · ${new Date(v.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}`;
  if (state.version.loaded == null) { state.version.loaded = v.version; return; }
  if (v.version === state.version.loaded) return;
  // On the sign-in screen nothing can be lost: just load the new version.
  if (document.getElementById("loginDlg").open) { location.reload(); return; }
  if (Date.now() > state.version.snoozed) document.getElementById("updateBar").classList.remove("hidden");
}
document.getElementById("btnUpdate").onclick = () => location.reload();
document.getElementById("btnUpdateLater").onclick = () => { state.version.snoozed = Date.now() + 10 * 60000; document.getElementById("updateBar").classList.add("hidden"); };
checkVersion();
setInterval(() => { if (!document.hidden) checkVersion(); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
window.addEventListener("pageshow", (e) => { if (e.persisted) checkVersion(); }); // restored from the phone's back/forward memory
