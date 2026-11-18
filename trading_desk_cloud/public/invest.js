"use strict";
/* Invest: the simple screen. One line that says what to do today, then one card per idea with a plain verdict, the
   size and levels if it is a buy, and every reason for and against with a tag that says whether that input has earned
   the right to count. Data: GET /api/invest. Nothing here places an order. */
state.invest = { data: null, open: {} };
async function loadInvest() {
  const host = $("#invest"); if (!state.invest.data) { host.textContent = ""; host.append(el("div", "dim", "Reading every model…")); }
  try { state.invest.data = await api("/api/invest"); } catch (e) { host.textContent = ""; host.append(el("div", "msg err", e.message)); return; }
  renderInvest();
}
const INV_ACT = { buy: ["Buy", "up"], consider: ["Small position", "warn"], wait: ["Wait", ""], avoid: ["Avoid", "down"] };
const INV_STATUS = { measured: "Measured", proven: "Proven on your data", unproven: "Not proven yet", losing: "Losing on your data" };
function renderInvest() {
  const host = $("#invest"), d = state.invest.data; if (!d) return; host.textContent = "";
  $("#investNote").textContent = `as of ${d.day}`;
  // 1. The answer.
  const top = el("div", "inv-top"); top.append(el("div", "inv-headline", d.headline), el("p", "small", d.market.text));
  const a = d.account, kp = el("div", "inv-kpis");
  for (const [k, v] of [["Account", `$${fmt(a.equity)}`], ["In cash", `${fmt(100 - a.invested_pct, 0)}%`], ["Open positions", String(a.open_positions)], ["Risk per trade", `${a.risk_pct}%`], ["Largest position", `${a.max_position_pct}% of the account`]]) { const c = el("div", "inv-kpi"); c.append(el("span", "dim small", k), el("b", null, v)); kp.append(c); }
  top.append(kp); host.append(top);
  // 2. The ideas.
  const list = el("div", "inv-list"); list.setAttribute("role", "list");
  if (!d.ideas.length) list.append(el("div", "bd-empty", "No symbols to judge yet: add stocks to your watchlist or run a scan."));
  for (const i of d.ideas) {
    const [word, cls] = INV_ACT[i.action] || [i.action, ""], card = el("article", `inv-card ${i.action}`); card.setAttribute("role", "listitem"); card.setAttribute("aria-label", `${i.symbol}: ${i.label}`);
    const head = el("div", "inv-head"), sym = el("button", "linklike inv-sym", i.symbol); sym.type = "button"; sym.title = `Open the ${i.symbol} chart`; sym.onclick = () => { setSymbol(i.symbol); navigate("chart"); };
    const px = el("span", "mono small", i.last == null ? "" : `${fmt(i.last)}${i.change_pct == null ? "" : `  ${i.change_pct > 0 ? "+" : ""}${fmt(i.change_pct)}%`}`); if (typeof liveTag === "function" && i.last != null) liveTag(px, i.symbol, "pxchg");
    const badge = el("span", `inv-badge ${cls}`, word), meter = el("span", "inv-score"); meter.title = "Score out of 100: 68 or more is a buy, 58 to 67 a small position"; meter.setAttribute("aria-label", `Score ${i.score} of 100`); const bar = el("i"); bar.style.width = `${i.score}%`; meter.append(bar);
    head.append(sym, px, el("span", "spacer"), meter, el("span", "mono small", String(i.score)), badge); card.append(head);
    card.append(el("div", "inv-label", i.label));
    if (i.trade) card.append(el("div", "inv-trade", i.trade.text));
    const fors = i.factors.filter((f) => f.says === "for"), against = i.factors.filter((f) => f.says === "against");
    card.append(el("div", "small", `${fors.length ? `For: ${fors.map((f) => f.name).join(", ")}.` : "Nothing speaks for it."} ${against.length ? `Against: ${against.map((f) => f.name).join(", ")}.` : ""}`));
    const more = el("button", "linklike small", state.invest.open[i.symbol] ? "Hide the reasons" : "Show every reason"); more.type = "button"; more.setAttribute("aria-expanded", String(!!state.invest.open[i.symbol]));
    const why = el("div", "inv-why"); why.hidden = !state.invest.open[i.symbol];
    for (const f of i.factors) { const row = el("div", `inv-f ${f.says}`); row.append(el("b", null, `${f.says === "for" ? "+" : f.says === "against" ? "−" : "·"} ${f.name}`), el("span", `inv-tag ${f.weight === "counted" ? "on" : f.weight === "small" ? "mid" : "off"}`, f.weight === "counted" ? `counted${f.points ? ` (${f.points > 0 ? "+" : ""}${f.points})` : ""}` : f.weight === "small" ? `small weight${f.points ? ` (${f.points > 0 ? "+" : ""}${f.points})` : ""}` : "shown, not counted"), el("span", "small", f.text)); why.append(row); }
    more.onclick = () => { state.invest.open[i.symbol] = why.hidden; why.hidden = !why.hidden; more.textContent = why.hidden ? "Show every reason" : "Hide the reasons"; more.setAttribute("aria-expanded", String(!why.hidden)); };
    card.append(more, why);
    if (i.trade && i.trade.shares > 0 && !state.paperView) { const b = el("button", "ghost small", "Open a paper order with these levels"); b.type = "button"; b.onclick = () => { if (typeof openTicket === "function") openTicket({ symbol: i.symbol, side: "long", type: "limit", price: i.trade.entry, qty: i.trade.shares, stop: i.trade.stop, target: i.trade.target, exit_mode: "hold" }); else { setSymbol(i.symbol); navigate("paper"); } }; card.append(b); }
    list.append(card);
  }
  host.append(list);
  // 3. How far each input can be trusted.
  const ev = el("section", "inv-ev"); ev.append(el("h3", null, "How much each input can be trusted"));
  for (const e of d.evidence) { const row = el("div", "inv-f"); row.append(el("b", null, e.name), el("span", `inv-tag ${e.status === "proven" || e.status === "measured" ? "on" : e.status === "losing" ? "bad" : "off"}`, INV_STATUS[e.status] || e.status), el("span", "small", e.text)); ev.append(row); }
  ev.append(el("p", "dim small", d.rules), el("p", "dim small", d.disclaimer)); host.append(ev);
  if (typeof deskSummaryEl === "function") host.append(deskSummaryEl());
}
document.addEventListener("section", (e) => { clearInterval(state.invest.timer); if (e.detail === "invest") { loadInvest(); state.invest.timer = setInterval(() => { if (sectionVisible("invest") && !document.hidden) loadInvest(); }, 120000); } });
$("#investRefresh").onclick = () => loadInvest();
