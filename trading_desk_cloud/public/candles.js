"use strict";
/* Candlestick pattern models shared by the browser (chart signals) and the Worker (chart autopilot).
   Rules follow TA-Lib's CDL* definitions (body / shadow ratios against the average body of the last
   10 bars) with MotiveWave-style context: each hit carries the trend it formed in, a volume check and
   a 1-3 "strength". Loaded as a classic script in the browser (window.TDCandles) and imported for its
   side effect by the Worker bundle (globalThis.TDCandles). No dependencies. */
(function (root) {
  const avgBody = (b, i, n = 10) => { let s = 0, k = 0; for (let j = Math.max(0, i - n); j < i; j++) { s += Math.abs(b[j].close - b[j].open); k++; } return k ? s / k : Math.abs(b[i].close - b[i].open) || 1e-9; };
  const body = (c) => Math.abs(c.close - c.open), range = (c) => c.high - c.low || 1e-9;
  const up = (c) => c.close > c.open, dn = (c) => c.close < c.open;
  const upper = (c) => c.high - Math.max(c.open, c.close), lower = (c) => Math.min(c.open, c.close) - c.low;
  const mid = (c) => (c.open + c.close) / 2;
  const doji = (c, ab) => body(c) <= ab * 0.1;
  const long = (c, ab) => body(c) >= ab * 1.0, short = (c, ab) => body(c) <= ab * 0.5;
  const gapUp = (a, b) => Math.min(b.open, b.close) > Math.max(a.open, a.close), gapDn = (a, b) => Math.max(b.open, b.close) < Math.min(a.open, a.close);
  const realGapUp = (a, b) => b.low > a.high, realGapDn = (a, b) => b.high < a.low;

  /** Trend before bar i: slope of a simple moving average of the closes, measured in average ranges. */
  function trendBefore(b, i, period) {
    if (i < period + 3) return "sideways";
    const sma = (k) => { let s = 0; for (let j = k - period + 1; j <= k; j++) s += b[j].close; return s / period; };
    let ar = 0; for (let j = i - period; j < i; j++) ar += range(b[j]); ar /= period;
    const slope = sma(i - 1) - sma(i - 1 - Math.max(2, Math.floor(period / 2)));
    return slope > 0.35 * ar ? "uptrend" : slope < -0.35 * ar ? "downtrend" : "sideways";
  }
  function volumeSpike(b, i, n = 20) {
    const v = b[i].volume; if (v == null) return false;
    let s = 0, k = 0; for (let j = Math.max(0, i - n); j < i; j++) { if (b[j].volume != null) { s += b[j].volume; k++; } }
    return k >= 5 && v >= 1.3 * (s / k);
  }

  // Each rule: (b, i, ab) -> truthy when the pattern ENDS at bar i. `n` = bars in the pattern.
  const RULES = {
    // ---- single bar
    hammer: { n: 1, dir: "bullish", test: (b, i, ab) => { const c = b[i]; return short(c, ab) && !doji(c, ab) && lower(c) >= 2 * body(c) && upper(c) <= 0.1 * range(c) && trendBefore(b, i, 10) !== "uptrend"; } },
    hangingMan: { n: 1, dir: "bearish", test: (b, i, ab) => { const c = b[i]; return short(c, ab) && !doji(c, ab) && lower(c) >= 2 * body(c) && upper(c) <= 0.1 * range(c) && trendBefore(b, i, 10) === "uptrend"; } },
    invertedHammer: { n: 1, dir: "bullish", test: (b, i, ab) => { const c = b[i]; return short(c, ab) && !doji(c, ab) && upper(c) >= 2 * body(c) && lower(c) <= 0.1 * range(c) && trendBefore(b, i, 10) !== "uptrend"; } },
    shootingStar: { n: 1, dir: "bearish", test: (b, i, ab) => { const c = b[i]; return short(c, ab) && !doji(c, ab) && upper(c) >= 2 * body(c) && lower(c) <= 0.1 * range(c) && trendBefore(b, i, 10) === "uptrend"; } },
    dragonflyDoji: { n: 1, dir: "bullish", test: (b, i, ab) => { const c = b[i]; return doji(c, ab) && lower(c) >= 0.6 * range(c) && upper(c) <= 0.1 * range(c); } },
    gravestoneDoji: { n: 1, dir: "bearish", test: (b, i, ab) => { const c = b[i]; return doji(c, ab) && upper(c) >= 0.6 * range(c) && lower(c) <= 0.1 * range(c); } },
    bullishMarubozu: { n: 1, dir: "bullish", test: (b, i, ab) => { const c = b[i]; return up(c) && long(c, ab) && upper(c) <= 0.05 * range(c) && lower(c) <= 0.05 * range(c); } },
    bearishMarubozu: { n: 1, dir: "bearish", test: (b, i, ab) => { const c = b[i]; return dn(c) && long(c, ab) && upper(c) <= 0.05 * range(c) && lower(c) <= 0.05 * range(c); } },
    bullishBeltHold: { n: 1, dir: "bullish", test: (b, i, ab) => { const c = b[i]; return up(c) && long(c, ab) && lower(c) <= 0.05 * range(c) && upper(c) > 0.05 * range(c) && trendBefore(b, i, 10) === "downtrend"; } },
    bearishBeltHold: { n: 1, dir: "bearish", test: (b, i, ab) => { const c = b[i]; return dn(c) && long(c, ab) && upper(c) <= 0.05 * range(c) && lower(c) > 0.05 * range(c) && trendBefore(b, i, 10) === "uptrend"; } },
    // ---- two bars
    bullishEngulfing: { n: 2, dir: "bullish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return dn(p) && up(c) && c.open <= p.close && c.close >= p.open && body(c) > body(p) && !doji(p, ab); } },
    bearishEngulfing: { n: 2, dir: "bearish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return up(p) && dn(c) && c.open >= p.close && c.close <= p.open && body(c) > body(p) && !doji(p, ab); } },
    piercingLine: { n: 2, dir: "bullish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return dn(p) && long(p, ab) && up(c) && c.open < p.low && c.close > mid(p) && c.close < p.open; } },
    darkCloudCover: { n: 2, dir: "bearish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return up(p) && long(p, ab) && dn(c) && c.open > p.high && c.close < mid(p) && c.close > p.open; } },
    bullishHarami: { n: 2, dir: "bullish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return dn(p) && long(p, ab) && short(c, ab) && Math.max(c.open, c.close) < p.open && Math.min(c.open, c.close) > p.close; } },
    bearishHarami: { n: 2, dir: "bearish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return up(p) && long(p, ab) && short(c, ab) && Math.max(c.open, c.close) < p.close && Math.min(c.open, c.close) > p.open; } },
    tweezersBottom: { n: 2, dir: "bullish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return dn(p) && up(c) && Math.abs(p.low - c.low) <= 0.1 * ab && trendBefore(b, i - 1, 10) !== "uptrend"; } },
    tweezersTop: { n: 2, dir: "bearish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return up(p) && dn(c) && Math.abs(p.high - c.high) <= 0.1 * ab && trendBefore(b, i - 1, 10) !== "downtrend"; } },
    bullishKicker: { n: 2, dir: "bullish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return dn(p) && up(c) && c.open > p.open && long(c, ab); } },
    bearishKicker: { n: 2, dir: "bearish", test: (b, i, ab) => { const p = b[i - 1], c = b[i]; return up(p) && dn(c) && c.open < p.open && long(c, ab); } },
    // Inside bar (a short bar inside a long "mother" bar) broken by a long bar closing beyond the mother's range.
    insideBarBreakUp: { n: 3, dir: "bullish", test: (b, i, ab) => { const m = b[i - 2], p = b[i - 1], c = b[i]; return long(m, ab) && short(p, ab) && p.high <= m.high && p.low >= m.low && c.close > m.high && up(c) && long(c, ab); } },
    insideBarBreakDown: { n: 3, dir: "bearish", test: (b, i, ab) => { const m = b[i - 2], p = b[i - 1], c = b[i]; return long(m, ab) && short(p, ab) && p.high <= m.high && p.low >= m.low && c.close < m.low && dn(c) && long(c, ab); } },
    // ---- three bars
    morningStar: { n: 3, dir: "bullish", test: (b, i, ab) => { const a = b[i - 2], s = b[i - 1], c = b[i]; return dn(a) && long(a, ab) && short(s, ab) && gapDn(a, s) && up(c) && c.close > mid(a); } },
    eveningStar: { n: 3, dir: "bearish", test: (b, i, ab) => { const a = b[i - 2], s = b[i - 1], c = b[i]; return up(a) && long(a, ab) && short(s, ab) && gapUp(a, s) && dn(c) && c.close < mid(a); } },
    abandonedBabyBullish: { n: 3, dir: "bullish", test: (b, i, ab) => { const a = b[i - 2], s = b[i - 1], c = b[i]; return dn(a) && long(a, ab) && doji(s, ab) && realGapDn(a, s) && realGapUp(s, c) && up(c) && c.close > mid(a); } },
    abandonedBabyBearish: { n: 3, dir: "bearish", test: (b, i, ab) => { const a = b[i - 2], s = b[i - 1], c = b[i]; return up(a) && long(a, ab) && doji(s, ab) && realGapUp(a, s) && realGapDn(s, c) && dn(c) && c.close < mid(a); } },
    threeInsideUp: { n: 3, dir: "bullish", test: (b, i, ab) => { const a = b[i - 2], h = b[i - 1], c = b[i]; return dn(a) && long(a, ab) && up(h) && short(h, ab) && h.close < a.open && h.open > a.close && up(c) && c.close > a.open; } },
    threeInsideDown: { n: 3, dir: "bearish", test: (b, i, ab) => { const a = b[i - 2], h = b[i - 1], c = b[i]; return up(a) && long(a, ab) && dn(h) && short(h, ab) && h.close > a.open && h.open < a.close && dn(c) && c.close < a.open; } },
    threeOutsideUp: { n: 3, dir: "bullish", test: (b, i, ab) => { const a = b[i - 2], e = b[i - 1], c = b[i]; return dn(a) && up(e) && e.open <= a.close && e.close >= a.open && body(e) > body(a) && up(c) && c.close > e.close; } },
    threeOutsideDown: { n: 3, dir: "bearish", test: (b, i, ab) => { const a = b[i - 2], e = b[i - 1], c = b[i]; return up(a) && dn(e) && e.open >= a.close && e.close <= a.open && body(e) > body(a) && dn(c) && c.close < e.close; } },
    threeWhiteSoldiers: { n: 3, dir: "bullish", test: (b, i, ab) => { const x = b[i - 2], y = b[i - 1], z = b[i]; return [x, y, z].every((c) => up(c) && long(c, ab) && upper(c) <= 0.3 * body(c)) && y.open > x.open && y.open < x.close && z.open > y.open && z.open < y.close && y.close > x.close && z.close > y.close; } },
    threeBlackCrows: { n: 3, dir: "bearish", test: (b, i, ab) => { const x = b[i - 2], y = b[i - 1], z = b[i]; return [x, y, z].every((c) => dn(c) && long(c, ab) && lower(c) <= 0.3 * body(c)) && y.open < x.open && y.open > x.close && z.open < y.open && z.open > y.close && y.close < x.close && z.close < y.close; } },
    // ---- five bars (continuation)
    risingThreeMethods: { n: 5, dir: "bullish", test: (b, i, ab) => { const f = b[i - 4], l = b[i]; const m = [b[i - 3], b[i - 2], b[i - 1]]; return up(f) && long(f, ab) && m.every((c) => short(c, ab) && c.high <= f.high && c.low >= f.low) && up(l) && long(l, ab) && l.close > f.close; } },
    fallingThreeMethods: { n: 5, dir: "bearish", test: (b, i, ab) => { const f = b[i - 4], l = b[i]; const m = [b[i - 3], b[i - 2], b[i - 1]]; return dn(f) && long(f, ab) && m.every((c) => short(c, ab) && c.high <= f.high && c.low >= f.low) && dn(l) && long(l, ab) && l.close < f.close; } },
  };
  const LABELS = {
    hammer: "Hammer", hangingMan: "Hanging Man", invertedHammer: "Inv. Hammer", shootingStar: "Shooting Star", dragonflyDoji: "Dragonfly Doji", gravestoneDoji: "Gravestone Doji",
    bullishMarubozu: "Bull Marubozu", bearishMarubozu: "Bear Marubozu", bullishBeltHold: "Bull Belt Hold", bearishBeltHold: "Bear Belt Hold",
    bullishEngulfing: "Bull Engulfing", bearishEngulfing: "Bear Engulfing", piercingLine: "Piercing Line", darkCloudCover: "Dark Cloud", bullishHarami: "Bull Harami", bearishHarami: "Bear Harami",
    tweezersBottom: "Tweezers Bottom", tweezersTop: "Tweezers Top", bullishKicker: "Bull Kicker", bearishKicker: "Bear Kicker", insideBarBreakUp: "Inside Bar Break ↑", insideBarBreakDown: "Inside Bar Break ↓",
    morningStar: "Morning Star", eveningStar: "Evening Star", abandonedBabyBullish: "Abandoned Baby (bull)", abandonedBabyBearish: "Abandoned Baby (bear)",
    threeInsideUp: "3 Inside Up", threeInsideDown: "3 Inside Down", threeOutsideUp: "3 Outside Up", threeOutsideDown: "3 Outside Down",
    threeWhiteSoldiers: "3 White Soldiers", threeBlackCrows: "3 Black Crows", risingThreeMethods: "Rising 3 Methods", fallingThreeMethods: "Falling 3 Methods",
  };
  // Patterns the browser's classic library (candlestick 3.0) does not have: the "extended" model adds these.
  const EXTENDED = ["dragonflyDoji", "gravestoneDoji", "bullishBeltHold", "bearishBeltHold", "insideBarBreakUp", "insideBarBreakDown",
    "abandonedBabyBullish", "abandonedBabyBearish", "threeInsideUp", "threeInsideDown", "threeOutsideUp", "threeOutsideDown", "risingThreeMethods", "fallingThreeMethods"];
  // The strongest reversal families: a signal from one of these counts as an exit signal against an open trade.
  const STRONG = new Set(["bullishEngulfing", "bearishEngulfing", "morningStar", "eveningStar", "abandonedBabyBullish", "abandonedBabyBearish", "threeInsideUp", "threeInsideDown",
    "threeOutsideUp", "threeOutsideDown", "threeWhiteSoldiers", "threeBlackCrows", "piercingLine", "darkCloudCover", "bullishKicker", "bearishKicker", "insideBarBreakUp", "insideBarBreakDown"]);

  /**
   * detect(bars, { only, from, trendPeriod, trendGate }) -> hits ending at each bar index (ascending).
   *   bars: [{time, open, high, low, close, volume}] oldest first (completed bars only).
   *   only: array/Set of pattern names (default: all). from: first bar index to scan.
   *   trendGate: drop bullish hits that form in an uptrend and bearish hits in a downtrend (default true).
   * Each hit: { index, time, pattern, label, dir, bars, trend, volume, strength (1-3), strong }.
   *   strength = 1, +1 when the trend fits (a reversal after the opposite trend), +1 on a volume spike.
   */
  function detect(bars, opts = {}) {
    const names = opts.only ? [...opts.only].filter((n) => RULES[n]) : Object.keys(RULES);
    const period = opts.trendPeriod || 10, gate = opts.trendGate !== false;
    const out = [];
    if (!bars || bars.length < 6) return out;
    for (let i = Math.max(5, opts.from || 0); i < bars.length; i++) {
      const ab = avgBody(bars, i);
      for (const name of names) {
        const r = RULES[name];
        if (i - r.n + 1 < 1) continue;
        let hit = false;
        try { hit = !!r.test(bars, i, ab); } catch { hit = false; }
        if (!hit) continue;
        const trend = trendBefore(bars, i - r.n + 1, period);
        if (gate && ((r.dir === "bullish" && trend === "uptrend") || (r.dir === "bearish" && trend === "downtrend"))) continue;
        const fits = (r.dir === "bullish" && trend === "downtrend") || (r.dir === "bearish" && trend === "uptrend");
        const vol = volumeSpike(bars, i);
        out.push({ index: i, time: bars[i].time, pattern: name, label: LABELS[name], dir: r.dir, bars: r.n, trend, volume: vol, strength: 1 + (fits ? 1 : 0) + (vol ? 1 : 0), strong: STRONG.has(name) });
      }
    }
    return out;
  }
  root.TDCandles = { detect, trendBefore, volumeSpike, LABELS, EXTENDED, STRONG, PATTERNS: Object.keys(RULES) };
})(typeof globalThis !== "undefined" ? globalThis : window);
