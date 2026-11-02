"use strict";
/* A self-contained live chart of one symbol: used by pop-out windows (chart.html) and the Monitor grid.
   createMiniChart(host, { symbol, range, interval, indicators, signals, onSignal, onQuote }) -> controller. */

const MC_NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const MC_RANGES = {
  "1D": { days: 4, def: "5m", allow: ["1m", "5m", "15m"], sessions: 1 },
  "5D": { days: 9, def: "15m", allow: ["1m", "5m", "15m", "60m"], sessions: 5 },
  "1M": { days: 45, def: "60m", allow: ["5m", "15m", "60m", "1d"], cal: 31 },
  "3M": { days: 130, def: "1d", allow: ["60m", "1d"], cal: 92 },
  "1Y": { days: 420, def: "1d", allow: ["1d"], cal: 365 },
};
const mcCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const mcShift = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
const mcDay = (t) => { const p = Object.fromEntries(MC_NY.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
const mcFmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const mcTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function mcEma(data, n) { const k = 2 / (n + 1); let p = null; return data.map((b) => { p = p == null ? b.close : b.close * k + p * (1 - k); return { time: mcShift(b.time), value: p }; }); }
function mcVwap(data) {
  let day = null, pv = 0, vol = 0; const out = [];
  for (const b of data) {
    const d = mcDay(b.time).day, fresh = d !== day && day !== null;
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += ((b.high + b.low + b.close) / 3) * b.volume; vol += b.volume;
    if (fresh && out.length) out[out.length - 1].color = "rgba(0,0,0,0)";
    if (vol > 0) out.push({ time: mcShift(b.time), value: pv / vol, ...(fresh ? { color: "rgba(0,0,0,0)" } : {}) });
  }
  return out;
}

async function mcApi(path) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" } });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `${r.status}`); }
  return r.json();
}

function createMiniChart(host, opts = {}) {
  const st = { symbol: (opts.symbol || "SPY").toUpperCase(), range: opts.range || "1D", interval: opts.interval || "5m",
    ind: { vwap: true, ema9: true, ema20: true, ...(opts.indicators || {}) }, signals: opts.signals !== false, candles: [], timer: null, disposed: false };
  const LW = LightweightCharts;
  const chart = LW.createChart(host, {
    autoSize: true,
    layout: { background: { color: mcCss("--panel") }, textColor: mcCss("--dim"), fontFamily: mcCss("--font"), fontSize: opts.fontSize || 11 },
    grid: { vertLines: { color: mcCss("--grid") }, horzLines: { color: mcCss("--grid") } },
    crosshair: { mode: LW.CrosshairMode.Normal },
    rightPriceScale: { borderColor: mcCss("--line") },
    timeScale: { borderColor: mcCss("--line"), timeVisible: true, secondsVisible: false, rightOffset: 4 },
  });
  const candles = chart.addCandlestickSeries({ upColor: mcCss("--up"), downColor: mcCss("--down"), borderVisible: false, wickUpColor: mcCss("--up"), wickDownColor: mcCss("--down") });
  const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const line = (c) => chart.addLineSeries({ color: c, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const vwapS = line(mcCss("--vwap")), ema9S = line(mcCss("--ema9")), ema20S = line(mcCss("--ema20"));
  const engine = createSignalEngine({ intervalSec: INTERVAL_SEC[st.interval], shift: mcShift, minFit: opts.minFit ?? 0.35 });
  // Plan monitor: entry / expected exit / exit detection for this symbol (see planmon.js).
  const mon = opts.plan === false ? null : createPlanMonitor({ series: candles, shift: mcShift, onEvent: (ev) => { markers(); opts.onPlanEvent?.(ev); }, onStatus: (text, cls, plan) => opts.onPlanStatus?.(text, cls, plan) });
  if (mon) mon.setSymbol(st.symbol);
  const intraday = () => st.interval !== "1d";

  function view(data) {
    const r = MC_RANGES[st.range]; if (!data.length) return;
    let from = 0;
    if (r.sessions) { const days = [...new Set(data.map((b) => mcDay(b.time).day))]; const first = days[Math.max(0, days.length - r.sessions)]; from = data.findIndex((b) => mcDay(b.time).day === first); }
    else { const cut = Date.now() / 1000 - r.cal * 86400; from = Math.max(0, data.findIndex((b) => b.time >= cut)); }
    chart.timeScale().setVisibleLogicalRange({ from: from - 0.5, to: data.length + 4 });
  }
  function indicators() {
    const d = st.candles;
    vwapS.setData(st.ind.vwap && intraday() ? mcVwap(d) : []); ema9S.setData(st.ind.ema9 ? mcEma(d, 9) : []); ema20S.setData(st.ind.ema20 ? mcEma(d, 20) : []);
  }
  function markers() {
    const paper = typeof paperMarkers === "function" ? paperMarkers(st.symbol, st.candles, mcShift) : [];
    const sig = st.signals ? engine.markers() : [];
    candles.setMarkers([...paper, ...sig, ...(mon ? mon.markers() : [])].sort((a, b) => a.time - b.time));
  }
  async function load(keep = false) {
    if (st.disposed) return;
    const sym = st.symbol, iv = st.interval, rg = st.range;
    try {
      const data = await mcApi(`/api/candles/${encodeURIComponent(sym)}?interval=${iv}&days=${MC_RANGES[rg].days}`);
      if (st.disposed || sym !== st.symbol || iv !== st.interval || rg !== st.range) return;
      const bar = (b) => ({ time: mcShift(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
      const vb = (b) => ({ time: mcShift(b.time), value: b.volume, color: b.close >= b.open ? "rgba(34,197,94,.35)" : "rgba(239,68,68,.35)" });
      if (keep && st.candles.length && data.length) { const lastT = st.candles[st.candles.length - 1].time; for (const b of data.filter((x) => x.time >= lastT)) { candles.update(bar(b)); vol.update(vb(b)); } }
      else { candles.setData(data.map(bar)); vol.setData(data.map(vb)); view(data); }
      st.candles = data; indicators();
      const fresh = st.signals ? engine.update(data) : [];
      if (mon) mon.update(data, engine.list());
      markers();
      const last = data[data.length - 1];
      opts.onQuote?.({ symbol: sym, last: last?.close, bars: data.length, empty: !data.length });
      if (fresh.length) opts.onSignal?.(fresh, { symbol: sym, latestBar: last?.time ?? 0, all: engine.list() });
      else if (!keep) opts.onSignal?.([], { symbol: sym, latestBar: last?.time ?? 0, all: engine.list() });
    } catch (e) { opts.onError?.(e); }
  }
  const tick = () => { if (intraday()) load(true); };
  st.timer = setInterval(tick, opts.refreshMs || 20000);
  load();
  return {
    chart, series: candles, engine, monitor: mon,
    get symbol() { return st.symbol; }, get interval() { return st.interval; }, get range() { return st.range; }, get ind() { return st.ind; }, get signals() { return st.signals; },
    setSymbol(s) { s = String(s || "").trim().toUpperCase(); if (!s || s === st.symbol) return; st.symbol = s; st.candles = []; engine.reset(); if (mon) mon.setSymbol(s); load(); },
    setModels(m) { engine.setModels(m); engine.update(st.candles); markers(); opts.onSignal?.([], { symbol: st.symbol, latestBar: st.candles.at(-1)?.time ?? 0, all: st.signals ? engine.list() : [] }); },
    setRange(r) { if (!MC_RANGES[r]) return; st.range = r; if (!MC_RANGES[r].allow.includes(st.interval)) this.setInterval(MC_RANGES[r].def); else load(); },
    setInterval(iv) { if (!INTERVAL_SEC[iv]) return; st.interval = iv; engine.setInterval(INTERVAL_SEC[iv]); engine.reset(); st.candles = []; load(); },
    toggleIndicator(k) { st.ind[k] = !st.ind[k]; indicators(); return st.ind[k]; },
    setSignals(on) { st.signals = !!on; if (on) engine.update(st.candles); markers(); opts.onSignal?.([], { symbol: st.symbol, latestBar: st.candles.at(-1)?.time ?? 0, all: on ? engine.list() : [] }); },
    refresh() { load(true); },
    retheme() {
      chart.applyOptions({ layout: { background: { color: mcCss("--panel") }, textColor: mcCss("--dim") }, grid: { vertLines: { color: mcCss("--grid") }, horzLines: { color: mcCss("--grid") } }, rightPriceScale: { borderColor: mcCss("--line") }, timeScale: { borderColor: mcCss("--line") } });
      candles.applyOptions({ upColor: mcCss("--up"), downColor: mcCss("--down"), wickUpColor: mcCss("--up"), wickDownColor: mcCss("--down") });
      vwapS.applyOptions({ color: mcCss("--vwap") }); ema9S.applyOptions({ color: mcCss("--ema9") }); ema20S.applyOptions({ color: mcCss("--ema20") }); markers();
    },
    dispose() { st.disposed = true; clearInterval(st.timer); if (mon) mon.dispose(); chart.remove(); },
  };
}

/** Open a symbol in its own browser window (one window per symbol; a second call focuses it). */
function openChartWindow(symbol, { index = 0 } = {}) {
  const sym = String(symbol || "").trim().toUpperCase(); if (!sym) return null;
  const w = 760, h = 560, off = (index % 6) * 36;
  const feats = `popup=yes,width=${w},height=${h},left=${80 + off},top=${60 + off},resizable=yes,scrollbars=no`;
  const win = window.open(`/chart.html?symbol=${encodeURIComponent(sym)}`, `chart-${sym}`, feats);
  if (win) win.focus();
  return win;
}
