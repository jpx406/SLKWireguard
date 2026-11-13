"use strict";
/* Research: thesis tracker and price watches (idea from LangAlpha's thesis-tracker, Apache-2.0).
   A thesis is three to five falsifiable pillars with break levels, an append-only evidence ledger and an aggregate
   status that follows the core pillars. Watches fire on a price or a daily move and can wake an update. */

state.thesis = { data: null, sel: null, detail: null, timer: null, seen: null };
const TH_CLS = { strengthening: "up", intact: "up", watch: "warn", impaired: "down", broken: "down", changed: "down", untested: "muted", retired: "muted" };
const TH_HELP = {
  strengthening: "Evidence is beating the plan.", intact: "Evidence matches the plan.", watch: "A warning level was touched: the next proof point decides.",
  impaired: "A break level was crossed, but the thesis still stands on other pillars.", broken: "The reason to own it is gone.", changed: "The business is no longer what was underwritten.",
  untested: "No evidence has reached it yet.", retired: "Closed on purpose.",
};
const WATCH_TEXT = { above: "rises to", below: "falls to", pct_up: "is up in a day by %", pct_down: "is down in a day by %" };
const thBadge = (s) => { const b = el("span", `badge th-${TH_CLS[s] || "muted"}`, s || "—"); b.title = TH_HELP[s] || ""; return b; };

async function loadThesis(keep = true) {
  let d;
  try { d = await api("/api/thesis"); } catch (e) { $("#thesis").innerHTML = ""; $("#thesis").append(el("div", "msg err", e.message)); return; }
  state.thesis.data = d;
  if (!keep || !d.theses.some((t) => t.id === state.thesis.sel)) state.thesis.sel = d.theses[0]?.id ?? null;
  // Tell the user about watches that fired since the last look.
  const fired = d.watches.filter((w) => w.status === "fired").map((w) => w.id);
  if (state.thesis.seen) for (const w of d.watches) if (w.status === "fired" && !state.thesis.seen.has(w.id)) thesisNotify(w);
  state.thesis.seen = new Set(fired);
  if (state.thesis.sel) { try { state.thesis.detail = await api(`/api/thesis/${state.thesis.sel}`); } catch { state.thesis.detail = null; } } else state.thesis.detail = null;
  renderThesis();
  clearTimeout(state.thesis.timer);
  const busy = d.theses.some((t) => t.status === "running" || t.status === "starting");
  state.thesis.timer = setTimeout(() => { if (sectionVisible("thesis") && !document.hidden && !$("#thesis :focus")) loadThesis(); else if (sectionVisible("thesis")) state.thesis.timer = setTimeout(loadThesis, 15000); }, busy ? 20000 : 60000);
}
function thesisNotify(w) {
  const text = `${w.symbol} ${w.kind === "above" ? "rose to" : w.kind === "below" ? "fell to" : "moved to"} ${fmt(w.fired_price)} (watch ${WATCH_TEXT[w.kind]} ${w.level})`;
  if (typeof pkToast === "function") pkToast(`Watch fired: ${text}`);
  try { if (window.Notification && Notification.permission === "granted") new Notification("Price watch fired", { body: text }); } catch { /* not allowed */ }
}

function renderThesis() {
  const host = $("#thesis"), d = state.thesis.data; if (!d) return;
  host.innerHTML = "";
  const body = el("div", "th-body"), list = el("div", "th-list"), det = el("div", "th-detail");
  if (!d.theses.length) list.append(el("div", "dim", "No thesis yet. Type a symbol above, say in a sentence why you would own it, and press Start. The analyst writes the pillars, the levels that would prove it wrong, and the price watches."));
  for (const t of d.theses) {
    const row = el("button", `th-row${t.id === state.thesis.sel ? " active" : ""}`); row.type = "button";
    const top = el("div", "th-row-top"); top.append(el("b", "sym", t.symbol), el("span", `small ${t.side === "long" ? "up" : "down"}`, t.side), el("span", "spacer"));
    if (t.status === "running" || t.status === "starting") top.append(el("span", "badge muted", "working…")); else if (t.data) top.append(thBadge(t.data.aggregate)); else top.append(el("span", "badge th-down", "error"));
    row.append(top);
    const q = t.quote, line = el("div", "mono small dim"); line.append(liveTag(el("span", null, q?.last == null ? "—" : fmt(q.last)), t.symbol));
    if (t.data?.break_price) line.append(`  ·  wrong ${t.side === "short" ? "above" : "below"} ${fmt(t.data.break_price)}`);
    row.append(line);
    if (t.data) row.append(el("div", "small dim", `call: ${t.data.security_call}${t.data.action ? ` · ${t.data.action}` : ""}`));
    row.onclick = () => { state.thesis.sel = t.id; loadThesis(); };
    list.append(row);
  }
  list.append(thesisWatches(d));
  thesisDetail(det);
  body.append(list, det); host.append(body);
}

