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

export type Identity = { email: string; user: string; role: "admin" | "user"; ai: boolean; must_change?: boolean; recovery?: boolean };
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
// Every account, the admin included, lives in D1 with a salted PBKDF2 hash. A new account (and the admin on
// a fresh database) starts with INITIAL_PASSWORD and must choose its own at the first sign-in: until then the
// API answers nothing but the password change. Sessions are HMAC-signed cookies whose key derives from the
// LOGIN_PASSWORD secret (changing it logs everyone out); a password change bumps the session version, which
// logs out that user's other devices. LOGIN_PASSWORD also works as a recovery password for "admin": it always
// signs the admin in and lets them set a new password without the current one.
export const INITIAL_PASSWORD = "Welcome1234";
const COOKIE = "desk_session";
const SESSION_DAYS = 30;
const PBKDF2_ITER = 100_000;
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

type UserRow = { id: string; salt: string; hash: string; role: string; ai: number; ver: number; created_at: string; must_change?: number };

let usersReady = false;
export async function ensureUsers(db: D1Database) {
  if (usersReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', ai INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`),
    db.prepare("CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)"),
  ]);
  try { await db.prepare("ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0").run(); } catch { /* exists */ }
  if (!(await db.prepare("SELECT 1 FROM users WHERE id = 'admin'").first())) {
    const h = await hashPassword(INITIAL_PASSWORD);
    await db.prepare("INSERT OR IGNORE INTO users (id, salt, hash, role, ai, ver, must_change) VALUES ('admin', ?, ?, 'admin', 1, 1, 1)").bind(h.salt, h.hash).run();
  }
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

