"use strict";
/* One settings source of truth, shown the same way everywhere. deskSummaryEl() returns the sentence with the limits and
   thresholds in force (from GET /api/config); pages append it instead of quoting their own numbers. The admin opens
   the editor from it. */
state.desk = { data: null, at: 0, loading: null };
async function loadDeskConfig(force) {
  if (!force && state.desk.data && Date.now() - state.desk.at < 30000) return state.desk.data;
  state.desk.loading ??= api("/api/config").then((d) => { state.desk.data = d; state.desk.at = Date.now(); return d; }).finally(() => { state.desk.loading = null; });
  return state.desk.loading;
}
/** The shared line. Fills itself in; every copy on screen updates when the config changes. */
function deskSummaryEl() {
  const box = el("div", "desk-line small"); box.setAttribute("role", "note");
  const paint = (d) => {
    box.textContent = ""; const off = d.sources.filter((s) => s.off);
    box.append(el("b", null, "Desk limits · "), el("span", null, d.summary));
    if (off.length) box.append(el("span", "desk-off", ` Switched off: ${off.map((s) => s.label).join(", ")}.`));
    if (state.me?.role === "admin") { const b = el("button", "linklike", "Change"); b.type = "button"; b.onclick = openDeskConfig; box.append(" ", b); }
  };
  box.dataset.desk = "1"; box._paint = paint;
  if (state.desk.data) paint(state.desk.data); else box.textContent = "Desk limits: loading…";
  loadDeskConfig().then(paint).catch(() => { box.textContent = ""; });
  return box;
}
function repaintDeskLines() { for (const n of document.querySelectorAll("[data-desk]")) if (n._paint && state.desk.data) n._paint(state.desk.data); }

