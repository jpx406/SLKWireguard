// Live price stream. One Durable Object ("the hub") keeps ONE websocket to Alpaca per feed (stocks, crypto) and
// fans the trades out to every open desk page, so prices move when they trade instead of every 10 seconds.
// Why a hub: Alpaca allows one stream connection per account, and the API keys must never reach the browser.
//   browser ──ws──▶ Worker (/api/stream, signed-in users only) ──▶ QuoteHub ──ws──▶ Alpaca
// The hub subscribes to the union of what the open pages ask for (capped: the free IEX plan allows 30 symbols),
// keeps only the newest trade per symbol and sends changes four times a second. With no page connected it drops
// the Alpaca connection after a short grace period, so it costs nothing while nobody is looking.
// Read-only market data: nothing here can place an order.
import type { Env } from "./env";

const FLUSH_MS = 250, IDLE_CLOSE_MS = 30_000, MAX_PER_CLIENT = 80;
const CAP = { iex: 30, sip: 400, crypto: 30 } as const;
const SYMBOL = /^[A-Z0-9.^=-]{1,15}$/;
const isCrypto = (s: string) => /-(USD|USDT|USDC|EUR|BTC|ETH)$/.test(s);
/** Desk symbol -> the feed's symbol: BRK-B -> BRK.B (stocks), BTC-USD -> BTC/USD (crypto). null = not streamable. */
export const feedSymbol = (s: string) => (/[\^=]/.test(s) ? null : isCrypto(s) ? s.replace("-", "/") : s.replace(/-/g, "."));

type Kind = "stocks" | "crypto";
type Up = { ws: WebSocket | null; state: "off" | "connecting" | "live" | "error"; detail: string; subs: Set<string>; retry: number; timer: ReturnType<typeof setTimeout> | null; authed: boolean };
type Tick = { p: number; t: number; s: number };

export class QuoteHub {
  private clients = new Map<WebSocket, Set<string>>();
  private up: Record<Kind, Up> = { stocks: this.fresh(), crypto: this.fresh() };
  private feed: "iex" | "sip" = "iex";
  private last = new Map<string, Tick>();       // newest trade per desk symbol
  private dirty = new Set<string>();
  private toDesk = new Map<string, string>();   // feed symbol -> desk symbol
  private flusher: ReturnType<typeof setInterval> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  constructor(_ctx: unknown, private env: Env) {}
  private fresh(): Up { return { ws: null, state: "off", detail: "", subs: new Set(), retry: 0, timer: null, authed: false }; }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a websocket", { status: 426 });
    const f = new URL(req.url).searchParams.get("feed"); if (f === "sip" || f === "iex") { if (f !== this.feed && this.up.stocks.ws) this.drop("stocks"); this.feed = f; }
    const pair = new WebSocketPair(), server = pair[1];
    server.accept(); this.clients.set(server, new Set());
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    server.addEventListener("message", (e) => this.onClient(server, e.data));
    const bye = () => { this.clients.delete(server); this.resubscribe(); };
    server.addEventListener("close", bye); server.addEventListener("error", bye);
    this.flusher ??= setInterval(() => this.flush(), FLUSH_MS);
    this.send(server, this.status());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private send(ws: WebSocket, msg: unknown) { try { ws.send(JSON.stringify(msg)); } catch { this.clients.delete(ws); } }
  private status() { return { t: "status", stocks: this.up.stocks.state, crypto: this.up.crypto.state, feed: this.feed, detail: this.up.stocks.detail || this.up.crypto.detail || "", cap: CAP[this.feed], streaming: [...this.up.stocks.subs, ...this.up.crypto.subs].map((s) => this.toDesk.get(s) || s) }; }
  private broadcast(msg: unknown) { for (const ws of this.clients.keys()) this.send(ws, msg); }

