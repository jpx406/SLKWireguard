# Trading Desk Cloud: deploying to https://trading-desk.nesrapp.com

This is the same day-trading app as `../trading_desk`, but it runs entirely on Cloudflare and Anthropic, so your PC does not need to be on.

| Piece | Where it runs |
|---|---|
| Web app (chart, watchlist, risk, journal, guide) | Cloudflare Worker + static assets |
| Journal, settings, your `trader/config.json`, GUIDE.md | Cloudflare D1 database |
| Login | The app's own login: admin password as an encrypted Worker secret, extra users with hashed passwords in D1 |
| Paper trading | Simulated accounts per user; order engine runs every minute (Cron Trigger) |
| Copilot and your 15 `trader-*` skills | **Claude Managed Agents**: Claude runs your SKILL.md files and Python tools in an Anthropic cloud sandbox |
| Quotes, candles, paper fills | **Alpaca** real-time (free IEX feed, or full SIP feed on Alpaca's paid plan), with Yahoo Finance (delayed) as automatic fallback |

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

## Real-time market data (Alpaca)

Out of the box the app uses Yahoo Finance, which is delayed. For real-time data:

1. Create a free account at **alpaca.markets**. In the dashboard, generate an API key. Paper-trading keys work for market data.
2. Store the key as two Cloudflare secrets. Never put them in a file:
   ```powershell
   .\node_modules\.bin\wrangler.cmd secret put ALPACA_KEY_ID
   .\node_modules\.bin\wrangler.cmd secret put ALPACA_SECRET_KEY
   ```
3. In ⚙ Settings → **Market data source**, leave it on **Auto** and click **Test Alpaca connection**.

| Source | Cost | Notes |
|---|---|---|
| **Alpaca IEX** (Auto picks this once keys are set) | free | Real-time trades from the IEX exchange (~2–3% of US volume). Prices are accurate on liquid stocks, but bar volume and high/low are partial, and coverage is thin on small caps |
| **Alpaca SIP** | Alpaca "Algo Trader Plus" (~$99/mo) | Real-time feed from all US exchanges. If your plan doesn't include it, the app falls back to IEX and says so |
| **Yahoo Finance** | free | Delayed and unofficial; no key needed |

* **What uses it:** the chart, watchlist quotes and the paper-trading engine. Market orders and P&L use Alpaca's latest trade price.
* **Index and futures symbols** (^VIX, ES=F) always come from Yahoo.
* **If Alpaca has a problem**, the app falls back to Yahoo automatically, and the footer under the watchlist shows which feed is live and any error.
* **Claude's skills** inside the sandbox keep using their own data sources.

## Paper trading (simulated, no real money)

Open the **Paper trading** tab in the center area. Every user has their own simulated account, starting with **$10,000**. You can change the amount under ⚙ Settings & auto-trade → Reset.

**Placing orders:**
* Click **Buy ▶ / Short ▶** on any recommendation (Market board or Briefs), **📝 Paper buy** in a pick's details, **Paper trade** in the chart toolbar, or **paper-trade this plan** in the Risk tab.
* The order ticket is pre-filled from the recommendation: entry, stop-loss, take-profit (T1) and size.
* **Order types:** Market (fills now), Limit (buy at or below the price, short at or above), or Stop trigger (a breakout entry that buys when the price rises through the level).
* **Sizing:** by shares, by dollars, or by risk % of equity. The ticket shows the cost, the maximum loss at the stop, the gain at the target, and R:R.

**How orders fill:**
* A server engine runs **every minute**, even with your browser closed. It checks working orders and open positions against 1-minute price bars.
* **The entry price is the most you pay on a buy** (the least you accept on a short).
  * If the stock is already at or below the entry, the buy fills immediately at the market price. For example, with the entry at 38.60 and the stock at 37.55, it buys now at about 37.55.
  * If the stock is above the entry, the order waits until the price comes back down to it, then fills at the entry or better.
  * Shorts work the same way in reverse.
  * Recommendations, auto-trade, the order ticket and the chart replay all follow this rule.
* Auto-trade skips a pick when the price is already through its stop-loss or past its take-profit. The order ticket refuses those cases with a message.
* A position closes automatically when its stop-loss or take-profit is touched. If one bar touches both, it counts as the stop (the conservative assumption).
* **Extended hours are automatic:** orders trade on the official schedule, with no setting to turn on.
  * Pre-market runs 07:00–09:30 New York, the regular session 09:30–16:00, and after-hours 16:00–20:00.
  * On NYSE early-close days the regular session ends at 13:00 and after-hours at 17:00. Holidays are closed.
  * Stops and targets are watched in every session.
  * The Paper trading tab shows which session is live.
* **While the market is closed** (20:00–07:00, weekends and holidays), a new order belongs to the next session. A market order, or a Sell now, executes at the first trade of the next pre-market.
* Unfilled entry orders expire when after-hours ends (20:00 New York).

**Exit mode (per trade):**
* **Close at end of day:** the position closes 5 minutes before the regular close (15:55 New York) if the stop or target hasn't hit first. A trade opened after the bell, in after-hours, closes 5 minutes before after-hours ends (19:55).
* **Hold until stop-loss or take-profit:** the position stays open overnight and across days until one is hit, or until you close it. Overnight gaps fill at the next bar's open, the way a real gap would.

Choose the mode on the order ticket, switch it any time with the **Exit** button on an open position, and set the default for new trades and auto-trades in ⚙ Settings & auto-trade.

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

Fills are simulated on your market data feed (Alpaca real-time, or delayed Yahoo), so real fills, slippage and liquidity will differ.

## Chart ranges and trade-plan view

- The chart opens on **1D** (today's session, 5m bars). The range buttons **1D, 5D, 1M, 3M, 1Y** load more history. Each range only offers the bar sizes that make sense for it: 1m/5m/15m for 1D, 15m/1h for 5D, daily for 1Y. Dotted lines mark session breaks. VWAP resets each session.
- **Select a recommendation** (click a row on the Market board or in a brief) to open its trade chart:
  - a green reward zone and a red risk zone
  - the entry, stop and T1/T2 lines labelled in R
  - markers for when the plan was issued, when it was entered, and when each target or the stop was hit
  - a status box such as "T1 hit, still open: +1.75R now"
  - from that box: **Paper buy** or **open on main chart**
- If you hold the symbol in paper trading, your own fills are marked on the main chart.

## Users

* **Admin:** log in with username **admin** and the `LOGIN_PASSWORD` secret. To change it, run `.\node_modules\.bin\wrangler.cmd secret put LOGIN_PASSWORD`. This logs everyone out.
* **Adding users:** 👤 (top right) → Users → add a username and password (10+ characters). Passwords are stored as salted PBKDF2 hashes, never in plain text.
* **Claude access:** tick **Claude access** only for users who may run scans and Copilot, since those cost money on your Anthropic key. Users without it can still see the briefs and the market board, chart, paper trade and keep a journal.
* **What each user has of their own:** a paper account and a journal. The watchlist, config, filters and autopilot are shared and only the admin can change them.
* **Passwords:** users can change their own password under 👤. The admin can reset a password (which logs that user out) or delete a user.


**Each user has their own paper account:**
* **Account:** cash and starting amount (⚙ Settings & auto-trade → Reset), plus orders, positions, history and daily summary.
* **Watchlist:** each user's own. The admin's watchlist is the one the scans use.
* **Auto-trade settings:** on/off, min score, sizing, risk per trade, take-profit target and default exit.
* **Auto-trade triggers:**
  * which scans trade automatically (for example only "Final pre-open plan")
  * long, short or both
  * minimum reward:risk and minimum stock price
  * the time window for auto entries
  * a maximum number of auto entries per day
  * a daily-loss limit that pauses auto-trading for the rest of the day
  * symbols never to auto-trade

**Viewing other users' accounts (read-only):** Paper trading shows an **All paper accounts** table, which every user can see. It lists equity, total P&L and %, today's P&L, win rate, trades and open positions for each user, best performer first. Click a row, or pick a name in the account selector, to open that user's positions, orders, daily summary and trade history. The account is marked **VIEW ONLY** and has no buttons to buy, sell, cancel or edit, and the server only accepts changes to your own account. **← My account** takes you back.

**Shared and admin-only:** the scans themselves (Autopilot schedule and scan filters), the trader config, the data source and the Claude budget. Scans are run once and shared because they cost money. Each user only chooses which results to trade.

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
