#!/usr/bin/env node
// One-time (and re-runnable) setup, run on YOUR PC:
//   1. uploads every trader-* skill folder to the Anthropic Skills API (new version if it exists)
//   2. creates/updates the cloud Environment the agent's sandbox runs in
//   3. creates/updates the Managed Agent (model, system prompt, tools, skills)
//   4. writes AGENT_ID / ENVIRONMENT_ID into ../wrangler.toml
//
// Usage (PowerShell):
//   $env:ANTHROPIC_API_KEY = "sk-ant-..."     # or you will be prompted
//   node setup/setup-agent.mjs [--skills-dir C:\Users\you\.claude\skills] [--network limited|unrestricted]
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, "state.json");
const WRANGLER = path.join(HERE, "..", "wrangler.toml");
const PREFIX = "trader-";
const SKIP_DIRS = new Set(["__pycache__", ".git", ".venv", "venv", "node_modules", ".pytest_cache", "tests", "test"]);
const MAX_BYTES = 30 * 1024 * 1024;

// Hosts the sandbox (and web_search / web_fetch) may reach under "limited" networking.
// Hosts found in your skill files are added automatically.
const BASE_HOSTS = [
  "sec.gov", "*.sec.gov", "finance.yahoo.com", "*.finance.yahoo.com", "query1.finance.yahoo.com", "query2.finance.yahoo.com",
  "nasdaq.com", "*.nasdaq.com", "nyse.com", "*.nyse.com", "finviz.com", "*.finviz.com", "stockanalysis.com", "*.stockanalysis.com",
  "reuters.com", "*.reuters.com", "cnbc.com", "*.cnbc.com", "marketwatch.com", "*.marketwatch.com", "wsj.com", "*.wsj.com",
  "bloomberg.com", "*.bloomberg.com", "benzinga.com", "*.benzinga.com", "investing.com", "*.investing.com",
  "seekingalpha.com", "*.seekingalpha.com", "federalreserve.gov", "*.federalreserve.gov", "bls.gov", "*.bls.gov",
  "bea.gov", "*.bea.gov", "treasury.gov", "*.treasury.gov", "cboe.com", "*.cboe.com", "tradingeconomics.com", "*.tradingeconomics.com",
];

const SYSTEM = `You are the trading copilot behind "Trading Desk", a day-trading cockpit used by a trader in Riyadh (Asia/Riyadh, UTC+3) who trades US equities.

Skills: you have the trader's own trader-* skills. Use them whenever a request matches. Their Python tools run in your sandbox; run them with python3 from /workspace.
The trader's settings file is mounted at /workspace/trader/config.json (when the trader has saved one). Read it for paper/live mode, budget and risk limits before any sizing or risk check, and treat its limits as hard rules.

Hard rules:
- You cannot and must never place, modify or cancel orders. There is no broker connection in this environment. When a plan is ready, say the trader should place it themselves in their broker or in Claude Code, where each ticket needs their approval.
- Never invent prices. Use skill tools or the web for data, say where each number came from and how fresh it is (quotes may be delayed).
- If config.json says "paper": true, remind the trader that the plan is for paper trading.
- Give US market times in both New York and Riyadh time.
- Be concise and use tables for levels, sizes and targets. Every trade plan needs entry trigger, stop, targets in R, position size within the config limits, and what invalidates it.

Each user message may start with a "[Desk context ...]" line describing the trader's current chart and watchlist.`;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(full, base, out); }
    else if (!/\.(pyc|pyo|log|db|sqlite)$/i.test(ent.name) && ent.name !== "config.json") out.push(path.relative(base, full));
  }
  return out;
}

