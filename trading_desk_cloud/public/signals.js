"use strict";
/* Live candlestick signals on a chart (shared by the main chart, pop-out windows and the Monitor grid).
   Detection: the "candlestick" library (vendored, MIT): 18 patterns / 29 variants, with trend context so a
   hammer in a downtrend scores higher than one in an uptrend. Only COMPLETED bars are scanned, so a signal
   never appears and then vanishes while a bar is still forming. */

const SIGNAL_LABELS = {
  hammer: "Hammer", bullishHammer: "Bull Hammer", bearishHammer: "Bear Hammer",
  invertedHammer: "Inv. Hammer", bullishInvertedHammer: "Bull Inv. Hammer", bearishInvertedHammer: "Bear Inv. Hammer",
  bullishEngulfing: "Bull Engulfing", bearishEngulfing: "Bear Engulfing", bullishHarami: "Bull Harami", bearishHarami: "Bear Harami",
  bullishKicker: "Bull Kicker", bearishKicker: "Bear Kicker", hangingMan: "Hanging Man", shootingStar: "Shooting Star",
  piercingLine: "Piercing Line", darkCloudCover: "Dark Cloud", doji: "Doji", morningStar: "Morning Star", eveningStar: "Evening Star",
  threeWhiteSoldiers: "3 White Soldiers", threeBlackCrows: "3 Black Crows", marubozu: "Marubozu",
  bullishMarubozu: "Bull Marubozu", bearishMarubozu: "Bear Marubozu", spinningTop: "Spinning Top",
  bullishSpinningTop: "Bull Spinning Top", bearishSpinningTop: "Bear Spinning Top", tweezersTop: "Tweezers Top", tweezersBottom: "Tweezers Bottom",
};
// Variants that only restate a parent pattern (the generic one already fires); skipped to avoid double markers.
const SIGNAL_SKIP = new Set(["hammer", "invertedHammer", "marubozu", "spinningTop", "bullishSpinningTop", "bearishSpinningTop"]);
// Weak, very frequent patterns: not drawn on the chart or notified by default (they still count in the feed when
// sensitivity is "all"). Harami and doji print on most intraday charts several times an hour.
const SIGNAL_WEAK = new Set(["bullishHarami", "bearishHarami", "doji"]);
// Only the most recent signals get a text label; older ones stay as bare arrows so the chart stays readable.
const SIGNAL_LABELLED = 6;
const INTERVAL_SEC = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600, "1d": 86400, "1wk": 604800 };

/**
 * createSignalEngine({ intervalSec, shift, minFit, onSignal })
 *   update(bars) -> scans completed bars, returns the NEW signals (newest last) and remembers them.
 *   markers()    -> lightweight-charts markers for every signal seen on the current symbol.
 *   list()       -> signals newest first.
 *   reset()      -> forget everything (symbol or interval changed).
 */
function createSignalEngine(opts = {}) {
  const C = window.Candlestick;
  let minFit = opts.minFit ?? 0.5, intervalSec = opts.intervalSec ?? 300, sensitivity = opts.sensitivity || "normal"; // "normal" | "all"
  const shiftT = opts.shift || ((t) => t);
  let seen = new Map(); // key -> signal
  const dirOf = (name) => C.metadata.getPatternMetadata?.(name)?.direction || (/bull|piercing|morning|white|bottom/i.test(name) ? "bullish" : /bear|hanging|shooting|dark|evening|black|top/i.test(name) ? "bearish" : "neutral");

  function completed(bars) {
    const now = Date.now() / 1000;
    // The last bar is still forming while its interval has not elapsed (a daily bar: the session is still open).
    const last = bars[bars.length - 1];
    if (last && now < last.time + intervalSec) return bars.slice(0, -1);
    return bars;
  }

  return {
    setInterval(sec) { if (sec !== intervalSec) { intervalSec = sec; seen = new Map(); } },
    setMinFit(v) { minFit = v; },
    setSensitivity(v) { sensitivity = v === "all" ? "all" : "normal"; seen = new Map(); },
    reset() { seen = new Map(); },
    update(bars) {
      if (!C || !bars?.length) return [];
      const done = completed(bars).slice(-400);
      if (done.length < 12) return [];
      let hits;
      try { hits = C.patternChain(done, C.allPatterns, { trendContext: { trendMethod: "sma-slope", trendPeriod: 10, resolveConflicts: true } }); }
      catch { return []; }
      const fresh = [];
      for (const h of hits) {
        if (SIGNAL_SKIP.has(h.pattern)) continue;
        if (sensitivity !== "all" && SIGNAL_WEAK.has(h.pattern)) continue;
        const dir = dirOf(h.pattern);
        if (dir === "neutral" && h.pattern !== "doji") continue;
        if (h.contextFit != null && h.contextFit < minFit) continue;
        const endIdx = h.index + (h.match?.length || 1) - 1;
        const bar = done[endIdx]; if (!bar) continue;
        const key = `${bar.time}|${h.pattern}`;
        if (seen.has(key)) continue;
        const sig = { key, time: bar.time, price: bar.close, pattern: h.pattern, label: SIGNAL_LABELS[h.pattern] || h.pattern, dir,
          fit: h.contextFit ?? null, trend: h.trendContext || null, bars: h.match?.length || 1 };
        seen.set(key, sig); fresh.push(sig);
      }
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
        text: i >= labelFrom ? s.label : undefined, size: 1,
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
    chip.className = `sig-chip ${s.dir}`;
    chip.innerHTML = `<b>${s.dir === "bearish" ? "▼" : s.dir === "bullish" ? "▲" : "•"} ${s.label}</b> <span class="mono">${fmtPrice ? fmtPrice(s.price) : s.price}</span> <span class="dim">${fmtTime ? fmtTime(s.time) : ""}${s.fit != null ? ` · fit ${Math.round(s.fit * 100)}%` : ""}</span>`;
    chip.title = `${s.label} (${s.dir}) on the ${s.bars}-bar pattern ending ${fmtTime ? fmtTime(s.time) : s.time}${s.trend ? `, after a ${s.trend}` : ""}. Fit = how well the preceding trend matches what this pattern expects.`;
    if (onPick) chip.onclick = () => onPick(s);
    host.append(chip);
  }
}

/** Browser notification for new signals on the latest bar only (not the backlog on first load). */
function notifySignals(symbol, fresh, latestBarTime) {
  try {
    if (Notification.permission !== "granted") return;
    for (const s of fresh) if (s.time >= latestBarTime) new Notification(`${symbol}: ${s.label}`, { body: `${s.dir} signal at ${s.price}`, tag: `sig-${symbol}-${s.key}` });
  } catch { /* unsupported */ }
}
