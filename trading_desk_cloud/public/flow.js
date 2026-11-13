"use strict";
/* Options flow: where the option premium went today, the prints since the last refresh, unusual contracts, strike
   concentration and the dealer gamma (GEX) map. Data: Cboe delayed chains, about 15 minutes behind. */

state.flow = { data: null, symbol: null, range: "month", timer: null, filter: { type: "all", side: "all", min: 0, unusual: false }, sort: "premium", view: "tape" };
const fM = (n) => (n == null ? "—" : Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`);
const fK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const flowDte = (c) => (c.dte === 0 ? "today" : `${c.dte}d`);
const flowCls = (score) => (score > 0 ? "up" : score < 0 ? "down" : "dim");

async function loadFlow(sym) {
  if (sym) state.flow.symbol = sym.trim().toUpperCase();
  if (!state.flow.symbol) state.flow.symbol = /^[A-Z]{1,6}$/.test(state.symbol || "") ? state.symbol : "SPY";
  $("#flowSym").value = state.flow.symbol;
  let d;
  try { d = await api(`/api/flow?symbol=${encodeURIComponent(state.flow.symbol)}&range=${state.flow.range}`); }
  catch (e) { $("#flow").innerHTML = ""; $("#flow").append(el("div", "msg err", e.message)); return; }
  state.flow.data = d; renderFlow();
}

function flowSplit(label, a, b, la, lb) {
  const tot = a + b || 1, box = el("div", "fl-split"); box.append(el("div", "small dim", label));
  const bar = el("div", "fl-bar"); bar.setAttribute("role", "img"); bar.setAttribute("aria-label", `${label}: ${la} ${fM(a)}, ${lb} ${fM(b)}`);
  const x = el("i", "up"); x.style.width = `${(a / tot) * 100}%`; const y = el("i", "down"); y.style.width = `${(b / tot) * 100}%`; bar.append(x, y);
  const leg = el("div", "fl-leg small mono"); leg.append(el("span", "up", `${la} ${fM(a)} · ${Math.round((a / tot) * 100)}%`), el("span", "down", `${lb} ${fM(b)} · ${Math.round((b / tot) * 100)}%`));
  box.append(bar, leg); return box;
}

function flowGex(d) {
  const sec = el("section", "fl-card"); sec.append(el("h4", null, "Dealer gamma by strike (GEX)"));
  const g = d.gex, lv = g.levels; if (!lv.length) { sec.append(el("div", "dim small", "No open interest in this range.")); return sec; }
  const reg = el("p", "small"); reg.append(el("b", g.regime === "positive" ? "up" : "down", g.regime === "positive" ? "Positive gamma" : "Negative gamma"), ` · net ${fM(g.net)} per 1% move. `,
    g.regime === "positive" ? "Dealers trade against the move: dips get bought, rallies sold. Expect smaller ranges and a pull toward the largest strike." : "Dealers trade with the move: selling into drops, buying into rallies. Expect bigger, faster swings.");
  sec.append(reg);
  const chips = el("div", "fl-chips");
  for (const [k, v, t] of [["Magnet", g.magnet, "Largest positive strike: price tends to stall or pin here"], ["Pit", g.pit, "Largest negative strike: moves tend to speed up through here"], ["Flip", g.flip, "Where total gamma changes sign near the price"], ["Call wall", g.call_wall, "Most call gamma: usual ceiling"], ["Put wall", g.put_wall, "Most put gamma: usual floor"]])
    if (v != null) { const c = el("span", "chip", `${k} ${fmt(v)}`); c.title = t; chips.append(c); }
  sec.append(chips);
  // Horizontal bars, one row per strike, around the price.
  const near = lv.slice().sort((a, b) => Math.abs(a.strike - d.spot) - Math.abs(b.strike - d.spot)).slice(0, 25).sort((a, b) => b.strike - a.strike);
  const max = Math.max(...near.map((l) => Math.abs(l.gex)), 1), W = 520, rowH = 16, H = near.length * rowH + 8, mid = 250;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "fl-gex", role: "img" }); s.setAttribute("aria-label", `Gamma exposure by strike around ${fmt(d.spot)}. ${g.regime} gamma.`);
  let spotY = null;
  near.forEach((l, i) => {
    const y = 4 + i * rowH, w = (Math.abs(l.gex) / max) * 200;
    if (spotY == null && l.strike <= d.spot) spotY = y;
    svg("text", { x: mid - 206, y: y + 11, class: "bd-val", "text-anchor": "end" }, s).textContent = fmt(l.strike);
    const r = svg("rect", { x: l.gex >= 0 ? mid : mid - w, y: y + 2, width: Math.max(w, 1), height: rowH - 5, rx: 2, fill: cssv(l.gex >= 0 ? "--up" : "--down") }, s);
    svg("title", {}, r).textContent = `${fmt(l.strike)}: ${fM(l.gex)} (calls ${fM(l.call_gex)}, puts ${fM(l.put_gex)})`;
    if (l.strike === g.magnet || l.strike === g.pit) svg("text", { x: l.gex >= 0 ? mid + w + 4 : mid - w - 4, y: y + 11, class: "bd-val", "text-anchor": l.gex >= 0 ? "start" : "end" }, s).textContent = l.strike === g.magnet ? "magnet" : "pit";
  });
  svg("line", { x1: mid, x2: mid, y1: 0, y2: H, stroke: cssv("--line") }, s);
  if (spotY != null) { svg("line", { x1: 40, x2: W - 4, y1: spotY, y2: spotY, stroke: cssv("--accent"), "stroke-dasharray": "4 3" }, s); svg("text", { x: W - 6, y: spotY - 3, class: "bd-val", "text-anchor": "end", fill: cssv("--accent") }, s).textContent = `price ${fmt(d.spot)}`; }
  sec.append(s);
  return sec;
}

function flowRows(d) {
  const f = state.flow.filter;
  let rows = state.flow.view === "unusual" ? d.unusual : d.tape;
  rows = rows.filter((c) => (f.type === "all" || c.type === f.type) && (f.side === "all" || (f.side === "bull" ? c.score > 0 : f.side === "bear" ? c.score < 0 : c.side === f.side)) && c.premium >= f.min && (!f.unusual || c.tags.includes("unusual")));
  const k = state.flow.sort; return rows.slice().sort((a, b) => (k === "score" ? Math.abs(b.score) - Math.abs(a.score) : k === "interest" ? b.interest - a.interest : k === "volume" ? b.volume - a.volume : k === "voloi" ? (b.vol_oi ?? 0) - (a.vol_oi ?? 0) : b.premium - a.premium));
}

function renderFlow() {
  const host = $("#flow"), d = state.flow.data; if (!d) return;
  host.innerHTML = "";
  const T = d.totals, head = el("div", "fl-head");
  const sc = el("div", `fl-score ${flowCls(T.flow_score)}`); sc.append(el("span", "small dim", "Flow score"), el("b", "mono", `${T.flow_score > 0 ? "+" : ""}${T.flow_score}`)); sc.title = "−100 all bearish premium, +100 all bullish. Bullish = calls bought or puts sold. A ranking aid, not a forecast.";
  head.append(sc);
  const px = el("div", "fl-kpi"); px.append(el("span", "small dim", d.symbol), liveTag(el("b", "mono", fmt(d.spot)), d.symbol)); head.append(px);
  for (const [k, v, t] of [["Premium today", fM(T.call_premium + T.put_premium), "Dollars paid for options in this expiry range"], ["Put/Call volume", T.pc_volume ?? "—", "Above 1: more puts than calls traded"], ["Put/Call open interest", T.pc_oi ?? "—", "Positions held overnight"], ["IV30", d.iv30 == null ? "—" : `${fmt(d.iv30)}%${d.iv30_change ? ` (${d.iv30_change > 0 ? "+" : ""}${fmt(d.iv30_change)})` : ""}`, "30-day implied volatility"]]) {
    const b = el("div", "fl-kpi"); b.title = t; b.append(el("span", "small dim", k), el("b", "mono", String(v))); head.append(b);
  }
  host.append(head);
  const body = el("div", "fl-body"), left = el("div", "fl-main"), right = el("div", "fl-side");

  // Tape
  const tabs = el("div", "seg fl-tabs");
  for (const [k, label] of [["tape", "Premium leaders"], ["prints", `New since last refresh${d.prints.length ? ` (${d.prints.length})` : ""}`], ["unusual", `Unusual (${d.unusual.length})`]]) { const b = el("button", state.flow.view === k ? "on" : "", label); b.type = "button"; b.onclick = () => { state.flow.view = k; renderFlow(); }; tabs.append(b); }
  left.append(tabs);
  if (state.flow.view === "prints") {
    if (!d.prints.length) left.append(el("div", "dim small", "Nothing new yet. Each refresh compares volume with the snapshot before it; contracts that traded in between appear here with what was paid."));
    const rows = d.prints.map((p) => { const tr = el("tr"); tr.append(td(new Date(p.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "mono dim"), td(`${fmt(p.strike)}${p.type}`, `sym ${p.type === "C" ? "up" : "down"}`), td(`${p.expiry.slice(5)} · ${flowDte(p)}`, "small"), td(fK(p.contracts), "num"), td(fmt(p.price), "num"), td(fM(p.premium), "num"), td(p.side, p.side === "bought" ? "up" : p.side === "sold" ? "down" : "dim"), td(`${p.score > 0 ? "+" : ""}${p.score}`, `num ${flowCls(p.score)}`)); return tr; });
    if (rows.length) { const w = el("div", "bd-table-wrap"); w.append(table(["Seen", "Contract", "Expiry", "Contracts", "Price", "Premium", "Side", "Score"], rows)); left.append(w); }
  } else {
    const fl = el("div", "fl-filters"), f = state.flow.filter;
    const sel = (label, key, opts) => { const s = el("select", "small"); s.setAttribute("aria-label", label); for (const [v, t] of opts) s.append(new Option(t, v)); s.value = String(f[key]); s.onchange = () => { f[key] = key === "min" ? +s.value : s.value; renderFlow(); }; return s; };
    fl.append(sel("Calls or puts", "type", [["all", "Calls + puts"], ["C", "Calls"], ["P", "Puts"]]), sel("Side", "side", [["all", "Any side"], ["bull", "Bullish"], ["bear", "Bearish"], ["bought", "Bought (at ask)"], ["sold", "Sold (at bid)"]]),
      sel("Minimum premium", "min", [[0, "Any size"], [100000, "$100K+"], [500000, "$500K+"], [1000000, "$1M+"]]));
    const so = el("select", "small"); so.setAttribute("aria-label", "Sort by"); for (const [v, t] of [["premium", "Sort: premium"], ["score", "Sort: score"], ["interest", "Sort: interest"], ["volume", "Sort: volume"], ["voloi", "Sort: volume / OI"]]) so.append(new Option(t, v)); so.value = state.flow.sort; so.onchange = () => { state.flow.sort = so.value; renderFlow(); }; fl.append(so);
    left.append(fl);
    const rows = flowRows(d).slice(0, 60).map((c) => {
      const tr = el("tr"); if (c.fresh) tr.classList.add("fl-fresh");
      const name = td(`${fmt(c.strike)}${c.type}`, `sym ${c.type === "C" ? "up" : "down"}`); for (const t of c.tags) name.append(" ", el("span", "fl-tag", t));
      const sideTd = td(c.side, c.side === "bought" ? "up" : c.side === "sold" ? "down" : "dim"); sideTd.title = `Last ${fmt(c.last)} against ${fmt(c.bid)} × ${fmt(c.ask)}`;
      tr.append(name, td(`${c.expiry.slice(5)} · ${flowDte(c)}`, "small"), td(fmt(c.last), "num"), td(fK(c.volume), "num"), td(fK(c.oi), "num dim"), td(c.vol_oi == null ? "new" : `${c.vol_oi}×`, `num ${c.vol_oi == null || c.vol_oi > 1 ? "warn" : "dim"}`), td(c.iv ? `${Math.round(c.iv)}%` : "—", "num dim"), td(fM(c.premium), "num"), sideTd, td(`${c.score > 0 ? "+" : ""}${c.score}`, `num ${flowCls(c.score)}`), td(c.interest, "num dim"));
      return tr;
    });
    if (!rows.length) left.append(el("div", "dim small", "No contracts match these filters."));
    else { const w = el("div", "bd-table-wrap"); w.append(table(["Contract", "Expiry", "Last", "Volume", "Open int.", "Vol / OI", "IV", "Premium", "Side", "Score", "Interest"], rows)); left.append(w); }
  }

  // Side column
  const splits = el("section", "fl-card"); splits.append(el("h4", null, "Where the premium went"), flowSplit("Calls against puts", T.call_premium, T.put_premium, "Calls", "Puts"), flowSplit("Bullish against bearish (by side)", T.bullish_premium, T.bearish_premium, "Bullish", "Bearish"));
  if (T.neutral_premium > 0) splits.append(el("div", "dim tiny", `${fM(T.neutral_premium)} traded between the bid and the ask and is not counted as either.`));
  right.append(splits, flowGex(d));
  const st = el("section", "fl-card"); st.append(el("h4", null, "Strike concentration"));
  const mx = Math.max(...d.strikes.map((s) => s.premium), 1);
  for (const s of d.strikes.slice(0, 8)) { const r = el("div", "fl-strike"); const b = el("i"); b.style.width = `${(s.premium / mx) * 100}%`; r.append(el("span", "mono", fmt(s.strike)), b, el("span", "mono small dim", fM(s.premium))); st.append(r); }
  right.append(st);
  if (d.expiries.length > 1) { const ex = el("section", "fl-card"); ex.append(el("h4", null, "By expiry")); for (const e of d.expiries.slice(0, 6)) ex.append(flowSplit(`${e.expiry} · ${e.dte === 0 ? "today" : e.dte + " days"}`, e.call_premium, e.put_premium, "C", "P")); right.append(ex); }
  body.append(left, right); host.append(body);
  host.append(el("p", "dim tiny", `${d.note} Snapshot: ${d.as_of || "—"} (exchange time). Research, not advice.`));
}

$("#flowForm").onsubmit = (e) => { e.preventDefault(); loadFlow($("#flowSym").value); };
$$("#flowRange button").forEach((b) => (b.onclick = () => { $$("#flowRange button").forEach((x) => x.classList.toggle("on", x === b)); state.flow.range = b.dataset.r; loadFlow(); }));
document.addEventListener("section", (e) => {
  clearInterval(state.flow.timer);
  if (e.detail === "flow") { loadFlow(); state.flow.timer = setInterval(() => { if (sectionVisible("flow") && !document.hidden && !$("#flow :focus")) loadFlow(); }, 60000); }
});
