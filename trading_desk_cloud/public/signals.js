"use strict";
/* Live candlestick signals on a chart (shared by the main chart, pop-out windows and the Monitor grid).
   Two detection models run on COMPLETED bars (a signal never appears and then vanishes while a bar forms):
     classic  - the "candlestick" library (vendored, MIT): 18 patterns / 29 variants with trend context.
     extended - candles.js (TA-Lib CDL* rules): belt holds, dragonfly/gravestone doji, abandoned baby,
                three inside/outside, rising/falling three methods, inside-bar breakouts.
   Context models: a trend gate (a bullish reversal only after a downtrend or sideways tape, as in MotiveWave's
   study) and volume confirmation (a spike of 1.3x the 20-bar average adds a star). Strength is 1-3 stars. */

const SIGNAL_LABELS = {
  hammer: "Hammer", bullishHammer: "Bull Hammer", bearishHammer: "Bear Hammer",
  invertedHammer: "Inv. Hammer", bullishInvertedHammer: "Bull Inv. Hammer", bearishInvertedHammer: "Bear Inv. Hammer",
  bullishEngulfing: "Bull Engulfing", bearishEngulfing: "Bear Engulfing", bullishHarami: "Bull Harami", bearishHarami: "Bear Harami",
  bullishKicker: "Bull Kicker", bearishKicker: "Bear Kicker", hangingMan: "Hanging Man", shootingStar: "Shooting Star",
  piercingLine: "Piercing Line", darkCloudCover: "Dark Cloud", doji: "Doji", morningStar: "Morning Star", eveningStar: "Evening Star",
  threeWhiteSoldiers: "3 White Soldiers", threeBlackCrows: "3 Black Crows", marubozu: "Marubozu",
  bullishMarubozu: "Bull Marubozu", bearishMarubozu: "Bear Marubozu", spinningTop: "Spinning Top",
  bullishSpinningTop: "Bull Spinning Top", bearishSpinningTop: "Bear Spinning Top", tweezersTop: "Tweezers Top", tweezersBottom: "Tweezers Bottom",
  ...(window.TDCandles ? window.TDCandles.LABELS : {}),
};
// Variants that only restate a parent pattern (the generic one already fires); skipped to avoid double markers.
const SIGNAL_SKIP = new Set(["hammer", "invertedHammer", "marubozu", "spinningTop", "bullishSpinningTop", "bearishSpinningTop"]);
// Weak, very frequent patterns: not drawn on the chart or notified by default (they still count in the feed when
// sensitivity is "all"). Harami and doji print on most intraday charts several times an hour.
const SIGNAL_WEAK = new Set(["bullishHarami", "bearishHarami", "doji"]);
// Only the most recent signals get a text label; older ones stay as bare arrows so the chart stays readable.
const SIGNAL_LABELLED = 6;
const INTERVAL_SEC = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600, "1d": 86400, "1wk": 604800 };
// The strongest reversal families (an exit signal against an open trade when they fire the other way).
const SIGNAL_STRONG = new Set(["bullishEngulfing", "bearishEngulfing", "morningStar", "eveningStar", "threeWhiteSoldiers", "threeBlackCrows", "piercingLine", "darkCloudCover",
  "bullishKicker", "bearishKicker", ...(window.TDCandles ? window.TDCandles.STRONG : [])]);

/** Detection models, remembered per device (td.sigmodels). */
const SIGNAL_MODELS_DEFAULT = { classic: true, extended: true, trendGate: true, volume: true };
function loadSignalModels() {
  try { return { ...SIGNAL_MODELS_DEFAULT, ...(JSON.parse(localStorage.getItem("td.sigmodels") || "{}")) }; } catch { return { ...SIGNAL_MODELS_DEFAULT }; }
}
function saveSignalModels(m) { try { localStorage.setItem("td.sigmodels", JSON.stringify(m)); } catch { /* ok */ } }

/**
 * createSignalEngine({ intervalSec, shift, minFit, onSignal, models })
 *   update(bars) -> scans completed bars, returns the NEW signals (newest last) and remembers them.
 *   markers()    -> lightweight-charts markers for every signal seen on the current symbol.
 *   list()       -> signals newest first.
 *   reset()      -> forget everything (symbol or interval changed).
 */
