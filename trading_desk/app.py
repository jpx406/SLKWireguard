"""Trading Desk — a local day-trading cockpit for the trader-* Claude Code skills.

Run:  python app.py        (opens http://127.0.0.1:8765 in your browser)

The server binds to 127.0.0.1 only. It never places orders: order tickets stay in
interactive Claude Code, where the broker connector asks you to approve each one.
"""
from __future__ import annotations

import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.environ.get("TRADING_DESK_HOME", Path.home() / ".trading_desk"))
SETTINGS_FILE = DATA_DIR / "settings.json"
JOURNAL_FILE = DATA_DIR / "journal.json"
WORKFLOWS_FILE = APP_DIR / "workflows.json"

DEFAULT_SETTINGS = {
    "skills_dir": str(Path.home() / ".claude" / "skills"),
    "skill_prefix": "trader-",
    "trading_dir": str(Path.home() / "nesr" / "Day_trading"),
    "guide_path": "",
    "watchlist": ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "AMD", "MSFT", "META"],
    "claude_command": "claude",
    "claude_model": "",
    # Read-only tools plus running the skills' Python tools. MCP/broker tools are
    # deliberately absent: in headless mode anything not allowed is denied.
    "claude_allowed_tools": ["Read", "Glob", "Grep", "Skill", "WebSearch", "WebFetch",
                             "Bash(python:*)", "Bash(py:*)", "Bash(python3:*)"],
    "tool_timeout_sec": 300,
}

SKIP_DIRS = {"__pycache__", "tests", "test", ".git", "node_modules", ".venv", "venv"}


# --------------------------------------------------------------------------- settings
def load_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    try:
        s.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return s


def save_settings(s: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(s, indent=2), encoding="utf-8")


def trading_dir(s: dict) -> Path:
    p = Path(os.path.expandvars(os.path.expanduser(s["trading_dir"])))
    return p if p.is_dir() else Path.cwd()


# --------------------------------------------------------------------------- skills
def parse_frontmatter(text: str) -> dict:
    """Minimal YAML-frontmatter reader (key: value, with folded multi-line values)."""
    m = re.match(r"^﻿?---\s*\n(.*?)\n---\s*(\n|$)", text, re.S)
    if not m:
        return {}
    out: dict[str, str] = {}
    key = None
    for line in m.group(1).splitlines():
        km = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if km:
            key = km.group(1)
            val = km.group(2).strip()
            out[key] = "" if val in (">", "|", ">-", "|-") else val.strip("'\"")
        elif key and line.startswith((" ", "\t")):
            out[key] = (out[key] + " " + line.strip()).strip()
    return out


def discover_skills(skills_dir: Path, prefix: str) -> list[dict]:
    skills = []
    if not skills_dir.is_dir():
        return skills
    for d in sorted(skills_dir.iterdir()):
        if not d.is_dir() or not d.name.startswith(prefix):
            continue
        md = d / "SKILL.md"
        text = md.read_text(encoding="utf-8", errors="replace") if md.exists() else ""
        fm = parse_frontmatter(text)
        body = re.sub(r"^﻿?---.*?\n---\s*\n", "", text, count=1, flags=re.S)
        tools = []
        for py in sorted(d.rglob("*.py")):
            rel = py.relative_to(d)
            if any(part in SKIP_DIRS for part in rel.parts[:-1]) or py.name.startswith(("test_", "_")):
                continue
            tools.append(rel.as_posix())
        skills.append({
            "name": fm.get("name", d.name),
            "folder": d.name,
            "description": fm.get("description", ""),
            "body": body.strip(),
            "tools": tools,
        })
    return skills


def resolve_tool(s: dict, folder: str, script: str) -> Path:
    """Only scripts that discovery lists for that skill folder may run."""
    skills_dir = Path(os.path.expanduser(s["skills_dir"]))
    for sk in discover_skills(skills_dir, s["skill_prefix"]):
        if sk["folder"] == folder and script in sk["tools"]:
            return skills_dir / folder / script
    raise HTTPException(404, "Unknown skill tool")


