// Claude Managed Agents: one session per Copilot conversation. The agent (model, system
// prompt, your trader-* skills, tools) and its environment are created once by
// setup/setup-agent.mjs; this file only creates sessions and relays their events.
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { getSetting, setSetting } from "./db";

export const CONFIG_MOUNT = "/workspace/trader/config.json";

export const client = (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });

const line = (o: unknown) => JSON.stringify(o) + "\n";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function toolDetail(input: Record<string, unknown>): string {
  for (const k of ["command", "file_path", "path", "pattern", "query", "url", "skill"]) if (k in input) return clip(String(input[k]), 300);
  return clip(JSON.stringify(input), 300);
}

/** Upload the trader config so every new session sees it at CONFIG_MOUNT. */
export async function syncConfigFile(env: Env, rawConfig: string) {
  const anthropic = client(env);
  const old = await getSetting<string | null>(env.DB, "config_file_id", null);
  let fileId: string | null = null;
  if (rawConfig.trim()) {
    const f = await anthropic.files.upload({ file: await toFile(new Blob([rawConfig], { type: "application/json" }), "config.json", { type: "application/json" }) });
    fileId = f.id;
  }
  await setSetting(env.DB, "config_file_id", fileId);
  if (old) await anthropic.files.delete(old).catch(() => {}); // best effort
}

/** Create a session for this conversation; returns its id. */
export async function createSession(env: Env, budgetUsd: number) {
  const fileId = await getSetting<string | null>(env.DB, "config_file_id", null);
  const session = await client(env).beta.sessions.create({
    agent: env.AGENT_ID,
    environment_id: env.ENVIRONMENT_ID,
    title: `Trading Desk ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    resources: fileId ? [{ type: "file", file_id: fileId, mount_path: CONFIG_MOUNT }] : [],
    budget: { type: "limit", max_list_cost: { amount: String(Math.round(budgetUsd * 100)), currency: "USD" } },
  });
  return session.id;
}

/**
 * Send one user message and stream the agent's work back as NDJSON lines:
 * {kind: init|text|tool|tool_result|status|usage|error|done, ...}
 */
export function runTurn(env: Env, sessionId: string, prompt: string): ReadableStream<Uint8Array> {
  const anthropic = client(env);
  const enc = new TextEncoder();
  const workspace = env.ANTHROPIC_WORKSPACE || "default";
  const toolNames = new Map<string, string>();

  return new ReadableStream({
    async start(controller) {
      const emit = (o: unknown) => controller.enqueue(enc.encode(line(o)));
      try {
        emit({ kind: "init", session_id: sessionId, trace: `https://platform.claude.com/workspaces/${workspace}/sessions/${sessionId}` });
        // Stream first, then send, so no early event is missed.
        const stream = await anthropic.beta.sessions.events.stream(sessionId);
        await anthropic.beta.sessions.events.send(sessionId, {
          events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
        });
        let cost: string | null = null, started = false;
        loop: for await (const ev of stream) {
          if (ev.type === "session.status_running" || ev.type.startsWith("agent.")) started = true;
          switch (ev.type) {
            case "agent.message":
              for (const b of ev.content) if (b.type === "text" && b.text) emit({ kind: "text", text: b.text });
              break;
            case "agent.thinking":
              emit({ kind: "status", text: "thinking" });
              break;
            case "agent.tool_use":
            case "agent.mcp_tool_use": {
              toolNames.set(ev.id, ev.name);
              emit({ kind: "tool", name: ev.name, detail: toolDetail(ev.input) });
              if (ev.evaluated_permission === "ask") {
                // Nobody approves from a browser tab: deny anything the server would not auto-allow.
                await anthropic.beta.sessions.events.send(sessionId, {
                  events: [{ type: "user.tool_confirmation", tool_use_id: ev.id, result: "deny" }],
                });
                emit({ kind: "error", text: `Blocked a tool call that needed approval: ${ev.name}` });
              }
              break;
            }
            case "agent.tool_result": {
              const text = (ev.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
              emit({ kind: "tool_result", name: toolNames.get(ev.tool_use_id) ?? "tool", is_error: !!ev.is_error, text: clip(text, 20000) });
              break;
            }
            case "agent.custom_tool_use":
              // The agent defines no custom tools; answer so the session never deadlocks.
              await anthropic.beta.sessions.events.send(sessionId, {
                events: [{ type: "user.custom_tool_result", custom_tool_use_id: ev.id, content: [{ type: "text", text: "Tool not available." }], is_error: true }],
              });
              break;
            case "session.usage":
              cost = ev.usage.list_cost ? `${ev.usage.list_cost.amount} ${ev.usage.list_cost.currency}` : cost;
              emit({ kind: "usage", cost });
              break;
            case "session.error":
              emit({ kind: "error", text: `${ev.error.type}: ${"message" in ev.error ? ev.error.message : ""}` });
              break;
            case "session.status_idle": {
              if (!started) break; // the session's idle state from before our message was picked up
              const reason = ev.stop_reason.type;
              if (reason === "requires_action") break; // we already answered; keep streaming
              if (reason === "budget_reached") emit({ kind: "error", text: "Session budget reached. Start a new session or raise the budget in Settings." });
              if (reason === "refusal") emit({ kind: "error", text: "Claude declined this request." });
              if (reason === "retries_exhausted") emit({ kind: "error", text: "The session failed after retries. Try again." });
              break loop;
            }
            case "session.status_terminated":
              emit({ kind: "error", text: "Session ended. Start a new session." });
              break loop;
          }
        }
        const s = await anthropic.beta.sessions.retrieve(sessionId).catch(() => null);
        emit({ kind: "done", session_id: sessionId, cost: s?.usage?.list_cost ? `${s.usage.list_cost.amount} ${s.usage.list_cost.currency}` : cost });
      } catch (e) {
        const err = e as { status?: number; message?: string };
        emit({ kind: "error", text: err.status === 404 ? "Session not found. Start a new session." : String(err.message || e) });
        emit({ kind: "done", session_id: sessionId, failed: true });
      } finally {
        controller.close();
      }
    },
  });
}

export type SkillInfo = { id: string; name: string; description: string };
let skillCache: { at: number; skills: SkillInfo[] } | null = null;

/** The custom skills attached to the agent, with name and description. */
export async function listAgentSkills(env: Env): Promise<SkillInfo[]> {
  if (skillCache && Date.now() - skillCache.at < 600_000) return skillCache.skills;
  const anthropic = client(env);
  const agent = await anthropic.beta.agents.retrieve(env.AGENT_ID);
  const refs = (agent.skills ?? []).filter((s) => s.type === "custom");
  const skills = await Promise.all(refs.map(async (ref): Promise<SkillInfo> => {
    try {
      const sk = await anthropic.skills.retrieve(ref.skill_id);
      const v = await anthropic.skills.versions.retrieve(sk.latest_version_id, { skill_id: ref.skill_id });
      return { id: ref.skill_id, name: v.name || sk.display_name, description: v.description };
    } catch {
      return { id: ref.skill_id, name: ref.skill_id, description: "" };
    }
  }));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  skillCache = { at: Date.now(), skills };
  return skills;
}
