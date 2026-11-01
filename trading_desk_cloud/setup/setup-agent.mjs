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
  // Deep Analysis (TradingAgents): its data vendors, the release wheel, and Claude itself (called from inside the sandbox).
  "api.anthropic.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
  "data.sec.gov", "efts.sec.gov", "api.stlouisfed.org", "api.stocktwits.com", "gamma-api.polymarket.com",
  // (reddit.com blocks Anthropic's crawler and cannot be allowed; TradingAgents' sentiment analyst then uses StockTwits and news.)
];
// Python packages installed in the sandbox besides the skills' own requirements (plain names only: the API
// refuses URL specs, so the TradingAgents wheel is installed by the deep-analysis prompt at the start of a run).
// ta-patterns: 300 candlestick/chart pattern detectors with no look-ahead, for the swing scan.
// ta-lib: the reference technical-analysis library (150+ indicators, 61 candlestick patterns, C speed);
//   its 0.8 wheels bundle the C library, so it installs without a compiler.
const EXTRA_PIP = ["ta-patterns>=1.2.1", "ta-lib>=0.8.3"];

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
  EXTRA_PIP.forEach((p) => pip.add(p));
  const envConfigWith = (pipList) => /** @type {const} */ ({ type: "cloud", networking, ...(pipList.length ? { packages: { pip: pipList } } : {}) });
  let envConfig = envConfigWith([...pip].sort());

  let environmentId = state.environment_id;
  const applyEnv = async (cfg) => {
    if (environmentId) { await client.beta.environments.update(environmentId, { config: cfg }); console.log(`\nEnvironment updated: ${environmentId}`); }
    else { const env = await client.beta.environments.create({ name: "trading-desk", description: "Sandbox for the Trading Desk agent", config: cfg }); environmentId = env.id; console.log(`\nEnvironment created: ${environmentId}`); }
  };
  // The API refuses some entries (a package spec it does not accept, a host that blocks Anthropic's crawler):
  // drop what it names and try again, so one bad entry does not stop the setup.
  for (let attempt = 0; ; attempt++) {
    try { await applyEnv(envConfig); break; } catch (e) {
      const msg = String(/** @type {any} */ (e)?.message || e);
      const badPkg = msg.match(/Invalid pip package name: '([^']+)'/)?.[1];
      const badHost = msg.match(/`allowed_hosts` entry "([^"]+)"/)?.[1];
      if (attempt > 20 || (!badPkg && !badHost)) throw e;
      if (badPkg) { pip.delete(badPkg); console.warn(`  ! package refused, skipped: ${badPkg}`); }
      if (badHost) { hosts.delete(badHost); console.warn(`  ! host refused (blocks Anthropic), skipped: ${badHost}`); }
      const nw = networking.type === "limited" ? { ...networking, allowed_hosts: [...hosts].sort() } : networking;
      envConfig = /** @type {const} */ ({ type: "cloud", networking: nw, ...(pip.size ? { packages: { pip: [...pip].sort() } } : {}) });
    }
  }
  const pipShown = envConfig.packages?.pip ?? [];
  console.log(`  networking: ${networking.type}${networking.allowed_hosts ? ` (${networking.allowed_hosts.length} hosts)` : ""}${pipShown.length ? `, pip: ${pipShown.join(" ")}` : ""}`);
  state.environment_id = environmentId;

  // Vault: the API key the sandbox uses when TradingAgents calls Claude (Deep Analysis). The value is substituted
  // into requests to api.anthropic.com at the network edge; the sandbox itself only sees a placeholder.
  const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  let vaultId = state.vault_id;
  if (!vaultId) {
    const v = await client.beta.vaults.create({ display_name: "trading-desk" });
    vaultId = v.id; state.vault_id = vaultId; saveState(); // saved at once, so a later failure does not create another vault
    console.log(`Vault created: ${vaultId}`);
  }
  // The credential's fields go under "auth" (as the API documents it); injection_location is left out, which
  // enables both header and body substitution.
  const auth = /** @type {const} */ ({
    type: "environment_variable", secret_name: "ANTHROPIC_API_KEY", secret_value: apiKey,
    networking: { type: "limited", allowed_hosts: ["api.anthropic.com"] },
  });
  if (state.credential_id) {
    try { await client.beta.vaults.credentials.update(state.credential_id, { vault_id: vaultId, auth: { type: "environment_variable", secret_value: apiKey } }); console.log("Vault credential ANTHROPIC_API_KEY updated"); }
    catch (e) { if (/** @type {any} */ (e)?.status !== 404) throw e; state.credential_id = null; }
  }
  if (!state.credential_id) {
    const c = await client.beta.vaults.credentials.create(vaultId, { display_name: "Anthropic API key for TradingAgents", auth });
    state.credential_id = c.id; saveState();
    console.log(`Vault credential ANTHROPIC_API_KEY created (${c.id}) for api.anthropic.com`);
  }

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
      .replace(/^ENVIRONMENT_ID = .*$/m, `ENVIRONMENT_ID = "${environmentId}"`)
      .replace(/^VAULT_ID = .*$/m, `VAULT_ID = "${vaultId}"`);
    fs.writeFileSync(WRANGLER, toml);
    console.log("wrangler.toml updated with AGENT_ID, ENVIRONMENT_ID and VAULT_ID.");
  }
  console.log("\nDone. Re-run this script any time you change a skill. Then: npx wrangler deploy");
  rl.close();
}

main().catch((e) => { console.error(`\nSetup failed: ${e?.message || e}`); process.exit(1); });