  private onClient(ws: WebSocket, raw: unknown) {
    if (raw === "ping") { try { ws.send("pong"); } catch { /* gone */ } return; }
    let m: { subscribe?: unknown }; try { m = JSON.parse(String(raw)); } catch { return; }
    if (!Array.isArray(m.subscribe)) return;
    const want = new Set<string>();
    for (const x of m.subscribe.slice(0, MAX_PER_CLIENT)) { const s = String(x).toUpperCase(); if (SYMBOL.test(s) && feedSymbol(s)) want.add(s); }
    this.clients.set(ws, want);
    // What is already known goes out at once, so a new page does not wait for the next trade.
    const known = [...want].filter((s) => this.last.has(s)).map((s) => { const k = this.last.get(s)!; return [s, k.p, k.t, k.s]; });
    if (known.length) this.send(ws, { t: "q", d: known });
    this.resubscribe();
  }

  /** Make the two Alpaca subscriptions match what the open pages want. Symbols asked for by more pages win the cap. */
  private resubscribe() {
    const count = new Map<string, number>();
    for (const set of this.clients.values()) for (const s of set) count.set(s, (count.get(s) || 0) + 1);
    const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const plan: Record<Kind, string[]> = { stocks: ranked.filter((s) => !isCrypto(s)).slice(0, CAP[this.feed]), crypto: ranked.filter(isCrypto).slice(0, CAP.crypto) };
    if (!this.clients.size) { this.idle ??= setTimeout(() => { this.idle = null; if (!this.clients.size) this.shutdown(); }, IDLE_CLOSE_MS); return; }
    for (const kind of ["stocks", "crypto"] as Kind[]) {
      const u = this.up[kind], want = new Set(plan[kind].map((s) => { const f = feedSymbol(s)!; this.toDesk.set(f, s); return f; }));
      if (!want.size) { if (u.ws) this.drop(kind); continue; }
      if (!u.ws) { u.subs = want; if (!u.timer) this.connect(kind); continue; }
      if (!u.authed) { u.subs = want; continue; }
      const add = [...want].filter((s) => !u.subs.has(s)), del = [...u.subs].filter((s) => !want.has(s));
      try { if (del.length) u.ws.send(JSON.stringify({ action: "unsubscribe", trades: del })); if (add.length) u.ws.send(JSON.stringify({ action: "subscribe", trades: add })); } catch { /* the close handler reconnects */ }
      u.subs = want;
    }
  }