function createSignalEngine(opts = {}) {
  const C = window.Candlestick, X = window.TDCandles;
  let minFit = opts.minFit ?? 0.5, intervalSec = opts.intervalSec ?? 300, sensitivity = opts.sensitivity || "normal"; // "normal" | "all"
  let models = { ...SIGNAL_MODELS_DEFAULT, ...(opts.models || loadSignalModels()) };
  const shiftT = opts.shift || ((t) => t);
  let seen = new Map(); // key -> signal
  const dirOf = (name) => C?.metadata?.getPatternMetadata?.(name)?.direction || (/bull|piercing|morning|white|bottom/i.test(name) ? "bullish" : /bear|hanging|shooting|dark|evening|black|top/i.test(name) ? "bearish" : "neutral");

  function completed(bars) {
    const now = Date.now() / 1000;
    // The last bar is still forming while its interval has not elapsed (a daily bar: the session is still open).
    const last = bars[bars.length - 1];
    if (last && now < last.time + intervalSec) return bars.slice(0, -1);
    return bars;
  }
  const gate = () => sensitivity !== "all" && models.trendGate;

  function classicHits(done) {
    if (!C || !models.classic) return [];
    let hits;
    try { hits = C.patternChain(done, C.allPatterns, { trendContext: { trendMethod: "sma-slope", trendPeriod: 10, resolveConflicts: true } }); }
    catch { return []; }
    const out = [];
    for (const h of hits) {
      if (SIGNAL_SKIP.has(h.pattern)) continue;
      if (sensitivity !== "all" && SIGNAL_WEAK.has(h.pattern)) continue;
      const dir = dirOf(h.pattern);
      if (dir === "neutral" && h.pattern !== "doji") continue;
      if (h.contextFit != null && h.contextFit < minFit) continue;
      // Trend gate (as in MotiveWave's "require correct trend context"): a bullish reversal only after a
      // downtrend or sideways tape, a bearish one only after an uptrend or sideways; never against the trend.
      if (gate() && h.trendContext && ((dir === "bullish" && h.trendContext === "uptrend") || (dir === "bearish" && h.trendContext === "downtrend"))) continue;
      const endIdx = h.index + (h.match?.length || 1) - 1;
      const fits = (dir === "bullish" && h.trendContext === "downtrend") || (dir === "bearish" && h.trendContext === "uptrend");
      out.push({ endIdx, pattern: h.pattern, dir, fit: h.contextFit ?? null, trend: h.trendContext || null, bars: h.match?.length || 1, fits, model: "classic" });
    }
    return out;
  }
  function extendedHits(done) {
    if (!X || !models.extended) return [];
    return X.detect(done, { only: X.EXTENDED, trendGate: gate() }).map((h) => ({ endIdx: h.index, pattern: h.pattern, dir: h.dir, fit: null, trend: h.trend, bars: h.bars,
      fits: (h.dir === "bullish" && h.trend === "downtrend") || (h.dir === "bearish" && h.trend === "uptrend"), model: "extended" }));
  }

  return {
    setInterval(sec) { if (sec !== intervalSec) { intervalSec = sec; seen = new Map(); } },
    setMinFit(v) { minFit = v; },
    setSensitivity(v) { sensitivity = v === "all" ? "all" : "normal"; seen = new Map(); },
    setModels(m) { models = { ...models, ...m }; seen = new Map(); },
    get models() { return { ...models }; },
    reset() { seen = new Map(); },
    update(bars) {
      if (!bars?.length) return [];
      const done = completed(bars).slice(-400);
      if (done.length < 12) return [];
      const fresh = [];
      for (const h of [...classicHits(done), ...extendedHits(done)]) {
        const bar = done[h.endIdx]; if (!bar) continue;
        const key = `${bar.time}|${h.pattern}`;
        if (seen.has(key)) continue;
        // "Three outside" = an engulfing plus a confirming bar: upgrade the engulfing already marked instead of a second arrow.
        if (/^threeOutside/.test(h.pattern) && h.endIdx > 0) {
          const eng = seen.get(`${done[h.endIdx - 1].time}|${h.dir}Engulfing`);
          if (eng) { if (!eng.confirmed) { eng.confirmed = true; eng.strength = Math.min(3, eng.strength + 1); eng.label += " ✓"; } continue; }
        }
        // No repeat of the same pattern on a run of same-colour candles (an engulfing chain marks once).
        if (sensitivity !== "all" && h.endIdx > 0) {
          const prev = done[h.endIdx - 1], same = (b) => (b.close >= b.open) === (bar.close >= bar.open);
          if (same(prev) && seen.has(`${prev.time}|${h.pattern}`)) continue;
        }
        const volume = models.volume && X ? X.volumeSpike(done, h.endIdx) : false;
        const strength = 1 + (h.fits ? 1 : 0) + (volume ? 1 : 0);
        const sig = { key, time: bar.time, price: bar.close, pattern: h.pattern, label: SIGNAL_LABELS[h.pattern] || h.pattern, dir: h.dir,
          fit: h.fit, trend: h.trend, bars: h.bars, volume, strength, strong: SIGNAL_STRONG.has(h.pattern), model: h.model,
          low: Math.min(...done.slice(h.endIdx - h.bars + 1, h.endIdx + 1).map((b) => b.low)), high: Math.max(...done.slice(h.endIdx - h.bars + 1, h.endIdx + 1).map((b) => b.high)) };
        seen.set(key, sig); fresh.push(sig);
      }
      fresh.sort((a, b) => a.time - b.time);
      if (fresh.length && opts.onSignal) opts.onSignal(fresh);
      return fresh;
    },
    list() { return [...seen.values()].sort((a, b) => b.time - a.time); },
    markers() {
      const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      const all = [...seen.values()].sort((a, b) => a.time - b.time);
      const labelFrom = Math.max(0, all.length - SIGNAL_LABELLED);
      return all.map((s, i) => ({
        time: shiftT(s.time),
        position: s.dir === "bearish" ? "aboveBar" : "belowBar",
        shape: s.dir === "bearish" ? "arrowDown" : s.dir === "bullish" ? "arrowUp" : "circle",
        color: s.dir === "bearish" ? css("--down") : s.dir === "bullish" ? css("--up") : css("--dim"),
        text: i >= labelFrom ? `${s.label}${s.strength >= 3 ? " ★★" : s.strength === 2 ? " ★" : ""}` : undefined, size: s.strength >= 3 ? 1.6 : s.strength === 2 ? 1.25 : 1,
      }));
    },
  };
}

