"use strict";
/* Trade-plan visualization on a Lightweight Charts candlestick chart (TradingView "long/short position" style):
   shaded risk (entry→stop) and reward (entry→final target) zones, labelled price lines with R multiples,
   and markers for when the plan was made, when the entry triggered and how it ended (target / stop),
   plus the user's paper trades in that symbol. Loaded before board.js and app.js. */

const planCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const planFmt = (n) => (n == null || isNaN(n) ? "—" : Number(n).toFixed(Number(n) >= 1000 ? 1 : 2));

/** Normalize a recommendation / risk-tab plan. */
function makePlan(p, time) {
  const n = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
  const side = /short/i.test(p.bias || p.side || "") ? "short" : "long";
  const targets = (p.targets || []).map(n).filter((x) => x !== null);
  return { symbol: String(p.symbol || "").toUpperCase(), side, entry: n(p.entry), stop: n(p.stop), targets, time: time ?? p._t ?? null, setup: p.setup || "", raw: p };
}

/** Replay the plan on the bars after it was made: did the entry trigger, then target or stop? */
function replayPlan(plan, bars) {
  const ev = [];
  if (!plan.time || plan.entry == null || !bars.length) return { ev, status: plan.time ? "No price data after the plan." : null };
  let i = bars.findIndex((b) => b.time >= plan.time);
  if (i < 0) return { ev, status: "Waiting for price data after the plan time." };
  ev.push({ time: bars[i].time, kind: "plan" });
  const long = plan.side === "long", ref = bars[i].open;
  // Entry above the market for a long (below for a short) is a breakout trigger; otherwise a pullback limit.
  const breakout = long ? plan.entry > ref : plan.entry < ref;
  let entryAt = -1;
  for (; i < bars.length; i++) {
    const b = bars[i];
    const hit = breakout ? (long ? b.high >= plan.entry : b.low <= plan.entry) : (long ? b.low <= plan.entry : b.high >= plan.entry);
    if (hit) { entryAt = i; break; }
  }
  if (entryAt < 0) return { ev, status: `Entry ${planFmt(plan.entry)} not triggered yet (${breakout ? "breakout" : "pullback"} entry).` };
  ev.push({ time: bars[entryAt].time, kind: "entry" });
  const risk = Math.abs(plan.entry - (plan.stop ?? plan.entry)) || null;
  const R = (px) => (risk ? ((px - plan.entry) * (long ? 1 : -1)) / risk : null);
  let next = 0;
  for (let j = entryAt + (breakout ? 0 : 1); j < bars.length; j++) {
    const b = bars[j];
    if (plan.stop != null && (long ? b.low <= plan.stop : b.high >= plan.stop)) {
      ev.push({ time: b.time, kind: "stop" });
      return { ev, status: `Triggered, then ${next ? `hit T${next} and later ` : ""}stopped out (${next ? "partial win" : "-1R"}).`, outcome: next ? "mixed" : "loss" };
    }
    while (next < plan.targets.length && (long ? b.high >= plan.targets[next] : b.low <= plan.targets[next])) {
      ev.push({ time: b.time, kind: `t${next + 1}` });
      next++;
    }
    if (next === plan.targets.length && next > 0) {
      const r = R(plan.targets[next - 1]);
      return { ev, status: `Triggered and reached every target (${r == null ? "" : `+${r.toFixed(1)}R`}).`, outcome: "win" };
    }
  }
  const last = bars.at(-1).close, r = R(last);
  return { ev, status: `Triggered${next ? `, T${next} hit` : ""}, still open: ${r == null ? "" : `${r >= 0 ? "+" : ""}${r.toFixed(2)}R now`}.`, outcome: next ? "win" : "open" };
}

/**
 * Attach a plan layer to a chart. `host` must be the chart's position:relative container.
 * opts.shift maps UTC bar times to the chart's display times (the main chart shows local time).
 */
