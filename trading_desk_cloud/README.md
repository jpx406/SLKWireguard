# Trading Desk Cloud: deploying to https://trading-desk.nesrapp.com

This is the same day-trading app as `../trading_desk`, but it runs entirely on Cloudflare and Anthropic, so your PC does not need to be on.

| Piece | Where it runs |
|---|---|
| Web app (chart, watchlist, risk, journal, guide) | Cloudflare Worker + static assets |
| Journal, settings, your `trader/config.json`, GUIDE.md | Cloudflare D1 database |
| Login | The app's own login: admin password as an encrypted Worker secret, extra users with hashed passwords in D1 |
| Paper trading | Simulated accounts per user; order engine runs every minute (Cron Trigger) |
| Copilot and your 15 `trader-*` skills | **Claude Managed Agents**: Claude runs your SKILL.md files and Python tools in an Anthropic cloud sandbox |
| Quotes and candles | Yahoo Finance (delayed and unofficial; for context only) |

**It cannot place orders.** No broker is connected anywhere in this stack. The agent's instructions forbid placing orders, and any tool call that would need approval is automatically denied. Place tickets yourself in your broker or in Claude Code.

## What you need

* A Cloudflare account that has `nesrapp.com` added as a zone (it already uses Cloudflare DNS).
* An Anthropic API key from console.anthropic.com → API keys. Copilot usage is billed to it. Each Copilot session has a spend cap, $5 by default, which you can change in Settings.
* Node.js 20 or newer on your PC: `winget install OpenJS.NodeJS.LTS`.
* Your skills installed in `%USERPROFILE%\.claude\skills\trader-*` (they already are).

## Deploy (PowerShell, about 5 minutes)

```powershell
cd <this folder>\trading_desk_cloud
.\deploy.ps1
```

The script takes care of everything in this order:

* installs packages
* logs you in to Cloudflare in your browser
* creates the D1 database
* runs the agent setup: it asks for your Anthropic API key, uploads all 15 skills, creates the cloud sandbox and the agent, and asks you to choose the sandbox network mode (see below)
* deploys the app
* stores your API key as an encrypted Worker secret
* asks you to choose the app password (12 or more characters), stored as an encrypted Worker secret

Then open **https://trading-desk.nesrapp.com**, log in with your password (you stay logged in for 30 days on that device), and:

1. Click ⚙ Settings and paste your `trader\config.json`. Keep `"paper": true`. The skills read this file inside the sandbox at `/workspace/trader/config.json`.
2. In the **Guide** tab, upload `GUIDE.md`.

## Autopilot (automatic scans and recommendations)

The **Briefs** tab is the first tab. On US market days, the Worker runs these scans for you with your trader-* skills:

| Brief | New York | Riyadh (until Nov 1 / after) | Default |
|---|---|---|---|
| **Full market scan (all skills)**: runs every trader-* skill in sequence over the whole market (regime → calendar → movers/volume/sector leaders → news, filings and levels → risk sizing), then merges everything into one ranked, de-duplicated list | 08:15 | 15:15 / 16:15 | on |
| Pre-market scan: regime, calendar, gappers and catalysts, ranked plans | 08:00 | 15:00 / 16:00 | off |
| Final pre-open plan | 09:10 | 16:10 / 17:10 | on |
| Opening range update | 09:50 | 16:50 / 17:50 | on |
| Midday check | 12:30 | 19:30 / 20:30 | off |
| Power hour | 15:00 | 22:00 / 23:00 | off |
| End-of-day review | 16:15 | 23:15 / 00:15 | off |

* **Market board** (center tab, or **▶ Full market scan** to run it now) shows each brief visually:
  * index cards with support and resistance
  * a sector performance chart, market breadth, and today's events with their impact
  * a sortable recommendations table with score, setup, catalyst, pre-market % change, relative volume, entry, stop, targets, R:R and size
  * a detail panel for each row with an intraday chart showing the entry, stop and target lines, a trade ladder, the exit plan and what invalidates the trade
  * a score chart, the "avoid" list, and which skills ran (✓ / ✗)
* **⚙ Scan filters** (next to the scan button) sets the screening rules for the full scan:
  * market cap min/max, price min/max
  * average daily volume, relative volume, pre-market volume
  * gap / pre-market move %, volatility (ATR % of price), short interest, float min/max
  * sectors, exchanges, ETFs on/off, earnings today (include/exclude/only), longs/shorts, max picks, and free-text extra instructions

  Presets: Balanced, Large-cap momentum, Mid-cap movers, Small-cap gappers. Claude gets the filters as hard rules. When the scan finishes, the server checks every pick again and moves any that break a filter to **Avoid** with the reason, so the recommendations always respect your settings. The active filters show as chips at the top of the board. The scheduled 08:15 scan uses the saved filters.
* The full scan gets twice the per-session budget because it runs every skill.
* Copilot answers from the workflow buttons also come back with a picks table.
* Each brief ends with ranked **picks**. Click **chart** to load a pick, or **plan** to fill the Risk tab and draw its entry, stop and targets on the chart.
* **run now** starts any brief immediately. **🔔 notify me** turns on a browser notification when a brief is ready, if the page is open.
* The scans run on Cloudflare's schedule even when your browser is closed. Weekends and NYSE holidays are skipped.
* Every brief is a Claude session capped at your per-session budget. Three briefs a day costs roughly $1–3 per brief in Anthropic usage. Turn off the ones you don't need.

## Paper trading (simulated, no real money)