  private async connect(kind: Kind) {
    const u = this.up[kind]; if (u.ws || !this.clients.size) return;
    const key = this.env.ALPACA_KEY_ID, secret = this.env.ALPACA_SECRET_KEY;
    if (!key || !secret) { u.state = "off"; u.detail = "Alpaca keys are not set"; this.broadcast(this.status()); return; }
    const base = (this.env.ALPACA_STREAM_BASE || "https://stream.data.alpaca.markets").replace(/\/$/, "");
    u.state = "connecting"; u.authed = false; this.broadcast(this.status());
    try {
      const res = await fetch(`${base}${kind === "stocks" ? `/v2/${this.feed}` : "/v1beta3/crypto/us"}`, { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket; if (!ws) throw new Error(`Alpaca stream answered ${res.status}`);
      ws.accept(); u.ws = ws;
      ws.addEventListener("message", (e) => this.onFeed(kind, ws, e.data));
      const lost = () => { if (u.ws !== ws) return; u.ws = null; u.authed = false; if (u.state !== "error") u.state = "connecting"; this.broadcast(this.status()); this.retry(kind); };
      ws.addEventListener("close", lost); ws.addEventListener("error", lost);
      ws.send(JSON.stringify({ action: "auth", key, secret }));
    } catch (e) { u.state = "error"; u.detail = String((e as Error).message || e).slice(0, 160); this.broadcast(this.status()); this.retry(kind); }
  }
  /** Reconnect with a growing pause (2 s … 2 min); a refusal that will not fix itself waits 5 minutes. */
  private retry(kind: Kind, long = false) {
    const u = this.up[kind]; if (u.timer || !this.clients.size) return;
    const wait = long ? 300_000 : Math.min(120_000, 2000 * 2 ** Math.min(u.retry++, 6));
    u.timer = setTimeout(() => { u.timer = null; if (this.clients.size && u.subs.size) this.connect(kind); }, wait);
  }
  private drop(kind: Kind) { const u = this.up[kind], ws = u.ws; if (u.timer) clearTimeout(u.timer); this.up[kind] = this.fresh(); try { ws?.close(1000, "no subscribers"); } catch { /* already closed */ } }
  private shutdown() { this.drop("stocks"); this.drop("crypto"); if (this.flusher) { clearInterval(this.flusher); this.flusher = null; } this.dirty.clear(); }

  private onFeed(kind: Kind, ws: WebSocket, raw: unknown) {
    const u = this.up[kind]; if (u.ws !== ws) return;
    let arr: Record<string, unknown>[]; try { const j = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)); arr = Array.isArray(j) ? j : [j]; } catch { return; }
    for (const m of arr) {
      if (m.T === "t") { // a trade
        const desk = this.toDesk.get(String(m.S)), p = Number(m.p); if (!desk || !(p > 0)) continue;
        const t = Date.parse(String(m.t)) || Date.now(), prev = this.last.get(desk);
        if (prev && t < prev.t) continue; // late print
        this.last.set(desk, { p, t, s: Number(m.s) || 0 }); this.dirty.add(desk);
      } else if (m.T === "success" && m.msg === "authenticated") {
        u.authed = true; u.state = "live"; u.detail = ""; u.retry = 0;
        try { ws.send(JSON.stringify({ action: "subscribe", trades: [...u.subs] })); } catch { /* close handler */ }
        this.broadcast(this.status());
      } else if (m.T === "error") {
        const code = Number(m.code), msg = String(m.msg || "stream error").slice(0, 120);
        // 405 = more symbols than the plan allows: halve the list and carry on. 402/406 = bad keys / another connection is open: wait.
        if (code === 405 && u.subs.size > 1) { const keep = [...u.subs].slice(0, Math.floor(u.subs.size / 2)); u.subs = new Set(keep); try { ws.send(JSON.stringify({ action: "subscribe", trades: keep })); } catch { /* close handler */ } u.detail = `Alpaca allows fewer symbols on this plan: streaming ${keep.length}`; this.broadcast(this.status()); continue; }
        u.state = "error"; u.detail = code === 406 ? "Alpaca allows one stream connection and another one is open (another app or tab using the same keys)" : code === 402 || code === 401 ? "Alpaca rejected the keys" : `Alpaca: ${msg}`;
        this.broadcast(this.status());
        if (code === 401 || code === 402 || code === 406 || code === 409) { u.ws = null; u.authed = false; try { ws.close(1000, "refused"); } catch { /* closed */ } this.retry(kind, true); }
      }
    }
  }

  private flush() {
    if (!this.dirty.size) return;
    const changed = [...this.dirty]; this.dirty.clear();
    for (const [ws, want] of this.clients) {
      const d = changed.filter((s) => want.has(s)).map((s) => { const k = this.last.get(s)!; return [s, k.p, k.t, k.s]; });
      if (d.length) this.send(ws, { t: "q", d });
    }
  }
}

/** Worker side of /api/stream: only for signed-in users, only when Alpaca is the active source. */
export async function streamRoute(req: Request, env: Env, active: string): Promise<Response> {
  const json = (o: unknown, status: number) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ available: !!env.QUOTE_HUB && active.startsWith("alpaca"), source: active, detail: !env.QUOTE_HUB ? "The stream is not deployed (wrangler.toml has no QUOTE_HUB binding)." : active.startsWith("alpaca") ? "Live stream available." : "Streaming needs Alpaca keys; prices are polled from Yahoo." }, 200);
  if (!env.QUOTE_HUB) return json({ detail: "Stream not deployed." }, 503);
  // A websocket carries the session cookie from any site, so only this desk's own pages may open one.
  const origin = req.headers.get("Origin"), host = new URL(req.url).host;
  if (origin && new URL(origin).host !== host && origin !== env.DEV_ORIGIN) return json({ detail: "Cross-site stream refused." }, 403);
  if (!active.startsWith("alpaca")) return json({ detail: "Streaming needs Alpaca as the data source." }, 409);
  const hub = env.QUOTE_HUB.get(env.QUOTE_HUB.idFromName("hub"));
  return hub.fetch(new Request(`https://hub/stream?feed=${active === "alpaca_sip" ? "sip" : "iex"}`, { headers: { Upgrade: "websocket" } }));
}
