"use strict";
/* Plan monitor: watches one symbol's plan on a live chart and marks / notifies the entry point, the expected
   exit (stop-loss and targets) and the actual exit (level hit, or a strong reversal signal against the trade).
   The plan comes from /api/plan/:symbol (your open paper position or order, today's latest recommendation,
   or a Deep Analysis). Shared by the main chart, pop-out windows and the Monitor grid. */

const PM_LEVEL_TTL = 60000; // re-read the plan every minute (the autopilot may have entered or exited)
const pmCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const pmFmt = (n) => (n == null || isNaN(n) ? "—" : Number(n).toFixed(Number(n) >= 1000 ? 1 : 2));

/**
 * createPlanMonitor({ series, shift, drawLines, onEvent(ev), onStatus(text, cls) })
 *   setSymbol(sym) -> loads the plan (and keeps it fresh); update(bars, signals) -> evaluates and emits events.
 *   Events: { kind: "entry" | "stop" | "target" | "signal", text, time, price, side }.
 */
function createPlanMonitor(opts = {}) {
  const series = opts.series, shiftT = opts.shift || ((t) => t);
  let symbol = null, plan = null, lines = [], loadedAt = 0, phase = "none", seen = new Set(), marks = [], disposed = false, lastStatus = "", lastBars = null, lastSignals = [];
  const drawLines = () => (typeof opts.drawLines === "function" ? opts.drawLines() : opts.drawLines !== false);

  function clearLines() { if (series) lines.forEach((l) => { try { series.removePriceLine(l); } catch { /* gone */ } }); lines = []; }
  function draw() {
    clearLines();
    if (!drawLines() || !series || !plan) return;
    const add = (price, color, title, style = 2, width = 1) => price != null && lines.push(series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    add(plan.entry, pmCss("--accent"), `${plan.side === "long" ? "BUY" : "SHORT"} ${pmFmt(plan.entry)}`, plan.entered ? 2 : 0, 2);
    add(plan.stop, pmCss("--down"), "STOP");
    plan.targets.forEach((t, i) => add(t, pmCss("--up"), `T${i + 1}`));
  }
  function emit(kind, text, bar, price) {
    const key = `${symbol}|${kind}|${bar?.time ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    const long = plan.side === "long";
    const m = { entry: { position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: pmCss("--accent"), text: `ENTRY ${pmFmt(price)}` },
      stop: { position: long ? "belowBar" : "aboveBar", shape: "square", color: pmCss("--down"), text: `EXIT stop ${pmFmt(price)}` },
      target: { position: long ? "aboveBar" : "belowBar", shape: "circle", color: pmCss("--up"), text: `EXIT ${text.includes("T2") ? "T2" : "T1"} ${pmFmt(price)}` },
      signal: { position: long ? "aboveBar" : "belowBar", shape: "circle", color: pmCss("--warn") || "#f59e0b", text: `EXIT signal` } }[kind];
    if (bar) marks.push({ time: shiftT(bar.time), ...m });
    opts.onEvent?.({ kind, text, time: bar?.time ?? null, price, side: plan.side, symbol });
  }
  function status(text, cls = "") { if (text !== lastStatus) { lastStatus = text; opts.onStatus?.(text, cls, plan); } }

  async function load(force = false) {
    if (!symbol || disposed) return;
    if (!force && Date.now() - loadedAt < PM_LEVEL_TTL) return;
    loadedAt = Date.now();
    try {
      const r = await fetch(`/api/plan/${encodeURIComponent(symbol)}`, { headers: { "Content-Type": "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json(); if (d.symbol !== symbol || disposed) return;
      const next = d.plan;
      const changed = JSON.stringify(next) !== JSON.stringify(plan);
      plan = next;
      if (changed) { phase = plan ? (plan.entered ? "in" : "waiting") : "none"; draw(); }
      if (!plan) status("No plan for this symbol yet: run a scan, a Deep Analysis, or place a paper order to watch it here.", "dim");
      else if (changed && lastBars) api.update(lastBars, lastSignals); // evaluate at once instead of at the next bar refresh
    } catch { /* keep the last plan */ }
  }

  const api = {
    get plan() { return plan; }, get phase() { return phase; },
    setSymbol(sym) { sym = String(sym || "").toUpperCase(); if (sym === symbol) return; symbol = sym; plan = null; phase = "none"; seen = new Set(); marks = []; lastStatus = ""; clearLines(); load(true); },
    refresh() { return load(true); },
    redraw() { draw(); },
    markers() { return marks.slice(); },
    /** bars: the chart's UTC bars (oldest first); signals: the signal engine's list (newest first). */
    update(bars, signals = []) {
      lastBars = bars; lastSignals = signals;
      load();
      if (!plan || !bars?.length) return;
      const long = plan.side === "long", last = bars[bars.length - 1], px = last.close;
      const t1 = plan.targets[0] ?? null, t2 = plan.targets[1] ?? null;
      const rr = plan.stop != null ? Math.abs(plan.entry - plan.stop) : null;
      const rNow = rr ? ((px - plan.entry) * (long ? 1 : -1)) / rr : null;
      const src = { position: "your paper position", order: "your working order", brief: plan.label || "recommendation", deep: `Deep Analysis ${plan.rating || ""}` }[plan.source];
      // Bars since the plan was made (or the last 3 bars when the plan time is unknown) decide the events.
      const from = plan.time ? bars.findIndex((b) => b.time >= plan.time - 60) : bars.length - 3;
      const recent = bars.slice(Math.max(0, from));
      if (phase === "waiting") {
        const hit = recent.find((b) => (long ? b.low <= plan.entry : b.high >= plan.entry));
        if (hit) { phase = "in"; emit("entry", `${symbol}: entry point reached (${long ? "buy" : "short"} ${pmFmt(plan.entry)})`, hit, plan.entry); }
        else { status(`Waiting for entry ${pmFmt(plan.entry)} · last ${pmFmt(px)} (${((px - plan.entry) / plan.entry * 100).toFixed(2)}% ${long ? "above" : "below"}) · ${src}${plan.stop != null ? ` · stop ${pmFmt(plan.stop)}` : ""}${t1 != null ? ` · T1 ${pmFmt(t1)}` : ""}`, "wait"); }
      }
      if (phase === "in") {
        const after = plan.entered && plan.time ? bars.filter((b) => b.time >= plan.time) : recent;
        const exitBar = after.find((b) => (plan.stop != null && (long ? b.low <= plan.stop : b.high >= plan.stop)) || (t1 != null && (long ? b.high >= t1 : b.low <= t1)));
        if (exitBar) {
          const stopHit = plan.stop != null && (long ? exitBar.low <= plan.stop : exitBar.high >= plan.stop);
          phase = "out";
          if (stopHit) emit("stop", `${symbol}: stop-loss ${pmFmt(plan.stop)} hit — exit`, exitBar, plan.stop);
          else emit("target", `${symbol}: expected exit reached — target T1 ${pmFmt(t1)}`, exitBar, t1);
        } else {
          // A strong reversal signal against the trade on the latest completed bar = exit signal.
          const sig = signals.find((s) => s.strong && s.strength >= 2 && s.time >= (after[0]?.time ?? 0) && (long ? s.dir === "bearish" : s.dir === "bullish"));
          if (sig && !seen.has(`${symbol}|signal|${sig.time}`)) { emit("signal", `${symbol}: exit signal — ${sig.label} against the ${plan.side}`, { time: sig.time }, sig.price); }
          status(`In trade ${long ? "long" : "short"} from ${pmFmt(plan.entry)} · last ${pmFmt(px)}${rNow != null ? ` (${rNow >= 0 ? "+" : ""}${rNow.toFixed(2)}R)` : ""} · expected exit: stop ${pmFmt(plan.stop)}${t1 != null ? `, T1 ${pmFmt(t1)}` : ""}${t2 != null ? `, T2 ${pmFmt(t2)}` : ""} · ${src}`, rNow != null && rNow < 0 ? "down" : "up");
        }
      }
      if (phase === "out") status(`Plan finished: ${[...seen].some((k) => k.includes("|stop|")) ? `stop ${pmFmt(plan.stop)} hit` : `target ${pmFmt(t1)} reached`} · ${src}. The next scan or order starts a new plan.`, "dim");
    },
    dispose() { disposed = true; clearLines(); },
  };
  return api;
}

/** Browser notification for a plan event. */
function notifyPlanEvent(ev) {
  try { if (Notification.permission === "granted") new Notification(ev.text, { body: `${ev.kind} at ${pmFmt(ev.price)}`, tag: `plan-${ev.symbol}-${ev.kind}-${ev.time}` }); } catch { /* unsupported */ }
}

/**
 * Per-chart "Auto" control: an amount of paper money that trades this symbol automatically (server-side, so it
 * keeps working when the window is closed). Returns the element; call .refresh() after the symbol changes.
 */
function createAutoControl(getSymbol, { compact = false } = {}) {
  const det = document.createElement("details"); det.className = `auto-ctl${compact ? " compact" : ""}`;
  const sum = document.createElement("summary"); sum.innerHTML = `<span class="auto-dot"></span><span class="auto-lbl">Auto</span>`; sum.title = "Automatic paper buy and sell for this chart"; det.append(sum);
  const box = document.createElement("div"); box.className = "auto-box"; det.append(box);
  box.innerHTML = `<div class="small"><b>Automatic paper trading for <span class="auto-sym"></span></b></div>
    <label class="small">Money to use <input type="number" class="auto-amt" min="50" step="50" value="1000"></label>
    <label class="small">Enter on <select class="auto-rule"><option value="both">plan, or a strong candle signal</option><option value="plan">the plan only (scan / Deep Analysis / order)</option><option value="signal">strong candle signals only</option></select></label>
    <div class="auto-note dim small">Buys at the plan's entry (or at a 2-star reversal signal), sells at the stop or target, or on a strong reversal signal against the trade. Paper money only.</div>
    <div class="auto-status small"></div>
    <div class="row gap"><button type="button" class="primary small auto-on">Start</button><button type="button" class="ghost small auto-off hidden">Stop</button><span class="auto-err small down"></span></div>`;
  const $ = (s) => box.querySelector(s);
  let row = null;
  async function api(path, init) {
    const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    return d;
  }
  function paint() {
    const sym = getSymbol(); $(".auto-sym").textContent = sym;
    const on = !!(row && row.enabled);
    det.classList.toggle("on", on); det.classList.toggle("live", on && !!(row.position || row.order));
    $(".auto-on").textContent = on ? "Save" : "Start"; $(".auto-off").classList.toggle("hidden", !on);
    if (row) { $(".auto-amt").value = row.amount_usd; $(".auto-rule").value = row.rule; }
    const st = $(".auto-status");
    st.textContent = !row ? "" : !row.enabled ? "Stopped." : row.position ? `In trade: ${row.position.side} ${row.position.qty} @ ${pmFmt(row.position.entry)} · stop ${pmFmt(row.position.stop)} · target ${pmFmt(row.position.target)}`
      : row.order ? `Entry order working: ${row.order.side} ${row.order.qty} @ ${pmFmt(row.order.price)}` : `Watching · ${row.entries_today}/4 entries today${row.last_note ? ` · ${row.last_note}` : ""}`;
    st.className = `auto-status small ${row?.position ? "up" : ""}`;
    sum.querySelector(".auto-lbl").textContent = on ? (row.position ? "Auto · in trade" : row.order ? "Auto · order" : `Auto $${Math.round(row.amount_usd)}`) : "Auto";
  }
  async function refresh() {
    try { const rows = await api("/api/paper/auto"); row = rows.find((r) => r.symbol === getSymbol()) || null; } catch { row = null; }
    paint();
  }
  $(".auto-on").onclick = async () => {
    $(".auto-err").textContent = "";
    try { const d = await api("/api/paper/auto", { method: "PUT", body: JSON.stringify({ symbol: getSymbol(), amount_usd: +$(".auto-amt").value, rule: $(".auto-rule").value, enabled: true }) }); row = d.rows.find((r) => r.symbol === getSymbol()) || null; paint(); }
    catch (e) { $(".auto-err").textContent = e.message; }
  };
  $(".auto-off").onclick = async () => {
    $(".auto-err").textContent = "";
    try { const d = await api("/api/paper/auto", { method: "PUT", body: JSON.stringify({ symbol: getSymbol(), enabled: false }) }); row = d.rows.find((r) => r.symbol === getSymbol()) || null; paint(); }
    catch (e) { $(".auto-err").textContent = e.message; }
  };
  document.addEventListener("click", (e) => { if (det.open && !det.contains(e.target)) det.open = false; });
  det.refresh = refresh; refresh();
  const timer = setInterval(refresh, 60000); det.dispose = () => clearInterval(timer);
  return det;
}

/**
 * Kronos forecast overlay on a Lightweight Charts chart: the mean path (dashed) with the 10-90% band lines.
 * createForecastLayer(chart, shiftT) -> { set(fc), clear() }; `fc` is the forecast JSON from /api/kronos/:id.
 */
function createForecastLayer(chart, shiftT = (t) => t) {
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const mk = (color, width, style) => chart.addLineSeries({ color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const mean = mk(css("--accent"), 2, 2), hi = mk(css("--dim"), 1, 3), lo = mk(css("--dim"), 1, 3);
  let fc = null;
  return {
    get forecast() { return fc; },
    set(f) {
      fc = f || null;
      if (!fc) { mean.setData([]); hi.setData([]); lo.setData([]); return; }
      const pts = (arr) => [{ time: shiftT(fc.last_time), value: fc.last_close }, ...fc.times.map((t, i) => ({ time: shiftT(t), value: arr[i] }))];
      mean.setData(pts(fc.mean_close)); hi.setData(pts(fc.p90)); lo.setData(pts(fc.p10));
    },
    clear() { this.set(null); },
    retheme() { mean.applyOptions({ color: css("--accent") }); hi.applyOptions({ color: css("--dim") }); lo.applyOptions({ color: css("--dim") }); },
  };
}
/** One line describing a forecast summary ({prob_up, exp_move_pct, band_pct, interval, pred_len, step_sec}). */
function forecastText(f) {
  if (!f) return "";
  const h = (f.pred_len * f.step_sec) / 3600, hz = h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;
  return `Kronos ${f.interval} · next ${hz}: ${Math.round(f.prob_up * 100)}% up · exp ${f.exp_move_pct >= 0 ? "+" : ""}${Number(f.exp_move_pct).toFixed(2)}% · band ±${(f.band_pct / 2).toFixed(2)}%`;
}
