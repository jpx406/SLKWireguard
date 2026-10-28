"use strict";
/* Paper trading UI (simulated orders only), account menu and user management.
   Loaded after app.js and board.js; uses their helpers ($, el, fmt, api, state, setSymbol, showTab, svg, cssv, barChart). */

const money = (v) => (v == null ? "—" : `${v < 0 ? "-" : ""}$${fmt(Math.abs(v))}`);
const pnlCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const ago = (t) => { const s = Math.max(0, Date.now() / 1000 - t); return s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const tm = (t) => (t ? new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/* ------------------------------------------------------------------ identity / roles */
async function loadMe() {
  try { state.me = await api("/api/me"); } catch { return; }
  $("#meName").textContent = state.me.user;
  const noAi = !state.me.ai, admin = state.me.role === "admin";
  for (const id of ["#btnFullScan", "#btnSend"]) { const b = $(id); if (b) { b.disabled = noAi; if (noAi) b.title = "Your account can't run Claude. Ask the admin."; } }
  document.body.classList.toggle("no-ai", noAi);
  document.body.classList.toggle("not-admin", !admin);
}
$("#btnMe").onclick = async () => {
  const me = state.me || {};
  $("#meTitle").textContent = `${me.user} (${me.role}${me.ai ? ", Claude access" : ""})`;
  $("#pwBox").classList.toggle("hidden", me.user === "admin");
  $("#usersBox").classList.toggle("hidden", me.role !== "admin" || !me.password_login);
  $("#meErr").textContent = "";
  if (me.role === "admin" && me.password_login) await loadUsers();
  $("#meDlg").showModal();
};
$("#btnMeClose").onclick = () => $("#meDlg").close();
$("#btnMeLogout").onclick = async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); };
$("#meForm").onsubmit = (e) => e.preventDefault();
$("#btnPwChange").onclick = async () => {
  const f = $("#meForm");
  try {
    await api("/api/me/password", { method: "POST", body: JSON.stringify({ current: f.current.value, next: f.next.value }) });
    f.current.value = f.next.value = ""; $("#meErr").textContent = "Password changed. Other devices are logged out.";
  } catch (err) { $("#meErr").textContent = err.message; }
};
async function loadUsers(list) {
  const users = list || (await api("/api/users"));
  const tb = $("#usersTable tbody"); tb.innerHTML = "";
  if (!users.length) { const tr = el("tr"); const td = el("td", "dim", "No other users yet."); td.colSpan = 5; tr.append(td); tb.append(tr); }
  for (const u of users) {
    const tr = el("tr"), aiTd = el("td"), cb = el("input"); cb.type = "checkbox"; cb.checked = u.ai;
    cb.onchange = () => userCall("PUT", u.id, { ai: cb.checked });
    aiTd.append(cb);
    const role = el("select"); role.append(new Option("user", "user"), new Option("admin", "admin")); role.value = u.role;
    role.onchange = () => userCall("PUT", u.id, { role: role.value });
    const roleTd = el("td"); roleTd.append(role);
    const act = el("td"), pw = el("button", "ghost small", "reset password"), del = el("button", "ghost small", "delete");
    pw.onclick = () => { const p = prompt(`New password for ${u.id} (10+ characters):`); if (p) userCall("PUT", u.id, { password: p }); };
    del.onclick = () => { if (confirm(`Delete user ${u.id}? Their paper account stays in the database but they can no longer log in.`)) userCall("DELETE", u.id); };
    act.append(pw, del);
    tr.append(el("td", "sym", u.id), roleTd, aiTd, el("td", "dim small", u.created_at || ""), act); tb.append(tr);
  }
}
async function userCall(method, id, body) {
  $("#meErr").textContent = "";
  try { loadUsers(await api(`/api/users/${encodeURIComponent(id)}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })); }
  catch (e) { $("#meErr").textContent = e.message; loadUsers(); }
}
$("#btnAddUser").onclick = async () => {
  $("#meErr").textContent = "";
  try {
    const list = await api("/api/users", { method: "POST", body: JSON.stringify({ username: $("#nuName").value.trim().toLowerCase(), password: $("#nuPw").value, ai: $("#nuAi").checked }) });
    $("#nuName").value = $("#nuPw").value = ""; $("#nuAi").checked = false; loadUsers(list);
  } catch (e) { $("#meErr").textContent = e.message; }
};

/* ------------------------------------------------------------------ order ticket */
let ticketLast = null;
function openTicket(pre = {}) {
  const f = $("#ticketForm");
  f.reset(); $("#ticketErr").textContent = "";
  f.symbol.value = (pre.symbol || state.symbol || "").toUpperCase();
  f.side.value = pre.side || "long"; f.type.value = pre.type === "stop" ? "limit" : pre.type || "market";
  f.price.value = pre.price ?? ""; f.stop.value = pre.stop ?? ""; f.target.value = pre.target ?? ""; f.note.value = pre.note || "";
  f.sizeBy.value = pre.qty ? "qty" : "risk"; f.size.value = pre.qty ?? (state.paper?.settings?.risk_pct ?? 1);
  f.exit_mode.value = pre.exit_mode || (state.paper?.settings?.auto_flat === false ? "hold" : "eod");
  syncTicket(); refreshTicketPrice(); $("#ticketDlg").showModal();
}
async function refreshTicketPrice() {
  const sym = $("#ticketForm").symbol.value.trim().toUpperCase(); ticketLast = null;
  if (!sym) return syncTicket();
  try { const [q] = await api(`/api/quotes?symbols=${encodeURIComponent(sym)}`); ticketLast = q?.last ?? null; } catch { /* unknown */ }
  syncTicket();
}
function ticketValues() {
  const f = $("#ticketForm"), n = (v) => (v === "" || v == null ? null : Number(v));
  const type = f.type.value, side = f.side.value, entry = type === "market" ? ticketLast : n(f.price.value);
  const stop = n(f.stop.value), target = n(f.target.value), size = n(f.size.value), eq = state.paper?.account?.equity ?? 0;
  let qty = null;
  if (entry) {
    if (f.sizeBy.value === "qty") qty = Math.floor(size || 0);
    else if (f.sizeBy.value === "usd") qty = Math.floor((size || 0) / entry);
    else if (stop) qty = Math.floor((eq * (size || 0) / 100) / Math.abs(entry - stop));
  }
  return { symbol: f.symbol.value.trim().toUpperCase(), side, type, entry, price: type === "market" ? null : entry, stop, target, qty, note: f.note.value, exit_mode: f.exit_mode.value };
}
function syncTicket() {
  const f = $("#ticketForm"), v = ticketValues();
  $("#ticketForm .px").classList.toggle("hidden", f.type.value === "market");
  $("#sizeLbl").textContent = { qty: "Shares", usd: "Dollars to invest", risk: "Risk % of equity (needs a stop)" }[f.sizeBy.value];
  const out = $("#ticketPreview"); out.innerHTML = "";
  const kv = (k, val, cls = "") => out.append(el("span", "k", k), el("span", cls, val));
  kv("Last price", ticketLast == null ? "…" : fmt(ticketLast));
  if (v.type === "limit" && v.entry && ticketLast != null) {
    const now = v.side === "long" ? ticketLast <= v.entry : ticketLast >= v.entry;
    kv("Execution", now ? `fills now at about ${fmt(ticketLast)} (${v.side === "long" ? "at or below" : "at or above"} your entry)` : `waits until the price ${v.side === "long" ? "drops" : "rises"} to ${fmt(v.entry)}`, now ? "up" : "");
  }
  if (v.entry && v.qty) {
    const cost = v.entry * v.qty, cash = state.paper?.account?.cash ?? 0;
    kv("Shares", fmt(v.qty, 0)); kv("Position", `${money(cost)} (${fmt((cost / Math.max(cash, 1)) * 100, 1)}% of cash)`, cost > cash ? "down" : "");
    const sg = v.side === "long" ? 1 : -1;
    if (v.stop) kv("Max loss at stop", money((v.stop - v.entry) * v.qty * sg), "down");
    if (v.target) kv("Gain at target", money((v.target - v.entry) * v.qty * sg), "up");
    if (v.stop && v.target) kv("Reward : risk", `${fmt(Math.abs(v.target - v.entry) / Math.abs(v.entry - v.stop), 2)} R`);
    if (cost > cash) out.append(el("span", "warn", "Not enough paper cash for this size."));
    const ph = marketState().s;
    if (ph === "closed") out.append(el("span", "note", v.type === "market" ? "Market closed: this market order fills at the first trade of the next session (07:00 New York pre-market)." : "Market closed: the order starts working at the next session (07:00 New York pre-market)."));
    else if (ph === "pre" || ph === "after") out.append(el("span", "note", `${ph === "pre" ? "Pre-market" : "After-hours"}: fills on extended-hours trades (thinner volume, wider spreads). Stops and targets are watched in every session.`));
    if (v.exit_mode === "hold" && !v.stop && !v.target) out.append(el("span", "warn", "Hold mode with no stop-loss or take-profit: the position stays open until you close it."));
    else if (v.exit_mode === "hold") out.append(el("span", "note", "Held overnight until the stop or target is hit (it can gap past them at the next open)."));
  } else out.append(el("span", "warn", f.sizeBy.value === "risk" && !v.stop ? "Risk sizing needs a stop-loss." : "Enter a price and size."));
  $("#btnTicketSubmit").textContent = `Place paper ${v.side === "long" ? "buy" : "short"}${v.qty ? ` · ${v.qty} ${v.symbol}` : ""}`;
}
$("#ticketForm").addEventListener("input", (e) => { if (e.target.name === "symbol") { clearTimeout(state.tkT); state.tkT = setTimeout(refreshTicketPrice, 500); } syncTicket(); });
$("#ticketForm").addEventListener("change", syncTicket);
$("#btnTicketCancel").onclick = () => $("#ticketDlg").close();
$("#ticketForm").onsubmit = async (e) => {
  e.preventDefault();
  const v = ticketValues();
  if (!v.qty || v.qty < 1) { $("#ticketErr").textContent = "Size works out to less than 1 share."; return; }
  try {
    await api("/api/paper/orders", { method: "POST", body: JSON.stringify({ symbol: v.symbol, side: v.side, type: v.type, price: v.price, qty: v.qty, stop: v.stop, target: v.target, note: v.note, exit_mode: v.exit_mode }) });
    $("#ticketDlg").close(); showTab("center", "paper"); loadPaper();
  } catch (err) { $("#ticketErr").textContent = err.message; }
};
/** Prefill from a recommendation. The entry is the most to pay (long) / least to accept (short): it fills now if the market is already there. */
async function openTicketFromPick(p) {
  const side = /short/i.test(p.bias || "") ? "short" : "long";
  const entry = p.entry == null ? null : Number(p.entry);
  const type = entry == null ? "market" : "limit";
  openTicket({ symbol: p.symbol, side, type, price: entry, stop: p.stop, target: (p.targets || [])[0], qty: p.size_shares || null, note: p.setup || "" });
}
$("#btnTradeSym").onclick = () => openTicket({ symbol: state.symbol });
$("#btnPaperPlan").onclick = () => {
  const n = (id) => ($(id).value === "" ? null : Number($(id).value));
  const entry = n("#rEntry"), stop = n("#rStop"), r = entry && stop ? Math.abs(entry - stop) : null, side = $("#rSide").value, sg = side === "long" ? 1 : -1;
  openTicket({ symbol: state.symbol, side, type: "limit", price: entry, stop, target: r ? +(entry + sg * 2 * r).toFixed(2) : null });
};

/* ------------------------------------------------------------------ paper account view */
async function loadPaper() {
  let d;
  try { d = await api("/api/paper"); } catch (e) { $("#paper").innerHTML = ""; $("#paper").append(el("div", "msg err", e.message)); return; }
  state.paper = d; renderPaper(d);
}
function stat(label, value, cls = "", sub = "") {
  const c = el("div", "bd-card"); c.append(el("div", "dim small", label), el("div", `mono big ${cls}`, value)); if (sub) c.append(el("div", `small ${cls}`, sub)); return c;
}
function table(headers, rows) {
  const t = el("table", "bd-table"), th = el("tr");
  headers.forEach((h) => th.append(el("th", null, h))); const thead = el("thead"); thead.append(th); t.append(thead);
  const tb = el("tbody"); rows.forEach((r) => tb.append(r)); t.append(tb);
  const w = el("div", "bd-table-wrap"); w.append(t); return w;
}
/** One line on which session is trading now and what that means for orders. */
function sessionNote(ss) {
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const hours = ss ? `Pre-market ${hm(ss.pre)}–${hm(ss.open)} · Regular ${hm(ss.open)}–${hm(ss.close)} · After-hours ${hm(ss.close)}–${hm(ss.postEnd)} New York` : "";
  const phase = ss?.phase ?? "closed";
  const txt = {
    pre: "PRE-MARKET: orders fill on extended-hours trades.",
    regular: "REGULAR SESSION.",
    post: "AFTER-HOURS: orders fill on extended-hours trades.",
    closed: `MARKET CLOSED: new orders work from the next session (${ss?.next_day ?? "next trading day"}, 07:00 pre-market).`,
  }[phase];
  const n = el("div", `session-note ${phase}`); n.append(el("b", null, txt), el("span", "dim", ` ${hours}`)); return n;
}
function td(text, cls = "") { return el("td", cls, text == null ? "—" : String(text)); }

function renderPaper(d) {
  const host = $("#paper"), a = d.account; host.innerHTML = "";
  const head = el("div", "bd-head");
  head.append(el("h2", null, "Paper trading"), el("span", "badge paper", "SIMULATED"), el("span", "dim small", `${a.user} · started with ${money(a.starting_cash)}`));
  const acts = el("span", "row gap"); acts.style.marginLeft = "auto";
  const nb = el("button", "primary small", "+ New order"), sb = el("button", "ghost small", "⚙ Settings & auto-trade");
  nb.onclick = () => openTicket({ symbol: state.symbol }); sb.onclick = openPaperSettings;
  acts.append(nb, sb); head.append(acts); host.append(head);
  host.append(sessionNote(d.session));
  if (d.settings.auto_trade) {
    const st = d.settings, names = Object.fromEntries((state.briefData?.slots || []).map((x) => [x.id, x.label]));
    const from = st.auto_slots?.length ? st.auto_slots.map((x) => names[x] || x).join(", ") : "every scan";
    const extra = [st.auto_side !== "both" ? `${st.auto_side} only` : "", st.auto_min_rr ? `R:R ≥ ${st.auto_min_rr}` : "", st.auto_min_price ? `price ≥ ${money(st.auto_min_price)}` : "",
      `${st.auto_start}–${st.auto_end} NY`, `max ${st.auto_max_trades_day}/day`, st.auto_max_daily_loss ? `pauses after −${money(st.auto_max_daily_loss)} today` : "",
      st.auto_blocked?.length ? `never ${st.auto_blocked.join(", ")}` : ""].filter(Boolean).join(" · ");
    host.append(el("div", "small up", `Auto-trade ON from ${from}: score ≥ ${st.auto_min_score}, up to ${st.auto_max_positions} at a time, ${st.sizing === "risk" ? `${st.risk_pct}% risk per trade` : st.sizing === "fixed" ? `${money(st.fixed_usd)} per trade` : "recommended size"}, ${st.auto_flat ? "closed at end of day" : "held until stop or target"} · ${extra}.`));
  }

  const todayPnl = a.today_realized + a.unrealized;
  const cards = el("div", "bd-indices");
  cards.append(stat("Equity", money(a.equity), "", `${a.total_pct >= 0 ? "+" : ""}${fmt(a.total_pct)}% total`),
    stat("Cash available", money(a.cash)), stat("Invested", money(a.invested)),
    stat("Today", money(todayPnl), pnlCls(todayPnl), `${money(a.today_realized)} closed · ${money(a.unrealized)} open`),
    stat("Total P&L", money(a.total_pnl), pnlCls(a.total_pnl), `${money(a.realized)} realized`),
    stat("Win rate", a.win_rate == null ? "—" : `${fmt(a.win_rate, 1)}%`, "", `${a.trades} closed trades`));
  host.append(cards);

  // Charts: equity curve + daily P&L
  if (d.daily.length) {
    const grid = el("div", "bd-grid"), eqSec = section("Equity by day"), dSec = section("Daily gain / loss");
    eqSec.append(equityChart([{ day: "start", equity: a.starting_cash }, ...d.curve]));
    dSec.append(barChart(d.daily.slice(-15).map((x) => ({ label: x.day, value: x.pnl })), { unit: "$", signed: true }));
    grid.append(eqSec, dSec); host.append(grid);
  }

  // Open positions
  const ps = section(`Open positions (${d.positions.length})`);
  ps.append(d.positions.length ? table(["Symbol", "Side", "Qty", "Entry", "Last", "P&L $", "P&L %", "Stop", "Target", "Exit", "Source", "Opened", ""], d.positions.map((p) => {
    const tr = el("tr"); const sym = td(p.symbol, "sym"); sym.style.cursor = "pointer"; sym.onclick = () => { setSymbol(p.symbol); showTab("center", "chart"); };
    tr.append(sym, td(p.side === "long" ? "long" : "short", p.side === "long" ? "up" : "down"), td(p.qty, "num"), td(fmt(p.entry), "num"), td(fmt(p.last), "num"),
      td(money(p.unrealized), `num ${pnlCls(p.unrealized)}`), td(p.unrealized_pct == null ? "—" : `${fmt(p.unrealized_pct)}%`, `num ${pnlCls(p.unrealized_pct)}`),
      td(fmt(p.stop), "num down"), td(fmt(p.target), "num up"));
    // Exit mode toggle: end of day <-> hold until stop/target.
    const mode = p.exit_mode || (d.settings.auto_flat ? "eod" : "hold"), exTd = el("td"), ex = el("button", `ghost small exit-${mode}`, mode === "eod" ? "End of day" : "Hold to stop/target");
    ex.title = "Click to switch"; ex.onclick = async () => {
      try { await api(`/api/paper/positions/${p.id}`, { method: "PUT", body: JSON.stringify({ exit_mode: mode === "eod" ? "hold" : "eod" }) }); loadPaper(); } catch (e) { showBanner(e.message); }
    };
    exTd.append(ex);
    tr.append(exTd, td(p.source), td(p.day_opened < d.ny_date ? `since ${p.day_opened}` : ago(p.opened_at), "dim small"));
    const act = el("td"), close = el("button", "primary small", p.close_req ? "Sells at next open" : p.side === "long" ? "Sell now" : "Cover now"), edit = el("button", "ghost small", "edit");
    close.disabled = !!p.close_req;
    if (p.close_req) close.title = "Requested while the market was closed; executes at the first trade of the next session (07:00 New York).";
    close.onclick = async () => {
      const shut = marketState().s === "closed";
      if (!confirm(`${p.side === "long" ? "Sell" : "Buy to cover"} ${p.qty} ${p.symbol} at market${shut ? "?\n\nThe market is closed: it executes at the first trade of the next session (07:00 New York pre-market)." : "?"}`)) return;
      try { await api(`/api/paper/positions/${p.id}/close`, { method: "POST", body: "{}" }); loadPaper(); } catch (e) { showBanner(e.message); }
    };
    edit.onclick = async () => {
      const s = prompt(`New stop-loss for ${p.symbol} (blank = none):`, p.stop ?? ""); if (s === null) return;
      const t = prompt(`New take-profit for ${p.symbol} (blank = none):`, p.target ?? ""); if (t === null) return;
      try { await api(`/api/paper/positions/${p.id}`, { method: "PUT", body: JSON.stringify({ stop: s, target: t }) }); loadPaper(); } catch (e) { showBanner(e.message); }
    };
    act.append(close, edit); tr.append(act); return tr;
  })) : el("div", "dim small", "No open positions."));
  host.append(ps);

  // Orders
  const working = d.orders.filter((o) => o.status === "open"), recent = d.orders.filter((o) => o.status !== "open").slice(0, 20);
  const os = section(`Working orders (${working.length})`);
  const orderRow = (o) => {
    const tr = el("tr");
    tr.append(td(o.symbol, "sym"), td(o.side === "long" ? "buy" : "short", o.side === "long" ? "up" : "down"), td(o.type === "market" ? "market" : "limit"), td(o.price == null ? "market" : fmt(o.price), "num"),
      td(o.qty, "num"), td(fmt(o.stop), "num down"), td(fmt(o.target), "num up"), td(o.source), td(o.status, `pill ${o.status === "filled" ? "done" : o.status === "open" ? "running" : "error"}`),
      td(o.reason || (o.fill_price ? `filled @ ${fmt(o.fill_price)}` : ago(o.created_at)), "dim small"));
    const act = el("td");
    if (o.status === "open") {
      const c = el("button", "ghost small", "cancel");
      c.onclick = async () => { try { await api(`/api/paper/orders/${o.id}`, { method: "DELETE" }); loadPaper(); } catch (e) { showBanner(e.message); } };
      act.append(c);
    }
    tr.append(act); return tr;
  };
  const oh = ["Symbol", "Side", "Type", "Price", "Qty", "Stop", "Target", "Source", "Status", "", ""];
  os.append(working.length ? table(oh, working.map(orderRow)) : el("div", "dim small", "No working orders. An entry order waits here only while the price is above your entry (long) or below it (short); it expires when after-hours ends."));
  if (recent.length) { const det = el("details"), s = el("summary", "dim small", `Recent orders (${recent.length})`); det.append(s, table(oh, recent.map(orderRow))); os.append(det); }
  host.append(os);

  // Daily summary
  const ds = section("Daily summary");
  let cum = a.starting_cash;
  ds.append(d.daily.length ? table(["Day", "Trades", "Wins", "Losses", "Win %", "P&L", "Best", "Worst", "Equity (closed)"], [...d.daily].map((x) => {
    cum += x.pnl; const tr = el("tr");
    tr.append(td(x.day, "mono"), td(x.trades, "num"), td(x.wins, "num up"), td(x.losses, "num down"), td(`${fmt((x.wins / x.trades) * 100, 0)}%`, "num"),
      td(money(x.pnl), `num ${pnlCls(x.pnl)}`), td(money(x.best), "num up"), td(money(x.worst), "num down"), td(money(cum), "num"));
    return tr;
  }).reverse()) : el("div", "dim small", "No closed trades yet."));
  host.append(ds);

  // History
  const hs = section(`Trade history (${d.trades.length})`);
  hs.append(d.trades.length ? table(["Closed", "Symbol", "Side", "Qty", "Entry", "Exit", "Exit reason", "P&L", "Source", "Note"], d.trades.map((t) => {
    const tr = el("tr");
    tr.append(td(tm(t.closed_at), "dim small"), td(t.symbol, "sym"), td(t.side, t.side === "long" ? "up" : "down"), td(t.qty, "num"), td(fmt(t.entry), "num"), td(fmt(t.exit), "num"),
      td(t.exit_reason), td(money(t.pnl), `num ${pnlCls(t.pnl)}`), td(t.source), td(t.note || "", "wrap dim small"));
    return tr;
  })) : el("div", "dim small", "Closed trades appear here."));
  host.append(hs);
  host.append(el("div", "dim tiny", `Simulated fills against 1-minute bars from ${state.status?.market?.label || "the market data feed"}: an entry fills at the entry price or better (at once if the market is already there), and a bar that touches both stop and target counts as the stop. Real fills, slippage and liquidity differ.`));
}

function equityChart(points) {
  const W = 560, H = 160, pad = 28, vals = points.map((p) => p.equity), lo = Math.min(...vals), hi = Math.max(...vals);
  const x = (i) => pad + (i / Math.max(points.length - 1, 1)) * (W - pad * 2), y = (v) => H - 18 - ((v - lo) / (hi - lo || 1)) * (H - 36);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "bd-bars" });
  svg("line", { x1: pad, x2: W - pad, y1: y(points[0].equity), y2: y(points[0].equity), stroke: cssv("--line"), "stroke-dasharray": "4 3" }, g);
  const up = vals.at(-1) >= vals[0];
  svg("polyline", { points: points.map((p, i) => `${x(i)},${y(p.equity)}`).join(" "), fill: "none", stroke: up ? cssv("--up") : cssv("--down"), "stroke-width": 2 }, g);
  points.forEach((p, i) => svg("circle", { cx: x(i), cy: y(p.equity), r: 2.5, fill: up ? cssv("--up") : cssv("--down") }, g));
  svg("text", { x: pad, y: 12, class: "bd-val" }, g).textContent = money(hi);
  svg("text", { x: pad, y: H - 4, class: "bd-val" }, g).textContent = `${money(lo)} · ${points[1]?.day ?? ""} → ${points.at(-1).day}`;
  return g;
}

/* ------------------------------------------------------------------ settings dialog */
function openPaperSettings() {
  const f = $("#paperSetForm"), s = state.paper.settings;
  for (const k of ["auto_min_score", "auto_max_positions", "auto_valid_min", "sizing", "risk_pct", "fixed_usd", "max_position_pct", "target", "commission"]) f[k].value = s[k];
  f.auto_trade.checked = s.auto_trade; f.auto_flat.value = s.auto_flat ? "eod" : "hold"; f.starting_cash.value = state.paper.account.starting_cash;
  for (const k of ["auto_side", "auto_min_rr", "auto_min_price", "auto_start", "auto_end", "auto_max_trades_day", "auto_max_daily_loss"]) f[k].value = s[k];
  f.auto_blocked.value = (s.auto_blocked || []).join(", ");
  // Which scans trigger auto-trades in this account (none ticked = every scan).
  const box = $("#psSlots"); box.innerHTML = "";
  box.append(el("span", "dim small", "Trade automatically from:"));
  for (const sl of state.briefData?.slots || []) {
    const lb = el("label", "check"), cb = el("input"); cb.type = "checkbox"; cb.value = sl.id;
    cb.checked = !s.auto_slots?.length || s.auto_slots.includes(sl.id);
    lb.append(cb, document.createTextNode(` ${sl.label}`)); box.append(lb);
  }
  $("#paperSetErr").textContent = ""; $("#paperSetDlg").showModal();
}
$("#btnPaperSetCancel").onclick = () => $("#paperSetDlg").close();
$("#paperSetForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, s = {};
  for (const k of ["auto_min_score", "auto_max_positions", "auto_valid_min", "risk_pct", "fixed_usd", "max_position_pct", "commission"]) s[k] = Number(f[k].value);
  s.sizing = f.sizing.value; s.target = f.target.value; s.auto_trade = f.auto_trade.checked; s.auto_flat = f.auto_flat.value === "eod";
  for (const k of ["auto_min_rr", "auto_min_price", "auto_max_trades_day", "auto_max_daily_loss"]) s[k] = Number(f[k].value);
  s.auto_side = f.auto_side.value; s.auto_start = f.auto_start.value; s.auto_end = f.auto_end.value;
  s.auto_blocked = f.auto_blocked.value.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  const boxes = [...$$("#psSlots input")], ticked = boxes.filter((b) => b.checked).map((b) => b.value);
  if (boxes.length && !ticked.length) { $("#paperSetErr").textContent = "Tick at least one scan, or turn auto-trade off."; return; }
  s.auto_slots = ticked.length === boxes.length ? [] : ticked;
  try { await api("/api/paper/settings", { method: "PUT", body: JSON.stringify({ settings: s }) }); $("#paperSetDlg").close(); loadPaper(); }
  catch (err) { $("#paperSetErr").textContent = err.message; }
};
$("#btnPaperReset").onclick = async () => {
  const cash = Number($("#paperSetForm").starting_cash.value);
  if (!confirm(`Reset the paper account to ${money(cash)}? All paper orders, positions and history are deleted.`)) return;
  try { await api("/api/paper/reset", { method: "POST", body: JSON.stringify({ starting_cash: cash }) }); $("#paperSetDlg").close(); loadPaper(); }
  catch (err) { $("#paperSetErr").textContent = err.message; }
};

/* ------------------------------------------------------------------ wiring */
$$('.center-tabs button[data-tab="paper"]').forEach((b) => b.addEventListener("click", loadPaper));
setInterval(() => { if (!$('.tab-body[data-tab="paper"]').classList.contains("hidden")) loadPaper(); }, 15000);
loadMe().then(loadPaper);
