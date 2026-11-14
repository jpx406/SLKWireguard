"use strict";
/* ML Signals: a neural network and boosted trees, trained on price history and judged on data they never saw.
   Two jobs: a BUY / SELL / HOLD direction model, and a filter that grades the desk's own candle signals. */

state.ml = { data: null, market: "stocks", busy: false };
const mlPct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const mlR = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(2)}R`);
const mlDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const ML_NAME = { mlp: "Neural network", gbdt: "Boosted trees", ensemble: "Both averaged" };

async function loadMl() {
  let d;
  try { d = await api("/api/ml"); } catch (e) { $("#ml").innerHTML = ""; $("#ml").append(el("div", "msg err", e.message)); return; }
  state.ml.data = d; renderMl();
}

function mlStatus(kind, text) { const b = el("span", `badge th-${kind}`, text); return b; }

function mlImportance(rep) {
  const box = el("div", "ml-imp"), top = rep.importance.slice(0, 8), mx = Math.max(...top.map((x) => x.gbdt_gain), 1e-9), help = state.ml.data.feature_help || {};
  for (const x of top) { const r = el("div", "fl-strike"); const b = el("i"); b.style.width = `${(x.gbdt_gain / mx) * 100}%`; const n = el("span", "small", x.feature); n.title = help[x.feature] || ""; r.append(n, b, el("span", "mono small dim", `${Math.round(x.gbdt_gain * 100)}%`)); box.append(r); }
  return box;
}

function mlDirectionCard(m) {
  const r = m.report, card = el("section", "fl-card ml-card"), head = el("div", "th-head");
  head.append(el("h4", null, "Direction model: BUY / SELL / HOLD"), r.edge ? mlStatus("up", "proven edge") : mlStatus("muted", "display only"));
  card.append(head, el("p", "small", r.edge_reason));
  card.append(el("p", "dim tiny", `Question: will the price reach +1 ATR (at least 1%) before −1 ATR within 5 days? Trained on ${r.symbols} symbols, ${r.samples.train.toLocaleString()} days up to ${mlDay(r.period.train_to)}; judged on ${r.samples.valid.toLocaleString()} later days (${mlDay(r.period.valid_from)} → ${mlDay(r.period.valid_to)}) it never saw. Chance: up ${mlPct(r.base_rate.up)}, down ${mlPct(r.base_rate.down)}, neither ${mlPct(r.base_rate.flat)}.`));
  const rows = ["mlp", "gbdt", "ensemble"].map((k) => { const s = r.scores[k], tr = el("tr"); if (k === r.winner) tr.classList.add("ml-win");
    tr.append(td(ML_NAME[k] + (k === r.winner ? " ✓" : ""), "sym"), td(mlPct(s.accuracy), "num"), td(s.f1_dir.toFixed(2), "num"), td(String(s.gated.signals), "num"), td(mlPct(s.gated.precision), "num"), td(s.gated.avg_return_pct == null ? "—" : `${s.gated.avg_return_pct > 0 ? "+" : ""}${s.gated.avg_return_pct}%`, `num ${s.gated.avg_return_pct > 0 ? "up" : s.gated.avg_return_pct < 0 ? "down" : ""}`)); return tr; });
  const w = el("div", "bd-table-wrap"); w.append(table(["Model", "Acc.", "F1", `Calls ≥${mlPct(r.threshold)}`, "Right", "Avg"], rows)); card.append(w);
  // Confusion matrix of the winner.
  const C = r.scores[r.winner].confusion, cm = el("div", "ml-cm"); cm.setAttribute("role", "img"); cm.setAttribute("aria-label", "Confusion matrix: rows are what happened, columns what the model said");
  const mx = Math.max(...C.flat(), 1); cm.append(el("span", "dim tiny", "happened ↓ / said →"), ...["DOWN", "HOLD", "UP"].map((x) => el("b", "tiny", x)));
  ["DOWN", "FLAT", "UP"].forEach((lab, i) => { cm.append(el("b", "tiny", lab)); C[i].forEach((v, j) => { const c = el("span", "mono small", String(v)); c.style.background = `color-mix(in srgb, var(${i === j ? "--up" : "--accent"}) ${Math.round((v / mx) * 55)}%, transparent)`; cm.append(c); }); });
  const det = el("details"); det.append(el("summary", "small", "Confusion matrix, confidence levels and what drives it"), cm);
  const sw = r.scores[r.winner].sweep.filter((x) => x.signals > 0).map((x) => { const tr = el("tr"); tr.append(td(mlPct(x.threshold), "num"), td(String(x.signals), "num"), td(mlPct(x.precision), "num"), td(x.avg_return_pct == null ? "—" : `${x.avg_return_pct}%`, "num")); return tr; });
  if (sw.length) { const t = el("div", "bd-table-wrap"); t.append(table(["Confidence at least", "Calls", "Right", "Avg / trade after costs"], sw)); det.append(el("p", "dim tiny", "How the calls would have done at other confidence levels (validation period):"), t); }
  det.append(el("p", "dim tiny", "Inputs the boosted trees leaned on most:"), mlImportance(r)); card.append(det);
  if (m.live) card.append(el("p", "small", `Earlier model, on the days after it was trained: ${m.live.signals} confident calls, right ${mlPct(m.live.precision)}.`));
  card.append(el("p", "dim tiny", `Trained ${mlDay(m.created_at)} in ${(r.train_ms / 1000).toFixed(1)}s · network stopped after ${r.mlp_epochs} passes, trees after ${r.gbdt_rounds} rounds.`));
  return card;
}

function mlFilterCard(m) {
  const r = m.report, card = el("section", "fl-card ml-card"), head = el("div", "th-head");
  head.append(el("h4", null, "Candle-signal filter"), r.useful ? mlStatus("up", "useful") : mlStatus("muted", "display only"));
  card.append(head, el("p", "small", r.reason));
  card.append(el("p", "dim tiny", `${r.title}. Learned from ${r.samples.train.toLocaleString()} past candle signals on ${r.symbols} symbols; judged on ${r.samples.valid.toLocaleString()} later signals (${mlDay(r.period.valid_from)} → ${mlDay(r.period.valid_to)}). Each signal is replayed with its stop and a 2R target; R is the result in multiples of the risk.`));
  const rows = [["All signals", r.all], ["Grade skip (worst quarter)", r.skip], ["Kept (C, B, A)", r.keep], ["Grade B and A (better half)", r.good], ["Grade A (top tenth)", r.top]].map(([k, s]) => { const tr = el("tr"); tr.append(td(k, "sym"), td(String(s.n), "num"), td(mlR(s.avg_r), `num ${s.avg_r > 0 ? "up" : s.avg_r < 0 ? "down" : ""}`), td(mlPct(s.win_rate), "num")); return tr; });
  const w = el("div", "bd-table-wrap"); w.append(table(["Validation signals", "Count", "Avg result", "Winners"], rows)); card.append(w);
  const det = el("details"); det.append(el("summary", "small", "Per model and what drives it"));
  const pm = Object.entries(r.by_model).map(([k, v]) => { const tr = el("tr"); if (k === r.winner) tr.classList.add("ml-win"); tr.append(td(ML_NAME[k] + (k === r.winner ? " ✓" : ""), "sym"), td(mlR(v.skip.avg_r), "num"), td(mlR(v.keep.avg_r), "num"), td(mlR(v.top.avg_r), "num")); return tr; });
  const t = el("div", "bd-table-wrap"); t.append(table(["Model", "Skip", "Kept", "Grade A"], pm)); det.append(t, mlImportance(r)); card.append(det);
  if (m.live) card.append(el("p", "small", `Earlier model, on signals after it was trained: skip ${mlR(m.live.skip.avg_r)} (${m.live.skip.n}), kept ${mlR(m.live.keep.avg_r)} (${m.live.keep.n}).`));
  card.append(el("p", "dim tiny", `Trained ${mlDay(m.created_at)} in ${(r.train_ms / 1000).toFixed(1)}s.`));
  return card;
}

function renderMl() {
  const host = $("#ml"), d = state.ml.data; if (!d) return;
  host.innerHTML = "";
  const admin = state.me?.role === "admin", mk = state.ml.market, act = (task) => d.models.find((m) => m.active && m.task === task && m.market === mk);
  host.append(el("p", "small dim", "Two models learn from price history: a neural network and boosted decision trees. They are trained on the older part of the history and judged on the newest part, which they never saw. A model is allowed to influence trades only after it proves itself there; otherwise it is shown for information."));

  // Today's reads
  const sig = d.signals.filter((s) => (mk === "crypto") === /-USD/.test(s.symbol)), sec = el("section", "fl-card"); sec.append(el("h4", null, `Today's direction reads (${mk})`));
  if (!act("direction")) sec.append(el("div", "dim small", admin ? "No model yet. Press Train below." : "No model yet. Ask the admin to train one."));
  else if (!sig.length) sec.append(el("div", "dim small", "No symbols in this watchlist."));
  else {
    const rows = sig.map((s) => { const tr = el("tr"); const dec = td(s.decision, `sym ${s.decision === "BUY" ? "up" : s.decision === "SELL" ? "down" : "dim"}`);
      const bar = el("td"); const b = el("div", "ml-prob"); b.setAttribute("role", "img"); b.setAttribute("aria-label", `down ${mlPct(s.probs[0])}, neither ${mlPct(s.probs[1])}, up ${mlPct(s.probs[2])}`); ["down", "dim", "up"].forEach((c, k) => { const i = el("i", c); i.style.width = `${s.probs[k] * 100}%`; b.append(i); }); bar.append(b);
      tr.append(td(s.symbol, "sym"), dec, td(mlPct(s.confidence), "num"), bar, td(`${mlPct(s.probs[2])} / ${mlPct(s.probs[0])}`, "num small dim"), td(fmt(s.price), "num"), td(mlDay(s.bar_time), "small dim")); return tr; });
    const w = el("div", "bd-table-wrap"); w.append(table(["Symbol", "Decision", "Confidence", "Down · neither · up", "Up / down", "Close", "Bar"], rows)); sec.append(w);
    sec.append(el("p", "dim tiny", `BUY or SELL only when the model is at least ${mlPct(d.settings.threshold)} sure; otherwise HOLD. ${sig[0]?.proven ? "" : "This model has no proven edge yet: treat the reads as information only."}`));
  }
  host.append(sec);
  const grid = el("div", "ml-grid"); const a = act("direction"), f = act("filter");
  grid.append(a ? mlDirectionCard(a) : el("section", "fl-card", "Direction model: not trained yet."), f ? mlFilterCard(f) : el("section", "fl-card", "Candle-signal filter: not trained yet."));
  host.append(grid);

  // Controls
  const ctl = el("section", "fl-card"); ctl.append(el("h4", null, "Training and use"));
  if (admin) {
    const row = el("div", "fl-filters");
    for (const [task, label] of [["direction", "Train direction model"], ["filter", "Train signal filter"]]) { const b = el("button", "ghost small", state.ml.busy === task ? "Training… (up to a minute)" : `${label} (${mk})`); b.disabled = !!state.ml.busy;
      b.onclick = async () => { state.ml.busy = task; renderMl(); try { await api("/api/ml/train", { method: "POST", body: JSON.stringify({ task, market: mk }) }); } catch (e) { showBanner(e.message); } state.ml.busy = false; loadMl(); }; row.append(b); }
    ctl.append(row);
    const s = d.settings, form = el("div", "ml-settings");
    const chk = (key, text, title) => { const l = el("label", "check small"), c = el("input"); c.type = "checkbox"; c.checked = !!s[key]; c.onchange = () => mlSave({ [key]: c.checked }); l.append(c, ` ${text}`); l.title = title; return l; };
    const th = el("label", "small"); const ti = el("input", "mono"); ti.type = "number"; ti.min = "0.5"; ti.max = "0.95"; ti.step = "0.05"; ti.value = s.threshold; ti.onchange = () => mlSave({ threshold: +ti.value }); th.append("Confidence needed for BUY / SELL ", ti);
    form.append(th, chk("filter", "Autopilot skips candle signals graded \"skip\"", "Only takes effect while the filter is marked useful."), chk("verdict", "Proven direction reads adjust the Auto Trader verdict", "Only takes effect while the direction model has a proven edge."), chk("retrain", "Retrain every Sunday", "Markets change: the models are rebuilt weekly on the newest history, and the old model is scored on what happened since."));
    ctl.append(form);
  } else ctl.append(el("div", "dim small", "The admin trains the models and decides how they are used."));
  if (d.runs.length) { const lg = el("details"); lg.append(el("summary", "small", "Training log")); for (const r of d.runs) lg.append(el("div", `small ${r.ok ? "dim" : "down"}`, `${new Date(r.at * 1000).toLocaleString()} · ${r.task} ${r.market} · ${(r.ms / 1000).toFixed(1)}s · ${r.note}`)); ctl.append(lg); }
  host.append(ctl);
  host.append(el("p", "dim tiny", "Past results do not guarantee future ones. A model that looked good on one period can fail on the next: that is why it is retrained weekly and re-scored on what came after. Research, not advice."));
}
async function mlSave(patch) { try { await api("/api/ml/settings", { method: "PUT", body: JSON.stringify(patch) }); } catch (e) { showBanner(e.message); } loadMl(); }

$$("#mlMarket button").forEach((b) => (b.onclick = () => { $$("#mlMarket button").forEach((x) => x.classList.toggle("on", x === b)); state.ml.market = b.dataset.k; renderMl(); }));
document.addEventListener("section", (e) => { if (e.detail === "ml") loadMl(); });
