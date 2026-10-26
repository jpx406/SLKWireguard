"use strict";
/* Market board: turns a brief's structured result into charts, tables and recommendations.
   Loaded before app.js; uses its helpers ($, el, fmt, md, state, api, setSymbol, showTab) at call time. */

const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
};
const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const nv = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const pct = (v) => (nv(v) === null ? "—" : `${nv(v) > 0 ? "+" : ""}${fmt(v)}%`);
const signCls = (v) => (nv(v) > 0 ? "up" : nv(v) < 0 ? "down" : "");
const biasCls = (b) => (/short|bear/i.test(b || "") ? "down" : /long|bull/i.test(b || "") ? "up" : "");
const section = (title, extra) => { const s = el("section", "bd-sec"); const h = el("h3", null, title); if (extra) h.append(extra); s.append(h); return s; };

/** Horizontal bar chart (sector performance, scores). rows: [{label, value, sub?}] */
function barChart(rows, { unit = "%", signed = true, max } = {}) {
  const W = 560, rowH = 22, padL = 150, padR = 60;
  const m = max ?? Math.max(0.01, ...rows.map((r) => Math.abs(nv(r.value) ?? 0)));
  const g = svg("svg", { viewBox: `0 0 ${W} ${rows.length * rowH + 6}`, class: "bd-bars", role: "img" });
  const zero = signed ? padL + (W - padL - padR) / 2 : padL;
  const span = signed ? (W - padL - padR) / 2 : W - padL - padR;
  if (signed) svg("line", { x1: zero, x2: zero, y1: 0, y2: rows.length * rowH + 6, stroke: cssv("--line") }, g);
  rows.forEach((r, i) => {
    const v = nv(r.value) ?? 0, y = i * rowH + 4, w = Math.max(1, (Math.abs(v) / m) * span);
    const color = !signed ? cssv("--accent") : v >= 0 ? cssv("--up") : cssv("--down");
    svg("text", { x: padL - 8, y: y + 13, "text-anchor": "end", class: "bd-lbl" }, g).textContent = r.label;
    svg("rect", { x: v >= 0 || !signed ? zero : zero - w, y, width: w, height: rowH - 8, rx: 3, fill: color, opacity: 0.85 }, g);
    // Value labels go on the right of the zero line for negatives too, so they never cover the names.
    const t = svg("text", { x: v >= 0 || !signed ? zero + w + 6 : zero + 6, y: y + 12, "text-anchor": "start", class: "bd-val" }, g);
    t.textContent = `${signed && v > 0 ? "+" : ""}${fmt(v, unit === "%" ? 2 : 0)}${unit}`;
  });
  return g;
}

/** Trade ladder: stop, entry, targets (and last price) on one scale. */
function ladder(p) {
  const entry = nv(p.entry), stop = nv(p.stop), targets = (p.targets || []).map(nv).filter((x) => x !== null), last = nv(p.last);
  if (entry === null || stop === null) return el("span", "dim small", "no levels");
  const vals = [entry, stop, ...targets, ...(last !== null ? [last] : [])];
  const lo = Math.min(...vals), hi = Math.max(...vals), W = 260, H = 34, pad = 8;
  const x = (v) => pad + ((v - lo) / (hi - lo || 1)) * (W - pad * 2);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "bd-ladder" });
  svg("rect", { x: Math.min(x(stop), x(entry)), y: 12, width: Math.abs(x(entry) - x(stop)), height: 8, fill: cssv("--down"), opacity: 0.35 }, g);
  if (targets.length) svg("rect", { x: Math.min(x(entry), x(targets.at(-1))), y: 12, width: Math.abs(x(targets.at(-1)) - x(entry)), height: 8, fill: cssv("--up"), opacity: 0.3 }, g);
  const tick = (v, color, label, above) => {
    svg("line", { x1: x(v), x2: x(v), y1: 8, y2: 24, stroke: color, "stroke-width": 2 }, g);
    svg("text", { x: x(v), y: above ? 7 : 33, "text-anchor": "middle", class: "bd-tick", fill: color }, g).textContent = label;
  };
  tick(stop, cssv("--down"), `S ${fmt(stop)}`, false);
  tick(entry, cssv("--accent"), `E ${fmt(entry)}`, true);
  targets.forEach((t, i) => tick(t, cssv("--up"), `T${i + 1}`, i % 2 === 0 ? false : true));
  if (last !== null) svg("circle", { cx: x(last), cy: 16, r: 3.5, fill: cssv("--text") }, g);
  return g;
}

