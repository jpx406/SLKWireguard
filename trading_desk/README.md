# Trading Desk

A local day-trading app for the 15 `trader-*` Claude Code skills. It runs in your browser in a dark, multi-panel layout like TradingView's:

| Panel | What it does |
|---|---|
| **Top bar** | PAPER / LIVE MONEY badge read from `trader/config.json`; Riyadh and New York clocks; market state (pre-market, open, after-hours, closed) with a countdown |
| **Watchlist** | Live % change, refreshed about every 15 s. Click a symbol to chart it; hover to remove it; type in "+ add" to add one |
| **Chart** | Candles + volume, VWAP, EMA 9/20, and the previous day's high, low and close (PDH/PDL/PDC). Intervals 1m, 5m, 15m, 1h, D. Press `/` to jump to the symbol box |
| **Copilot** | Chats with Claude Code inside your trading folder, so all your skills load. One-click workflows (pre-market brief, scan, trade plan, size and risk check, news and filings, end-of-day review) fill in the active symbol, price and watchlist. Conversations continue until you click "new session" |
| **Skills** | Finds every `trader-*` skill on its own. Shows each skill's SKILL.md, runs its Python tools with arguments (`{symbol}` is replaced with the active symbol), has a `--help` button for each tool, and an "Ask Claude to use this skill" button |
| **Risk** | Position size from account, risk % and stop, capped by max position %. Shows 1R/2R/3R targets and draws entry, stop and targets on the chart. "Ask Claude to verify" checks the plan against your skills and config |
| **Journal** | Logs trades and shows P&L, R multiple, win rate, average R and today's P&L |
| **Guide** | Shows your `GUIDE.md` |

## Install and run (Windows)

1. Copy the `trading_desk` folder somewhere, for example `C:\Users\JuanCeron\nesr\Day_trading\trading_desk`.
2. Double-click `start.bat`, or run `.\start.ps1` in PowerShell. The first run creates `.venv` and installs FastAPI, uvicorn and yfinance. Your browser then opens at http://127.0.0.1:8765.
3. Click ⚙ Settings and check these two folders:
   * **Skills folder:** `C:\Users\JuanCeron\.claude\skills`
   * **Trading folder:** the folder that holds `trader\config.json`, by default `%USERPROFILE%\nesr\Day_trading`. Both Claude and the skill tools run in this folder.

You need Python 3.10 or newer and Claude Code installed (`claude` on your PATH; the green dot in the top bar shows it was found). If `claude` lives somewhere else, put its full path in Settings → Claude command.

## Safety

* The app listens only on `127.0.0.1`, so other devices cannot reach it.
* **It never places orders.** The Copilot runs Claude in headless mode (`claude -p`). It is allowed only read-only tools, web search and running Python (the default list is in Settings). Any other tool needs approval, and the app automatically skips it. That includes your broker connector. When this happens, the chat shows "Needs your approval, so it was skipped" and names the tool. Place real tickets in interactive Claude Code, where you approve each one.
* Do not add broker or order tools to the allowed list.
* The skill runner only runs `.py` files that sit inside a discovered `trader-*` skill folder.
* Yahoo Finance quotes are delayed and unofficial. Use them for context, never for execution prices.

## Customise

* **Workflows:** edit `workflows.json`. Each entry is a button. Use `{symbol}`, `{interval}`, `{price}` and `{watchlist}` in labels and prompts. A good next step is to add one button per chain from your GUIDE.md.
* **Settings and journal** are saved in `%USERPROFILE%\.trading_desk\`.
* **Port:** set the environment variable `TRADING_DESK_PORT` to change it.

## Tests

```
.venv\Scripts\python.exe -m pip install httpx
.venv\Scripts\python.exe -m unittest test_app
```

Bundled libraries in `static/vendor` (licenses included): TradingView Lightweight Charts™ (Apache-2.0), marked (MIT), DOMPurify (Apache-2.0/MPL-2.0).