async function issueCookie(env: Env, user: string, ver: number, recovery = false) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${recovery ? "v2r" : "v2"}.${user}.${ver}.${exp}`;
  const sig = b64url(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload)));
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

async function sessionIdentity(req: Request, env: Env): Promise<Identity | null> {
  const v = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const m0 = v?.match(/^(v2r?)\.([a-z0-9_.-]{3,32})\.(\d{1,9})\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if (!m0 || Number(m0[4]) < Date.now() / 1000) return null;
  const recovery = m0[1] === "v2r", m = m0.slice(1);
  const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), b64urlDecode(m[4]), enc.encode(`${m0[1]}.${m[1]}.${m[2]}.${m[3]}`));
  if (!ok || (recovery && m[1] !== "admin")) return null;
  await ensureUsers(env.DB);
  const row = await env.DB.prepare("SELECT id, role, ai, ver, must_change FROM users WHERE id = ?").bind(m[1]).first<UserRow>();
  if (!row || row.ver !== Number(m[2])) return null; // deleted, or password changed since
  const admin = row.role === "admin" || row.id === "admin";
  return { email: row.id, user: row.id, role: admin ? "admin" : "user", ai: !!row.ai || admin, must_change: !!row.must_change && !recovery, recovery };
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
  let ok = false, ver = 0, recovery = false, mustChange = false;
  if (password && password.length <= 512 && USERNAME_RE.test(username)) {
    const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(username).first<UserRow>();
    const h = await hashPassword(password, row?.salt); // hash even for unknown users, so timing doesn't reveal them
    if (row) { ok = await sameSecret(h.hash, row.hash); ver = row.ver; mustChange = !!row.must_change; }
    // The LOGIN_PASSWORD secret always signs the admin in (recovery): no forced change, and a new password can be set.
    if (!ok && row && username === "admin" && (await sameSecret(password, env.LOGIN_PASSWORD))) { ok = true; recovery = true; mustChange = false; }
  }
  if (!ok) {
    await db.prepare("INSERT INTO login_failures (ip, at) VALUES (?, ?)").bind(ip, Math.floor(Date.now() / 1000)).run();
    return deny(401, "Wrong username or password.");
  }
  await db.prepare("DELETE FROM login_failures WHERE ip = ?").bind(ip).run();
  return new Response(JSON.stringify({ ok: true, user: username, must_change: mustChange }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": await issueCookie(env, username, ver, recovery) },
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
  const { results } = await db.prepare("SELECT id, role, ai, created_at, must_change FROM users ORDER BY id = 'admin' DESC, id").all<UserRow>();
  return results.map((u) => ({ id: u.id, role: u.id === "admin" ? "admin" : u.role, ai: !!u.ai || u.id === "admin", created_at: u.created_at, must_change: !!u.must_change }));
}

export function checkNewPassword(p: string) {
  if (p.length < 10) return "Passwords need at least 10 characters.";
  if (p.length > 200) return "Password too long.";
  if (p === INITIAL_PASSWORD) return "Choose a password different from the initial one.";
  return null;
}

export async function createUser(db: D1Database, id: string, password: string, ai: boolean, role: "user" | "admin") {
  await ensureUsers(db);
  if (!USERNAME_RE.test(id) || id === "admin") return "Usernames are 3-32 characters: a-z, 0-9, . _ - (and not \"admin\").";
  // No password given: the account starts with the initial password and must change it at the first sign-in.
  const initial = !password || password === INITIAL_PASSWORD;
  const bad = initial ? null : checkNewPassword(password);
  if (bad) return bad;
  if (await db.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first()) return "That username already exists.";
  const h = await hashPassword(initial ? INITIAL_PASSWORD : password);
  await db.prepare("INSERT INTO users (id, salt, hash, role, ai, ver, must_change) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(id, h.salt, h.hash, role, ai ? 1 : 0, initial ? 1 : 0).run();
  return null;
}

export async function updateUser(db: D1Database, id: string, patch: { password?: string; reset?: boolean; ai?: boolean; role?: "user" | "admin" }) {
  await ensureUsers(db);
  if (!(await db.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first())) return "No such user.";
  if (id === "admin" && (patch.ai !== undefined || patch.role !== undefined)) return "The admin account always keeps its role and Claude access.";
  if (patch.reset) {
    // Back to the initial password; the user must choose a new one at the next sign-in.
    const h = await hashPassword(INITIAL_PASSWORD);
    await db.prepare("UPDATE users SET salt = ?, hash = ?, ver = ver + 1, must_change = 1 WHERE id = ?").bind(h.salt, h.hash, id).run();
  } else if (patch.password !== undefined) {
    const bad = checkNewPassword(patch.password);
    if (bad) return bad;
    const h = await hashPassword(patch.password);
    await db.prepare("UPDATE users SET salt = ?, hash = ?, ver = ver + 1, must_change = 0 WHERE id = ?").bind(h.salt, h.hash, id).run();
  }
  if (patch.ai !== undefined) await db.prepare("UPDATE users SET ai = ? WHERE id = ?").bind(patch.ai ? 1 : 0, id).run();
  if (patch.role !== undefined) await db.prepare("UPDATE users SET role = ?, ver = ver + 1 WHERE id = ?").bind(patch.role, id).run();
  return null;
}

export async function deleteUser(db: D1Database, id: string) {
  await ensureUsers(db);
  if (id === "admin") return;
  await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
}

/** A user changes their own password (must know the current one); returns a fresh cookie. */
export async function changeOwnPassword(env: Env, who: Identity, current: string, next: string): Promise<Response> {
  if (!env.LOGIN_PASSWORD) return deny(400, "Password login is not enabled.");
  await ensureUsers(env.DB);
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(who.user).first<UserRow>();
  if (!row) return deny(400, "No such user.");
  // A recovery session (admin signed in with the LOGIN_PASSWORD secret) may set a new password without the current one.
  if (!who.recovery && !(await sameSecret((await hashPassword(current, row.salt)).hash, row.hash))) return deny(401, "Current password is wrong.");
  if (await sameSecret((await hashPassword(next, row.salt)).hash, row.hash)) return deny(400, "The new password must be different from the current one.");
  const err = await updateUser(env.DB, who.user, { password: next });
  if (err) return deny(400, err);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Set-Cookie": await issueCookie(env, who.user, row.ver + 1) },
  });
}
