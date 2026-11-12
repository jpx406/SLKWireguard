# Trading Desk — User Manual

This manual explains every section of the desk, the strategy behind each one, how to read its recommendations, and at the end a complete routine for getting the most out of all the tools together.

**Three facts to keep in mind while reading.**

1. **Everything is paper money.** The desk cannot place a real order anywhere. It simulates fills against real market prices.
2. **Nothing here is financial advice or a promise of profit.** The desk gives opinions with evidence. Most trading edges are small and many disappear; the desk is built to measure that honestly, not to hide it.
3. **The AI suggests; plain code decides.** Risk limits, the kill switch and the market-regime rules cannot be overridden by any AI opinion.

---

## Contents

1. Core ideas you need first
2. The screen: top bar, sidebar, right panel
3. Auto Trader (the simple master control)
4. Dashboard
5. Quant Terminal
6. Chart
7. Market Board
8. Briefs & Autopilot (the scans)
9. Paper Trading
10. Monitor and chart windows
11. Winners / copy desk
12. Deep Analysis
13. Crypto
14. Performance (the learning loop)
15. Journal
16. Kronos forecasts
17. Copilot and Position Size
18. The safety layer
19. Settings and costs
20. **The full guideline: how to use everything together**
21. Glossary
22. Troubleshooting

---

## 1. Core ideas you need first

**A plan.** Every recommendation is a plan with four numbers: an **entry** (the most you pay on a buy, the least you accept on a short), a **stop-loss** (where you admit you are wrong), one or two **targets** (where you take profit) and a **size**. A recommendation without these is only an opinion.

**R (risk units).** 1R is the distance from entry to stop. A trade that hits a target twice as far as the stop makes +2R; a stopped trade loses −1R. The desk measures everything in R so that a $50 stock and a $70,000 coin can be compared.

**Why R matters more than win rate.** With targets at 2R you only need to win a little over one trade in three to break even. With targets at 1R you need more than half. Always read win rate and average R together.

**Score (0–100).** The scan's own judgment of a setup's quality. It is an opinion; the Performance page checks whether higher scores really win more (calibration).

**Horizon.** *Day* plans are opened and closed the same session. *Swing* plans are held for days until the stop or target.

**Long and short.** Long = buy first, profit if it rises. Short = sell first, profit if it falls.

**Sessions (New York time).** Pre-market 07:00–09:30, regular 09:30–16:00, after-hours 16:00–20:00. Crypto trades all day, every day.

**Completed bars only.** Candle signals and automatic entries only use bars that have finished, so nothing appears and then vanishes.

---

## 2. The screen

**Top bar.** Sidebar toggle (collapses the menu to icons), the rules badge (*Paper Mode* when your trading rules are loaded), clocks for Riyadh and New York, the market state with a countdown, the Claude status dot, your account, the right-panel toggle and Preferences.

**Sidebar.** The list of sections and, under it, your **watchlist**. Clicking a watchlist symbol changes the symbol everywhere: Chart, Dashboard and Quant Terminal follow at once.

**Right panel.** Three tabs: **Briefs** (the scans and their results), **Copilot** (chat with the agent) and **Position Size** (a risk calculator).

**Collapsing.** The sidebar and the right panel collapse with their top-bar buttons. Any section heading with a small triangle collapses when clicked. All choices are remembered on the device.

**Phone and tablet.** A tablet shows the sidebar and one section. A phone shows one section with a tab bar (Watchlist, Chart, Board, Paper, More).

---

## 3. Auto Trader

**What it is.** The one screen for running automatic paper trading. It has a **Stocks** tab and a **Crypto** tab. If you only learn one section, learn this one.

### How to use it

1. **Pick a style** (top). *Conservative*: only verdicts of 70 or more, entries from the plan only, 3 trades at most. *Balanced*: 60 or more, plan or a strong candle signal, 5 at most. *Active*: 50 or more, 8 at most.
2. **Set the money per trade.** The size of each trade is this amount divided by the entry price.
3. **Turn the master switch on.** The desk turns Auto on for everything the style accepts, best verdict first. Off stops them all. You can also use the switch on any single row.
4. **Click a row** to see its clean chart with the entry, stop and target lines, what the desk recommends and why, and the levels.
5. **Adjust levels if you want.** Change the stop-loss, the target or the money for that symbol and press *Save levels*. The screen shows what you lose at the stop and gain at the target before you commit.
6. **In a trade**, the same fields move the open position's stop and target, and *Sell now* closes it.

