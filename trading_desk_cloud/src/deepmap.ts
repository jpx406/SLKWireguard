// Deep Analysis rating -> what the desk may do. A rating is the portfolio manager's view; an order needs more:
//   · "Sell" / "Underweight" means get out of (or stay out of) longs. It is NOT an instruction to short.
//   · A short needs the trader's action to say "Short" AND the manager's text not to say cash / avoid / stay out.
//   · A long needs the manager's rating (Buy / Overweight) and the trader's action (Buy) to agree.
//   · "35-40% of a normal position" becomes a size multiplier.
// Pure, so the stored notes can be replayed in tests.
export type DeepDecision = { action: "long" | "short" | "none"; flatten_longs: boolean; block_longs: boolean; size_mult: number; why: string };

const CASH = /\b(stay(ing)? in cash|remain in cash|hold cash|in cash|avoid(ing)? (new )?(entry|entries|the stock|exposure|initiating|a position)|avoid entry|do not (enter|initiate|buy|short)|don'?t (enter|initiate|short)|no (new )?position|stay(ing)? (out|flat|on the sidelines)|sidelines|stand aside|wait for|not (a )?short)\b/i;
const STAGED = /(\d{1,3})\s*(?:%\s*)?(?:(?:-|–|—|to)\s*(\d{1,3})\s*)?%\s*(?:of\s+)?(?:a\s+|the\s+)?(?:normal|full|usual|standard|typical|regular)/i;

export function stagedSize(text: string): number {
  const m = STAGED.exec(text || ""); if (!m) return 1;
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a, v = (a + b) / 2 / 100;
  return v > 0 && v <= 1 ? Math.round(v * 1000) / 1000 : 1;
}
export function deepDecision(x: { rating?: string | null; trader_action?: string | null; text?: string | null }): DeepDecision {
  const rating = String(x.rating || "").trim().toLowerCase(), trader = String(x.trader_action || "").trim().toLowerCase(), text = String(x.text || "");
  const size_mult = stagedSize(text), cash = CASH.test(text);
  if (rating === "sell" || rating === "underweight") {
    const short = /^short|sell short/.test(trader) && !cash;
    return { action: short ? "short" : "none", flatten_longs: true, block_longs: true, size_mult,
      why: short ? "Rated " + x.rating + " and the trader's action is Short: a short is allowed." : `Rated ${x.rating}${cash ? " with the manager saying cash / avoid" : `, trader action "${x.trader_action || "none"}"`}: no new longs and existing longs are closed. It is not a short.` };
  }
  if (rating === "buy" || rating === "overweight") {
    if (cash) return { action: "none", flatten_longs: false, block_longs: true, size_mult, why: `Rated ${x.rating} but the text says cash / avoid / wait: no order.` };
    if (trader !== "buy") return { action: "none", flatten_longs: false, block_longs: false, size_mult, why: `The manager rated it ${x.rating} but the trader's action is "${x.trader_action || "none"}": they must agree before any order.` };
    return { action: "long", flatten_longs: false, block_longs: false, size_mult, why: `Manager (${x.rating}) and trader (Buy) agree${size_mult < 1 ? `, at ${Math.round(size_mult * 100)}% of a normal position` : ""}.` };
  }
  return { action: "none", flatten_longs: false, block_longs: false, size_mult, why: rating ? "Rated Hold: no order." : "No readable rating: no order." };
}
