"use strict";
/* Live layer: one 10-second quote loop for everything on screen, a "last updated" indicator in the top bar,
   and a refresh of the visible screen when the tab comes back. Prices are polled, not streamed.
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
  const src = state.live.source === "alpaca" ? "Real-time" : state.live.source === "yahoo" ? "Yahoo feed" : "Prices";
  const closed = typeof marketState === "function" && marketState().s === "closed";
  let cls = "ok", text;
  if (age == null) { cls = "wait"; text = "Connecting…"; }
  else if (age > 45) { cls = "stale"; text = `No update for ${age < 120 ? age + "s" : Math.round(age / 60) + "m"}`; }
  else text = `${closed ? "Stocks closed" : src} · ${age < 2 ? "just now" : age + "s ago"}`;
  box.className = `clock live-box ${cls}`; txt.textContent = text;
  box.title = `Prices are re-read every ${LIVE_MS / 1000} seconds while this tab is open (not streamed). ${state.live.source === "alpaca" ? "Source: Alpaca, real-time." : "Source: Yahoo, which can lag by up to 15 minutes for stocks; add Alpaca keys in Settings for real-time."}${closed ? " The US stock market is closed, so stock prices do not move; crypto still does." : ""}`;
}

async function liveTick() {
  if (document.hidden || !state.settings) return;
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
