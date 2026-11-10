"use strict";
/* Winners / copy desk: what proven buyers are buying (insider cluster buys, Congress, superinvestor filings,
   copy-trading leaderboards and social interest), merged by the agent into ranked day and swing plans.
   From here: Deep Analysis on a pick, and chart autopilot (paper money + candles) on the selected picks. */

state.winners = { briefs: [], ratings: {}, auto: {}, slot: null, sel: new Set() };
const WIN_SRC = { insider: ["Insiders", "Officers and directors buying their own stock (Form 4); a cluster is several insiders inside 30 days"],
  congress: ["Congress", "Members' periodic transaction reports (House Clerk, Senate eFD via Capitol Trades)"],
  fund: ["Funds", "Superinvestor and hedge-fund 13F filings and real-time activity (Dataroma, EDGAR)"],
  funds: ["Funds", "Superinvestor and hedge-fund 13F filings and real-time activity (Dataroma, EDGAR)"],
  social: ["Social", "StockTwits trending: crowd interest, a timing signal only"],
  copytrader: ["Copy traders", "Holdings of the top verified gainers on a public copy-trading leaderboard"] };

async function loadWinners() {
  let d;
  try { d = await api("/api/winners"); } catch (e) { $("#winners").innerHTML = ""; $("#winners").append(el("div", "msg err", e.message)); return; }
  state.winners.briefs = d.briefs; state.winners.ratings = d.ratings || {}; state.winners.auto = d.auto || {}; state.winners.slot = d.slot;
  if (d.ratings) state.deep.ratings = { ...state.deep.ratings, ...d.ratings };
  renderWinners();
  if (d.briefs.some((b) => b.status === "running" || b.status === "starting")) { clearTimeout(state.winners.timer); state.winners.timer = setTimeout(loadWinners, 30000); }
}

function srcChip(s) {
  const [label] = WIN_SRC[s.type] || [s.type];
  const c = el("span", `chip src ${s.type}`, `${label}${s.who ? ` · ${s.who}` : ""}`);
  c.title = [s.action, s.date, s.size, s.note].filter(Boolean).join(" · ");
  return c;
}