def stream_process(cmd: list[str], cwd: Path, timeout: int, stdin_text: str | None = None) -> Iterator[str]:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(cmd, cwd=str(cwd), stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    if stdin_text is not None:
        proc.stdin.write(stdin_text)
        proc.stdin.close()
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    try:
        for line in proc.stdout:
            yield line
        proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
    if proc.returncode not in (0, None):
        yield f"\n[exit code {proc.returncode}]\n"


# --------------------------------------------------------------------------- claude
def claude_cmd(s: dict, session_id: str | None) -> list[str]:
    exe = shutil.which(s["claude_command"]) or s["claude_command"]
    cmd = [exe, "-p", "--output-format", "stream-json", "--verbose"]
    if s.get("claude_model"):
        cmd += ["--model", s["claude_model"]]
    if s.get("claude_allowed_tools"):
        cmd += ["--allowedTools", ",".join(s["claude_allowed_tools"])]
    if session_id:
        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", session_id):
            raise HTTPException(400, "Bad session id")
        cmd += ["--resume", session_id]
    return cmd


def summarize_tool_input(name: str, inp: dict) -> str:
    for k in ("command", "skill", "file_path", "pattern", "query", "url", "prompt"):
        if k in inp:
            return str(inp[k])[:200]
    return json.dumps(inp)[:200]


def claude_events(lines: Iterator[str]) -> Iterator[str]:
    """Translate Claude Code stream-json into compact NDJSON events for the UI."""
    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except ValueError:
            yield json.dumps({"kind": "log", "text": raw}) + "\n"
            continue
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            yield json.dumps({"kind": "init", "session_id": ev.get("session_id")}) + "\n"
        elif t == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text"):
                    yield json.dumps({"kind": "text", "text": block["text"]}) + "\n"
                elif block.get("type") == "tool_use":
                    yield json.dumps({"kind": "tool", "name": block.get("name"),
                                      "detail": summarize_tool_input(block.get("name", ""), block.get("input", {}))}) + "\n"
        elif t == "result":
            yield json.dumps({"kind": "done", "session_id": ev.get("session_id"),
                              "cost": ev.get("total_cost_usd"), "is_error": ev.get("is_error", False),
                              "denials": [d.get("tool_name") for d in ev.get("permission_denials", []) or []]}) + "\n"


# --------------------------------------------------------------------------- market data
INTERVALS = {"1m": "5d", "2m": "5d", "5m": "30d", "15m": "30d", "30m": "30d", "60m": "60d", "1d": "2y", "1wk": "10y"}
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.\-^=]{1,15}$")


def check_symbol(sym: str) -> str:
    if not SYMBOL_RE.match(sym):
        raise HTTPException(400, "Bad symbol")
    return sym.upper()


def _num(x):
    try:
        x = float(x)
        return None if math.isnan(x) else x
    except (TypeError, ValueError):
        return None


def get_candles(symbol: str, interval: str) -> list[dict]:
    import yfinance as yf
    df = yf.Ticker(symbol).history(period=INTERVALS[interval], interval=interval,
                                   prepost=interval in ("1m", "2m", "5m", "15m", "30m"), auto_adjust=False)
    out = []
    for ts, row in df.iterrows():
        o, h, l, c = (_num(row[k]) for k in ("Open", "High", "Low", "Close"))
        if None in (o, h, l, c):
            continue
        out.append({"time": int(ts.timestamp()), "open": o, "high": h, "low": l, "close": c,
                    "volume": _num(row.get("Volume")) or 0})
    return out


def get_quotes(symbols: list[str]) -> list[dict]:
    import yfinance as yf
    out = []
    for sym in symbols:
        try:
            fi = yf.Ticker(sym).fast_info
            last, prev = _num(fi.last_price), _num(fi.previous_close)
            chg = (last - prev) / prev * 100 if last and prev else None
            out.append({"symbol": sym, "last": last, "prev": prev, "change_pct": chg,
                        "volume": _num(getattr(fi, "last_volume", None))})
        except Exception as e:  # noqa: BLE001 — one bad ticker must not kill the list
            out.append({"symbol": sym, "error": str(e)[:120]})
    return out