### The verdicts

| Verdict | Meaning | What to do |
|---|---|---|
| Buy setup / Short setup | Score 65+, the evidence agrees | Auto on is reasonable |
| Worth a look | 55–64, fair but not strong | Smaller amount, or confirm with a Deep Analysis |
| Wait | Under 55, or no plan yet | Leave Auto off; run a scan |
| Avoid | Crash regime, or your own strategy rules exclude it | Skip |
| Missed | Price is already past the stop or the target | Do not chase |
| In trade | You hold it | Manage stop and target |

### The strategy behind the verdict

The verdict starts at 50 and moves with the evidence:

- **The scan's plan and score** move it the most (a score of 88 adds about 23 points).
- **Deep Analysis rating** adds up to 15 points when it agrees with the trade's direction and subtracts when it disagrees.
- **Kronos forecast** adds or subtracts up to 15 points by its probability.
- **Reward against risk**: +5 when the target is at least twice the risk, −10 when it is less than the risk.
- **Market regime**: −5 in sideways or jumpy markets; in a crash everything becomes Avoid.
- **Your approved strategy rules** turn a plan they exclude into Avoid.
- **Price against the levels**: a plan the price has already run through becomes Missed.

### Recommendations

- Start with **Balanced** and a small amount.
- Prefer rows where at least two independent sources agree (scan score plus a Deep rating, for example).
- A switch on a row with *no plan* lets the desk trade strong candle signals only. That is the least-proven entry type; keep the amount small.
- Do not widen a stop to avoid being stopped out. Move a stop only in the direction that reduces risk.

---

## 4. Dashboard

**What it is.** The overview. Use it at the start and end of the day.

- **Cards:** paper equity, today's result, win rate and average R of the last 90 days of plans, the active strategy version, today's plans.
- **Live chart** of the selected symbol with signals and the plan monitor.
- **Strategy performance:** your paper equity against simply holding SPY since your first trade. If you are not beating buy-and-hold over months, the automatic trading is not adding value yet.
- **Strategy research:** a heat-map of the candle-signal rule over minimum strength and hold time for the selected symbol. Green cells made money in the test, red cells lost. Hover for trade counts and out-of-sample results.
- **Backtest results:** total R, win rate, drawdown and trade count of the signal rule on the selected symbol, after costs.
- **Paper trading:** open positions and today's plans with their live status.

**How to read the heat-map.** A single bright green cell surrounded by red is luck. A block of green neighbours is more believable. Always check the out-of-sample value in the hover.

---

## 5. Quant Terminal

**What it is.** A dense, always-dark terminal view of the same data, for people who like to see everything at once. It follows the selected symbol.

| Panel | What it shows | How to use it |
|---|---|---|
| Account | Equity, trades, win rate, average R/R, Sharpe, equity curve, drawdown gauge | The gauge runs 0–10 toward your drawdown limit; above 7 is a warning |
| Candles | Live 5-minute bars | Context |
| Resolution grid | The latest plans as tiles, green won, red lost, amber open | Click a tile to switch symbol |
| Excursion survival | Share of plans that reached +1R, +2R, +3R, and that went against you | If many reach +1R but few reach +2R, nearer targets would pay better |
| Order flow aurora | Buying and selling pressure estimated from bars | A rising amber line with green dominance supports longs |
| Range membrane | Volatility ridges over recent windows | "Stretched" means ranges are unusually wide: smaller size |
| Phase vortex | How many watchlist symbols move the same way | 100% coherence means the market, not the stock, is driving |
| Ruin cone | 300 simulated futures from your own results | P(ruin) is the chance of hitting your drawdown limit; keep it low |
| Analog matcher | The most similar past windows and what followed | A hint, not a forecast; needs agreement elsewhere |
| Bayesian update | Your win probability after the evidence | Compare with the break-even rate printed below it |

