"use strict";
/* Operations: routine health for the Briefs & Autopilot panel (GET /api/briefs/health) and the alert that goes with
   it. For each scan routine: the last successful run, what the last run cost, and failures / skips in the last 7 days.
   When the most recent run of an enabled routine failed or was skipped, or an error says a spending or usage limit
   was hit, the page banner says so once per incident, and a browser notification is raised if those are allowed. */

state.ops = { data: null, err: null, timer: null };
const OPS_SEEN_KEY = "td.opsSeen";
function opsSeen() { try { const v = JSON.parse(localStorage.getItem(OPS_SEEN_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
function opsMarkSeen(keys) { try { localStorage.setItem(OPS_SEEN_KEY, JSON.stringify([...new Set([...opsSeen(), ...keys])].slice(-60))); } catch { /* private mode: the banner may repeat */ } }
const opsWhen = (s) => { if (!s) return "—"; const d = new Date(s.replace(" ", "T") + "Z"); return isNaN(d) ? s : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
const opsCost = (c) => (c ? (typeof formatCost === "function" ? formatCost(c) : String(c)) : "—");

async function loadOpsHealth() {
  const O = state.ops;
  try { O.data = await api("/api/briefs/health"); O.err = null; } catch (e) { O.err = e.message; }
  renderOpsHealth();
  if (O.data) opsAlert(O.data.alerts || []);
}

/** Banner + notification for alerts not shown before on this device. */
function opsAlert(alerts) {
  const seen = new Set(opsSeen()), fresh = alerts.filter((a) => !seen.has(a.key));
  if (!fresh.length) return;
  const limit = fresh.some((a) => a.kind === "limit");
  const text = `${limit ? "A spending or usage limit stopped a routine. " : ""}${fresh.map((a) => a.text).join("  ·  ")}  (See Routine health under Briefs.)`;
  showBanner(text);
  try { if (window.Notification && Notification.permission === "granted") new Notification(limit ? "Trading Desk: spending or usage limit hit" : "Trading Desk: a routine did not run", { body: fresh.map((a) => a.text).join("\n").slice(0, 300), tag: `ops-${fresh[0].key}` }); } catch { /* unsupported */ }
  opsMarkSeen(fresh.map((a) => a.key));
}

function renderOpsHealth() {
  const anchor = $("#apDetails"); if (!anchor) return;
  let box = $("#apHealth");
  if (!box) {
    box = el("details", "ap-details ap-health"); box.id = "apHealth";
    try { box.open = localStorage.getItem("td.aphealth") === "1"; } catch { /* ok */ }
    box.addEventListener("toggle", () => { try { localStorage.setItem("td.aphealth", box.open ? "1" : "0"); } catch { /* ok */ } });
    anchor.after(box);
  }
  const O = state.ops, d = O.data, wasOpen = box.open; box.innerHTML = "";
  const bad = d ? d.routines.filter((r) => r.enabled && (r.state === "failed" || r.state === "skipped")).length : 0;
  const sum = el("summary", "small", "Routine health"); if (d) sum.append(" ", el("span", `pill ${bad ? "error" : "done"}`, bad ? `${bad} need${bad === 1 ? "s" : ""} attention` : "no problems"));
  // Opens by itself the first time something needs attention; after that it stays the way the user left it.
  box.append(sum); box.open = wasOpen || (bad > 0 && !box.dataset.opened); if (bad > 0) box.dataset.opened = "1";
  const body = el("div", "ap-slots oh-list"); box.append(body);
  if (O.err) { body.append(el("div", "msg err small", `Routine health could not be read: ${O.err}`)); return; }
  if (!d) { body.append(el("div", "dim small", "Loading…")); return; }
  if (!d.autopilot_enabled) body.append(el("div", "dim small", "Autopilot is off: no routine runs by itself."));
  const words = { ok: "ok", failed: "last run failed", skipped: "last run skipped", running: "running", never: "not run yet", off: "off" }, cls = { ok: "done", failed: "error", skipped: "skipped", running: "running", never: "skipped", off: "skipped" };
  for (const r of d.routines) {
    const row = el("div", "oh-row"), top = el("div", "oh-top");
    top.append(el("b", null, r.label), el("span", `pill ${cls[r.state] || "skipped"}`, words[r.state] || r.state)); if (!r.enabled && r.state !== "off") top.append(el("span", "dim tiny", "switched off"));
    const line = el("div", "dim tiny");
    line.append(`Last success: ${r.last_success ? opsWhen(r.last_success.at) : "none on record"} · last run cost: ${opsCost(r.last_cost)} · last 7 days: `,
      el("span", r.failures_7d ? "down" : "", `${r.failures_7d} failed`), ", ", el("span", r.skips_7d ? "warn-text" : "", `${r.skips_7d} skipped`), ` of ${r.runs_7d} run${r.runs_7d === 1 ? "" : "s"}`);
    row.append(top, line);
    if (r.last_run && r.last_run.error && r.state !== "ok") row.append(el("div", `tiny ${r.state === "failed" ? "down" : "dim"}`, `${opsWhen(r.last_run.at)}: ${r.last_run.error}`));
    body.append(row);
  }
}

document.addEventListener("section", (e) => { if (e.detail === "briefs") loadOpsHealth(); });
setTimeout(() => { loadOpsHealth(); state.ops.timer = setInterval(() => { if (!document.hidden) loadOpsHealth(); }, 180000); }, 4000);
