// Routine health: for each scan routine, when it last finished, what the last run cost, and how often it failed or
// was skipped in the last 7 days. Read from the briefs table only. Also decides which problems deserve a banner:
// the most recent run of an ENABLED routine failed or was skipped, or the latest error says a spend cap or usage
// limit was hit. The reducer is pure (tested); the D1 read is a thin wrapper.

export type BriefRow = { id: string; day: string; slot: string; label: string | null; status: string; cost: string | null; error: string | null; created_at: string; finished_at: string | null };
export type HealthRow = {
  id: string; label: string; et: string; enabled: boolean;
  last_run: { at: string; day: string; status: string; error: string | null } | null;
  last_success: { at: string; day: string; finished_at: string | null } | null;
  last_cost: string | null;            // cost of the latest run that actually ran (a skipped run costs nothing)
  failures_7d: number; skips_7d: number; runs_7d: number;
  state: "ok" | "failed" | "skipped" | "running" | "never" | "off";
};
export type HealthAlert = { key: string; slot: string; kind: "failed" | "skipped" | "limit"; text: string };

/** Does this error text say the money or usage ceiling was hit (desk cap, session budget, API credit or rate limit)? */
export const LIMIT_RE = /spend(ing)? cap|daily cap|usage limit|session budget|budget[_ ]reached|credit balance|insufficient (credit|fund|balance)|quota|rate.?limit|billing|\b429\b|overloaded/i;
export const isLimitError = (s: string | null | undefined) => !!s && LIMIT_RE.test(s);

const ts = (s: string | null | undefined) => (s ? Date.parse(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")) : NaN);

/** rows: any order. now: ms. */
export function routineHealth(rows: BriefRow[], slots: { id: string; label: string; et: string }[], autopilot: { enabled: boolean; slots: Record<string, boolean> }, now = Date.now()): { routines: HealthRow[]; alerts: HealthAlert[]; autopilot_enabled: boolean; window_days: number } {
  const sorted = [...rows].filter((r) => Number.isFinite(ts(r.created_at))).sort((a, b) => ts(b.created_at) - ts(a.created_at)), weekAgo = now - 7 * 86400_000;
  const alerts: HealthAlert[] = [];
  const routines = slots.map((s): HealthRow => {
    const mine = sorted.filter((r) => r.slot === s.id), last = mine[0] ?? null, ok = mine.find((r) => r.status === "done") ?? null, ran = mine.find((r) => r.status !== "skipped" && r.status !== "starting") ?? null;
    const week = mine.filter((r) => ts(r.created_at) >= weekAgo), enabled = !!autopilot.enabled && !!autopilot.slots?.[s.id];
    const state: HealthRow["state"] = !last ? (enabled ? "never" : "off") : last.status === "error" ? "failed" : last.status === "skipped" ? "skipped" : last.status === "done" ? "ok" : "running";
    if (last && enabled && (last.status === "error" || last.status === "skipped")) {
      const limit = isLimitError(last.error);
      alerts.push({ key: `${last.id}:${last.status}`, slot: s.id, kind: limit ? "limit" : last.status === "error" ? "failed" : "skipped",
        text: `${s.label}: the last run (${last.day}) ${last.status === "error" ? "failed" : "was skipped"}${last.error ? `: ${last.error.slice(0, 220)}` : "."}` });
    } else if (last && isLimitError(last.error) && ts(last.created_at) >= now - 2 * 86400_000) {
      // A limit hit matters even on a manual run of a routine that is switched off, while it is fresh (2 days).
      alerts.push({ key: `${last.id}:limit`, slot: s.id, kind: "limit", text: `${s.label}: a spending or usage limit was hit on the last run (${last.day}): ${String(last.error).slice(0, 220)}` });
    }
    return { id: s.id, label: s.label, et: s.et, enabled,
      last_run: last ? { at: last.created_at, day: last.day, status: last.status, error: last.error } : null,
      last_success: ok ? { at: ok.created_at, day: ok.day, finished_at: ok.finished_at } : null,
      last_cost: ran?.cost ?? null,
      failures_7d: week.filter((r) => r.status === "error").length, skips_7d: week.filter((r) => r.status === "skipped").length, runs_7d: week.length, state };
  });
  return { routines, alerts, autopilot_enabled: !!autopilot.enabled, window_days: 7 };
}

export async function briefHealth(db: D1Database, slots: { id: string; label: string; et: string }[], autopilot: { enabled: boolean; slots: Record<string, boolean> }) {
  // Light columns only (no content): the newest 2000 rows cover far more than 7 days and still find an old last success.
  const { results } = await db.prepare("SELECT id, day, slot, label, status, cost, error, created_at, finished_at FROM briefs ORDER BY created_at DESC LIMIT 2000").all<BriefRow>();
  return routineHealth(results, slots, autopilot);
}
