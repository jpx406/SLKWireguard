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

export type Identity = { email: string; user: string; role: "admin" | "user"; ai: boolean };
const ADMIN = (email: string): Identity => ({ email, user: "admin", role: "admin", ai: true });

export async function authenticate(req: Request, env: Env): Promise<Identity | Response> {
  if (env.DEV_NO_AUTH === "1") return ADMIN("dev@localhost");
  if (env.LOGIN_PASSWORD) {
    return (await sessionIdentity(req, env)) ?? Response.json({ detail: "Please log in.", login: true }, { status: 401 });
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
  return ADMIN(String(payload.email || payload.sub || ""));
}

const deny = (status: number, detail: string) => Response.json({ detail }, { status });

// ---------------------------------------------------------------------------------------- password mode
// The admin logs in as "admin" with the LOGIN_PASSWORD secret. The admin can add users; their
// passwords are stored as salted PBKDF2 hashes in D1. Sessions are HMAC-signed cookies whose key
// derives from LOGIN_PASSWORD (changing it logs everyone out); a user's own password change bumps
// their session version, which logs out that user's other devices.
const COOKIE = "desk_session";
const SESSION_DAYS = 30;
const PBKDF2_ITER = 100_000;
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

type UserRow = { id: string; salt: string; hash: string; role: string; ai: number; ver: number; created_at: string };

let usersReady = false;
export async function ensureUsers(db: D1Database) {
  if (usersReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', ai INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`),
    db.prepare("CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)"),
  ]);
  usersReady = true;
}

async function sessionKey(env: Env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`trading-desk-session:${env.LOGIN_PASSWORD}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hashPassword(password: string, saltB64?: string) {
  const salt = saltB64 ? b64urlDecode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64url(salt), hash: b64url(bits) };
}

async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function issueCookie(env: Env, user: string, ver: number) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `v2.${user}.${ver}.${exp}`;
  const sig = b64url(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload)));
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

async function sessionIdentity(req: Request, env: Env): Promise<Identity | null> {
  const v = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const m = v?.match(/^v2\.([a-z0-9_.-]{3,32})\.(\d{1,9})\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if (!m || Number(m[3]) < Date.now() / 1000) return null;
  const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), b64urlDecode(m[4]), enc.encode(`v2.${m[1]}.${m[2]}.${m[3]}`));
  if (!ok) return null;
  if (m[1] === "admin") return { email: "admin", user: "admin", role: "admin", ai: true };
  await ensureUsers(env.DB);
  const row = await env.DB.prepare("SELECT id, role, ai, ver FROM users WHERE id = ?").bind(m[1]).first<UserRow>();
  if (!row || row.ver !== Number(m[2])) return null; // deleted, or password changed since
  return { email: row.id, user: row.id, role: row.role === "admin" ? "admin" : "user", ai: !!row.ai || row.role === "admin" };
}

/** POST /api/login {username, password}. Max 5 failures per IP and 30 overall per 15 minutes. */
export async function login(req: Request, env: Env): Promise<Response> {
  if (!env.LOGIN_PASSWORD) return deny(400, "Password login is not enabled.");
  const db = env.DB;
  await ensureUsers(db);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const since = Math.floor(Date.now() / 1000) - 900;
  await db.prepare("DELETE FROM login_failures WHERE at < ?").bind(since).run();
  const mine = await db.prepare("SELECT COUNT(*) AS n FROM login_failures WHERE ip = ?").bind(ip).first<{ n: number }>();
  const all = await db.prepare("SELECT COUNT(*) AS n FROM login_failures").first<{ n: number }>();
  if ((mine?.n ?? 0) >= 5 || (all?.n ?? 0) >= 30) return deny(429, "Too many wrong passwords. Wait 15 minutes and try again.");

  let username = "", password = "";
  try {
    const b = (await req.json()) as { username?: unknown; password?: unknown };
    username = String(b.username ?? "").trim().toLowerCase() || "admin";
    password = String(b.password ?? "");
  } catch { /* empty */ }
  let ok = false, ver = 0;
  if (password && password.length <= 512) {
    if (username === "admin") ok = await sameSecret(password, env.LOGIN_PASSWORD);
    else if (USERNAME_RE.test(username)) {
      const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(username).first<UserRow>();
      const h = await hashPassword(password, row?.salt); // hash even for unknown users, so timing doesn't reveal them
      if (row) { ok = await sameSecret(h.hash, row.hash); ver = row.ver; }
    }
  }
  if (!ok) {
    await db.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
    return deny(401, "Wrong username or password.");
  }
  await db.prepare("DELETE FROM login_failures WHERE ip = ?").bind(ip).run();
  return new Response(JSON.stringify({ ok: true, user: username }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": await issueCookie(env, username, ver) },
  });
}

export function logout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
  });
}

// ---------------------------------------------------------------------------------------- user admin
export async function listUsers(db: D1Database) {
  await ensureUsers(db);
  const { results } = await db.prepare("SELECT id, role, ai, created_at FROM users ORDER BY id").all<UserRow>();
  return results.map((u) => ({ id: u.id, role: u.role, ai: !!u.ai, created_at: u.created_at }));
}

export function checkNewPassword(p: string) {
  if (p.length < 10) return "Passwords need at least 10 characters.";
  if (p.length > 200) return "Password too long.";
  return null;
}

export async function createUser(db: D1Database, id: string, password: string, ai: boolean, role: "user" | "admin") {
  await ensureUsers(db);
  if (!USERNAME_RE.test(id) || id === "admin") return "Usernames are 3-32 characters: a-z, 0-9, . _ - (and not \"admin\").";
  const bad = checkNewPassword(password);
  if (bad) return bad;
  if (await db.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first()) return "That username already exists.";
  const h = await hashPassword(password);
  await db.prepare("INSERT INTO users (id, salt, hash, role, ai, ver) VALUES (?, ?, ?, ?, ?, 1)").bind(id, h.salt, h.hash, role, ai ? 1 : 0).run();
  return null;
}

export async function updateUser(db: D1Database, id: string, patch: { password?: string; ai?: boolean; role?: "user" | "admin" }) {
  await ensureUsers(db);
  if (!(await db.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first())) return "No such user.";
  if (patch.password !== undefined) {
    const bad = checkNewPassword(patch.password);
    if (bad) return bad;
    const h = await hashPassword(patch.password);
    await db.prepare("UPDATE users SET salt = ?, hash = ?, ver = ver + 1 WHERE id = ?").bind(h.salt, h.hash, id).run();
  }
  if (patch.ai !== undefined) await db.prepare("UPDATE users SET ai = ? WHERE id = ?").bind(patch.ai ? 1 : 0, id).run();
  if (patch.role !== undefined) await db.prepare("UPDATE users SET role = ?, ver = ver + 1 WHERE id = ?").bind(patch.role, id).run();
  return null;
}

export async function deleteUser(db: D1Database, id: string) {
  await ensureUsers(db);
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

/** A user changes their own password (must know the current one); returns a fresh cookie. */
export async function changeOwnPassword(env: Env, who: Identity, current: string, next: string): Promise<Response> {
  if (who.user === "admin") return deny(400, "The admin password is the LOGIN_PASSWORD secret. Change it with: wrangler secret put LOGIN_PASSWORD");
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(who.user).first<UserRow>();
  if (!row || !(await sameSecret((await hashPassword(current, row.salt)).hash, row.hash))) return deny(401, "Current password is wrong.");
  const err = await updateUser(env.DB, who.user, { password: next });
  if (err) return deny(400, err);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": await issueCookie(env, who.user, row.ver + 1) },
  });
}
