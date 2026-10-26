# Trading Desk Cloud: deploying to https://trading-desk.nesrapp.com

This is the same day-trading app as `../trading_desk`, but it runs entirely on Cloudflare and Anthropic, so your PC does not need to be on.

| Piece | Where it runs |
|---|---|
| Web app (chart, watchlist, risk, journal, guide) | Cloudflare Worker + static assets |
| Journal, settings, your `trader/config.json`, GUIDE.md | Cloudflare D1 database |
| Login | Cloudflare Access (only your email gets in) |
| Copilot and your 15 `trader-*` skills | **Claude Managed Agents**: Claude runs your SKILL.md files and Python tools in an Anthropic cloud sandbox |
| Quotes and candles | Yahoo Finance (delayed and unofficial; for context only) |

**It cannot place orders.** No broker is connected anywhere in this stack. The agent's instructions forbid placing orders, and any tool call that would need approval is automatically denied. Place tickets yourself in your broker or in Claude Code.

## What you need

* A Cloudflare account that has `nesrapp.com` added as a zone (it already uses Cloudflare DNS).
* An Anthropic API key from console.anthropic.com → API keys. Copilot usage is billed to it. Each Copilot session has a spend cap, $5 by default, which you can change in Settings.
* Node.js 20 or newer on your PC: `winget install OpenJS.NodeJS.LTS`.
* Your skills installed in `%USERPROFILE%\.claude\skills\trader-*` (they already are).

## Step 1: Turn on the login (Cloudflare dashboard, about 5 minutes)

1. Go to dash.cloudflare.com → **Zero Trust**. If asked, pick a team name such as `nesr` and choose the **Free** plan. Your team domain becomes `nesr.cloudflareaccess.com`.
2. Open **Access → Applications → Add an application → Self-hosted**.
   * Application name: `Trading Desk`
   * Public hostname: subdomain `trading-desk`, domain `nesrapp.com`
   * Add a policy named `Me`. Set **Action** to Allow and **Include** to *Emails*, then enter `juanp97g@gmail.com` (and any other email you want to let in).
   * Login method: **One-time PIN** is enough.
3. Save the application, open it again, and copy the **Application Audience (AUD) Tag** from its Overview or Basic information section.

## Step 2: Deploy (PowerShell, about 5 minutes)

```powershell
cd <this folder>\trading_desk_cloud
.\deploy.ps1
```

The script takes care of everything in this order:

* installs packages
* logs you in to Cloudflare in your browser
* creates the D1 database
* runs the agent setup: it asks for your Anthropic API key, uploads all 15 skills, creates the cloud sandbox and the agent, and asks you to choose the sandbox network mode (see below)
* asks for the team domain and AUD tag from Step 1
* deploys the app
* stores your API key as an encrypted Worker secret

Then open **https://trading-desk.nesrapp.com**, log in with the emailed code, and:

1. Click ⚙ Settings and paste your `trader\config.json`. Keep `"paper": true`. The skills read this file inside the sandbox at `/workspace/trader/config.json`.
2. In the **Guide** tab, upload `GUIDE.md`.

## Updating

* **You changed a skill:** run `node setup/setup-agent.mjs`. It uploads a new version of each skill, and new Copilot sessions use it.
* **You changed the app:** run `npx wrangler deploy`.
* **You want different workflow buttons:** edit `public/workflows.json`, then run `npx wrangler deploy`.

## Sandbox network mode (asked during setup)

* **limited** (recommended): the sandbox, web search and web fetch can only reach SEC, exchange, finance-news and economic-data sites, plus every host that appears in your skill files. It can also install pip packages listed in your skills' `requirements.txt`. If a skill needs another site, add it to `BASE_HOSTS` in `setup/setup-agent.mjs` and re-run the script.
* **unrestricted**: full internet access, so every data source works. The downside: a web page the agent reads could try to steer it into sending sandbox contents somewhere. The only personal data in the sandbox is your config.json.

## Costs

* **Cloudflare:** the free plan covers this (Workers, D1 and Access for up to 50 users).
* **Anthropic:** pay as you go for Claude Opus 5.5 tokens plus sandbox time. Every reply shows the session's cost so far. Each session also has a link to its full trace in the Claude Console.

## Security notes

* The `/api` routes verify the Cloudflare Access JWT signature, audience, issuer and expiry on every request, and they refuse to serve if Access isn't configured.
* `workers.dev` and preview URLs are disabled, so the app is only reachable at trading-desk.nesrapp.com.
* The Anthropic API key lives only as a Worker secret. It is never sent to the browser or placed in the sandbox.

## Local development

```powershell
# .dev.vars (not committed):
#   DEV_NO_AUTH="1"
#   ANTHROPIC_API_KEY="sk-ant-..."
npx wrangler dev
npm run typecheck
```