/** Intraday sparkline with the plan's levels, loaded from /api/candles. */
async function sparkline(host, p) {
  host.textContent = "loading chart…";
  try {
    const bars = await api(`/api/candles/${encodeURIComponent(p.symbol)}?interval=5m`);
    const day = bars.slice(-90);
    if (!day.length) { host.textContent = "no data"; return; }
    const levels = [nv(p.entry), nv(p.stop), ...(p.targets || []).map(nv)].filter((v) => v !== null);
    const closes = day.map((b) => b.close), lo = Math.min(...closes, ...levels), hi = Math.max(...closes, ...levels);
    const W = 360, H = 120, pad = 6;
    const x = (i) => pad + (i / (day.length - 1 || 1)) * (W - pad * 2), y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - pad * 2);
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "bd-spark" });
    const line = (v, color, dash) => v !== null && svg("line", { x1: pad, x2: W - pad, y1: y(v), y2: y(v), stroke: color, "stroke-dasharray": dash ? "4 3" : "", "stroke-width": 1 }, g);
    line(nv(p.stop), cssv("--down")); line(nv(p.entry), cssv("--accent"));
    (p.targets || []).forEach((t) => line(nv(t), cssv("--up"), true));
    const up = closes.at(-1) >= closes[0];
    svg("polyline", { points: closes.map((c, i) => `${x(i)},${y(c)}`).join(" "), fill: "none", stroke: up ? cssv("--up") : cssv("--down"), "stroke-width": 1.6 }, g);
    host.innerHTML = ""; host.append(g);
  } catch (e) { host.textContent = `chart unavailable (${e.message})`; }
}

function planPick(p) {
  setSymbol(String(p.symbol)); showTab("center", "chart"); showTab("side", "risk");
  if (nv(p.entry) !== null) $("#rEntry").value = p.entry;
  if (nv(p.stop) !== null) $("#rStop").value = p.stop;
  $("#rSide").value = /short/i.test(p.bias || "") ? "short" : "long";
  setTimeout(() => $("#btnDrawPlan").click(), 1500);
}

/** Sortable picks table with an expandable detail row per pick. compact = side panel / chat. */
function picksTable(picks, { compact = false } = {}) {
  const wrap = el("div", "bd-table-wrap");
  const cols = compact
    ? [["#", "rank"], ["Symbol", "symbol"], ["Bias", "bias"], ["Score", "score"], ["Entry", "entry"], ["Stop", "stop"], ["T1", "t1"], ["R:R", "rr"]]
    : [["#", "rank"], ["Symbol", "symbol"], ["Bias", "bias"], ["Setup", "setup"], ["Score", "score"], ["Conf.", "confidence"], ["Catalyst", "catalyst"],
       ["PM %", "premarket_change_pct"], ["RVOL", "rvol"], ["Entry", "entry"], ["Stop", "stop"], ["T1", "t1"], ["T2", "t2"], ["R:R", "rr"], ["Size", "size_shares"]];
  const rows = picks.map((p, i) => ({ ...p, rank: nv(p.rank) ?? i + 1, t1: (p.targets || [])[0], t2: (p.targets || [])[1],
    rr: nv(p.rr) ?? (nv(p.entry) !== null && nv(p.stop) !== null && (p.targets || [])[0] != null ? Math.abs(p.targets[0] - p.entry) / Math.abs(p.entry - p.stop || 1) : null) }));
  let sortKey = "rank", asc = true;
  const table = el("table", "bd-table"), thead = el("thead"), tbody = el("tbody"), hr = el("tr");
  for (const [label, key] of cols) {
    const th = el("th", null, label); th.onclick = () => { asc = sortKey === key ? !asc : key === "rank"; sortKey = key; draw(); };
    hr.append(th);
  }
  thead.append(hr); table.append(thead, tbody); wrap.append(table);
  const cell = (p, key) => {
    const v = p[key];
    if (key === "symbol") { const td = el("td", "sym"); td.append(el("b", null, String(v || "?").toUpperCase())); if (p.name && !compact) td.append(el("div", "dim tiny", p.name)); return td; }
    if (key === "bias") return el("td", biasCls(v), String(v || "—"));
    if (key === "score") { const td = el("td", "score"); const bar = el("span", "scorebar"); bar.style.width = `${Math.max(0, Math.min(100, nv(v) ?? 0))}%`; td.append(bar, el("span", null, v ?? "—")); return td; }
    if (key === "premarket_change_pct") return el("td", `num ${signCls(v)}`, pct(v));
    if (key === "rr") return el("td", "num", nv(v) === null ? "—" : `${fmt(v, 1)}R`);
    if (key === "rvol") return el("td", "num", nv(v) === null ? "—" : `${fmt(v, 1)}x`);
    if (key === "size_shares") return el("td", "num", nv(v) === null ? "—" : fmt(v, 0));
    if (["entry", "stop", "t1", "t2"].includes(key)) return el("td", `num ${key === "stop" ? "down" : key.startsWith("t") ? "up" : ""}`, fmt(v));
    return el("td", key === "setup" || key === "catalyst" ? "wrap" : "", v == null ? "—" : String(v));
  };
  function draw() {
    tbody.innerHTML = "";
    const sorted = [...rows].sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      const r = nv(x) !== null && nv(y) !== null ? nv(x) - nv(y) : String(x ?? "").localeCompare(String(y ?? ""));
      return asc ? r : -r;
    });
    for (const p of sorted) {
      const tr = el("tr", "pick-row"); cols.forEach(([, k]) => tr.append(cell(p, k)));
      const detail = el("tr", "pick-detail hidden"), td = el("td"); td.colSpan = cols.length; detail.append(td);
      tr.onclick = () => {
        const open = detail.classList.toggle("hidden") === false;
        if (open && !td.childElementCount) td.append(pickDetail(p));
      };
      tbody.append(tr, detail);
    }
  }
  draw();
  return wrap;
}