function createPlanLayer(chart, series, host, opts = {}) {
  const shiftT = opts.shift || ((t) => t);
  const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgEl.setAttribute("class", "plan-svg");
  host.append(svgEl);
  const info = document.createElement("div"); info.className = "plan-info hidden"; host.append(info);
  let plan = null, lines = [], separators = [], raf = 0, alive = true, startX = null;

  series.applyOptions({
    autoscaleInfoProvider: (orig) => {
      const r = orig();
      if (!r || !plan) return r;
      const lv = [plan.entry, plan.stop, ...plan.targets].filter((x) => x != null);
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...lv), maxValue: Math.max(r.priceRange.maxValue, ...lv) } };
    },
  });

  const S = (tag, a) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in a) e.setAttribute(k, a[k]); svgEl.append(e); return e; };
  function draw() {
    if (!alive) return;
    raf = requestAnimationFrame(draw);
    if (!host.offsetParent) return; // hidden tab
    const ts = chart.timeScale(), w = ts.width(), h = host.clientHeight;
    svgEl.setAttribute("width", w); svgEl.setAttribute("height", h); svgEl.innerHTML = "";
    for (const t of separators) {
      const x = ts.timeToCoordinate(t);
      if (x != null && x > 0 && x < w) S("line", { x1: x, x2: x, y1: 0, y2: h, stroke: planCss("--line"), "stroke-dasharray": "3 4" });
    }
    if (!plan || plan.entry == null) return;
    const y = (p) => series.priceToCoordinate(p);
    let x0 = startX != null ? ts.timeToCoordinate(startX) : null;
    x0 = x0 == null ? 0 : Math.max(0, Math.min(w, x0));
    const ye = y(plan.entry);
    if (ye == null) return;
    const zone = (p, color, label) => {
      const yy = y(p); if (yy == null) return;
      S("rect", { x: x0, y: Math.min(ye, yy), width: Math.max(0, w - x0), height: Math.abs(yy - ye), fill: color, "fill-opacity": 0.13 });
      const t = S("text", { x: w - 8, y: yy + (yy < ye ? 14 : -6), "text-anchor": "end", class: "plan-zone-label", fill: color });
      t.textContent = label;
    };
    const risk = plan.stop != null ? Math.abs(plan.entry - plan.stop) : null;
    const last = plan.targets.at(-1);
    if (last != null) zone(last, planCss("--up"), `Reward ${planFmt(last)}${risk ? ` · ${(Math.abs(last - plan.entry) / risk).toFixed(1)}R` : ""}`);
    if (plan.stop != null) zone(plan.stop, planCss("--down"), `Risk ${planFmt(plan.stop)} · -1R`);
  }
  raf = requestAnimationFrame(draw);

  function clearLines() { lines.forEach((l) => series.removePriceLine(l)); lines = []; }
  return {
    get plan() { return plan; },
    /** Show a plan; `bars` are the chart's (UTC) bars, used for the replay markers. */
    set(p, bars = [], extraMarkers = []) {
      plan = p; clearLines();
      const add = (price, color, title, style = 0, width = 1) => price != null && lines.push(series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
      const risk = p.stop != null && p.entry != null ? Math.abs(p.entry - p.stop) : null;
      add(p.entry, planCss("--accent"), `${p.side === "long" ? "BUY" : "SHORT"} ${planFmt(p.entry)}`, 0, 2);
      add(p.stop, planCss("--down"), "STOP", 2);
      p.targets.forEach((t, i) => add(t, planCss("--up"), `T${i + 1}${risk ? ` ${(Math.abs(t - p.entry) / risk).toFixed(1)}R` : ""}`, 2));
      const { ev, status } = replayPlan(p, bars);
      startX = p.time ? shiftT((bars.find((b) => b.time >= p.time) || bars.at(-1) || { time: p.time }).time) : null;
      const M = {
        plan: { position: "aboveBar", color: "#94a3b8", shape: "circle", text: "Plan" },
        entry: p.side === "long" ? { position: "belowBar", color: planCss("--accent"), shape: "arrowUp", text: `Entry ${planFmt(p.entry)}` }
                                 : { position: "aboveBar", color: planCss("--accent"), shape: "arrowDown", text: `Entry ${planFmt(p.entry)}` },
        stop: { position: p.side === "long" ? "belowBar" : "aboveBar", color: planCss("--down"), shape: "square", text: `Stop ${planFmt(p.stop)}` },
      };
      const markers = ev.map((e) => ({ time: shiftT(e.time), ...(M[e.kind] || { position: p.side === "long" ? "aboveBar" : "belowBar", color: planCss("--up"), shape: "circle", text: `${e.kind.toUpperCase()} ${planFmt(p.targets[Number(e.kind.slice(1)) - 1])}` }) }));
      series.setMarkers([...markers, ...extraMarkers].sort((a, b) => a.time - b.time));
      // Info box
      info.classList.remove("hidden"); info.innerHTML = "";
      const head = document.createElement("div"); head.className = "plan-head";
      const b = document.createElement("b"); b.textContent = `${p.symbol} ${p.side.toUpperCase()}`; b.className = p.side === "long" ? "up" : "down";
      head.append(b, document.createTextNode(` ${p.setup ? `· ${p.setup}` : ""}`));
      const lv = document.createElement("div"); lv.className = "plan-lv";
      lv.textContent = `Entry ${planFmt(p.entry)} · Stop ${planFmt(p.stop)}${risk ? ` (-${planFmt(risk)})` : ""} · ${p.targets.map((t, i) => `T${i + 1} ${planFmt(t)}${risk ? ` (${(Math.abs(t - p.entry) / risk).toFixed(1)}R)` : ""}`).join(" · ")}`;
      info.append(head, lv);
      if (status) { const st = document.createElement("div"); st.className = "plan-status"; st.textContent = status; info.append(st); }
      if (opts.actions) { const a = document.createElement("div"); a.className = "plan-actions"; opts.actions(a, p); info.append(a); }
    },
    clear() { plan = null; startX = null; clearLines(); series.setMarkers([]); info.classList.add("hidden"); },
    setSeparators(times) { separators = times; },
    destroy() { alive = false; cancelAnimationFrame(raf); clearLines(); svgEl.remove(); info.remove(); },
  };
}