function renderWinners() {
  const host = $("#winners"); host.innerHTML = "";
  const b = state.winners.briefs[0];
  const intro = el("p", "dim small", "Follows the money of buyers with a record: insider cluster buys (the best-documented edge), new buys in Congress, superinvestor 13F adds and real-time activity, the top verified gainers on copy-trading leaderboards, and crowd interest for timing. Each name is planned as a day trade or a swing; picks scoring 65 or more go to Deep Analysis automatically, and Auto-trade puts paper money on them with the plan and the candle signals.");
  host.append(intro);
  if (!b) { host.append(el("div", "bd-empty", "No winners scan yet. Click Run Now (top right), or turn on the Winners / copy desk routine in Briefs & Autopilot (08:40 New York).")); return; }
  const d = b.data || { picks: b.picks || [] };
  const head = el("div", "bd-head");
  head.append(el("h2", null, "Winners"), el("span", "dim small", `${b.day} · ${new Date(String(b.created_at).replace(" ", "T") + "Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${b.cost ? ` · ${formatCost(b.cost)}` : ""}`));
  if (b.status !== "done") head.append(el("span", `pill ${b.status}`, b.status === "error" ? "error" : "working…"));
  host.append(head);
  if (b.error) host.append(el("div", "msg err small", b.error));
  if (d.market?.summary) host.append(el("p", "bd-summary", d.market.summary));
  const skills = Array.isArray(d.skills_run) ? d.skills_run.filter((s) => s.status && s.status !== "ok") : [];
  if (skills.length) host.append(el("div", "dim small", `Sources with problems: ${skills.map((s) => `${s.skill} (${s.status}${s.note ? `: ${s.note}` : ""})`).join(" · ")}`));

  // Picks with sources, selection and actions.
  const picks = Array.isArray(d.picks) ? d.picks : [];
  const ps = section(`Plans (${picks.length})`, el("span", "dim small", "  tick the ones to auto-trade · click a symbol for the chart"));
  if (!picks.length) ps.append(el("div", "dim small", "No plans in this scan."));
  else {
    const t = el("table", "bd-table win-table"), hr = el("tr");
    for (const h of ["", "#", "Symbol", "Horizon", "Score", "Followed by", "Bias", "Entry", "Stop", "T1", "Setup", "Deep", "Auto", ""]) hr.append(el("th", null, h));
    t.append(hr);
    picks.forEach((p, i) => {
      const sym = String(p.symbol || "").toUpperCase(), tr = el("tr", "pick-row");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = state.winners.sel.has(sym); cb.setAttribute("aria-label", `Select ${sym}`);
      cb.onchange = () => { if (cb.checked) state.winners.sel.add(sym); else state.winners.sel.delete(sym); syncWinnersBar(); };
      const c0 = el("td"); c0.append(cb);
      const cs = el("td", "sym"); const bsym = el("b", null, sym); bsym.style.cursor = "pointer"; bsym.onclick = () => { setSymbol(sym); navigate("chart"); }; cs.append(bsym);
      if (p.name) cs.append(el("div", "dim tiny", p.name));
      const hz = el("td"); hz.append(el("span", `pill ${p.horizon === "swing" ? "swing" : "day"}`, p.horizon === "swing" ? "swing" : "day"));
      const sc = el("td", "score"); const bar = el("span", "scorebar"); bar.style.width = `${Math.max(0, Math.min(100, Number(p.score) || 0))}%`; sc.append(bar, el("span", null, p.score ?? "—"));
      const src = el("td", "wrap"); for (const s of (p.sources || []).slice(0, 5)) src.append(srcChip(s)); if (!(p.sources || []).length) src.textContent = "—";
      const dr = state.winners.ratings[sym], deep = el("td"); if (dr) { deep.append(ratingBadge(dr.rating)); } else { const bt = el("button", "ghost small", "Deep"); bt.title = "Run a Deep Analysis (TradingAgents) on this symbol"; bt.onclick = () => runDeep(sym); deep.append(bt); }
      const au = state.winners.auto[sym], auto = el("td"); auto.append(el("span", au?.enabled ? (au.position ? "up small" : "small") : "dim small", au?.enabled ? (au.position ? `in trade ${au.position.qty}` : `$${Math.round(au.amount_usd)} on`) : "—"));
      const act = el("td"); const pb = el("button", "ghost small", /short/i.test(p.bias || "") ? "Paper Short" : "Paper Buy"); pb.onclick = () => openTicketFromPick(p); act.append(pb);
      tr.append(c0, el("td", "num", String(p.rank ?? i + 1)), cs, hz, sc, src, el("td", /short/i.test(p.bias || "") ? "down" : "up", p.bias || "long"), el("td", "num", fmt(p.entry)), el("td", "num down", fmt(p.stop)), el("td", "num up", fmt((p.targets || [])[0])), el("td", "wrap small", p.setup || ""), deep, auto, act);
      t.append(tr);
      if (p.catalyst || p.exit_plan || p.invalidation) { const dtr = el("tr", "win-detail"); const td = el("td", "dim small"); td.colSpan = 14; td.textContent = [p.catalyst, p.exit_plan && `Exit: ${p.exit_plan}`, p.invalidation && `Invalid if: ${p.invalidation}`].filter(Boolean).join(" · "); dtr.append(td); t.append(dtr); }
    });
    const wrap = el("div", "bd-table-wrap"); wrap.append(t); ps.append(wrap);
  }
  host.append(ps);

  // The raw feed by source, including names that were not planned.
  const w = d.winners || {};
  const grid = el("div", "bd-grid win-grid");
  for (const key of ["insider", "congress", "funds", "social", "copytrader"]) {
    const rows = Array.isArray(w[key]) ? w[key] : (key === "funds" && Array.isArray(w.fund) ? w.fund : []);
    if (!rows.length) continue;
    const [label, help] = WIN_SRC[key]; const s = section(label, el("span", "dim small", `  ${rows.length}`)); s.title = help;
    const t = el("table", "bd-table small");
    for (const r of rows.slice(0, 25)) {
      const tr = el("tr"); const sym = String(r.symbol || "").toUpperCase(); const c = el("td", "sym"); const bb = el("b", null, sym); bb.style.cursor = "pointer"; bb.onclick = () => { setSymbol(sym); navigate("chart"); }; c.append(bb);
      tr.append(c, el("td", "wrap", r.who || ""), el("td", /sell/i.test(r.action || "") ? "down" : "up", r.action || ""), el("td", "mono dim", r.date || ""), el("td", "num", r.size || ""), el("td", "wrap dim", r.note || ""));
      t.append(tr);
    }
    const fw = el("div", "bd-table-wrap"); fw.append(t); s.append(fw); grid.append(s);
  }
  if (grid.childElementCount) host.append(grid);
  if (state.winners.briefs.length > 1) {
    const det = el("details"), sm = el("summary", "dim small", `Earlier winners scans (${state.winners.briefs.length - 1})`); det.append(sm);
    for (const ob of state.winners.briefs.slice(1)) det.append(el("div", "small dim", `${ob.day} · ${ob.status} · ${(ob.data?.picks || ob.picks || []).map((p) => p.symbol).join(", ")}`));
    host.append(det);
  }
  syncWinnersBar();
}

function syncWinnersBar() {
  const n = state.winners.sel.size;
  $("#winAutoBtn").textContent = n ? `Auto-trade ${n} selected` : "Auto-trade selected";
  $("#winAutoBtn").disabled = !n;
}
$("#winRun").onclick = async () => {
  const bt = $("#winRun"); bt.disabled = true;
  try { await api("/api/briefs/run", { method: "POST", body: JSON.stringify({ slot: "winners" }) }); await loadWinners(); } catch (e) { showBanner(e.message); }
  bt.disabled = false;
};
$("#winSelAll").onclick = () => {
  const picks = state.winners.briefs[0]?.data?.picks || state.winners.briefs[0]?.picks || [];
  const all = picks.map((p) => String(p.symbol || "").toUpperCase()).filter(Boolean);
  state.winners.sel = state.winners.sel.size === all.length ? new Set() : new Set(all); renderWinners();
};
$("#winAutoBtn").onclick = async () => {
  const amount = +$("#winAmount").value || 0;
  if (!(amount >= 50)) { showBanner("Money per symbol must be at least $50."); return; }
  const syms = [...state.winners.sel];
  if (!(await askConfirm({ title: `Auto-trade ${syms.length} winner${syms.length > 1 ? "s" : ""}?`, message: `${money(amount)} of paper money on each of ${syms.join(", ")}. The chart autopilot buys at each plan's entry (or on a 2-star candle signal) and sells at the stop, the target or a reversal signal. Paper only.`, confirm: "Start Auto-Trading", destructive: false }))) return;
  try {
    const r = await api("/api/winners/auto", { method: "POST", body: JSON.stringify({ symbols: syms, amount_usd: amount, rule: "both" }) });
    const errs = Object.entries(r.results).filter(([, v]) => v.error).map(([k, v]) => `${k}: ${v.error}`);
    if (errs.length) showBanner(errs.join(" · "));
    state.winners.sel = new Set(); await loadWinners();
  } catch (e) { showBanner(e.message); }
};
document.addEventListener("section", (e) => { if (e.detail === "winners") loadWinners(); });