**The KILL SWITCH** in the header cancels working orders, closes every paper position and stops automatic entries until you press it again.

**Honesty note.** The tape-pressure panel is an estimate from bars and the range panel replaces an order book the desk does not have. Both are labelled.

---

## 6. Chart

**What it is.** The full chart of one symbol.

- **Range and bar size:** 1D, 5D, 1M, 3M, 1Y; bars from 1 minute to daily.
- **Indicators:** VWAP (the session's average price weighted by volume), EMA 9 and EMA 20 (short moving averages), PDH/PDL (previous day's high, low and close).
- **Signals:** candle patterns on completed bars. **Models** chooses which run: classic patterns, extended patterns, the trend gate and volume confirmation.
- **Auto:** automatic paper trading for this one chart, with an amount and an entry rule.
- **Window:** opens the chart in its own browser window.
- **Plan bar** under the chart: what the plan monitor sees (waiting for entry, in trade, exit).

### The candle strategy

A candle pattern alone is weak evidence. The desk therefore adds context:

- **Trend gate.** A bullish reversal counts only after a downtrend or a flat market; a bearish one only after an uptrend or flat.
- **Volume confirmation.** A bar with 1.3 times the usual volume adds a star.
- **Strength.** One star means the trend fits; two stars means the trend fits and volume confirms. Automatic entries need the first star at least and a "strong" pattern family (engulfing, morning or evening star, three soldiers or crows, piercing line, dark cloud, kickers, three inside or outside, inside-bar breakout).
- **Reliability per chart.** Each chip shows the pattern's past win rate on this very symbol. Patterns proven bad here are skipped by the autopilot.

**When a signal becomes a trade (Auto with signals):** entry at the close of the pattern bar, stop just beyond the pattern's low (long) or high (short), target at twice the risk, at most 4 entries per symbol per day, 30 minutes of pause after an exit.

**Recommendations.** Use signals as timing inside a plan, not as the plan. The best case is a strong bullish signal near a plan's entry. Check *Pattern reliability* on the Performance page before trusting a pattern on a symbol.

---

## 7. Market Board

**What it is.** The full result of one scan: market regime and summary, index levels, sector performance, breadth, today's events, and the ranked recommendations.

**Using it.** Click a row to open the plan: a chart with the risk and reward zones, the catalyst, the exit plan and what invalidates the idea. Buttons place a paper order with the plan pre-filled, open it on the main chart, or run a Deep Analysis.

**Reading a pick.** Check, in order: the catalyst (why today), the setup (what pattern), score and confidence, reward against risk (prefer 2 or more), the **edge** sentence (why it should work) and the **bear case** (why it could fail). A pick whose bear case sounds stronger than its edge is a pass.

**Filters.** The full scan can be filtered by price, volume, market cap, sector and more (scan filters, admin).

---

## 8. Briefs & Autopilot (the scans)

**What it is.** The scheduled research runs. Each one is a session of the Claude agent using your trader skills. Turn *Autopilot* on and tick the routines you want; or press *Run Now*.

| Routine | New York | What it does | Strategy |
|---|---|---|---|
| Pre-market scan | 08:00 | Gappers, news, calendar | Early list |
| Full market scan | 08:15 | Every skill over the whole market | The day's main plan |
| Crypto scan | 08:30, every day | Market overview, trending and top movers, your pairs | Swing plans with halved risk |
| Winners / copy desk | 08:40 | What proven buyers are buying | Follow insiders, funds, Congress |
| Final pre-open plan | 09:10 | Refresh levels before the bell | Drop what faded |
| Opening range update | 09:50 | First 20 minutes | What is triggering |
| Midday check | 12:30 | Afternoon setups | Continuation, VWAP reclaims |
| Power hour | 15:00 | Last-hour setups | Closing strength or weakness |
| End-of-day review | 16:15 | What worked, what was missed | Lessons |
| Swing setups | 16:40 | Daily and weekly charts | 2–10 day holds |

**What every scan reads first.** Your active strategy rules, the playbook built from your own track record, and fresh Kronos forecasts. Later scans start from the morning's plan and only refresh what changes during the day, which saves cost.