function pickDetail(p) {
  const box = el("div", "bd-detail"), left = el("div"), right = el("div", "bd-detail-txt");
  const spark = el("div", "bd-spark-host"); left.append(spark, ladder(p)); sparkline(spark, p);
  const kv = (k, v) => { if (v == null || v === "") return; const d = el("div"); d.append(el("span", "dim", `${k}: `), document.createTextNode(Array.isArray(v) ? v.join(", ") : String(v))); right.append(d); };
  kv("Setup", p.setup); kv("Catalyst", p.catalyst); kv("Exit plan", p.exit_plan); kv("Invalidation", p.invalidation);
  kv("Targets", (p.targets || []).map((t) => fmt(t)).join(" / ")); kv("Sector", p.sector); kv("Skills", p.skills); kv("Why", p.reason);
  const acts = el("div", "row gap"), c = el("button", "ghost small", "open chart"), pl = el("button", "primary small", "plan this trade"), ask = el("button", "ghost small", "ask Copilot");
  c.onclick = (e) => { e.stopPropagation(); setSymbol(String(p.symbol)); showTab("center", "chart"); };
  pl.onclick = (e) => { e.stopPropagation(); planPick(p); };
  ask.onclick = (e) => { e.stopPropagation(); showTab("side", "copilot"); sendChat(`Re-check this idea with my trader-* skills using live data and tell me if it is still valid: ${JSON.stringify(p)}`, `Re-check ${p.symbol}`); };
  acts.append(c, pl, ask); right.append(acts);
  box.append(left, right);
  return box;
}

