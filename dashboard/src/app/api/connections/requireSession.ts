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