function thesisWatches(d) {
  const box = el("section", "th-watches"); box.append(el("h4", null, "Price watches"));
  const active = d.watches.filter((w) => w.status === "active"), fired = d.watches.filter((w) => w.status === "fired").slice(0, 8);
  if (!active.length && !fired.length) box.append(el("div", "dim small", "None yet. A watch fires when a price is reached or a stock moves a set percent in a day."));
  for (const w of [...active, ...fired]) {
    const r = el("div", `th-watch${w.status === "fired" ? " fired" : ""}`), q = w.quote;
    let dist = "";
    if (w.status === "active" && q?.last != null && !w.kind.startsWith("pct")) dist = `${(((w.level - q.last) / q.last) * 100).toFixed(1)}% away`;
    if (w.status === "active" && q?.change_pct != null && w.kind.startsWith("pct")) dist = `today ${q.change_pct > 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`;
    const txt = el("div", "th-watch-txt"); txt.append(el("b", "sym", w.symbol), ` ${WATCH_TEXT[w.kind].replace(" %", "")} `, el("span", "mono", w.kind.startsWith("pct") ? `${w.level}%` : fmt(w.level)));
    txt.append(el("div", "dim tiny", w.status === "fired" ? `fired ${new Date(w.fired_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} at ${fmt(w.fired_price)}` : `${dist}${w.action === "update" ? " · wakes the thesis" : " · notifies"}${w.note ? ` · ${w.note}` : ""}`));
    const del = el("button", "ghost small", "✕"); del.setAttribute("aria-label", `Remove the ${w.symbol} watch`);
    del.onclick = async () => { try { await api(`/api/watches/${w.id}`, { method: "DELETE" }); loadThesis(); } catch (e) { showBanner(e.message); } };
    r.append(txt, del); box.append(r);
  }
  const f = el("form", "th-watch-form"); const sym = el("input", "sym-input mono"); sym.placeholder = "SYMBOL"; sym.maxLength = 15; sym.setAttribute("aria-label", "Symbol to watch");
  sym.value = d.theses.find((t) => t.id === state.thesis.sel)?.symbol || "";
  const kind = el("select", "small"); kind.setAttribute("aria-label", "Condition"); for (const [k, v] of Object.entries({ above: "rises to", below: "falls to", pct_up: "up in a day by %", pct_down: "down in a day by %" })) kind.append(new Option(v, k));
  const level = el("input", "mono"); level.type = "number"; level.step = "any"; level.min = "0"; level.placeholder = "level"; level.setAttribute("aria-label", "Price or percent");
  const wake = el("label", "check small"); const cb = el("input"); cb.type = "checkbox"; cb.checked = true; wake.append(cb, " wake the thesis"); wake.title = "When it fires, the analyst re-checks the thesis (uses Claude). Off: just notify.";
  const add = el("button", "ghost small", "Add watch");
  f.append(sym, kind, level, wake, add);
  f.onsubmit = async (e) => { e.preventDefault(); try { await api("/api/watches", { method: "POST", body: JSON.stringify({ symbol: sym.value, kind: kind.value, level: +level.value, action: cb.checked ? "update" : "notify" }) }); loadThesis(); } catch (err) { showBanner(err.message); } };
  box.append(f);
  return box;
}

