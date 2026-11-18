// Pick normaliser for brief results. A model answer sometimes glues a bias or horizon word onto the ticker
// ("AMDSell long", "UPBDSWING", "HYPE32196-USDSWING") and states one R:R for the whole plan while each row has its
// own levels. This turns every pick into clean, separate fields before it is stored or shown:
//   symbol  : a ticker that passes SYMBOL_RE (crypto pairs such as HYPE32196-USD stay whole)
//   bias    : "long" | "short" (recovered from the glued word when the field is missing)
//   horizon : "day" | "swing"  (same)
//   rr      : reward / risk of THIS row, from its own entry, stop and first target (null when the levels do not allow it)
// Pure: no I/O, so it is unit-tested.
import { SYMBOL_RE } from "./market";

export type RawPick = Record<string, unknown>;
type Bias = "long" | "short";
type Horizon = "day" | "swing";

const WORD_BIAS: Record<string, Bias> = { long: "long", short: "short", buy: "long", sell: "short", bullish: "long", bearish: "short" };
const WORD_HORIZON: Record<string, Horizon> = { swing: "swing", day: "day", intraday: "day" };
const WORDS = "bullish|bearish|intraday|short|swing|long|sell|buy|day";
// "AMDSell": an upper-case ticker followed by a Capitalised or lower-case word. The case change marks the seam.
const GLUED_MIXED = new RegExp(`^([A-Z0-9.^=-]+?)((?:${WORDS})|(?:${WORDS.split("|").map((w) => w[0].toUpperCase() + w.slice(1)).join("|")}))$`);
// "UPBDSWING": all capitals, so only words that no ticker ends with are cut. DAY and BUY are real ticker endings
// (WDAY, DAY), so they are cut only from a crypto pair ("BTC-USDDAY"), where nothing may follow the quote currency.
const GLUED_CAPS = /^([A-Z0-9.^=-]+?)(BULLISH|BEARISH|INTRADAY|SHORT|SWING|LONG|SELL)$/;
const GLUED_PAIR = /^([A-Z0-9]+-(?:USD|USDT|USDC|EUR|BTC|ETH))(DAY|BUY)$/;

const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const biasOf = (s: unknown): Bias | null => { const t = String(s ?? "").toLowerCase(); return /short|sell|bear/.test(t) ? "short" : /long|buy|bull/.test(t) ? "long" : null; };
const horizonOf = (s: unknown): Horizon | null => { const t = String(s ?? "").toLowerCase(); return /swing/.test(t) ? "swing" : /\bday\b|intraday/.test(t) ? "day" : null; };

/** Split a raw symbol cell into the ticker and the words stuck to it. `words` are lower-case, in the order found. */
export function splitSymbol(raw: unknown): { symbol: string | null; words: string[] } {
  const tokens = String(raw ?? "").replace(/[ ​]/g, " ").trim().split(/[\s,;|/()]+/).filter(Boolean);
  if (!tokens.length) return { symbol: null, words: [] };
  let s = tokens[0].replace(/^\$/, ""); const words: string[] = [];
  if (/^[A-Za-z]{2,12}:/.test(s)) s = s.slice(s.indexOf(":") + 1); // "NASDAQ:AMD"
  const glued: string[] = [];
  for (let i = 0; i < 3; i++) {
    const m = s.match(GLUED_MIXED) || s.match(GLUED_PAIR) || s.match(GLUED_CAPS);
    if (!m || !m[1] || !/[A-Z0-9]$/.test(m[1])) break;
    s = m[1]; glued.unshift(m[2].toLowerCase());
  }
  words.push(...glued);
  for (const t of tokens.slice(1)) { const w = t.toLowerCase().replace(/[^a-z]/g, ""); if (w in WORD_BIAS || w in WORD_HORIZON) words.push(w); }
  s = s.toUpperCase();
  return { symbol: SYMBOL_RE.test(s) && /[A-Z0-9]/.test(s) ? s : null, words };
}

/** Reward / risk of one row from its own levels. Null when a level is missing or on the wrong side of the entry. */
export function rowRR(entry: unknown, stop: unknown, target: unknown, bias?: Bias | null): number | null {
  const e = num(entry), s = num(stop), t = num(target);
  if (e === null || s === null || t === null || e === s) return null;
  const side: Bias = bias ?? (s < e ? "long" : "short"), sg = side === "long" ? 1 : -1;
  const risk = (e - s) * sg, reward = (t - e) * sg;
  if (!(risk > 0) || !(reward > 0)) return null;
  return Math.round((reward / risk) * 100) / 100;
}

/** One pick with clean fields, or null when no valid ticker can be read from it. Unknown fields are kept as they are. */
export function normalizePick(p: unknown): RawPick | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const o = { ...(p as RawPick) }, { symbol, words } = splitSymbol(o.symbol ?? o.ticker);
  if (!symbol) return null;
  o.symbol = symbol;
  // Bias: the pick's own field first; else a standalone "long"/"short" word; else buy/sell/bullish/bearish.
  const wb = words.find((w) => w === "long" || w === "short") ?? words.find((w) => w in WORD_BIAS);
  const bias = biasOf(o.bias) ?? (wb ? WORD_BIAS[wb] : null);
  if (bias) o.bias = bias; // an unreadable bias is left as written rather than guessed
  // Horizon: its own field; else a word in the bias field ("long swing"); else the glued word.
  const wh = words.find((w) => w in WORD_HORIZON);
  const horizon = horizonOf(o.horizon) ?? horizonOf((p as RawPick).bias) ?? (wh ? WORD_HORIZON[wh] : null);
  if (horizon) o.horizon = horizon; // absent stays absent: the desk treats a pick without a horizon as a day trade
  // R:R of this row. The model's own figure is kept beside it when it differs, so the difference can be seen.
  const targets = Array.isArray(o.targets) ? o.targets : o.target != null ? [o.target] : [];
  const stated = num(o.rr), rr = rowRR(o.entry, o.stop, targets[0], bias);
  if (stated !== null && (rr === null || Math.abs(stated - rr) > 0.05)) o.rr_stated = stated;
  o.rr = rr;
  return o;
}

/** A list of picks: normalised, without the rows that have no readable ticker (`dropped` counts those). */
export function normalizePicks(list: unknown): { picks: RawPick[]; dropped: number } {
  const arr = Array.isArray(list) ? list : [], picks: RawPick[] = [];
  let dropped = 0;
  for (const p of arr) { const n = normalizePick(p); if (n) picks.push(n); else dropped++; }
  return { picks, dropped };
}
