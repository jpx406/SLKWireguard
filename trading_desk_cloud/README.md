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

## Layout

**One way to move around, adapted to the screen:**

| Screen | Layout |
|---|---|
| Mac and wide windows | **Sidebar** (Chart, Market Board, Paper Trading, Journal, Help & Skills, then the watchlist), the selected section in the middle, and an **inspector** on the right with Briefs, Copilot or Position Size |
| iPad and smaller windows | Sidebar with every section; one section shows at a time |
| iPhone | **Tab bar** at the bottom: Watchlist, Chart, Board, Paper and More. More holds Briefs, Copilot, Position Size, Journal, Help and Preferences. Tapping a watchlist symbol opens its chart. |

**Where things moved:**
* **Tool Output:** the Claude console is now **Tool Output** at the bottom of Copilot.
* **Help & Skills:** Skills and the Guide open as a **Help & Skills** sheet.
* **Preferences (gear button, every user):** appearance (*Match this device*, Dark or Light, remembered on each device), your watchlist and brief notifications.
* **Admin Settings:** data source, budgets, Claude cost controls and the trading rules are under **Admin Settings…** inside Preferences, and also behind the trading-rules badge. Admins only.

## iPhone and iPad

* **Install it like an app:** open the desk in Safari, tap Share, then **Add to Home Screen**. It opens full screen with its own icon.
* **Built for touch:** on touch screens, buttons are 44 pt.
* **Text size follows the device:** on iPhone and iPad, body text is 15 pt and follows your Text Size setting (Dynamic Type). **Preferences → Text size** makes it one step smaller (13 pt) or larger (17 pt).
* **Sizes on a Mac:** body text is 13 pt and controls are at least 28 pt, both following Apple's guidelines.

## Deep Analysis (TradingAgents)

