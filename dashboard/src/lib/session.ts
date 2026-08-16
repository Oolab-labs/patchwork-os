/**
 * Stateless HMAC-signed session cookies for the dashboard.
 *
 * The FORMAT — signing, verification, the member-id constraint — now lives in
 * `src/identity/dashboardSession.ts` and is re-exported here. It moved because
 * the bridge has to read these cookies too (ADR-0020 Phase A: an approval
 * arriving over the dashboard proxy must be able to name the human who gave
 * it), and two implementations of one wire format drift. The drift is not a
 * crash: a verifier slightly more permissive than the signer accepts a cookie
 * that would never have been issued, and stamps a person's name into an audit
 * record on it.
 *
 * This file keeps what is genuinely dashboard-only: the `Set-Cookie` headers,
 * whose attributes (Path, SameSite, Secure, Max-Age) are properties of the
 * dashboard's HTTP surface and mean nothing to the bridge.
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
 * Cookie value: `v1.<expiresAtMs>.<HMAC>` (unattributed) or
 * `v2.<memberId>.<expiresAtMs>.<HMAC>` (attributed — ADR-0020 Phase A).
 * Stateless (no DB) — server validates by re-computing the HMAC.
 *
 * Caveats:
 *   - Changing DASHBOARD_PASSWORD does NOT invalidate active sessions
 *     (cookie isn't bound to password). To force re-login on rotation,
 *     also rotate DASHBOARD_SESSION_SECRET.
 *   - 30-day default TTL. No sliding refresh — cookie is fixed-expiry
 *     until the user explicitly logs out / re-logs in.
 */

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from "../../../src/identity/dashboardSession";

export {
  MEMBER_ID_RE,
  SESSION_COOKIE_NAME,
  signSession,
  verifySession,
} from "../../../src/identity/dashboardSession";

const TTL_MS = SESSION_TTL_MS;

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