/** Markers for the user's paper trades in a symbol (times are UTC seconds). */
function paperMarkers(symbol, bars, shiftT = (t) => t) {
  const d = typeof state !== "undefined" ? state.paper : null;
  if (!d || !bars.length) return [];
  const barAt = (t) => { let best = null; for (const b of bars) { if (b.time <= t) best = b; else break; } return best; };
  const out = [];
  const add = (t, m) => { const b = barAt(t); if (b) out.push({ time: shiftT(b.time), ...m }); };
  for (const p of [...(d.positions || []), ...(d.trades || [])].filter((x) => x.symbol === symbol)) {
    add(p.opened_at, { position: p.side === "long" ? "belowBar" : "aboveBar", color: "#a78bfa", shape: p.side === "long" ? "arrowUp" : "arrowDown", text: `Paper ${p.side === "long" ? "buy" : "short"} ${p.qty}` });
    if (p.closed_at) add(p.closed_at, { position: p.side === "long" ? "aboveBar" : "belowBar", color: (p.pnl ?? 0) >= 0 ? "#22c55e" : "#ef4444", shape: "circle", text: `Paper exit ${(p.pnl ?? 0) >= 0 ? "+" : ""}$${Number(p.pnl ?? 0).toFixed(0)}` });
  }
  return out;
}

