/**
 * Stateless HMAC-signed session cookies for the dashboard.
 *
 * Uses Web Crypto API (crypto.subtle) so the same code runs in both the
 * Edge Runtime (middleware) and Node (API routes). Replaces HTTP Basic
 * auth so that:
 *   - iOS Safari PWAs don't re-prompt on every cold launch (basic-auth
 *     credentials get evicted aggressively by mobile WebKit; cookies
 *     persist via the Set-Cookie store).
 *   - Service workers can authenticate with the cookie (default
 *     `credentials: "same-origin"` includes it for same-origin fetches).
 *   - Logout actually exists (you can't log out of basic-auth without
 *     closing the browser).
 *
 * Cookie value: `v1.<expiresAtMs>.<base64url-HMAC-SHA256(secret, payload)>`.
 * Stateless (no DB) — server validates by re-computing the HMAC.
 *
 * Caveats:
 *   - Changing DASHBOARD_PASSWORD does NOT invalidate active sessions
 *     (cookie isn't bound to password). To force re-login on rotation,
 *     also rotate DASHBOARD_SESSION_SECRET.
 *   - 30-day default TTL. No sliding refresh — cookie is fixed-expiry
 *     until the user explicitly logs out / re-logs in.
 */

export const SESSION_COOKIE_NAME = "patchwork_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  return process.env.DASHBOARD_SESSION_SECRET ?? "";
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i] ?? 0);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (padded.length % 4)) % 4);
  const raw = atob(padded + padding);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function importKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string): Promise<string> {
  const key = await importKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64url(sig);
}

export async function signSession(
  expiresAt = Date.now() + TTL_MS,
): Promise<string> {
  const payload = `v1.${expiresAt}`;
  return `${payload}.${await sign(payload)}`;
}

export async function verifySession(
  value: string | undefined | null,
): Promise<{ valid: boolean; expiresAt?: number }> {
  if (!value || !getSecret()) return { valid: false };
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { valid: false };
  const expiresAtStr = parts[1];
  const sig = parts[2];
  if (!expiresAtStr || !sig) return { valid: false };
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt)) return { valid: false };
  if (Date.now() > expiresAt) return { valid: false };
  try {
    const key = await importKey();
    const sigBytes = base64urlDecode(sig);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(`v1.${expiresAtStr}`),
    );
    return ok ? { valid: true, expiresAt } : { valid: false };
  } catch {
    return { valid: false };
  }
}

const IS_DEV = process.env.NODE_ENV === "development";

export function sessionCookieHeader(value: string, maxAgeSec = TTL_MS / 1000): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (!IS_DEV) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (!IS_DEV) parts.push("Secure");
  return parts.join("; ");
}