Open the **Paper trading** tab in the center area. Every user has their own simulated account, starting with **$10,000**. You can change the amount under ⚙ Settings & auto-trade → Reset.

**Placing orders:**
* Click **Buy ▶ / Short ▶** on any recommendation (Market board or Briefs), **📝 Paper buy** in a pick's details, **Paper trade** in the chart toolbar, or **paper-trade this plan** in the Risk tab.
* The order ticket is pre-filled from the recommendation: entry, stop-loss, take-profit (T1) and size.
* **Order types:** Market (fills now), Limit (buy at or below the price, short at or above), or Stop trigger (a breakout entry that buys when the price rises through the level).
* **Sizing:** by shares, by dollars, or by risk % of equity. The ticket shows the cost, the maximum loss at the stop, the gain at the target, and R:R.

**How orders fill:**
* A server engine runs **every minute**, even with your browser closed. It checks working orders and open positions against 1-minute price bars.
* A limit order fills at its price or better. A stop trigger fills at its price or worse.
* A position closes automatically when its stop-loss or take-profit is touched. If one bar touches both, it counts as the stop (the conservative assumption).
* Unfilled day orders expire at 16:00 New York time. Optionally, every open position is closed at 15:55.

**Managing positions:**
* **Sell now / Cover now** closes at market at any moment.
* **edit** changes the stop or target. **cancel** removes a working order.

**Records:**
* Account cards: equity, cash, invested, today's P&L, total P&L, win rate.
* An equity-by-day chart and a daily gain/loss chart.
* Tables for open positions, working and recent orders, a **daily summary** (trades, wins, losses, win %, P&L, best, worst, equity) and the full trade history.

**Auto-trade (optional, in Settings):**
* When a scan finishes, orders are placed automatically for recommendations above a minimum score.
* Settings include the maximum number of open trades, how long entry orders stay valid, sizing (risk % of equity, the recommended shares, or a fixed $ amount), the maximum % of equity per position, T1 or T2 as the take-profit, and commission.
* Entries above the market become breakout stop orders, and the rest become limits.
* Each scan is auto-traded only once.

Fills are simulated on delayed Yahoo Finance data, so real fills, slippage and liquidity will differ.

## Users

* **Admin:** log in with username **admin** and the `LOGIN_PASSWORD` secret. To change it, run `.\node_modules\.bin\wrangler.cmd secret put LOGIN_PASSWORD`. This logs everyone out.
* **Adding users:** 👤 (top right) → Users → add a username and password (10+ characters). Passwords are stored as salted PBKDF2 hashes, never in plain text.
* **Claude access:** tick **Claude access** only for users who may run scans and Copilot, since those cost money on your Anthropic key. Users without it can still see the briefs and the market board, chart, paper trade and keep a journal.
* **What each user has of their own:** a paper account and a journal. The watchlist, config, filters and autopilot are shared and only the admin can change them.
* **Passwords:** users can change their own password under 👤. The admin can reset a password (which logs that user out) or delete a user.

## Troubleshooting

If something fails, a red **Problem:** bar at the top of the app says what went wrong. You can also open `https://trading-desk.nesrapp.com/api/status` in a new tab.

| Message | Fix |
|---|---|
| `No login is configured` | Set the password: `.\node_modules\.bin\wrangler.cmd secret put LOGIN_PASSWORD` |
| `Too many wrong passwords` | 5 wrong tries from your network locks login for 15 minutes. Wait it out |
| Forgot the password | Set a new one with the command above. This also logs out every device |
| `Agent not configured` | Run `node setup/setup-agent.mjs`, then redeploy |
| Claude dot is red | The `ANTHROPIC_API_KEY` secret is missing. Run `.\node_modules\.bin\wrangler.cmd secret put ANTHROPIC_API_KEY` |

## Updating

* **You changed a skill:** run `node setup/setup-agent.mjs`. It uploads a new version of each skill, and new Copilot sessions use it.
* **You changed the app:** run `npx wrangler deploy`.
* **You want different workflow buttons:** edit `public/workflows.json`, then run `npx wrangler deploy`.

## Sandbox network mode (asked during setup)

* **limited** (recommended): the sandbox, web search and web fetch can only reach SEC, exchange, finance-news and economic-data sites, plus every host that appears in your skill files. It can also install pip packages listed in your skills' `requirements.txt`. If a skill needs another site, add it to `BASE_HOSTS` in `setup/setup-agent.mjs` and re-run the script.
* **unrestricted**: full internet access, so every data source works. The downside: a web page the agent reads could try to steer it into sending sandbox contents somewhere. The only personal data in the sandbox is your config.json.

## Costs

* **Cloudflare:** the free plan covers this (Workers, D1 and Cron Triggers).
* **Anthropic:** pay as you go for Claude Opus 5.5 tokens plus sandbox time. Every reply shows the session's cost so far. Each session also has a link to its full trace in the Claude Console.

## Security notes

* Every `/api` request needs a valid session. You get one by entering the password. The session cookie is HMAC-signed, HttpOnly, Secure and SameSite=Strict, and expires after 30 days. The signing key comes from the password, so changing the password ends every session. Login is rate-limited to 5 wrong tries per IP address and 30 overall in any 15 minutes. If no password (and no Cloudflare Access) is configured, the API refuses to serve.
* Cloudflare Access is still supported instead of the password. Leave `LOGIN_PASSWORD` unset and fill in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (`setup/setup-access.ps1` can create the Access app).
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
