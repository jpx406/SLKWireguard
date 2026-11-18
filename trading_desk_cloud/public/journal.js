"use strict";
/* Journal, automatic half: every closed paper trade from GET /api/tradelog (date, symbol, side, source, plan, entry,
   exit, P&L, R, exit reason), newest first, with a free-text note per trade (PUT /api/tradelog/note) and summary
   stats on top. The manual journal below it (form + table in app.js) is untouched. */

state.tradeLog = { data: null, err: null };

async function loadTradeLog() {
  const T = state.tradeLog;
  try { T.data = await api("/api/tradelog"); T.err = null; } catch (e) { T.err = e.message; }
  renderTradeLog();
}

const tlDate = (t) => (t.closed_at ? new Date(t.closed_at * 1000).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t.day || "—");
const tlR = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, 2)}R`);
const tlMoney = (v) => (v == null ? "—" : `${v < 0 ? "-" : v > 0 ? "+" : ""}$${fmt(Math.abs(v))}`);
const tlCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

function renderTradeLog() {
  const host = $("#tradeLog"), statsBox = $("#tradeLogStats"), T = state.tradeLog; if (!host || !statsBox) return;
  // Do not redraw under someone who is typing a note.
  if (host.contains(document.activeElement) && document.activeElement.matches("input.tl-note")) return;
  host.innerHTML = ""; statsBox.innerHTML = "";
  if (T.err) { host.append(el("div", "msg err small", `The trade log could not be read: ${T.err}`)); return; }
  const d = T.data; if (!d) { host.append(el("div", "dim small pad", "Loading…")); return; }
  const s = d.stats || {}, trades = [...(d.trades || [])].sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));
  const add = (k, v, c) => { const sp = el("span", null, `${k} `); sp.append(el("b", c || "", String(v))); statsBox.append(sp); };
  add("Closed trades", s.trades ?? trades.length);
  add("Win rate", s.win_pct == null ? "—" : `${fmt(s.win_pct, 0)}%`);
  add("Total P&L", tlMoney(s.pnl ?? 0), tlCls(s.pnl));
  add("Profit factor", s.profit_factor == null ? "—" : s.profit_factor >= 99 ? "∞" : fmt(s.profit_factor, 2));
  add("Avg R", s.avg_r == null ? "—" : `${tlR(s.avg_r)}${s.r_low != null && s.r_high != null ? ` (${tlR(s.r_low)} … ${tlR(s.r_high)})` : ""}`, tlCls(s.avg_r));
  if (!trades.length) { host.append(el("div", "dim small pad", `No closed paper trades in the last ${d.days ?? 120} days. They appear here by themselves as positions close.`)); return; }
  const tb = el("tbody");
  for (const t of trades) {
    const tr = el("tr"), short = t.side === "short";
    const note = el("input", "tl-note"); note.type = "text"; note.maxLength = 600; note.value = t.note || ""; note.placeholder = "Add a note"; note.setAttribute("aria-label", `Note for the ${t.symbol} trade closed ${tlDate(t)}`);
    const status = el("span", "tiny dim tl-saved"); status.setAttribute("role", "status");
    const save = async () => {
      const text = note.value.trim(); if (text === (t.note || "")) return;
      status.textContent = "saving…"; status.className = "tiny dim tl-saved";
      try { await api("/api/tradelog/note", { method: "PUT", body: JSON.stringify({ id: t.id, note: text }) }); t.note = text; status.textContent = "saved"; setTimeout(() => { if (status.textContent === "saved") status.textContent = ""; }, 2500); }
      catch (e) { status.textContent = `not saved: ${e.message}`; status.className = "tiny down tl-saved"; }
    };
    note.onchange = save; note.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); note.blur(); } };
    const noteTd = el("td", "tl-note-td"); noteTd.append(note, status);
    const cells = [el("td", "small", tlDate(t)), el("td", "sym", t.symbol), el("td", short ? "down" : "up", short ? "Short" : "Long"), el("td", "small", t.source_label || t.source || "—"), el("td", "small wrap tl-plan", t.plan || "—"),
      el("td", "num", fmt(t.entry)), el("td", "num", fmt(t.exit)), el("td", `num ${tlCls(t.pnl)}`, tlMoney(t.pnl)), el("td", `num ${tlCls(t.r)}`, tlR(t.r)), el("td", "small", t.exit_reason || "—"), noteTd];
    cells[4].title = t.plan || ""; tr.append(...cells); tb.append(tr);
  }
  const table = el("table", "bd-table tl-table"), thead = el("thead"), hr = el("tr");
  for (const h of ["Closed", "Symbol", "Side", "Source", "Plan", short2("Entry", "sold short at for shorts"), short2("Exit", "covered at for shorts"), "P&L", "R", "Exit reason", "Your note"]) hr.append(h instanceof Node ? h : el("th", null, h));
  thead.append(hr); table.append(thead, tb);
  const wrap = el("div", "bd-table-wrap"); wrap.append(table); host.append(wrap);
  host.append(el("div", "dim tiny pad", `Newest first, last ${d.days ?? 120} days${(d.trades || []).length >= 500 ? " (the latest 500 trades)" : ""}. R uses the stop the trade started with; a trade without a stop has no R. For a short, Entry is the price sold short at and Exit the price covered at. Notes save when you leave the field.`));
}
function short2(label, hint) { const th = el("th", null, label); th.title = hint; return th; }

document.addEventListener("section", (e) => { if (e.detail === "journal") loadTradeLog(); });
