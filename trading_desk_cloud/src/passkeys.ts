// Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello or an Android fingerprint.
// A signed-in user registers the device; later the device signs a one-time challenge and the desk checks the
// signature against the stored public key. Attestation is "none": the key is accepted from the user's own
// authenticated session, so no CBOR parsing is needed. Only platform authenticators with user verification.
import type { Env } from "./env";
import { ensureUsers, issueCookie, noteLoginFailure, loginLocked, type Identity } from "./auth";

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string): Uint8Array => { s = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const B64 = /^[A-Za-z0-9_-]{1,4096}$/;
const deny = (status: number, detail: string) => Response.json({ detail }, { status });
const ALGS: Record<number, { imp: { name: string; namedCurve?: string; hash?: string }; ver: { name: string; hash?: string } }> = {
  [-7]: { imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" } },
  [-257]: { imp: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, ver: { name: "RSASSA-PKCS1-v1_5" } },
};

let ready = false;
async function ensure(db: D1Database) {
  if (ready) return;
  await ensureUsers(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, user TEXT NOT NULL, pub TEXT NOT NULL, alg INTEGER NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0, name TEXT, created_at TEXT DEFAULT (datetime('now')), last_used TEXT)`),
    db.prepare("CREATE TABLE IF NOT EXISTS passkey_challenges (challenge TEXT PRIMARY KEY, user TEXT, exp INTEGER NOT NULL)"),
  ]);
  ready = true;
}

async function newChallenge(db: D1Database, user: string | null) {
  const now = Math.floor(Date.now() / 1000), c = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([db.prepare("DELETE FROM passkey_challenges WHERE exp < ?").bind(now), db.prepare("INSERT INTO passkey_challenges (challenge, user, exp) VALUES (?, ?, ?)").bind(c, user, now + 300)]);
  return c;
}
/** A challenge is good once, for five minutes, for the purpose it was made for. */
async function useChallenge(db: D1Database, c: string, user: string | null) {
  const row = await db.prepare("DELETE FROM passkey_challenges WHERE challenge = ? RETURNING user, exp").bind(c).first<{ user: string | null; exp: number }>();
  return !!row && row.exp >= Date.now() / 1000 && row.user === user;
}

function clientData(raw: Uint8Array, type: string, origin: string): { challenge: string } | string {
  let d: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  try { d = JSON.parse(new TextDecoder().decode(raw)); } catch { return "Malformed response from the device."; }
  if (d.type !== type || typeof d.challenge !== "string") return "Unexpected response from the device.";
  if (d.origin !== origin || d.crossOrigin === true) return "This sign-in came from a different site.";
  return { challenge: d.challenge };
}

/** ECDSA signatures arrive as ASN.1 DER; WebCrypto wants r||s. */
function derToRaw(der: Uint8Array): Uint8Array | null {
  let i = 0; if (der[i++] !== 0x30) return null;
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f); else i++;
  const out = new Uint8Array(64);
  for (const off of [0, 32]) {
    if (der[i++] !== 0x02) return null;
    const len = der[i++]; let v = der.subarray(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    out.set(v, off + 32 - v.length);
  }
  return out;
}

export async function listPasskeys(db: D1Database, user: string) {
  await ensure(db);
  const { results } = await db.prepare("SELECT id, name, created_at, last_used FROM passkeys WHERE user = ? ORDER BY created_at").bind(user).all<{ id: string; name: string | null; created_at: string; last_used: string | null }>();
  return results;
}

/** Step 1 of setting a device up: the options for navigator.credentials.create(). */
export async function registerOptions(env: Env, who: Identity, host: string) {
  await ensure(env.DB);
  const mine = await listPasskeys(env.DB, who.user);
  return {
    challenge: await newChallenge(env.DB, who.user), rp: { id: host, name: "JP97 Trading Desk" },
    user: { id: b64url(enc.encode(who.user)), name: who.user, displayName: who.user },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: mine.map((k) => ({ type: "public-key", id: k.id })), attestation: "none", timeout: 120000,
  };
}

/** Step 2: store the device's public key. */
export async function registerFinish(env: Env, who: Identity, origin: string, b: { id?: unknown; clientDataJSON?: unknown; publicKey?: unknown; alg?: unknown; name?: unknown }) {
  await ensure(env.DB);
  const id = String(b.id ?? ""), cdj = String(b.clientDataJSON ?? ""), pub = String(b.publicKey ?? ""), alg = Number(b.alg);
  if (![id, cdj, pub].every((s) => B64.test(s)) || !ALGS[alg]) return "This device's key type is not supported.";
  const cd = clientData(unb64(cdj), "webauthn.create", origin);
  if (typeof cd === "string") return cd;
  if (!(await useChallenge(env.DB, cd.challenge, who.user))) return "The setup took too long. Try again.";
  try { await crypto.subtle.importKey("spki", unb64(pub), ALGS[alg].imp, false, ["verify"]); } catch { return "This device's key could not be read."; }
  if ((await listPasskeys(env.DB, who.user)).length >= 10) return "You already have 10 devices. Remove one first.";
  const name = String(b.name ?? "").replace(/[^\w .,()'-]/g, "").trim().slice(0, 40) || "This device";
  try { await env.DB.prepare("INSERT INTO passkeys (id, user, pub, alg, name) VALUES (?, ?, ?, ?, ?)").bind(id, who.user, pub, alg, name).run(); }
  catch { return "This device is already set up."; }
  return null;
}

export async function deletePasskey(db: D1Database, user: string, id: string) {
  await ensure(db);
  await db.prepare("DELETE FROM passkeys WHERE id = ? AND user = ?").bind(id, user).run();
}
export async function deleteUserPasskeys(db: D1Database, user: string) { await ensure(db); await db.prepare("DELETE FROM passkeys WHERE user = ?").bind(user).run(); }

/** Sign-in step 1 (no session yet): a challenge for navigator.credentials.get(). */
export async function loginOptions(env: Env, host: string) {
  await ensure(env.DB);
  return { challenge: await newChallenge(env.DB, null), rpId: host, userVerification: "required", timeout: 120000 };
}

/** Sign-in step 2: check the device's signature and issue the session cookie. */
export async function loginFinish(req: Request, env: Env, origin: string, host: string): Promise<Response> {
  if (!env.LOGIN_PASSWORD) return deny(400, "Password login is not enabled.");
  await ensure(env.DB);
  if (await loginLocked(req, env.DB)) return deny(429, "Too many failed sign-ins. Wait 15 minutes and try again.");
  const fail = async (detail: string) => { await noteLoginFailure(req, env.DB); return deny(401, detail); };
  let b: { id?: unknown; clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown };
  try { b = await req.json(); } catch { return deny(400, "Bad request."); }
  const id = String(b.id ?? ""), cdj = String(b.clientDataJSON ?? ""), ad = String(b.authenticatorData ?? ""), sig = String(b.signature ?? "");
  if (![id, cdj, ad, sig].every((s) => B64.test(s))) return deny(400, "Bad request.");
  const key = await env.DB.prepare("SELECT * FROM passkeys WHERE id = ?").bind(id).first<{ id: string; user: string; pub: string; alg: number; counter: number }>();
  if (!key) return fail("This device is not set up for any account here. Sign in with your password and set it up under your account.");
  const cdRaw = unb64(cdj), cd = clientData(cdRaw, "webauthn.get", origin);
  if (typeof cd === "string") return fail(cd);
  if (!(await useChallenge(env.DB, cd.challenge, null))) return fail("The sign-in took too long. Try again.");
  const auth = unb64(ad);
  if (auth.length < 37) return fail("Malformed response from the device.");
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(host)));
  if (!rpHash.every((v, i) => v === auth[i])) return fail("This sign-in was made for a different site.");
  if ((auth[32] & 0x05) !== 0x05) return fail("The device did not confirm it was you (Face ID, fingerprint or PIN).");
  const signed = new Uint8Array(auth.length + 32); signed.set(auth); signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", cdRaw)), auth.length);
  let ok = false;
  try {
    const k = await crypto.subtle.importKey("spki", unb64(key.pub), ALGS[key.alg].imp, false, ["verify"]);
    const s = key.alg === -7 ? derToRaw(unb64(sig)) : unb64(sig);
    ok = !!s && (await crypto.subtle.verify(ALGS[key.alg].ver, k, s, signed));
  } catch { ok = false; }
  if (!ok) return fail("The device's signature did not match.");
  const counter = new DataView(auth.buffer, auth.byteOffset + 33, 4).getUint32(0);
  if ((counter || key.counter) && counter <= key.counter) return fail("This device's key looks copied. Remove it under your account and set it up again.");
  const user = await env.DB.prepare("SELECT id, ver, must_change FROM users WHERE id = ?").bind(key.user).first<{ id: string; ver: number; must_change: number }>();
  if (!user) return fail("That account no longer exists.");
  await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used = datetime('now') WHERE id = ?").bind(counter, key.id).run();
  return new Response(JSON.stringify({ ok: true, user: user.id, must_change: !!user.must_change }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": await issueCookie(env, user.id, user.ver, "k") },
  });
}
