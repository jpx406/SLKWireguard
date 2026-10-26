// Login for the API. Two modes, chosen by configuration (fails closed if neither is set):
//  - password: LOGIN_PASSWORD secret + signed, HttpOnly session cookie (no Cloudflare Access needed)
//  - Cloudflare Access: verifies the Access JWT (ACCESS_TEAM_DOMAIN + ACCESS_AUD)
// DEV_NO_AUTH=1 (local `wrangler dev` only) skips both.
import type { Env } from "./env";

type Jwk = JsonWebKey & { kid: string };
let certCache: { team: string; keys: Jwk[]; at: number } | null = null;

const b64urlDecode = (s: string): Uint8Array => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

async function accessKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && certCache && certCache.team === team && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access certs ${r.status}`);
  const keys = ((await r.json()) as { keys: Jwk[] }).keys;
  certCache = { team, keys, at: Date.now() };
  return keys;
}

export type Identity = { email: string };

export async function authenticate(req: Request, env: Env): Promise<Identity | Response> {
  if (env.DEV_NO_AUTH === "1") return { email: "dev@localhost" };
  if (env.LOGIN_PASSWORD) {
    return (await validSession(req, env)) ? { email: "owner" } : Response.json({ detail: "Please log in.", login: true }, { status: 401 });
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
    return deny(503, "No login is configured. Set a password with:  .\\node_modules\\.bin\\wrangler.cmd secret put LOGIN_PASSWORD");
  return authenticateAccess(req, env);
}

async function authenticateAccess(req: Request, env: Env): Promise<Identity | Response> {
  const team = (env.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!team || !env.ACCESS_AUD) return deny(503, "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD).");
  // Access sends the login as a header; the CF_Authorization cookie carries the same signed token.
  const cookie = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith("CF_Authorization="))?.slice(17);
  const token = req.headers.get("cf-access-jwt-assertion") || cookie;
  if (!token)
    return deny(401, `No Cloudflare Access login reached the app for ${new URL(req.url).hostname}. Cloudflare Access is not protecting this hostname: check that the Access application's public hostname is exactly this one (no path) and that its policy action is Allow (not Bypass), then open the site in a private window. You should see a Cloudflare login page first.`);
  let header, payload, h, p, s;
  try {
    [h, p, s] = token.split(".");
    header = decodeJson(h); payload = decodeJson(p);
  } catch {
    return deny(401, "Malformed Cloudflare Access token. Reload the page.");
  }
  if (header.alg !== "RS256") return deny(401, "Bad token algorithm.");
  // Specific reasons, so a wrong setting is easy to spot (none of these reveal secrets).
  if (payload.iss !== `https://${team}`)
    return deny(401, `ACCESS_TEAM_DOMAIN is "${team}" but this login came from "${String(payload.iss).replace("https://", "")}". Fix ACCESS_TEAM_DOMAIN in wrangler.toml and redeploy.`);
  const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD))
    return deny(401, "ACCESS_AUD does not match this Access application's Audience (AUD) Tag. Copy the tag again from Zero Trust > Access > Applications, fix wrangler.toml and redeploy.");
  const now = Date.now() / 1000;
  if (!(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) return deny(401, "Your Cloudflare login expired. Reload the page.");
  try {
    let key = (await accessKeys(team)).find((k) => k.kid === header.kid);
    if (!key) key = (await accessKeys(team, true)).find((k) => k.kid === header.kid); // key rotation
    if (!key) return deny(401, "Unknown signing key.");
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return deny(401, "Invalid Cloudflare Access token signature.");
  } catch (e) {
    return deny(503, `Could not verify the login with ${team}: ${(e as Error).message}`);
  }
  return { email: String(payload.email || payload.sub || "") };
}

const deny = (status: number, detail: string) => Response.json({ detail }, { status });

// ---------------------------------------------------------------------------------------- password mode
const COOKIE = "desk_session";
const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The signing key is derived from the password, so changing the password logs out every session.
async function sessionKey(env: Env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`trading-desk-session:${env.LOGIN_PASSWORD}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function validSession(req: Request, env: Env): Promise<boolean> {
  const v = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const m = v?.match(/^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return crypto.subtle.verify("HMAC", await sessionKey(env), b64urlDecode(m[2]), enc.encode(`v1.${m[1]}`));
}

async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** POST /api/login {password}. Max 5 failures per IP and 30 overall per 15 minutes. */
export async function login(req: Request, env: Env): Promise<Response> {
  if (!env.LOGIN_PASSWORD) return deny(400, "Password login is not enabled.");
  const db = env.DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)").run();
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const since = Math.floor(Date.now() / 1000) - 900;
  await db.prepare("DELETE FROM login_failures WHERE at < ?").bind(since).run();
  const mine = await db.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ?").bind(ip).first<{ n: number }>();
  const all = await db.prepare("SELECT COUNT(*) AS n FROM login_failures").first<{ n: number }>();
  if ((mine?.n ?? 0) >= 5 || (all?.n ?? 0) >= 30) return deny(429, "Too many wrong passwords. Wait 15 minutes and try again.");

  let password = "";
  try { password = String(((await req.json()) as { password?: unknown }).password ?? ""); } catch { /* empty */ }
  if (!password || password.length > 512 || !(await sameSecret(password, env.LOGIN_PASSWORD))) {
    await db.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
    return deny(401, "Wrong password.");
  }
  await db.prepare("DELETE FROM login_failures WHERE ip = ?").bind(ip).run();
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = b64url(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(`v1.${exp}`)));
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE}=v1.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
    },
  });
}

export function logout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
  });
}