**After a scan.** Picks scoring 65 or more get a Deep Analysis automatically (up to 5 per scan). If auto-trade is on, picks that pass your triggers and the risk gate become paper orders.

**Recommendations.** For a day trader: full scan, pre-open plan and opening range update. For a swing trader with little time: swing setups and winners only. Each scan costs money; see section 19.

---

## 9. Paper Trading

**What it is.** Your simulated account, starting at $10,000. Each user has their own; you can view others' accounts read-only.

**Order ticket.** Market or limit, sized by shares, dollars or risk percent, with an optional stop-loss and take-profit, and an exit mode: *End of day* (closed 5 minutes before the close) or *Hold* (kept until stop, target or you close it).

**How fills work.**

- The entry is the most you pay. If the market is already at or below it (long), the order fills now at the market price; otherwise it waits.
- Fills are checked every minute on 1-minute bars.
- If one bar touches both the stop and the target, the stop counts. This is deliberately pessimistic.
- A price that gaps through the stop before entry cancels the order.
- Stocks trade in the three sessions; crypto fills at any hour, in fractions.

**Settings & Auto-Trade.** Auto-trade takes scan recommendations by your triggers: minimum score, which scans, long or short only, minimum reward-to-risk, minimum price, time window, maximum positions, maximum trades per day, a daily loss limit, blocked symbols. Sizing: risk percent of equity, the recommended shares, fixed dollars, or quarter Kelly.

**Chart autopilot list.** Every per-symbol Auto with its state, with Stop and Remove.

**Recommendations.** Risk 1% of equity or less per trade. Keep the daily loss limit on (2–3% of equity is common). Let trades reach the stop or target instead of closing early out of nerves; the statistics only mean something if you follow the plan.

---

## 10. Monitor and chart windows

**Monitor** is a grid of live charts (2×2 up to 4×3) of your watchlist or any symbols you type, each with signals and a plan-status line, plus one combined signal feed. **Windows** opens charts in separate browser windows for several screens. Use these to watch; use Auto Trader to act.

---

## 11. Winners / copy desk

**What it is.** A copy-trading desk built on public disclosures rather than a copy-trading app.

**The strategy, in order of evidence.**

1. **Insider cluster buys.** Several officers or directors buying their own company's stock on the open market within 30 days. This is the best-documented edge in academic work. It weakens in illiquid stocks and with large position sizes.
2. **Congress.** New buys disclosed by members. Evidence for copying *after* the filing delay is weak, so these add conviction but do not time an entry.
3. **Superinvestors and funds.** New positions and adds by long-term managers. The data is at least 45 days old: conviction only.
4. **Leaderboards and social interest.** Timing only, never a reason by itself.

Names where several independent source types agree rank highest. Each becomes a day or swing plan with entry, stop and targets.

**Using it.** *Run Now*, read the *Followed by* chips, tick the plans you like, set an amount and press *Auto-trade selected*.

**Recommendations.** Favour picks with an insider cluster plus one other source. Treat a pick supported only by social interest as a pass. These work better as swings than as day trades.

---

## 12. Deep Analysis

**What it is.** A slower second opinion on one symbol from TradingAgents: four analysts (market, news, fundamentals, sentiment), a bull-against-bear debate, a trader, a risk desk and a portfolio manager, ending in a rating: **Buy, Overweight, Hold, Underweight, Sell**.

**Using it.** Type a symbol and run it, or let the autopilot run it on picks scoring 65 or more. It takes 5–15 minutes. Open a run to read the bull case, the bear case, the trader's plan and the full report. It keeps a decision log and learns from its own settled calls.

**The strategy.** It answers "should I hold this for days?", not "should I buy in the next ten minutes?". Its rating badge appears across the app and moves the Auto Trader verdict by up to 15 points.

**Recommendations.** Use it to confirm swing ideas and to veto day trades that fight a Sell rating. It is the most expensive analysis per symbol, so do not run it on everything.

---

## 13. Crypto

**What it is.** A separate desk for pairs such as BTC-USD, ETH-USD, SOL-USD, with two views.