/** A self-contained candlestick chart of one recommendation (used inside the market board). Returns a dispose fn. */
function renderTradeChart(host, pick, time, { height = 320 } = {}) {
  host.innerHTML = ""; host.classList.add("trade-chart");
  const box = document.createElement("div"); box.className = "trade-chart-box"; box.style.height = `${height}px`; host.append(box);
  const shiftT = (t) => t - new Date(t * 1000).getTimezoneOffset() * 60;
  const c = LightweightCharts.createChart(box, {
    autoSize: true,
    layout: { background: { color: planCss("--panel-2") }, textColor: planCss("--dim"), fontFamily: planCss("--font") },
    grid: { vertLines: { color: "#161c27" }, horzLines: { color: "#161c27" } },
    rightPriceScale: { borderColor: planCss("--line") }, timeScale: { borderColor: planCss("--line"), timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  const cs = c.addCandlestickSeries({ upColor: planCss("--up"), downColor: planCss("--down"), borderVisible: false, wickUpColor: planCss("--up"), wickDownColor: planCss("--down") });
  const vs = c.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "v", lastValueVisible: false, priceLineVisible: false });
  c.priceScale("v").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  const vw = c.addLineSeries({ color: planCss("--vwap"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const plan = makePlan(pick, time);
  const layer = createPlanLayer(c, cs, box, {
    shift: shiftT,
    actions: (a, p) => {
      const t = document.createElement("button"); t.className = "primary small"; t.textContent = p.side === "long" ? "📝 Paper buy" : "📝 Paper short";
      t.onclick = (e) => { e.stopPropagation(); openTicketFromPick(pick); };
      const o = document.createElement("button"); o.className = "ghost small"; o.textContent = "open on main chart";
      o.onclick = (e) => { e.stopPropagation(); showPlanOnMain(pick, time); };
      a.append(t, o);
    },
  });
  const msg = document.createElement("div"); msg.className = "dim small trade-chart-msg"; msg.textContent = "loading chart…"; host.append(msg);
  (async () => {
    try {
      // Enough history for the plan day plus the previous session for context.
      const ageDays = time ? Math.ceil((Date.now() / 1000 - time) / 86400) : 0;
      const bars = await api(`/api/candles/${encodeURIComponent(plan.symbol)}?interval=5m&days=${Math.min(59, ageDays + 4)}`);
      if (!bars.length) { msg.textContent = "No price data."; return; }
      cs.setData(bars.map((b) => ({ time: shiftT(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
      vs.setData(bars.map((b) => ({ time: shiftT(b.time), value: b.volume, color: b.close >= b.open ? "rgba(34,197,94,.3)" : "rgba(239,68,68,.3)" })));
      // Session VWAP
      let day = null, pv = 0, v = 0; const vwd = [];
      for (const b of bars) {
        const d = nyParts(new Date(b.time * 1000)).day, fresh = d !== day && day !== null;
        if (d !== day) { day = d; pv = 0; v = 0; }
        pv += ((b.high + b.low + b.close) / 3) * b.volume; v += b.volume;
        if (fresh && vwd.length) vwd[vwd.length - 1].color = "rgba(0,0,0,0)";
        if (v) vwd.push({ time: shiftT(b.time), value: pv / v, ...(fresh ? { color: "rgba(0,0,0,0)" } : {}) });
      }
      vw.setData(vwd);
      layer.set(plan, bars, paperMarkers(plan.symbol, bars, shiftT));
      // Show from the start of the plan's session (or the last session) to now.
      const anchor = time ? nyParts(new Date(time * 1000)).day : nyParts(new Date(bars.at(-1).time * 1000)).day;
      let from = bars.findIndex((b) => nyParts(new Date(b.time * 1000)).day === anchor);
      if (from < 0) from = Math.max(0, bars.length - 120);
      c.timeScale().setVisibleLogicalRange({ from: from - 1, to: bars.length + 4 });
      msg.remove();
    } catch (e) { msg.textContent = `chart unavailable (${e.message})`; }
  })();
  return () => { layer.destroy(); c.remove(); };
}
