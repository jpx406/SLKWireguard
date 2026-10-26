// Verifies the Cloudflare Access JWT on every API request. Fails closed: if Access
// is not configured, the API refuses to serve (unless DEV_NO_AUTH=1 in local dev).
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