- **Desk:** a grid of live charts like the Monitor. Each tile has Kronos (forecast), Deep, Paper Buy, Auto and FOMO.
- **Dashboard:** crypto profit and loss, positions, win rate, the latest scan and the outcomes of crypto plans.

**What is different from stocks.** No sessions and no closing bell: orders fill at any hour, positions are held until the stop or target, and the autopilot works at weekends. Sizes can be fractions.

**The strategy.** Crypto moves three to five times more than stocks, so the crypto scan plans swings with half the usual risk. Bitcoin sets the regime: when BTC is in a crash state the desk stops opening crypto trades.

**FOMO.** The FOMO app has no public interface the desk can connect to. The buttons open it; any real trade there is tapped by you. The desk only analyses.

**Recommendations.** Keep crypto to a small share of the account. Use Balanced or Conservative. Expect wider stops.

---

## 14. Performance (the learning loop)

**What it is.** Where the desk checks itself and improves. This is the most important section for long-term results.

**How outcomes are measured.** Every recommendation is recorded when it is made and then replayed only on the bars that came after it: did the price reach the entry, then the target or the stop, or did time run out? Plans that never triggered and losers are kept, so the record cannot flatter itself.

**Reading the numbers.**

- **Win rate with its lower bound.** "60% wins, lower bound 31%" from 10 trades means the sample is too small to promise anything. Trust groups with 30 or more trades.
- **Average R.** Positive means the group made money per trade.
- **Profit factor.** Total wins divided by total losses; above 1.3 is decent.
- **Calibration.** If the 80–100 score group does not win more than the 60–69 group, the score is not informative yet.
- **Tables** by scan, setup type, score, hour, horizon, side, source, symbol and market regime show where money is made and lost.

**The self-improving loop.**

1. **Observe:** all plans and trades are logged.
2. **Analyze:** the failure analyzer lists what goes wrong with evidence (a losing setup type, a losing hour, drawdown, overtrading, slippage, a losing regime).
3. **Reason:** *Propose from statistics* or *Ask Claude to reason* turns that into candidate rules.
4. **Validate:** each proposal is replayed on the past, split into an older part and a newer unseen part. The verdict says *improves*, *neutral*, *worse* or *insufficient*.
5. **Update:** you approve or reject. One version is active at a time; *Retire* returns to no rules.

Approved rules are enforced: scans read them, and automatic trading skips plans that break them.

**The playbook.** A short text of what has worked and what has not, placed at the top of every scan's instructions.

**Candle patterns.** *Pattern reliability* shows each pattern's record on the selected symbol; *Backtest signal rule* tests the automatic signal rule there, after costs, against simply holding.

**Recommendations.** Approve a version only when the verdict is *improves* on at least 30 trades and it keeps more than half of the trades. Review once a week, not daily. Fewer rules are better than many.

---

## 15. Journal

Your own notes on real or paper trades, with statistics. Writing why you took a trade and what happened is the cheapest improvement tool there is. Use it for anything the automatic record cannot know: your mood, a rule you broke, news you reacted to.

---

## 16. Kronos forecasts

**What it is.** A statistical model trained on billions of price bars. Given the last 400 bars it samples possible futures and reports the average path, a band, the chance of closing higher and the expected move.

**Using it.** Type a symbol, choose a bar size and press Forecast. The first run takes several minutes; later ones about a minute. The result draws on the chart as a dashed line with a dotted band.

**Two models.** *Kronos* runs in the agent's sandbox (minutes, costs a session). *Instant (built-in)* runs at once and free: it resamples this symbol's own past returns, an honest baseline with no opinion beyond recent drift and volatility. If a Kronos run fails, the row shows the reason and the agent's notes, and the built-in forecast is used instead so the chart still gets a band.

**Is it useful?** Unproven. The page scores every forecast once its time has passed, per model: Kronos is only worth its cost if it beats the built-in baseline. Rely on it only while the direction hit rate is above 55% and the Brier score is below 0.22 over 30 or more forecasts. It knows nothing about news.

**Recommendations.** Treat it as one more vote. Never trade on it alone.

---

## 17. Copilot and Position Size