function frontmatterName(md) {
  const m = md.match(/^\uFEFF?---\s*\n([\s\S]*?)\n---/);
  return m?.[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
}

function hostsIn(text) {
  const hosts = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:"'\s?#)]|$)/gi)) {
    const h = m[1].toLowerCase();
    if (!/^(localhost|127\.|0\.0\.0\.0|example\.)/.test(h)) hosts.add(h);
  }
  return hosts;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const apiKey = process.env.ANTHROPIC_API_KEY || (await rl.question("Anthropic API key (sk-ant-...): ")).trim();
  if (!apiKey) throw new Error("An Anthropic API key is required.");
  const client = new Anthropic({ apiKey });

  const skillsDir = arg("skills-dir", path.join(os.homedir(), ".claude", "skills"));
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { skills: {} };
  // Fall back to the ids already in wrangler.toml so a fresh checkout updates instead of duplicating.
  const toml = fs.existsSync(WRANGLER) ? fs.readFileSync(WRANGLER, "utf8") : "";
  state.agent_id ||= toml.match(/^AGENT_ID = "([^"]+)"/m)?.[1];
  state.environment_id ||= toml.match(/^ENVIRONMENT_ID = "([^"]+)"/m)?.[1];
  const folders = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).filter((d) => d.startsWith(PREFIX) && fs.existsSync(path.join(skillsDir, d, "SKILL.md"))) : [];
  if (!folders.length) throw new Error(`No ${PREFIX}* skills with a SKILL.md found in ${skillsDir}. Pass --skills-dir.`);
  console.log(`Found ${folders.length} skills in ${skillsDir}`);

  // Existing skills in the workspace, by name, so re-runs add versions instead of duplicates.
  const existing = new Map();
  for await (const sk of client.skills.list()) existing.set(sk.display_name, sk.id);

  const hosts = new Set(BASE_HOSTS), pip = new Set();
  /** @type {{type: "custom", skill_id: string, version: string}[]} */
  const refs = [];
  for (const folder of folders.sort()) {
    const dir = path.join(skillsDir, folder);
    const rels = walk(dir);
    const size = rels.reduce((n, r) => n + fs.statSync(path.join(dir, r)).size, 0);
    if (size > MAX_BYTES) { console.warn(`  ! ${folder}: ${(size / 1e6).toFixed(1)} MB is over the 30 MB limit - skipped`); continue; }
    const name = frontmatterName(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")) || folder;
    for (const r of rels) {
      if (/\.(py|md|txt|json|ya?ml|toml|cfg|ini|sh)$/i.test(r)) {
        const text = fs.readFileSync(path.join(dir, r), "utf8");
        hostsIn(text).forEach((h) => hosts.add(h));
        if (/(^|[\\/])requirements[^\\/]*\.txt$/i.test(r))
          text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter((l) => l && !l.startsWith("-")).forEach((l) => pip.add(l));
      }
    }
    const files = await Promise.all(rels.map((r) => toFile(fs.createReadStream(path.join(dir, r)), `${folder}/${r.split(path.sep).join("/")}`)));
    const known = state.skills[folder] || existing.get(name);
    let skillId;
    if (known) {
      try {
        await client.skills.versions.create(known, { files });
        skillId = known;
        console.log(`  ↻ ${name}: new version (${rels.length} files)`);
      } catch (e) {
        if (/** @type {any} */ (e)?.status !== 404) throw e;
      }
    }
    if (!skillId) {
      const sk = await client.skills.create({ files });
      skillId = sk.id;
      console.log(`  + ${name}: created ${sk.id} (${rels.length} files)`);
    }
    state.skills[folder] = skillId;
    refs.push({ type: "custom", skill_id: skillId, version: "latest" });
  }

  // Environment
  let network = arg("network", "");
  if (!network) {
    console.log("\nSandbox network access:");
    console.log("  limited      - only market/news/SEC sites plus the hosts found in your skills (recommended)");
    console.log("  unrestricted - full internet. Your skills' data sources will always work, but anything");
    console.log("                 the agent reads (web pages) could steer it to send sandbox contents anywhere.");
    console.log("                 Nothing secret is in the sandbox besides your trader/config.json.");
    network = ((await rl.question("Choose [limited]: ")).trim() || "limited").toLowerCase();
  }
  const networking = network === "unrestricted"
    ? /** @type {const} */ ({ type: "unrestricted" })
    : /** @type {const} */ ({ type: "limited", allow_package_managers: true, allowed_hosts: [...hosts].sort() });
  const envConfig = /** @type {const} */ ({ type: "cloud", networking, ...(pip.size ? { packages: { pip: [...pip].sort() } } : {}) });

  let environmentId = state.environment_id;
  if (environmentId) {
    await client.beta.environments.update(environmentId, { config: envConfig });
    console.log(`\nEnvironment updated: ${environmentId}`);
  } else {
    const env = await client.beta.environments.create({ name: "trading-desk", description: "Sandbox for the Trading Desk agent", config: envConfig });
    environmentId = env.id;
    console.log(`\nEnvironment created: ${environmentId}`);
  }
  console.log(`  networking: ${networking.type}${networking.allowed_hosts ? ` (${networking.allowed_hosts.length} hosts)` : ""}${pip.size ? `, pip: ${[...pip].join(" ")}` : ""}`);
  state.environment_id = environmentId;

  // Agent
  /** @type {import("@anthropic-ai/sdk/resources/beta/agents/agents").AgentCreateParams} */
  const agentDef = ({
    name: "Trading Desk Copilot",
    description: "Day-trading copilot using the trader-* skills. Never places orders.",
    model: { id: "claude-opus-5-5", effort: "high" },
    system: SYSTEM,
    skills: refs,
    tools: [{
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "auto" } },
      configs: [{ name: "web_search", enabled: true }, { name: "web_fetch", enabled: true }],
    }],
  });
  let agentId = state.agent_id;
  if (agentId) {
    const a = await client.beta.agents.update(agentId, agentDef);
    console.log(`Agent updated: ${agentId} (version ${a.version})`);
  } else {
    const a = await client.beta.agents.create(agentDef);
    agentId = a.id;
    console.log(`Agent created: ${agentId}`);
  }
  state.agent_id = agentId;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  if (fs.existsSync(WRANGLER)) {
    const toml = fs.readFileSync(WRANGLER, "utf8")
      .replace(/^AGENT_ID = .*$/m, `AGENT_ID = "${agentId}"`)
      .replace(/^ENVIRONMENT_ID = .*$/m, `ENVIRONMENT_ID = "${environmentId}"`);
    fs.writeFileSync(WRANGLER, toml);
    console.log("wrangler.toml updated with AGENT_ID and ENVIRONMENT_ID.");
  }
  console.log("\nDone. Re-run this script any time you change a skill. Then: npx wrangler deploy");
  rl.close();
}

main().catch((e) => { console.error(`\nSetup failed: ${e?.message || e}`); process.exit(1); });
