"use strict";
/* Face ID / fingerprint sign-in (passkeys) and the "forgot password" request.
   The device keeps a private key behind Face ID, Touch ID, Windows Hello or an Android fingerprint; the desk
   only stores the public key. Works over HTTPS (and on localhost) in browsers that support passkeys. */

const pkB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pkBytes = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const pkSupported = () => !!(window.PublicKeyCredential && navigator.credentials);
const pkPost = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).catch(() => null);
  if (!r) throw new Error("Can't reach the server.");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || "That did not work.");
  return j;
};
const pkReason = (e) => e?.name === "NotAllowedError" ? "Cancelled, or this device has no Face ID / fingerprint set up for this site."
  : e?.name === "InvalidStateError" ? "This device is already set up." : e?.name === "SecurityError" ? "Face ID / fingerprint sign-in needs the site's real https address." : e?.message || "That did not work.";

/* ---- sign in */
const btnPk = document.getElementById("btnPasskey");
if (!pkSupported()) btnPk.classList.add("hidden");
btnPk.onclick = async () => {
  const err = document.getElementById("loginErr"); err.textContent = "";
  btnPk.disabled = true;
  try {
    const o = await pkPost("/api/login/passkey/options");
    const cred = await navigator.credentials.get({ publicKey: { challenge: pkBytes(o.challenge), rpId: o.rpId, userVerification: "required", timeout: o.timeout, allowCredentials: [] } });
    await pkPost("/api/login/passkey", { id: cred.id, clientDataJSON: pkB64(cred.response.clientDataJSON), authenticatorData: pkB64(cred.response.authenticatorData), signature: pkB64(cred.response.signature) });
    location.reload();
  } catch (e) { err.textContent = pkReason(e); btnPk.disabled = false; }
};

/* ---- forgot password */
document.getElementById("btnForgot").onclick = async () => {
  const out = document.getElementById("forgotOut"), user = document.getElementById("loginUser").value.trim().toLowerCase();
  if (!user) { out.textContent = "Type your username above first."; return; }
  if (user === "admin") { out.textContent = "The admin signs in with the recovery password (the LOGIN_PASSWORD secret) and then chooses a new password."; return; }
  try { await pkPost("/api/login/forgot", { username: user }); out.textContent = "Request sent. The administrator will reset your account; you then sign in with the initial password and choose a new one."; }
  catch (e) { out.textContent = e.message; }
};

/* ---- my devices (account dialog) */
async function loadPasskeys(list) {
  const box = document.getElementById("pkList"); if (!box) return;
  const btn = document.getElementById("btnPkAdd"), supported = pkSupported();
  btn.classList.toggle("hidden", !supported);
  let keys = list;
  if (!keys) { try { keys = await api("/api/me/passkeys"); } catch { keys = []; } }
  box.innerHTML = "";
  if (!keys.length) box.append(el("div", "dim small", supported ? "No device set up yet." : "This browser does not support Face ID / fingerprint sign-in."));
  for (const k of keys) {
    const row = el("div", "pk-row"), del = el("button", "ghost small", "Remove");
    del.onclick = async () => { if (await askConfirm({ title: `Remove ${k.name || "this device"}?`, message: "It can no longer sign in with Face ID / fingerprint. Your password still works.", confirm: "Remove Device" })) { try { loadPasskeys(await api(`/api/me/passkeys/${encodeURIComponent(k.id)}`, { method: "DELETE" })); } catch (e) { $("#meErr").textContent = e.message; } } };
    row.append(el("span", "sym", k.name || "Device"), el("span", "dim small", `added ${String(k.created_at || "").slice(0, 10)}${k.last_used ? ` · last used ${String(k.last_used).slice(0, 10)}` : ""}`), del);
    box.append(row);
  }
}
function pkDeviceName() {
  const u = navigator.userAgent;
  return /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android phone" : /Mac/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows PC" : "This device";
}
document.getElementById("btnPkAdd").onclick = async () => {
  const msg = document.getElementById("meErr"); msg.textContent = "";
  try {
    const o = await api("/api/me/passkeys/options", { method: "POST", body: "{}" });
    const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: pkBytes(o.challenge), user: { ...o.user, id: pkBytes(o.user.id) }, excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: pkBytes(c.id) })) } });
    const pub = cred.response.getPublicKey?.();
    if (!pub) throw new Error("This browser cannot hand over the device key. Update the browser and try again.");
    loadPasskeys(await api("/api/me/passkeys", { method: "POST", body: JSON.stringify({ id: cred.id, clientDataJSON: pkB64(cred.response.clientDataJSON), publicKey: pkB64(pub), alg: cred.response.getPublicKeyAlgorithm(), name: pkDeviceName() }) }));
    msg.textContent = "Done. Next time, use \"Sign in with Face ID / fingerprint\" on the sign-in screen.";
  } catch (e) { msg.textContent = pkReason(e); }
};