const DESK_FIELDS = [
  ["Risk gate (automatic entries only; manual trades are never blocked)", [
    ["max_trades_per_day", "Automatic entries per day", "1"], ["max_concurrent", "Open positions and orders at once", "1"], ["max_entries_per_symbol_per_day", "Entries per symbol per day", "1"],
    ["cooldown_after_stop_min", "Minutes to wait after a stop on a symbol", "5"], ["daily_loss_halt_pct", "Stop new entries when the day is down this % of equity", "0.25"], ["weekly_loss_halt_pct", "…or the week is down this %", "0.5"]]],
  ["Order engine", [
    ["confirm_minutes", "Breakouts: bar size that must close beyond the trigger (minutes)", "1"], ["max_chase_atr", "Do not chase past the trigger by more than (× daily ATR)", "0.05"], ["risk_min_pct", "Skip a trade that risks less than this % of equity", "0.05"],
    ["max_notional_pct", "Largest position, % of equity", "1"], ["signal_min_stop_atr", "Candle signals: pattern stop at least (× chart ATR)", "0.25"], ["signal_min_stop_pct", "…and at least this % of price", "0.1"],
    ["stop_slippage_pct", "A stop fills this % worse than its price", "0.01"], ["commission_per_share", "Commission per share ($)", "0.001"], ["max_bar_age_min", "No instant fill when the last trade is older than (minutes)", "1"]]],
  ["Copy desk (insider / fund plans are swing trades)", [["copy_stop_atr", "Stop (× daily ATR)", "0.25"], ["copy_min_rr", "Target (× the risk)", "0.5"], ["copy_hold_days", "Close after (sessions)", "1"]]],
];
async function openDeskConfig() {
  let d; try { d = await loadDeskConfig(true); } catch (e) { showBanner(e.message); return; }
  let dlg = document.getElementById("deskDlg");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "deskDlg"; dlg.className = "dlg desk-dlg"; dlg.setAttribute("aria-label", "Desk limits and switches"); document.body.append(dlg); }
  dlg.textContent = ""; const c = d.config, f = el("form", "desk-form"); f.method = "dialog";
  f.append(el("h3", null, "Desk limits and switches"), el("p", "dim small", "One set of numbers for every automatic path: scan routines, copy desk, chart autopilot, Deep Analysis and the strategy auto-trader. A halt stops new entries only; open positions keep their stops and targets."));
  for (const [title, fields] of DESK_FIELDS) { const fs = el("fieldset"); fs.append(el("legend", null, title)); const grid = el("div", "desk-grid");
    for (const [k, label, step] of fields) { const l = el("label", "field small"); l.append(el("span", null, label)); const i = el("input"); i.type = "number"; i.name = k; i.step = step; i.min = d.bounds[k][0]; i.max = d.bounds[k][1]; i.value = c[k]; i.inputMode = "decimal"; l.append(i); grid.append(l); }
    fs.append(grid); f.append(fs); }
  const sw = el("fieldset"); sw.append(el("legend", null, "Switches (off until their own results earn them back)"));
  const chk = (name, label, val) => { const l = el("label", "check small"); const i = el("input"); i.type = "checkbox"; i.name = name; i.checked = val; l.append(i, el("span", null, ` ${label}`)); return l; };
  sw.append(chk("kronos_gate", "Kronos may veto chart signals", c.kronos_gate), chk("crypto_autotrade", "Automatic crypto trades", c.crypto_autotrade), chk("exit_scale", "Day trades: sell half at +1R, stop to break-even, trail the rest (off = fixed stop and target)", c.exit_model === "scale"));
  const txt = (name, label, val, hint) => { const l = el("label", "field small"); l.append(el("span", null, label)); const i = el("input"); i.type = "text"; i.name = name; i.value = val; i.spellcheck = false; l.append(i, el("span", "dim", hint)); return l; };
  sw.append(txt("candle_grades_allowed", "ML grades the chart autopilot may trade", c.candle_grades_allowed.join(", "), "A, B, C (empty = none)"), txt("candle_patterns_blocked", "Patterns never traded", c.candle_patterns_blocked.join(", "), "pattern ids, comma separated"),
    txt("candle_patterns_research", "Patterns traded without a grade (research bucket)", c.candle_patterns_research.join(", "), "pattern ids"), txt("signal_blackout_ny", "No candle-signal entries (New York time)", c.signal_blackout_ny.join(", "), "HH:MM-HH:MM"));
  f.append(sw);
  const src = el("fieldset"); src.append(el("legend", null, "Sources (kill switch per part of the desk)")); for (const s of d.sources) src.append(chk(`src_${s.id}`, s.label, !s.off)); f.append(src);
  const bar = el("div", "row gap"), save = el("button", "primary small", "Save"), reset = el("button", "ghost small", "Back to defaults"), close = el("button", "ghost small", "Cancel"); save.type = "submit"; reset.type = "button"; close.type = "button";
  bar.append(save, reset, close); f.append(bar); dlg.append(f);
  const done = (r) => { state.desk.data = r; state.desk.at = Date.now(); repaintDeskLines(); dlg.close(); document.dispatchEvent(new CustomEvent("deskconfig")); };
  close.onclick = () => dlg.close();
  reset.onclick = async () => { try { done(await api("/api/config", { method: "PUT", body: JSON.stringify({ reset: true }) })); } catch (e) { showBanner(e.message); } };
  f.onsubmit = async (ev) => { ev.preventDefault(); const q = (n) => f.querySelector(`[name="${n}"]`), list = (n) => q(n).value.split(",").map((x) => x.trim()).filter(Boolean), cfg = {};
    for (const [, fields] of DESK_FIELDS) for (const [k] of fields) cfg[k] = Number(q(k).value);
    cfg.kronos_gate = q("kronos_gate").checked; cfg.crypto_autotrade = q("crypto_autotrade").checked; cfg.exit_model = q("exit_scale").checked ? "scale" : "fixed";
    for (const k of ["candle_grades_allowed", "candle_patterns_blocked", "candle_patterns_research", "signal_blackout_ny"]) cfg[k] = k === "candle_grades_allowed" ? list(k).map((x) => x.toUpperCase()) : list(k);
    cfg.sources_off = d.sources.filter((s) => !q(`src_${s.id}`).checked).map((s) => s.id);
    try { done(await api("/api/config", { method: "PUT", body: JSON.stringify({ config: cfg }) })); } catch (e) { showBanner(e.message); } };
  dlg.showModal();
}
// The same line on the pages that used to quote their own thresholds.
document.addEventListener("section", (e) => {
  const where = { paper: "#paper", master: "#master", deep: "#deep" }[e.detail]; if (!where) return;
  const put = () => { const host = document.querySelector(where); if (!host || host.querySelector(":scope > [data-desk]")) return; host.prepend(deskSummaryEl()); };
  // These pages rebuild themselves after loading: keep the line present.
  put(); const host = document.querySelector(where); if (host && !host._deskObs) { host._deskObs = new MutationObserver(() => { if (!host.querySelector(":scope > [data-desk]") && host.children.length) host.prepend(deskSummaryEl()); }); host._deskObs.observe(host, { childList: true }); }
});