# --------------------------------------------------------------------------- journal
def load_journal() -> list[dict]:
    try:
        return json.loads(JOURNAL_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_journal(rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    JOURNAL_FILE.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def trade_stats(t: dict) -> dict:
    sign = 1 if t.get("side", "long") == "long" else -1
    entry, exit_, stop, qty = (_num(t.get(k)) for k in ("entry", "exit", "stop", "qty"))
    pnl = r = None
    if entry is not None and exit_ is not None and qty:
        pnl = round((exit_ - entry) * qty * sign - (_num(t.get("fees")) or 0), 2)
        if stop is not None and stop != entry:
            r = round((exit_ - entry) * sign / abs(entry - stop), 2)
    return {**t, "pnl": pnl, "r": r}


# --------------------------------------------------------------------------- API
app = FastAPI(title="Trading Desk")


class SettingsIn(BaseModel):
    settings: dict


class RunIn(BaseModel):
    folder: str
    script: str
    args: str = ""


class ChatIn(BaseModel):
    prompt: str
    session_id: str | None = None


class TradeIn(BaseModel):
    trade: dict


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/settings")
def api_settings():
    return load_settings()


@app.put("/api/settings")
def api_save_settings(body: SettingsIn):
    s = load_settings()
    s.update({k: v for k, v in body.settings.items() if k in DEFAULT_SETTINGS})
    save_settings(s)
    return s


@app.get("/api/status")
def api_status():
    s = load_settings()
    tdir = trading_dir(s)
    cfg_path = tdir / "trader" / "config.json"
    config, config_error = None, None
    if cfg_path.exists():
        try:
            config = json.loads(cfg_path.read_text(encoding="utf-8"))
        except ValueError as e:
            config_error = str(e)
    skills_dir = Path(os.path.expanduser(s["skills_dir"]))
    return {
        "trading_dir": str(tdir),
        "config_path": str(cfg_path),
        "config": config,
        "config_error": config_error,
        "paper": None if config is None else bool(config.get("paper", True)),
        "claude_found": shutil.which(s["claude_command"]) is not None,
        "skills_dir": str(skills_dir),
        "skills_count": len(discover_skills(skills_dir, s["skill_prefix"])),
        "server_time": datetime.now().astimezone().isoformat(),
    }


@app.get("/api/skills")
def api_skills():
    s = load_settings()
    return discover_skills(Path(os.path.expanduser(s["skills_dir"])), s["skill_prefix"])


@app.post("/api/skills/run")
def api_run_tool(body: RunIn):
    s = load_settings()
    script = resolve_tool(s, body.folder, body.script)
    try:
        # Non-POSIX mode keeps Windows backslashes intact; strip the quotes it leaves on.
        args = [a[1:-1] if len(a) > 1 and a[0] == a[-1] and a[0] in "\"'" else a
                for a in shlex.split(body.args, posix=False)]
    except ValueError as e:
        raise HTTPException(400, f"Bad arguments: {e}") from e
    cmd = [sys.executable, str(script), *args]
    head = f"$ python {body.folder}/{body.script} {body.args}\n(cwd: {trading_dir(s)})\n\n"

    def gen():
        yield head
        yield from stream_process(cmd, trading_dir(s), int(s["tool_timeout_sec"]))
    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8")


@app.post("/api/claude")
def api_claude(body: ChatIn):
    s = load_settings()
    if not body.prompt.strip():
        raise HTTPException(400, "Empty prompt")
    cmd = claude_cmd(s, body.session_id)
    if not shutil.which(cmd[0]) and not Path(cmd[0]).exists():
        raise HTTPException(503, "Claude Code CLI not found. Install it or set claude_command in Settings.")

    def gen():
        try:
            yield from claude_events(stream_process(cmd, trading_dir(s), 1800, stdin_text=body.prompt))
        except OSError as e:
            yield json.dumps({"kind": "error", "text": str(e)}) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.get("/api/workflows")
def api_workflows():
    return json.loads(WORKFLOWS_FILE.read_text(encoding="utf-8"))


@app.get("/api/guide")
def api_guide():
    s = load_settings()
    candidates = [s.get("guide_path") or "", trading_dir(s) / "GUIDE.md"]
    for c in candidates:
        p = Path(os.path.expanduser(str(c))) if c else None
        if p and p.is_file():
            return {"path": str(p), "markdown": p.read_text(encoding="utf-8", errors="replace")}
    return {"path": None, "markdown": ""}


@app.get("/api/candles/{symbol}")
def api_candles(symbol: str, interval: str = "5m"):
    if interval not in INTERVALS:
        raise HTTPException(400, "Bad interval")
    try:
        return get_candles(check_symbol(symbol), interval)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Data error: {e}") from e


@app.get("/api/quotes")
def api_quotes(symbols: str):
    syms = [check_symbol(x) for x in symbols.split(",") if x.strip()][:40]
    return get_quotes(syms)


@app.get("/api/journal")
def api_journal():
    return [trade_stats(t) for t in load_journal()]


@app.post("/api/journal")
def api_add_trade(body: TradeIn):
    rows = load_journal()
    t = {k: body.trade.get(k) for k in ("date", "symbol", "side", "qty", "entry", "stop", "exit", "fees", "setup", "notes")}
    t["id"] = uuid.uuid4().hex[:12]
    t["date"] = t.get("date") or datetime.now().strftime("%Y-%m-%d")
    rows.append(t)
    save_journal(rows)
    return trade_stats(t)


@app.delete("/api/journal/{trade_id}")
def api_delete_trade(trade_id: str):
    rows = load_journal()
    save_journal([t for t in rows if t.get("id") != trade_id])
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def main():
    import uvicorn
    port = int(os.environ.get("TRADING_DESK_PORT", "8765"))
    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
