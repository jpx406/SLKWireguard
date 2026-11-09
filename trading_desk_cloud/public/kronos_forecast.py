#!/usr/bin/env python3
"""Kronos (shiyu-coder/Kronos, AAAI 2026) candlestick forecast for one symbol.

Lives in public/ so the Worker can read it through its assets binding and mount it in the agent's sandbox; runs anywhere with the Kronos repo and torch:
  python3 kronos_forecast.py --symbol BTC-USD --interval 60m --pred 24 --samples 20 --kronos /workspace/kronos --out fc.json
Bars come from Yahoo Finance's chart API (stocks and crypto, e.g. BTC-USD) or a CSV (timestamps,open,high,low,close,volume).
Prints ONE json object (also written to --out): the mean forecast path with a 10-90% band from `--samples` sampled paths,
the probability the final close is above the last close, and the expected move. Never places orders.
"""
import argparse, json, math, os, sys, time, urllib.request

INTERVALS = {"1m": (60, "1m", "5d"), "5m": (300, "5m", "30d"), "15m": (900, "15m", "60d"), "60m": (3600, "60m", "180d"), "1h": (3600, "60m", "180d"), "1d": (86400, "1d", "3y")}


def fetch_yahoo(symbol, iv, n):
    step, yf, rng = INTERVALS[iv]
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}?interval={yf}&range={rng}&includePrePost=false"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (TradingDesk Kronos forecast)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(res.get("timestamp") or []):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        rows.append((t, o, h, l, c, (q.get("volume") or [0] * len(res["timestamp"]))[i] or 0))
    return rows[-n:], step


def read_csv(path, n):
    import csv
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            t = r.get("timestamps") or r.get("timestamp") or r.get("time")
            try:
                ts = int(float(t))
            except ValueError:
                import datetime
                ts = int(datetime.datetime.fromisoformat(t).replace(tzinfo=datetime.timezone.utc).timestamp())
            rows.append((ts, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r.get("volume") or 0)))
    rows.sort()
    step = int(rows[1][0] - rows[0][0]) if len(rows) > 1 else 300
    return rows[-n:], step


def future_times(last, step, n, daily):
    import datetime
    out, t = [], last
    while len(out) < n:
        t += step
        if daily and datetime.datetime.fromtimestamp(t, datetime.timezone.utc).weekday() >= 5:
            continue
        out.append(t)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--interval", default="60m", choices=list(INTERVALS))
    ap.add_argument("--pred", type=int, default=24)
    ap.add_argument("--lookback", type=int, default=400)
    ap.add_argument("--samples", type=int, default=20)
    ap.add_argument("--model", default="NeoQuasar/Kronos-small")
    ap.add_argument("--tokenizer", default="NeoQuasar/Kronos-Tokenizer-base")
    ap.add_argument("--kronos", default=os.environ.get("KRONOS_DIR", "/workspace/kronos"), help="path of the Kronos repo checkout")
    ap.add_argument("--csv", help="read bars from this CSV instead of Yahoo")
    ap.add_argument("--out", help="write the json here too")
    ap.add_argument("--temperature", type=float, default=1.0)
    ap.add_argument("--top_p", type=float, default=0.9)
    a = ap.parse_args()
    t0 = time.time()
    rows, step = read_csv(a.csv, a.lookback) if a.csv else fetch_yahoo(a.symbol, a.interval, a.lookback)
    if len(rows) < 64:
        print(json.dumps({"error": f"only {len(rows)} bars for {a.symbol} {a.interval}"})); sys.exit(2)
    sys.path.insert(0, a.kronos)
    import numpy as np, pandas as pd, torch
    from model import Kronos, KronosTokenizer, KronosPredictor
    torch.set_num_threads(max(1, os.cpu_count() or 1))
    tok = KronosTokenizer.from_pretrained(a.tokenizer)
    mdl = Kronos.from_pretrained(a.model)
    pred = KronosPredictor(mdl, tok, device="cpu", max_context=512)
    df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "volume"])
    df["amount"] = df["volume"] * df[["open", "high", "low", "close"]].mean(axis=1)
    x_ts = pd.Series(pd.to_datetime(df["t"], unit="s"))
    fut = future_times(int(df["t"].iloc[-1]), step, a.pred, a.interval == "1d")
    y_ts = pd.Series(pd.to_datetime(fut, unit="s"))
    x_df = df[["open", "high", "low", "close", "volume", "amount"]]
    paths = []
    for _ in range(max(1, a.samples)):
        p = pred.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=a.pred, T=a.temperature, top_p=a.top_p, sample_count=1, verbose=False)
        paths.append(p[["open", "high", "low", "close"]].values)
    P = np.array(paths)  # samples x pred x 4
    last = float(df["close"].iloc[-1])
    close = P[:, :, 3]
    mean_close, p10, p90 = close.mean(0), np.percentile(close, 10, axis=0), np.percentile(close, 90, axis=0)
    final = close[:, -1]
    out = {
        "symbol": a.symbol, "interval": a.interval, "step_sec": step, "model": a.model, "samples": int(len(paths)), "lookback": int(len(df)), "pred_len": a.pred,
        "last_time": int(df["t"].iloc[-1]), "last_close": round(last, 6), "times": fut,
        "mean_close": [round(float(v), 6) for v in mean_close], "p10": [round(float(v), 6) for v in p10], "p90": [round(float(v), 6) for v in p90],
        "mean_high": [round(float(v), 6) for v in P[:, :, 1].mean(0)], "mean_low": [round(float(v), 6) for v in P[:, :, 2].mean(0)],
        "prob_up": round(float((final > last).mean()), 3), "exp_move_pct": round(float((final.mean() - last) / last * 100), 3),
        "max_up_pct": round(float((P[:, :, 1].max(axis=1).mean() - last) / last * 100), 3), "max_down_pct": round(float((P[:, :, 2].min(axis=1).mean() - last) / last * 100), 3),
        "band_pct": round(float((p90[-1] - p10[-1]) / last * 100), 3), "elapsed_s": round(time.time() - t0, 1),
    }
    s = json.dumps(out)
    if a.out:
        with open(a.out, "w") as f:
            f.write(s)
    print(s)


if __name__ == "__main__":
    main()