/** Full board for one brief. */
function renderBoard(host, b) {
  host.innerHTML = "";
  if (!b) { host.append(el("div", "bd-empty", "No market board yet. Click ▶ Full market scan (top right) to run every skill over the whole market, or wait for the scheduled scans.")); return; }
  const d = b.data || { picks: b.picks || [] }, m = d.market || {};
  const head = el("div", "bd-head");
  head.append(el("h2", null, b.label || b.slot));
  if (m.regime) head.append(el("span", `regime ${/on/i.test(m.regime) ? "up" : /off/i.test(m.regime) ? "down" : ""}`, m.regime));
  head.append(el("span", "dim small", `${b.day} · ${new Date(b.created_at.replace(" ", "T") + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${b.cost ? ` · ${formatCost(b.cost)}` : ""}`));
  if (b.status !== "done") head.append(el("span", `pill ${b.status}`, b.status === "error" ? "error" : "working…"));
  host.append(head);
  if (b.error) host.append(el("div", "msg err small", b.error));
  if (m.summary) host.append(el("p", "bd-summary", m.summary));

  if (Array.isArray(m.indices) && m.indices.length) {
    const strip = el("div", "bd-indices");
    for (const ix of m.indices) {
      const c = el("div", "bd-card");
      c.append(el("div", "bd-card-sym", ix.symbol), el("div", "mono big", fmt(ix.last)), el("div", `mono ${signCls(ix.change_pct)}`, pct(ix.change_pct)), el("div", `small ${biasCls(ix.bias)}`, ix.bias || ""));
      const lv = el("div", "dim tiny mono", `S ${(ix.support || []).map((v) => fmt(v)).join(" / ") || "—"} · R ${(ix.resistance || []).map((v) => fmt(v)).join(" / ") || "—"}`);
      c.append(lv); c.onclick = () => { setSymbol(ix.symbol); showTab("center", "chart"); };
      strip.append(c);
    }
    host.append(strip);
  }

  const grid = el("div", "bd-grid");
  if (Array.isArray(m.sectors) && m.sectors.length) {
    const s = section("Sectors");
    s.append(barChart([...m.sectors].sort((a, b) => (nv(b.change_pct) ?? 0) - (nv(a.change_pct) ?? 0)).map((x) => ({ label: `${x.name}${x.etf ? ` (${x.etf})` : ""}`, value: x.change_pct }))));
    grid.append(s);
  }
  const side = el("div");
  if (m.breadth && (nv(m.breadth.advancers) || nv(m.breadth.decliners))) {
    const s = section("Breadth"), a = nv(m.breadth.advancers) ?? 0, dcl = nv(m.breadth.decliners) ?? 0, tot = a + dcl || 1;
    const bar = el("div", "bd-breadth"), up = el("span", "up-bg"), dn = el("span", "down-bg");
    up.style.width = `${(a / tot) * 100}%`; dn.style.width = `${(dcl / tot) * 100}%`; bar.append(up, dn);
    s.append(bar, el("div", "small", `${fmt(a, 0)} advancing · ${fmt(dcl, 0)} declining${m.breadth.note ? ` — ${m.breadth.note}` : ""}`));
    side.append(s);
  }
  if (Array.isArray(m.events) && m.events.length) {
    const s = section("Today's events"), t = el("table", "bd-table small");
    for (const ev of m.events) { const tr = el("tr"); tr.append(el("td", "mono", ev.time_et || ""), el("td", "wrap", ev.event || ""), el("td", `impact ${ev.impact || ""}`, ev.impact || "")); t.append(tr); }
    s.append(t); side.append(s);
  }
  if (side.childElementCount) grid.append(side);
  if (grid.childElementCount) host.append(grid);

  const picks = d.picks || [];
  const ps = section(`Recommendations (${picks.length})`, el("span", "dim small", "  click a row for chart, levels and exit plan · click a header to sort"));
  if (picks.length) {
    ps.append(picksTable(picks));
    const scores = picks.filter((p) => nv(p.score) !== null);
    if (scores.length) { const sc = el("div", "bd-scores"); sc.append(el("div", "dim small", "Score by pick"), barChart(scores.map((p) => ({ label: `${p.symbol} ${/short/i.test(p.bias || "") ? "▼" : "▲"}`, value: p.score })), { unit: "", signed: false, max: 100 })); ps.append(sc); }
  } else ps.append(el("div", "dim", "No trade met the rules in this brief."));
  host.append(ps);

  if (Array.isArray(d.avoid) && d.avoid.length) {
    const s = section("Avoid"), t = el("table", "bd-table small");
    for (const a of d.avoid) { const tr = el("tr"); tr.append(el("td", "sym", String(a.symbol || "")), el("td", "wrap", a.reason || "")); t.append(tr); }
    s.append(t); host.append(s);
  }
  if (Array.isArray(d.skills_run) && d.skills_run.length) {
    const s = section("Skills pipeline"), chips = el("div", "bd-chips");
    for (const k of d.skills_run) { const c = el("span", `chip ${k.status || ""}`, `${k.status === "ok" ? "✓" : k.status === "failed" ? "✗" : "–"} ${k.skill}`); if (k.note) c.title = k.note; chips.append(c); }
    s.append(chips); host.append(s);
  }
  if (b.content) {
    const det = el("details", "bd-sec"), sum = el("summary", null, "Full written analysis"), body = el("div", "md");
    body.innerHTML = md(b.content.replace(/```json[\s\S]*?```\s*$/, "")); det.append(sum, body);
    if (!picks.length && !m.summary) det.open = true;
    host.append(det);
  }
}

/** Compact version for the Briefs tab and Copilot answers. */
function renderMini(host, result) {
  const picks = result?.picks || [];
  const m = result?.market || {};
  if (m.regime || m.summary) { const h = el("div", "small"); if (m.regime) h.append(el("b", /on/i.test(m.regime) ? "up" : /off/i.test(m.regime) ? "down" : "", `${m.regime} `)); if (m.summary) h.append(document.createTextNode(m.summary)); host.append(h); }
  if (picks.length) host.append(picksTable(picks, { compact: true }));
}

/** Pull the trailing ```json result out of a Copilot answer. */
function splitResult(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)], last = blocks.at(-1);
  if (!last) return { text, result: null };
  try {
    const obj = JSON.parse(last[1]);
    if (!obj || !(Array.isArray(obj.picks) || obj.market)) return { text, result: null };
    return { text: text.replace(last[0], "").trim(), result: obj };
  } catch { return { text, result: null }; }
}
