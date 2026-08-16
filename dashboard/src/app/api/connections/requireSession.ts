/**
 * Session guard for OAuth callback routes.
 *
 * LOW #39: OAuth callback routes are exempted from the middleware session gate
 * (necessary because the OAuth provider's redirect is a cross-site navigation
 * and SameSite=Strict cookies aren't sent on cross-origin top-level navigations).
 * However, the API callback routes (/api/connections/<name>/callback) are called
 * by same-origin browser code, so the session cookie IS sent. We verify it here
 * to prevent unauthenticated code-exchange (an attacker who knows the callback URL
 * could otherwise complete an OAuth flow without a valid session).
 *
 * Pass-through when DASHBOARD_ALLOW_UNAUTHENTICATED=1 (local dev).
 *
 * Returns null when the request is allowed; returns a 401 Response to return
 * directly when not.
 */

import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";

/** Parse a single named cookie out of the Cookie header. */
function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k?.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

export async function requireCallbackSession(
  req: Request,
): Promise<Response | null> {
  if (process.env.DASHBOARD_ALLOW_UNAUTHENTICATED === "1") return null;
  const sessionValue = getCookie(req, SESSION_COOKIE_NAME);
  const { valid } = await verifySession(sessionValue);
  if (!valid) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

/**
 * Who this request is, or `undefined` — ADR-0020 Phase A, the read side.
 *
 * `undefined` means UNATTRIBUTED and callers must treat it as such. It is
 * returned for an unauthenticated request, for a v1 (subject-less) cookie, and
 * for the `DASHBOARD_ALLOW_UNAUTHENTICATED` dev bypass. All three are "nobody
 * was identified", and none of them may become a person: an absent actor
 * already means "nobody recorded this" and is never backfilled, while a
 * defaulted one is indistinguishable from a recorded one.
 *
 * ## Why this re-verifies the cookie instead of reading a header
 *
 * The obvious alternative is for the middleware to stamp the member id onto a
 * request header for handlers to read. That was built and thrown away: the
 * middleware `config.matcher` EXEMPTS a set of paths (`api/login`, the OAuth
 * callback routes, the push/SW machinery), so on any exempt path a header of
 * that name is whatever the client sent. A consumer cannot tell from the read
 * site which kind of path it is on, so the header would be trustworthy in most
 * places and forgeable in a few — the worst available shape for an identity.
 *
 * Re-verifying costs one HMAC and is trustworthy everywhere, including on
 * paths the middleware never sees.
 */
export async function sessionMemberId(
  req: Request,
): Promise<string | undefined> {
  const sessionValue = getCookie(req, SESSION_COOKIE_NAME);
  const { valid, memberId } = await verifySession(sessionValue);
  return valid ? memberId : undefined;
}
