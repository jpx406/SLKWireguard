"use strict";
/* Auto Trader: one simple screen to run automatic paper trading, for stocks and for crypto.
   Left: every watchlist symbol and recommendation with a plain-language verdict and an Auto switch.
   Right: a clean chart of the selected symbol with the entry, stop and target lines, the reasons behind the verdict,
   and the levels you can change. Top: the master switch, money per trade and a preset. Paper money only. */

state.master = { kind: "stocks", data: null, sel: null, mc: null };
const V_CLS = { buy: "up", consider: "accent", wait: "dim", avoid: "down" };

async function loadMaster(keepSel = true) {
  let d;
  try { d = await api(`/api/master?kind=${state.master.kind}`); } catch (e) { $("#master").innerHTML = ""; $("#master").append(el("div", "msg err", e.message)); return; }
  state.master.data = d;
  if (!keepSel || !d.rows.some((r) => r.symbol === state.master.sel)) state.master.sel = d.rows[0]?.symbol ?? null;
  renderMaster();
}

async function masterAuto(symbol, body) {
  try { await api("/api/paper/auto", { method: "PUT", body: JSON.stringify({ symbol, ...body }) }); await loadMaster(); }
  catch (e) { showBanner(e.message); await loadMaster(); }
}

function renderMaster() {
  const host = $("#master"), d = state.master.data; if (!d) return;
  if (state.master.mc) { state.master.mc.dispose(); state.master.mc = null; }
  host.innerHTML = "";
  // ---- top: master controls
  const top = el("div", "mt-top");
  const sw = el("label", "mt-master"); const cb = el("input"); cb.type = "checkbox"; cb.checked = d.on > 0; cb.setAttribute("role", "switch"); cb.setAttribute("aria-label", "Automatic trading for everything recommended");
  const P = d.presets[d.preset];
  cb.onchange = async () => {
    const on = cb.checked;
    if (on && !(await askConfirm({ title: `Start automatic ${d.kind === "crypto" ? "crypto" : "stock"} trading?`, message: `${P.label}: ${P.text} ${money(+amt.value || d.amount)} of paper money per trade. It buys at each entry and sells at the stop or the target. Paper money only.`, confirm: "Start", destructive: false }))) { cb.checked = false; return; }
    try { const r = await api("/api/master", { method: "PUT", body: JSON.stringify({ kind: d.kind, on, preset: ps.value, amount_usd: +amt.value || d.amount }) }); state.master.data = r.view; if (r.errors?.length) showBanner(r.errors.join(" · ")); else if (on && !r.changed) showBanner("Nothing meets this preset right now. Run a scan, or pick a more active preset."); renderMaster(); }
    catch (e) { showBanner(e.message); loadMaster(); }
  };
  sw.append(cb, el("span", "mt-knob"), el("b", null, d.on ? `Auto is ON for ${d.on}` : "Auto is OFF"));
  const amt = el("input", "sym-input mono"); amt.type = "number"; amt.min = 50; amt.step = 50; amt.value = d.amount; amt.style.width = "7em"; amt.setAttribute("aria-label", "Paper money per trade");
  const ps = el("select", "small"); for (const [k, v] of Object.entries(d.presets)) ps.append(new Option(v.label, k)); ps.value = d.preset; ps.setAttribute("aria-label", "Style");
  const save = async () => { try { const r = await api("/api/master", { method: "PUT", body: JSON.stringify({ kind: d.kind, preset: ps.value, amount_usd: +amt.value || d.amount }) }); state.master.data = r.view; renderMaster(); } catch (e) { showBanner(e.message); } };
  ps.onchange = save; amt.onchange = save;
  const l1 = el("label", "small mt-field"); l1.append(el("span", "dim", "Money per trade"), amt);
  const l2 = el("label", "small mt-field"); l2.append(el("span", "dim", "Style"), ps);
  top.append(sw, l1, l2, el("span", "dim small mt-ptext", P.text));
  host.append(top);
  const chips = el("div", "mt-chips");
  const chip = (t, cls = "") => chips.append(el("span", `chip ${cls}`, t));
  chip(`Market: ${d.regime.regime.replace("_", " ").toLowerCase()}${d.regime.size_mult < 1 ? ` · sizes ×${d.regime.size_mult}` : ""}`, d.regime.size_mult <= 0 ? "down" : "");
  chip(`Paper cash ${money(d.cash)}`); chip(`${d.in_trade} in a trade`);
  chip(d.strategy ? `Strategy v${d.strategy} rules on` : "No strategy rules");
  if (d.radar?.length) { const r0 = d.radar[0]; const c = el("span", "chip", `Cleanest now: ${d.radar.slice(0, 3).map((x) => `${x.symbol} ${x.score}`).join(" · ")}`); c.title = `Market radar: liquidity, tight bars, active volume, one-sided flow and trend. ${r0.symbol}: buyers ${Math.round(r0.buy_share * 100)}%, volume ${r0.rvol}x normal, the Six ${r0.label.toLowerCase()}.`; c.style.cursor = "pointer"; c.onclick = () => { state.master.sel = r0.symbol; renderMaster(); }; chips.append(c); }
  if (d.kill_switch) chip(`KILL SWITCH ON: ${d.kill_reason || "manual"}`, "down");
  host.append(chips);
  if (d.kill_switch) { const w = el("div", "msg err small"); w.textContent = "The kill switch is on: nothing is bought automatically until you turn it off (Quant Terminal, top right)."; host.append(w); }

  const body = el("div", "mt-body"); host.append(body);
  // ---- left: the list
  const list = el("div", "mt-list"); body.append(list);
  if (!d.rows.length) list.append(el("div", "bd-empty", d.kind === "crypto" ? "Add pairs on the Crypto page, or run the Crypto scan." : "Add symbols to your watchlist, or run a scan."));
  for (const r of d.rows) {
    const v = r.verdict, a = r.auto, row = el("div", `mt-row${r.symbol === state.master.sel ? " on" : ""}`); row.tabIndex = 0;
    const left = el("div", "mt-rl"); const nm = el("div", "mt-sym"); nm.append(el("b", null, r.symbol)); if (r.rating) nm.append(ratingBadge(r.rating));
    left.append(nm, el("div", "mono small", `${r.last == null ? "—" : fmt(r.last)}${r.change_pct == null ? "" : `  ${r.change_pct > 0 ? "+" : ""}${fmt(r.change_pct)}%`}`));
    const mid = el("div", "mt-rm"); const vb = el("span", `mt-verdict ${V_CLS[v.action]}`, v.label); vb.title = v.reasons.join(" ");
    const bar = el("span", "mt-score"); const fill = el("i"); fill.style.width = `${v.score}%`; bar.append(fill);
    const st = a?.position ? `In trade: ${a.position.side} ${a.position.qty} @ ${fmt(a.position.entry)}` : a?.order ? `Waiting to ${a.order.side === "long" ? "buy" : "short"} at ${fmt(a.order.price)}` : a?.enabled ? "Auto on: watching" : r.plan && r.plan.source !== "position" ? `Entry ${fmt(r.plan.entry)} · stop ${fmt(r.plan.stop)} · target ${fmt(r.plan.targets?.[0])}` : "No plan yet";
    mid.append(vb, bar, el("div", `tiny ${a?.position ? "up" : "dim"}`, st));
    if (r.six) mid.append(el("div", `tiny ${r.six.consensus >= 12 ? "up" : r.six.consensus <= -12 ? "down" : "dim"}`, `The Six ${r.six.consensus >= 0 ? "+" : ""}${r.six.consensus} · ${r.six.agree}/6 · radar ${r.six.radar}`));
    const right = el("label", "mt-switch"); const c = el("input"); c.type = "checkbox"; c.checked = !!a?.enabled; c.setAttribute("role", "switch"); c.setAttribute("aria-label", `Automatic trading for ${r.symbol}`);
    c.onclick = (e) => e.stopPropagation(); c.onchange = () => masterAuto(r.symbol, { enabled: c.checked, amount_usd: a?.amount_usd ?? d.amount, rule: a?.rule ?? d.presets[d.preset].rule });
    right.append(c, el("span", "mt-knob")); right.onclick = (e) => e.stopPropagation();
    row.append(left, mid, right);
    row.onclick = () => { state.master.sel = r.symbol; renderMaster(); };
    row.onkeydown = (e) => { if (e.key === "Enter") row.onclick(); };
    list.append(row);
  }
  // ---- right: the selected symbol
  const det = el("div", "mt-detail"); body.append(det);
  const r = d.rows.find((x) => x.symbol === state.master.sel);
  if (!r) { det.append(el("div", "dim", "Select a symbol.")); return; }
  const v = r.verdict, a = r.auto, pos = a?.position, ord = a?.order, plan = r.plan;
  const head = el("div", "mt-dhead"); const title = el("h2", null, r.symbol); title.style.cursor = "pointer"; title.title = "Open the full chart"; title.onclick = () => { setSymbol(r.symbol); navigate("chart"); };
  head.append(title, el("span", "mono", r.last == null ? "—" : fmt(r.last)), el("span", `mt-verdict ${V_CLS[v.action]}`, `${v.label} · ${v.score}`), el("span", "spacer"));
  const dsw = el("label", "mt-master small"); const dc = el("input"); dc.type = "checkbox"; dc.checked = !!a?.enabled; dc.setAttribute("role", "switch"); dc.setAttribute("aria-label", `Automatic trading for ${r.symbol}`);
  dc.onchange = () => masterAuto(r.symbol, { enabled: dc.checked, amount_usd: +(damt.value) || d.amount, rule: a?.rule ?? d.presets[d.preset].rule });
  dsw.append(dc, el("span", "mt-knob"), el("b", null, a?.enabled ? "Auto ON" : "Auto OFF")); head.append(dsw);
  det.append(head);
  const box = el("div", "mt-chart"); det.append(box);
  const status = el("div", "plan-bar small dim"); det.append(status);
  // Strategist
  const adv = el("div", "mt-advice"); adv.append(el("b", null, "What the desk recommends"), el("p", null, v.strategist));
  const ul = el("ul", "small"); for (const t of v.reasons) ul.append(el("li", null, t)); adv.append(ul);
  const more = el("div", "row gap wrap");
  const bDeep = el("button", "ghost small", "Run Deep Analysis"); bDeep.onclick = () => runDeep(r.symbol);
  const bKr = el("button", "ghost small", "Kronos forecast"); bKr.onclick = () => runKronos(r.symbol, d.kind === "crypto" ? "60m" : "60m", null);
  const bScan = el("button", "ghost small", d.kind === "crypto" ? "Run Crypto scan" : "Run Full scan"); bScan.onclick = async () => { try { await api("/api/briefs/run", { method: "POST", body: JSON.stringify({ slot: d.kind === "crypto" ? "cryptoscan" : "fullscan" }) }); showBanner("Scan started: new plans appear here in a few minutes."); } catch (e) { showBanner(e.message); } };
  more.append(bScan, bDeep, bKr); adv.append(more); det.append(adv);
  // The Six: the agent council for this symbol.
  const six = el("div", "six"); det.append(six);
  api(`/api/council/${encodeURIComponent(r.symbol)}`).then((c) => {
    if (state.master.sel !== r.symbol) return;
    const head = el("div", "six-head"); head.append(el("b", null, "The Six"), el("span", `mt-verdict ${c.consensus >= 12 ? "up" : c.consensus <= -12 ? "down" : "dim"}`, `${c.label} ${c.consensus >= 0 ? "+" : ""}${c.consensus}`), el("span", "dim tiny", `${c.agree} of 6 agree · radar ${c.radar.score}/100 · six rule-based analysts on ${c.interval} bars, not six AI models`));
    const grid = el("div", "six-grid");
    for (const ag of c.agents) { const card = el("div", `six-card ${ag.vote >= 0.15 ? "up" : ag.vote <= -0.15 ? "down" : ""}`); const bar = el("span", "six-bar"); const f = el("i"); f.style.width = `${Math.abs(ag.vote) * 50}%`; f.style[ag.vote >= 0 ? "left" : "right"] = "50%"; bar.append(f);
      card.append(el("b", null, ag.name), el("span", "dim tiny", ag.role), bar, el("span", "tiny", ag.text)); grid.append(card); }
    six.append(head, grid);
  }).catch(() => { six.append(el("div", "dim tiny", "The Six need more price bars for this symbol.")); });
  // Levels
  const lv = el("div", "mt-levels");
  const cur = pos ? { entry: pos.entry, stop: pos.stop, target: pos.target } : ord ? { entry: ord.price, stop: ord.stop, target: ord.target } : { entry: plan?.entry ?? null, stop: a?.stop_override ?? plan?.stop ?? null, target: a?.target_override ?? plan?.targets?.[0] ?? null };
  const num = (label, val, ro = false) => { const l = el("label", "small"); const i = el("input", "mono"); i.type = "number"; i.step = "any"; i.value = val ?? ""; i.readOnly = ro; if (ro) i.classList.add("ro"); l.append(el("span", "dim", label), i); l.input = i; return l; };
  const fEntry = num(pos ? "Bought at" : "Entry (buys at or below)", cur.entry, true), fStop = num("Stop-loss (sell if it falls here)", cur.stop), fTarget = num("Target (sell with profit here)", cur.target);
  const damtL = el("label", "small"); const damt = el("input", "mono"); damt.type = "number"; damt.min = 50; damt.step = 50; damt.value = a?.amount_usd ?? d.amount; damtL.append(el("span", "dim", "Money for this one"), damt);
  lv.append(fEntry, fStop, fTarget, damtL);
  const risk = el("div", "small dim mt-risk");
  const calc = () => { const e = +fEntry.input.value, s = +fStop.input.value, t = +fTarget.input.value, q = pos ? pos.qty : e ? (+(damt.value) || 0) / e : 0; if (!e || !q) { risk.textContent = ""; return; } const sg = (v.side || pos?.side) === "short" ? -1 : 1;
    risk.textContent = `${pos ? fmt(pos.qty, pos.qty % 1 ? 4 : 0) : fmt(q, d.kind === "crypto" ? 4 : 0)} ${d.kind === "crypto" ? "units" : "shares"}${s ? ` · if the stop is hit: ${money((s - e) * q * sg)}` : ""}${t ? ` · if the target is hit: ${money((t - e) * q * sg)}` : ""}${s && t ? ` · reward ${fmt(Math.abs(t - e) / Math.abs(e - s), 1)}× the risk` : ""}`; };
  for (const f of [fStop, fTarget]) f.input.oninput = calc; damt.oninput = calc; calc();
  const acts = el("div", "row gap wrap");
  const bSave = el("button", "primary small", pos ? "Save stop & target" : "Save levels");
  bSave.onclick = async () => {
    const s = fStop.input.value === "" ? null : +fStop.input.value, t = fTarget.input.value === "" ? null : +fTarget.input.value;
    try {
      if (pos) await api(`/api/paper/positions/${pos.id}`, { method: "PUT", body: JSON.stringify({ stop: s, target: t }) });
      else await api("/api/paper/auto", { method: "PUT", body: JSON.stringify({ symbol: r.symbol, stop: s, target: t, amount_usd: +damt.value || d.amount, enabled: !!a?.enabled, rule: a?.rule ?? d.presets[d.preset].rule }) });
      showBanner("Saved."); await loadMaster();
    } catch (e) { showBanner(e.message); }
  };
  acts.append(bSave);
  if (pos) { const bSell = el("button", "ghost small danger", pos.side === "long" ? "Sell now" : "Close now"); bSell.onclick = async () => { if (!(await askConfirm({ title: `Close ${r.symbol} now?`, message: "The paper position is closed at the current price.", confirm: "Close Position" }))) return; try { await api(`/api/paper/positions/${pos.id}/close`, { method: "POST" }); await loadMaster(); } catch (e) { showBanner(e.message); } }; acts.append(bSell); }
  else if (plan && plan.source !== "position") { const bBuy = el("button", "ghost small", v.side === "short" ? "Short now (once)" : "Buy now (once)"); bBuy.title = "Place this plan as a single paper order now, without turning Auto on"; bBuy.onclick = () => openTicket({ symbol: r.symbol, side: v.side || "long", type: "limit", price: cur.entry, stop: +fStop.input.value || null, target: +fTarget.input.value || null, exit_mode: d.kind === "crypto" ? "hold" : undefined }); acts.append(bBuy); }
  if (a?.last_note) acts.append(el("span", "dim tiny", a.last_note));
  det.append(el("h4", "small dim", pos ? "Your trade" : "Levels for the automatic trade"), lv, risk, acts);
  // Clean chart: candles only, plan lines from the plan monitor.
  requestAnimationFrame(() => {
    state.master.mc = createMiniChart(box, { symbol: r.symbol, interval: d.kind === "crypto" ? "60m" : "5m", range: d.kind === "crypto" ? "5D" : "1D", fontSize: 11, signals: $("#masterSignals").checked, indicators: { vwap: false, ema9: false, ema20: false },
      onPlanStatus: (text, cls) => { status.textContent = text; status.className = `plan-bar small ${cls || ""}`; },
      onPlanEvent: (ev) => { status.textContent = ev.text; status.className = `plan-bar small ${ev.kind === "entry" ? "accent" : ev.kind === "target" ? "up" : "down"}`; if (state.sigNotify) notifyPlanEvent(ev); } });
  });
}

$$("#masterKind button").forEach((b) => (b.onclick = () => { $$("#masterKind button").forEach((x) => x.classList.toggle("on", x === b)); state.master.kind = b.dataset.k; loadMaster(false); }));
$("#masterSignals").onchange = (e) => state.master.mc?.setSignals(e.target.checked);
document.addEventListener("section", (e) => {
  clearInterval(state.master.timer);
  if (e.detail === "master") { loadMaster(); state.master.timer = setInterval(() => { if (sectionVisible("master") && !document.activeElement?.closest?.(".mt-levels")) loadMaster(); }, 60000); }
  else if (state.master.mc && !sectionVisible("master")) { state.master.mc.dispose(); state.master.mc = null; }
});