[TradingAgents](https://github.com/TauricResearch/TradingAgents) (Tauric Research, MIT) is a multi-agent analysis of one ticker: four analysts (market, news, fundamentals, sentiment), a bull-vs-bear debate, a trader, a risk desk and a portfolio manager, ending in a 5-tier rating (Buy / Overweight / Hold / Underweight / Sell). It is a slower, multi-day second opinion; your trader-* skills stay the intraday desk.

* **Where it runs:** inside the same Claude sandbox as your skills. `setup/setup-agent.mjs` installs `ta-patterns`, allows the TradingAgents data sources (Yahoo, SEC EDGAR, StockTwits, FRED, Polymarket; Reddit blocks Anthropic and is skipped) and the GitHub release the `tradingagents` 0.7.1 wheel is installed from at the start of each run and stores your Anthropic key in a Managed Agents **vault** so TradingAgents can call Claude from the sandbox. The key is substituted into requests to api.anthropic.com at the network edge; the sandbox never sees it. Re-run the setup script after updating: it prints the `VAULT_ID` into wrangler.toml, then deploy.
* **Menu:** **Deep Analysis** in the sidebar (More › Deep Analysis on iPhone). Type a symbol and click *Run Deep Analysis*, or click **Deep Analysis** on a recommendation in the Market Board.
* **Result:** rating, confidence, summary, bull and bear case, the trader's entry / stop / targets / horizon, risks, and the full report with every agent's section. **Paper Buy** on a run prefills the ticket with the trader's plan and holds it (not end-of-day).
* **Badges:** a rating from the last 5 days shows next to the symbol in the Market Board and briefs, so the intraday pick and the deep view sit side by side.
* **Autopilot:** after ANY finished brief (a scheduled slot or Run Now), every pick scoring at least Admin Settings › *Deep Analysis score threshold* (default 65) gets a Deep Analysis automatically, best score first, at most *per brief* runs (default 5), once per symbol per day, and only while the daily cap allows. Set the threshold to 0 to turn it off.
* **After a run:** the rating badge appears on the board and in the watchlist, the trader's entry/stop/targets become the chart's plan (plan monitor, chart autopilot) when there is no fresher recommendation, and *Paper Buy* on the Deep Analysis page places a held trade.
* **Cost:** one run is about 15 model calls (5-15 minutes). It gets three times the normal session budget (at least $3) and counts toward the daily cap. Admin Settings › *Model and effort per task* has a *Deep Analysis* row (the quick-think analysts can run on Sonnet 5.5 to halve the cost).
* **Combined with the desk:** each run gets your paper account (cash and open positions) as TradingAgents' portfolio, so its trader and risk desk size against what you actually hold; and the decision log it writes is kept by the desk and given back to the next run, so past calls get settled against real prices and their lessons feed later analyses.
* **Not included:** TradingAgents' backtests (run those from its own CLI if you want them).

## Monitor and chart windows

* **Monitor** (sidebar): a grid of live charts (2 × 2 up to 4 × 3) of your watchlist or any symbols you type, each with VWAP/EMAs and candle signals, and one combined signal feed. Click a symbol name to open it on the main chart.
* Each tile also shows the plan monitor line (entry / expected exit) for its symbol.
* **Chart windows:** **Window** on the chart toolbar, the window icon on a watchlist row, or *Open as Windows* in Monitor opens `chart.html?symbol=…` in its own browser window, so you can tile several charts across your screens. Each window has its own range, bar size, indicators, a **Signals** switch and a **Notify** switch, shows your paper fills, and *Paper Trade* sends the symbol back to the desk. Browsers allow one pop-up per click; for *Open as Windows* allow pop-ups for this site when asked.

## Candle signals

* **Switch:** *Signals* on the main chart (remembered on this device), on every Monitor tile, and in every chart window.
* **Models** (the *Models* button next to Signals, remembered on this device):
  * *Classic patterns*: the open-source `candlestick` library (MIT, 18 patterns / 29 variants: hammers, engulfing, kickers, piercing line, dark cloud, morning and evening stars, three white soldiers, three black crows, tweezers, marubozu…) with trend context.
  * *Extended patterns*: `candles.js`, TA-Lib CDL* rules written for the browser and the Worker: bullish/bearish belt hold, dragonfly and gravestone doji, abandoned baby, three inside up/down, three outside up/down (merged into the engulfing it confirms, shown as ✓), rising and falling three methods, inside-bar breakouts.
  * *Trend gate* (MotiveWave rule): a reversal must fit the preceding trend. *Volume confirmation*: a 1.3× volume spike adds a star.
  * **Strength** 1-3 stars (★ = trend fits, ★★ = trend fits and volume spike): bigger arrows and stars in the feed. Two-star signals are the ones the chart autopilot acts on.
* **What it detects:** both models run on completed bars with trend context. A bullish reversal is only shown after a downtrend or sideways tape and a bearish one only after an uptrend or sideways (never against the trend), the same pattern is not re-marked on a run of same-colour candles, and the *fit %* in the feed says how well the preceding trend matches the pattern. Harami and doji are too frequent to be useful and are left out. On random test data these rules cut the signals by about two thirds.
* **In the sandbox:** TA-Lib (61 CDL* functions, -100..100 strength) and ta-patterns are installed for the swing scan and Deep Analysis; the chart signals stay in the browser so they are instant and free.
* **No repainting:** only completed bars are scanned, so a signal never appears and then vanishes while a bar is still forming.
* **On the chart:** green arrows below bars for bullish patterns, red arrows above for bearish; the last few are labelled. The feed under the chart lists them newest first.
* **Notifications:** with browser notifications on (Preferences), a new signal on the latest bar notifies you, on the main chart and in Monitor; chart windows have their own *Notify* switch.

## Winners / copy desk (follow proven buyers)

**Winners** in the sidebar (More › Winners on iPhone) is a copy-trading desk built on public disclosures instead of a paid copy-trading app. The *Winners / copy desk* routine (Autopilot, off by default, 08:40 New York; or **Run Now**) has the agent read, in order of evidence:

1. **Insider cluster buys** (OpenInsider, confirmed on SEC EDGAR Form 4): several officers or directors buying their own stock within 30 days. The best-documented edge in the academic literature.
2. **Congress**: new buys from the House Clerk's periodic transaction reports (`/trader-pelosi`) and Capitol Trades (both chambers). Evidence for copying after the filing lag is weak, so these count as conviction, not timing.
3. **Superinvestors and funds**: Dataroma real-time activity and top buys, plus `/trader-copycat diff` on a few long-term records (Berkshire, Pershing Square, Appaloosa, Duquesne, Baupost, Greenlight). 13F data is 45+ days old.
4. **Copy-trading leaderboards and social**: the eToro public leaderboard when reachable (what the top verified gainers hold) and StockTwits trending for timing only.

It merges everything into one list (conviction = independent source types agreeing, recency, size, the buyer's record), drops illiquid names, and plans each pick as a **day** trade (momentum today, flat by the close) or a **swing** (entry at support or breakout, held through stop or targets). The page shows the plans with their *Followed by* chips and the raw feed per source, and from there:

* picks scoring 65 or more go to **Deep Analysis** automatically (the normal threshold rule); a *Deep* button runs it on any other pick;
* tick picks, set *$ each*, and **Auto-trade selected** puts that paper money on every one through the chart autopilot: entries at the plan's entry or on a two-star candle signal, exits at the stop, the target or a reversal signal.

Why not a copy-trading app: dub, Autopilot, eToro and Invo copy other people's accounts in real time but offer no API, and Invo is mostly crypto. The desk uses the same disclosures those apps are built on, for free, and keeps everything on paper.

**Setup:** run `setup/setup-agent.mjs` again once after updating so the sandbox may reach huggingface.co and its CDNs, download.pytorch.org (Kronos), openinsider.com, capitoltrades.com, dataroma.com, quiverquant.com, disclosures-clerk.house.gov, efdsearch.senate.gov and etoro.com (hosts the API refuses are dropped automatically). `sec_user_agent` in the trading rules must have your real name and email for EDGAR.

## Kronos forecasts (candlestick foundation model)

**Kronos** in the sidebar runs [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) (AAAI 2026, MIT): a decoder-only transformer pre-trained on 12 billion K-lines from 45 exchanges that tokenizes OHLCV bars and samples what the next bars could look like. The desk runs it inside the agent's sandbox (`public/kronos_forecast.py` is mounted there; the agent clones the repo, installs CPU torch and the `NeoQuasar/Kronos-small` weights on first use, then runs the script), so nothing heavy runs in the Worker.

* **Run:** symbol (stocks or crypto such as BTC-USD), bar size (5m, 15m, 1h, daily) and bars ahead. The first run in a fresh sandbox takes several minutes (torch + weights); later runs about a minute. Each run samples *N* futures (Admin Settings, default 20) and reports the mean path, the 10-90% band, the chance of closing higher, the expected move and the mean best/worst excursion.
* **On the chart:** the dashed line is the mean path and the dotted lines the band, on the main chart (the latest forecast for the symbol loads automatically) and on the Crypto desk tiles.
* **Mixed with the rest:** every scan prompt and every Deep Analysis start with the fresh forecasts (24 h) for the symbols involved, as one more opinion on direction and size of move. Admin Settings › *Chart autopilot: skip a candle-signal entry when a fresh Kronos forecast disagrees* adds Kronos as a gate (off by default). Kronos knows nothing about news or levels.
* **Verified here:** Kronos-small on CPU: 5 sampled paths on the repo's 5-minute test series in 62 s (first load), 8 paths on BTC-USD hourly bars in 18 s.

## Crypto desk (24/7, linked to the FOMO app)

**Crypto** in the sidebar is a separate desk for pairs in Yahoo notation (BTC-USD, ETH-USD, SOL-USD by default; each user keeps their own list):

* live charts with candle signals and the plan monitor, 15-minute, hourly or daily bars; prices from Yahoo Finance (CCC);
* **Kronos** per pair or *Forecast All*; the forecast line and band draw on each tile;
* **24/7 paper trading:** crypto orders fill at any hour (the cron now runs every minute every day), stay working for 7 days, positions are held to the stop or target (no end-of-day close), and the chart autopilot watches crypto pairs at weekends too; *Paper Buy* opens the ticket in hold mode and *Auto* puts paper money on the pair;
* **FOMO:** the FOMO app (mobile, self-custodial, Solana/Base/BNB/Monad) has no public API, so the desk links to it (*Open FOMO* and a FOMO button per tile; Admin Settings › *FOMO app link*, for example your referral link `https://fomo.family/r/<name>`) and execution there stays manual: the desk analyses, you tap the trade in FOMO. Nothing here can move real money.

## Performance: backtesting and the learning loop

**Performance** in the sidebar (More › Performance on iPhone) is where the desk learns from its own wins and losses.

**How outcomes are measured (walk-forward, no look-ahead).** Every pick of every finished brief is registered the moment the brief finishes and replayed only on the 5-minute bars that came after it: did the price come to the entry (a day plan has until that session's close, a swing plan three sessions), then did it reach the first target or the stop (when one bar touches both, the stop counts), or did time run out (a day plan exits at the close, a swing plan after ten sessions)? Entries through a gap fill at the bar's open. Results are in R (1R = entry to stop), with the best and worst excursion (MFE/MAE). Picks are never deleted, so losers and plans that never triggered stay in the record (no survivorship bias). The cron evaluates due plans every five minutes.

**Statistics with honesty built in.** Groups (scan, setup type, score bucket, hour, horizon, side, followed source, symbol) report trades, win rate, the Wilson 95% lower bound of the win rate (what a sample that size can promise), average R, total R and profit factor. The equity curve risks 1R per plan in time order and reports the worst drawdown and a per-trade Sharpe. Calibration shows whether a higher score really means a better trade. The page states how many groups were examined, a reminder that with many comparisons one shining group is expected by chance (the Deflated Sharpe idea).

**The playbook (AI improvement).** After the close (or with *Evaluate Now*), the groups with at least *N* settled trades (Admin Settings, default 10) become a short playbook: what works (average +0.25R or better with a CI lower bound of 35% or more), what does not, and the lowest score bucket that has paid. Every scan prompt starts with it, so the agent prefers the setups, scans, hours and sources with a record and is stricter with the rest, and says in one line how the lessons changed the list. Admin Settings › *Scans read the playbook* turns this off. TradingAgents keeps its own decision log the same way (Deep Analysis).

**Candle pattern reliability.** For any symbol and bar size, *Pattern reliability* backtests every pattern the models produce on that chart with the chart-autopilot rule (enter at the pattern close, stop just beyond the pattern, 2R target, time exit) and splits the bars 70/30 into in-sample and out-of-sample. Patterns marked **bad** (enough signals, negative expectancy) are skipped by the chart autopilot on that chart, and the signal chips show each pattern's historical win rate on that chart. *Backtest signal rule* runs the full rule at a chosen minimum strength and shows the R curve and the per-pattern table.

**Why this design.** The reviewed tools (backtrader, backtesting.py, vectorbt, NautilusTrader) are strategy backtesters for code you write; the desk's "strategy" is a set of agent recommendations, so the right test is a point-in-time replay of exactly what was recommended, which is what the outcome engine does. Walk-forward testing with an out-of-sample part, conservative fills, minimum sample sizes and confidence bounds are the standard defenses against the backtest-looks-great-live-fails problem; purged cross-validation is not needed because nothing is fitted on the data beyond simple group averages.

## Plan monitor: entry, expected exit, exit detection

Every chart (main chart, Monitor tiles, chart windows) watches the symbol's **plan**: your open paper position or working order, else today's latest recommendation for the symbol from any brief, else the latest Deep Analysis (5 days) with an entry and stop. The plan's levels are drawn (BUY/SHORT entry, STOP, T1/T2) and a status line under the chart says what is happening:

* **Waiting for entry** – how far the price is from the entry. When a bar reaches it, an **ENTRY** marker is drawn and you are notified ("entry point reached").
* **In trade** – the expected exit (stop and targets) and the current R multiple. When a bar hits the stop or the first target, an **EXIT** marker is drawn and you are notified. A two-star strong reversal pattern against the trade (for example a Bear Engulfing ★ while long) draws an **EXIT signal** marker and notifies you too.
* The main chart uses the notification permission from Preferences; chart windows have their own *Notify* switch.

## Automatic buy and sell per chart (paper)

The **Auto** button on every chart (main chart toolbar, chart windows; the Paper trading page lists them under *Chart autopilot*) lets an amount of paper money trade that one symbol by itself. It runs in the Worker every minute while a session is open, so it keeps working with the browser closed:

* **Money to use:** the dollars for this chart (at least $50, never more than your paper cash). Size = money ÷ entry price.
* **Enter on:** the plan (buys at the recommendation's or Deep Analysis's entry, with its stop and T1; a Deep Analysis trade is held overnight), a strong two-star candle signal on the last completed 5-minute bar (stop just beyond the pattern's low or high, target 2R), or either.
* **Exits:** the stop or target through the paper engine, a strong reversal signal against the trade (intraday trades; held multi-day trades keep to their levels), end of day for intraday plans, or *Sell Now* on the Paper page.
* **Guards:** one trade per symbol at a time, at most 4 entries per symbol per day, a 30-minute pause after an exit, the account's long/short preference, and paper cash. *Stop* keeps the row (and any open trade) and stops new entries; *Remove* deletes it. Reset account removes them all.

Paper only: nothing here can place a real order.

## Swing setups

The **Swing setups (2-10 day holds)** brief (Autopilot, off by default, 16:40 New York) scans daily and weekly bars for breakouts, pullbacks, bases and exhaustion hammers, confirms them with `ta_patterns` (300 candlestick and chart patterns, no look-ahead) in the sandbox, and tags each pick `swing`. Auto-trade takes swing picks after the close and holds them through the stop or target instead of closing at end of day.

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

**Cutting the Claude bill** (⚙ Settings → Claude usage & cost, admin only):

* **Usage:** spend today, over 7 days and over 30 days, split by brief type and Copilot chat, with the average and maximum per run. Use it to see where the money goes.
* **Reuse the morning research (on by default):** later briefs (pre-open, opening range, midday, power hour, review) get the day's earlier plan.
  * They refresh what changes during the day: prices, levels, volume, news and new movers.
  * They don't re-run slow-moving research (SEC filings, fundamentals, 13F, calendars) unless something new happened.
  * The full market scan always runs complete.
* **Duplicate runs are skipped:** a scheduled brief doesn't start if another brief is running or started in the last 30 minutes, for example a manual run. A full scan is only skipped by another full scan. Skipped runs show as "skipped" and cost nothing.
* **Daily spending cap (off by default):** once today's recorded spend reaches it, new scans and chats are refused until the next day. Spend is recorded when a session finishes.
* **Model and effort per task (optional; everything defaults to the agent's Opus 5.5 at high effort):**
  * Opus 5.5 at medium effort, or Sonnet 5.5 at high effort, can be chosen per brief type or for chat. Both cost less, but may lower quality.
  * Change one task at a time and compare its briefs for a few days before keeping it. Refresh briefs (pre-open, opening range) are the natural first candidates; the full scan is the last.
* **Cheapest of all:** turn off Autopilot briefs you don't read.

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