/** Render a signal feed (newest first) into `host`. `fmtTime` formats a unix time. */
function renderSignalFeed(host, signals, { fmtTime, fmtPrice, limit = 8, onPick } = {}) {
  host.innerHTML = "";
  if (!signals.length) { host.append(Object.assign(document.createElement("span"), { className: "dim small", textContent: "No candle signals yet on completed bars." })); return; }
  for (const s of signals.slice(0, limit)) {
    const chip = document.createElement("button"); chip.type = "button";
    chip.className = `sig-chip ${s.dir}${s.strength >= 3 ? " s3" : s.strength === 2 ? " s2" : ""}`;
    const stars = s.strength >= 3 ? "★★" : s.strength === 2 ? "★" : "";
    chip.innerHTML = `<b>${s.dir === "bearish" ? "▼" : s.dir === "bullish" ? "▲" : "•"} ${s.label}</b>${stars ? ` <span class="stars">${stars}</span>` : ""} <span class="mono">${fmtPrice ? fmtPrice(s.price) : s.price}</span> <span class="dim">${fmtTime ? fmtTime(s.time) : ""}</span>`;
    chip.title = `${s.label} (${s.dir}, ${s.model} model) on the ${s.bars}-bar pattern ending ${fmtTime ? fmtTime(s.time) : s.time}${s.trend ? `, after a ${s.trend}` : ""}.` +
      ` Strength ${s.strength}/3: ${[s.trend && ((s.dir === "bullish" && s.trend === "downtrend") || (s.dir === "bearish" && s.trend === "uptrend")) ? "trend fits" : "trend neutral", s.volume ? "volume spike" : "normal volume"].join(", ")}.`;
    if (onPick) chip.onclick = () => onPick(s);
    host.append(chip);
  }
}

/** A small popover with the detection models (checkboxes). `onChange(models)` gets the new set. */
function sigModelsControl(onChange, { models = loadSignalModels() } = {}) {
  const det = document.createElement("details"); det.className = "sig-models";
  const sum = document.createElement("summary"); sum.textContent = "Models"; sum.title = "Which candle models run on this chart"; det.append(sum);
  const box = document.createElement("div"); box.className = "sig-models-box"; det.append(box);
  const rows = [["classic", "Classic patterns", "18 patterns (hammer, engulfing, stars, soldiers, kickers, tweezers…)"],
    ["extended", "Extended patterns", "TA-Lib rules: belt holds, dragonfly / gravestone doji, abandoned baby, 3 inside / outside, rising / falling 3 methods, inside-bar breakouts"],
    ["trendGate", "Trend gate", "Only reversals that fit the preceding trend (MotiveWave rule)"],
    ["volume", "Volume confirmation", "A 1.3x volume spike adds a star to the signal"]];
  for (const [k, label, help] of rows) {
    const l = document.createElement("label"); l.className = "check"; l.title = help;
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!models[k];
    cb.onchange = () => { models = { ...models, [k]: cb.checked }; saveSignalModels(models); onChange(models); };
    l.append(cb, document.createTextNode(` ${label}`)); box.append(l);
  }
  document.addEventListener("click", (e) => { if (det.open && !det.contains(e.target)) det.open = false; });
  return det;
}

/** Browser notification for new signals on the latest bar only (not the backlog on first load). */
function notifySignals(symbol, fresh, latestBarTime) {
  try {
    if (Notification.permission !== "granted") return;
    for (const s of fresh) if (s.time >= latestBarTime) new Notification(`${symbol}: ${s.label}${s.strength >= 2 ? ` ${"★".repeat(s.strength - 1)}` : ""}`, { body: `${s.dir} signal at ${s.price}`, tag: `sig-${symbol}-${s.key}` });
  } catch { /* unsupported */ }
}