**Copilot.** Chat with the agent that has your skills. Good questions: "check this plan against my rules", "what is the catalyst in NVDA today", "explain why this pick was scored 72". It can never place an order.

**Position Size.** Enter account size, risk percent, entry and stop. It returns the number of shares, the dollar risk and the 1R, 2R and 3R targets, and can draw the plan on the chart.

---

## 18. The safety layer

These run in plain code before every automatic order.

| Guard | What it does |
|---|---|
| Kill switch | Cancels orders, closes all positions, blocks automatic entries until re-armed |
| Max drawdown guard | Equity 15% (setting) under its peak trips the kill switch by itself |
| Daily loss limit | Stops automatic entries for the day |
| Stale data check | No entry when the newest price bar is over 20 minutes old |
| Market regime | Calm trend: full size. Sideways or jumpy: half size. Crash: no entries |
| Strategy rules | Plans your approved rules exclude are skipped |
| Pattern reliability | Signals proven bad on a chart are skipped |
| Entry limits | One trade per symbol, 4 entries per symbol per day, 30-minute pause after an exit |

Every block is written to a risk log (hover the footer of the Quant Terminal, or see the autopilot's note on the Paper page).

---

## 19. Settings and costs

**Preferences** (gear): appearance, text size, notifications.

**Paper settings:** everything in section 9, plus the drawdown guard and regime sizing.

**Admin Settings:** trading rules, data source, users, and cost controls: a daily spending cap, the model and effort per task, the score threshold and the number of automatic Deep Analyses per scan, the playbook switch, the Kronos gate.

**What costs money.** Every scan, chat, Deep Analysis, Kronos forecast and strategy review is a Claude session. Charts, signals, the paper engine, the autopilot, Auto Trader verdicts, backtests and the Performance statistics cost nothing.

**Keeping cost down.** Set a daily cap. Run fewer routines. Keep "later briefs reuse the morning research" on. Raise the Deep Analysis threshold or lower its per-scan limit.

---

## 20. The full guideline: how to use everything together

### Stage 1 — First week: learn and observe (no automation)

1. Add 6–10 liquid symbols you understand to the watchlist.
2. Turn Autopilot on with three routines: full scan, pre-open plan, opening range update.
3. Each morning read the Market Board. For every pick read the edge and the bear case.
4. Place two or three paper trades by hand from picks you understand. Use the plan's stop and target unchanged.
5. In the evening open Performance and look at how the day's plans ended.
6. Write one line per trade in the Journal.

Goal: understand a plan, R, and the difference between a good idea and a good trade.

### Stage 2 — Weeks 2 to 4: simple automation

1. Open Auto Trader. Choose **Balanced** and a small amount per trade (about 5% of the account).
2. In Paper settings: risk 1%, daily loss limit about 2% of equity, drawdown guard 15%, regime sizing on.
3. Turn the master switch on after the full scan arrives. Check once at midday and once after the close.
4. Do not interfere with open trades except to reduce risk.
5. Let Deep Analysis run automatically on high scores; read at least the bull and bear case of each.

Goal: collect 50 or more settled plans. Statistics before that are noise.

### Stage 3 — From month 2: let the desk improve itself

1. Once a week open Performance. Read the failure analyzer.
2. Press *Propose from statistics*. If you want reasoning in words, *Ask Claude to reason*.
3. Approve a version only if it *improves* out of sample on 30 or more trades and keeps over half of them. Otherwise reject and wait.
4. Check calibration. If scores below 70 lose, raise the auto-trade minimum score to match.
5. Check *Pattern reliability* on the symbols you trade most.
6. Compare paper equity with SPY on the Dashboard every month.

Goal: a small set of rules that your own record supports.

### A daily routine (about 20 minutes)

| When (New York) | Do this | Where |
|---|---|---|
| 08:20 | Read regime, summary and top picks | Market Board |
| 08:30 | Check the verdicts; confirm the master switch and style | Auto Trader |
| 09:15 | Glance at the final pre-open plan | Briefs |
| 10:00 | See what triggered | Auto Trader, Dashboard |
| 12:30 | One check; reduce risk if a trade stalls | Auto Trader |
| 16:05 | Day's result, plans won and lost | Dashboard |
| Evening | One Journal line; scan the swing setups if you hold overnight | Journal, Briefs |

### A weekly routine (about 30 minutes)

1. Performance: win rate with lower bound, average R, drawdown.
2. Failure analyzer and one proposal; approve or reject.
3. Kronos track record: keep or disable the gate.
4. Cost: Admin Settings usage; trim routines you do not read.
5. Watchlist: remove symbols you never trade, add ones the scans keep finding.

### Combining the tools: what "strong" looks like

The best automatic trades have several independent supports. Count them:

- a scan plan scoring 75 or more with reward at least twice the risk;
- a Deep Analysis rating that agrees;
- a Winners source (ideally an insider cluster) on the same name;
- a strong candle signal near the entry;
- a calm-trend market regime;
- a setup type and hour your own record shows as profitable.

Four or more: full normal size. Two or three: half size. One: watch only.

### Profiles

**Complete beginner.** Auto Trader on Conservative, small amount, three routines. Read the "What the desk recommends" box for every trade. Touch nothing else for a month.

**Busy part-timer.** Swing setups and Winners only, Balanced style, exit mode Hold. Check once a day after the close.

**Active day trader.** Full routine set, Monitor on a second screen with signals, Active style on a short list, Quant Terminal for risk. Weekly strategy review is mandatory at this pace.

**Crypto.** Crypto scan daily, Conservative or Balanced, small amounts, wider stops. Watch the BTC regime chip.

### Ten rules that protect you

1. Paper first. Months, not days.
2. Risk 1% or less per trade.
3. Never move a stop further away.
4. A daily loss limit, always on.
5. Trust groups of 30 or more trades, not a good week.
6. One change at a time, then measure.
7. If you cannot say the edge and the bear case, skip the trade.
8. In a crash regime, stand aside.
9. Beating buy-and-hold over months is the test. A high win rate alone is not.
10. When in doubt, press the kill switch and think.

### What the desk cannot do

It cannot know news before it happens, guarantee a fill at your price in a fast market, or turn a strategy with no edge into a profitable one. Paper results are usually better than real ones because real orders move prices and real money moves emotions. If you ever trade real money, start at the smallest size and expect worse results than on paper.

---

## 21. Glossary

- **ATR:** average true range, a measure of how much a symbol moves per bar.
- **Brier score:** accuracy of a probability forecast; 0 is perfect, 0.25 is a coin flip.
- **Calibration:** whether a higher score really means a better trade.
- **CVD:** cumulative volume delta, buying minus selling volume added up.
- **Drawdown:** the fall from the highest equity to a later low.
- **EMA:** exponential moving average.
- **In-sample / out-of-sample:** the data a rule was chosen on, and newer data it never saw.
- **Kelly fraction:** the bet size that maximises growth in theory; the desk uses a quarter of it, capped at 2%.
- **MFE / MAE:** the furthest a trade went in your favour and against you.
- **Profit factor:** total winnings divided by total losses.
- **R:** one unit of risk, entry to stop.
- **Regime:** the market's state: calm trend, sideways, jumpy or crash.
- **Sharpe (per trade):** average result divided by its variability.
- **VWAP:** volume-weighted average price of the session.
- **Walk-forward:** testing only on data that came after the decision.

---

## 22. Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| A scan shows an error and $0 | Agent not configured or budget too low | Admin Settings; rerun the setup script |
| Nothing is bought with Auto on | Kill switch on, crash regime, stale data, price past the levels, or the daily cap of entries | Read the row's status line and the risk log |
| Sizes are half what I set | Sideways or jumpy regime | Normal; or turn regime sizing off in Paper settings |
| Kronos run shows error | Sandbox cannot reach the model host | Rerun the setup script; read the agent notes under the row |
| Master switch turned nothing on | No verdict meets the style | Run a scan, or choose a more active style |
| Empty chart | Market closed or wrong symbol | Try 5D; check the symbol |
| Winners shows "sources with problems" | A site refused the sandbox | The rest still works; report which source |
| Numbers look too good | Too few trades | Wait for 30 or more per group |
