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

/**
 * Member ids that are safe inside a dot-delimited cookie payload.
 *
 * Load-bearing, not cosmetic. The payload is split on ".", so an id
 * containing one makes `v2.a.b.123.<sig>` ambiguous — is the subject `a` with
 * expiry `b.123`, or `a.b` with expiry `123`? Two members could then produce
 * cookies that parse as each other. Rejected at BOTH ends: signing throws,
 * verifying returns invalid, because a check on only one side is a check that
 * a hand-written cookie skips.
 */
const MEMBER_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Sign a session cookie.
 *
 * With `memberId` → `v2.<memberId>.<expiresAt>.<HMAC>`, an ATTRIBUTED session.
 * Without → `v1.<expiresAt>.<HMAC>`, exactly as before.
 *
 * v1 is still minted on purpose. The dashboard password gate authenticates a
 * SECRET, not a person, so there is nobody to name; minting a v2 with a
 * placeholder subject would turn "we do not know who this is" into a claim
 * about someone. v2 appears only once a real member has authenticated.
 */
export async function signSession(
  expiresAtOrOpts:
    | number
    | { memberId?: string; expiresAt?: number } = Date.now() + TTL_MS,
): Promise<string> {
  const opts =
    typeof expiresAtOrOpts === "number"
      ? { expiresAt: expiresAtOrOpts }
      : expiresAtOrOpts;
  const expiresAt = opts.expiresAt ?? Date.now() + TTL_MS;
  const memberId = opts.memberId;

  if (memberId === undefined) {
    const payload = `v1.${expiresAt}`;
    return `${payload}.${await sign(payload)}`;
  }
  if (!MEMBER_ID_RE.test(memberId)) {
    throw new Error(
      "memberId must match /^[A-Za-z0-9_-]+$/ — a dot would make the payload ambiguous",
    );
  }
  const payload = `v2.${memberId}.${expiresAt}`;
  return `${payload}.${await sign(payload)}`;
}

/**
 * Verify a session cookie.
 *
 * `memberId` is present ONLY for a valid v2 cookie. For v1 it is `undefined`,
 * and that is the whole point of this function's shape:
 *
 *   **a v1 cookie must never read as an attributed v2.**
 *
 * A v1 cookie means nobody was identified. If verification returned some
 * stand-in subject there — the implicit owner, the first member, a literal
 * "unknown" — the absence of a subject would become a CLAIM of one, and every
 * record stamped from it would name a person on no evidence. Undefined stays
 * undefined; callers decide, and must treat it as unattributed.
 *
 * The version is inside the SIGNED payload, so a v1 cookie cannot be
 * re-spelled as a v2 one: the HMAC covers `v1.<exp>` or `v2.<id>.<exp>`, and
 * those are different strings under the same key.
 */
export async function verifySession(
  value: string | undefined | null,
): Promise<{ valid: boolean; expiresAt?: number; memberId?: string }> {
  if (!value || !getSecret()) return { valid: false };
  const parts = value.split(".");
  const version = parts[0];

  let memberId: string | undefined;
  let expiresAtStr: string | undefined;
  let sig: string | undefined;

  if (version === "v1" && parts.length === 3) {
    expiresAtStr = parts[1];
    sig = parts[2];
  } else if (version === "v2" && parts.length === 4) {
    memberId = parts[1];
    expiresAtStr = parts[2];
    sig = parts[3];
    // Defence in depth, and honestly redundant TODAY — probed, not assumed.
    // Removing this line leaves every test green, because an id containing a
    // "." makes the cookie 5 parts and the arity check above rejects it, while
    // any other malformed id can only appear in a cookie we signed — and
    // signing refuses it. The signature stops the rest.
    //
    // Kept because the arity check is what currently carries it, and arity
    // stops discriminating the moment a fifth field is added to this format.
    // A constraint that survives a format change is worth one line.
    if (!memberId || !MEMBER_ID_RE.test(memberId)) return { valid: false };
  } else {
    return { valid: false };
  }

  if (!expiresAtStr || !sig) return { valid: false };
  const expiresAt = Number.parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt)) return { valid: false };
  if (Date.now() > expiresAt) return { valid: false };

  const payload =
    memberId === undefined
      ? `v1.${expiresAtStr}`
      : `v2.${memberId}.${expiresAtStr}`;

  try {
    const key = await importKey();
    const sigBytes = base64urlDecode(sig);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(payload),
    );
    // `memberId` is spread only when defined, so a v1 result has no such key
    // at all — not a key holding undefined that some later `in` check reads
    // as present.
    return ok
      ? { valid: true, expiresAt, ...(memberId !== undefined && { memberId }) }
      : { valid: false };
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