function thesisDetail(det) {
  const t = state.thesis.detail; if (!t) { det.append(el("div", "dim", "Select a thesis.")); return; }
  const d = t.data, head = el("div", "th-head");
  head.append(el("h3", null, `${t.symbol} · ${t.side} · ${t.horizon}`));
  if (d) head.append(thBadge(d.aggregate), el("span", "badge muted", `call: ${d.security_call}`));
  const del = el("button", "ghost small", "Delete thesis"); del.style.marginLeft = "auto";
  del.onclick = async () => { if (await askConfirm({ title: `Delete the ${t.symbol} thesis?`, message: "Its evidence ledger and its watches are deleted too.", confirm: "Delete Thesis" })) { try { await api(`/api/thesis/${t.id}`, { method: "DELETE" }); state.thesis.sel = null; loadThesis(false); } catch (e) { showBanner(e.message); } } };
  head.append(del); det.append(head);
  if (t.status === "running" || t.status === "starting") det.append(el("div", "msg", t.pending ? `The analyst is checking: "${t.pending}". This takes a few minutes.` : "The analyst is framing the thesis: reading filings, earnings and estimates. This takes a few minutes."));
  if (t.error) det.append(el("div", "msg err", t.error));
  if (!d) return;
  det.append(el("p", "th-summary", d.summary));
  if (d.aggregate_reason || d.rule_note) det.append(el("p", "small dim", [d.aggregate_reason, d.rule_note].filter(Boolean).join(" ")));
  if (d.call_reason) det.append(el("p", "small dim", `Security call: ${d.call_reason}`));
  // Where the price sits between bear, base and bull.
  const sc = d.scenarios || {}, last = state.thesis.data.theses.find((x) => x.id === t.id)?.quote?.last;
  const pts = [["wrong", d.break_price], ["bear", sc.bear], ["base", sc.base], ["bull", sc.bull], ["now", last]].filter(([, v]) => v > 0);
  if (pts.length >= 3) {
    const lo = Math.min(...pts.map(([, v]) => v)), hi = Math.max(...pts.map(([, v]) => v)), bar = el("div", "th-scale"); bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", pts.map(([k, v]) => `${k} ${fmt(v)}`).join(", "));
    for (const [k, v] of pts) { const m = el("span", `th-mark th-${k}`); m.style.left = `${((v - lo) / (hi - lo || 1)) * 100}%`; m.append(el("i"), el("b", null, k), el("span", "mono", fmt(v))); bar.append(m); }
    det.append(bar);
  }
  const rows = d.pillars.map((p) => { const tr = el("tr"); const c = el("td"); c.append(el("b", null, p.claim), el("div", "dim tiny", [p.expected && `Expected: ${p.expected}`, p.break && `Breaks at: ${p.break}`, p.next_proof && `Next proof: ${p.next_proof}`].filter(Boolean).join(" · ")));
    const st = el("td"); st.append(thBadge(p.status)); tr.append(c, td(p.priority), td(p.signal || "—", "small"), st); return tr; });
  const sec = el("section"); sec.append(el("h4", null, "Pillars"), el("div", "bd-table-wrap")); sec.lastChild.append(table(["Claim", "Priority", "Signal", "Status"], rows)); det.append(sec);
  if (d.drift?.length) { const dr = el("section"); dr.append(el("h4", null, "Drift check"), el("ul", "small")); for (const x of d.drift) dr.lastChild.append(el("li", null, x)); det.append(dr); }

  const upd = el("form", "th-update"); const ta = el("textarea"); ta.rows = 2; ta.placeholder = "A development to test against the thesis: an earnings print, a guidance cut, a deal, a sharp move…"; ta.setAttribute("aria-label", "Development");
  const go = el("button", "primary small", "Update thesis"); go.disabled = t.status === "running" || t.status === "starting" || document.body.classList.contains("no-ai");
  upd.append(ta, go);
  upd.onsubmit = async (e) => { e.preventDefault(); go.disabled = true; try { await api(`/api/thesis/${t.id}/update`, { method: "POST", body: JSON.stringify({ note: ta.value }) }); loadThesis(); } catch (err) { showBanner(err.message); go.disabled = false; } };
  det.append(el("h4", null, "Add a development"), upd);

  const lg = el("section"); lg.append(el("h4", null, "Evidence ledger (newest first, never rewritten)"));
  if (!t.ledger.length) lg.append(el("div", "dim small", "Empty."));
  for (const l of t.ledger.slice(0, 60)) { const r = el("div", "th-led"); r.append(el("span", "mono dim tiny", String(l.at).slice(0, 10)), el("span", "badge muted", l.pillar || "note")); const b = el("div"); b.append(l.fact); if (l.signal || l.impact || l.source) b.append(el("div", "dim tiny", [l.signal, l.impact, l.source].filter(Boolean).join(" · "))); r.append(b); lg.append(r); }
  det.append(lg);
  if (t.content) { const rep = el("details", "th-report"); rep.append(el("summary", null, "Full report")); const m = el("div", "md"); m.innerHTML = md(t.content); rep.append(m); det.append(rep); }
  det.append(el("p", "dim tiny", `Method adapted from LangAlpha's thesis-tracker (Apache-2.0). Research, not advice.${t.cost ? ` Last run cost ${formatCost(t.cost)}.` : ""}`));
}

$("#thesisForm").onsubmit = async (e) => {
  e.preventDefault(); const b = e.target.querySelector("button.primary"); b.disabled = true;
  try { const r = await api("/api/thesis", { method: "POST", body: JSON.stringify({ symbol: $("#thSym").value, side: $("#thSide").value, horizon: $("#thHorizon").value, note: $("#thNote").value }) }); $("#thSym").value = $("#thNote").value = ""; state.thesis.sel = r.id; loadThesis(); }
  catch (err) { showBanner(err.message); }
  b.disabled = false;
};
document.addEventListener("section", (e) => { if (e.detail === "thesis") loadThesis(); else clearTimeout(state.thesis.timer); });
