import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";

/**
 * Cookie-based session auth for the dashboard. Replaces the previous
 * HTTP Basic auth gate so that:
 *   - iOS Safari PWAs don't re-prompt on every cold launch
 *   - Service workers can authenticate via the cookie (default
 *     `credentials: "same-origin"` includes it)
 *   - Logout actually exists (POST /dashboard/api/logout clears the cookie)
 *
 * Required env: DASHBOARD_PASSWORD (the one shared password) and
 * DASHBOARD_SESSION_SECRET (HMAC signing key, ≥32 bytes recommended —
 * generate with `openssl rand -base64 32`).
 *
 * Dev override: DASHBOARD_ALLOW_UNAUTHENTICATED=1 keeps the dashboard
 * world-readable. Useful for local dev; never set in production.
 */

const ALLOW_UNAUTHENTICATED =
  process.env.DASHBOARD_ALLOW_UNAUTHENTICATED === "1";

function unauthenticated(req: NextRequest): NextResponse {
  // For HTML navigations: redirect to /dashboard/login with the original
  // path as `next` so the user can come back after authenticating.
  // For API/JSON requests: 401 with a small JSON body so client code can
  // detect missing-session and prompt for login programmatically.
  const accept = req.headers.get("accept") ?? "";
  const wantsHtml = accept.includes("text/html");
  if (wantsHtml) {
    const url = req.nextUrl.clone();
    // Capture the original URL the browser sees, INCLUDING the basePath,
    // so login can send the user back where they were. `nextUrl.pathname`
    // is post-basePath-strip (`/analytics` for external `/dashboard/analytics`),
    // so we re-prepend it. Without this the post-login redirect drops the
    // basePath and lands at bare `/analytics`, which nginx routes to the
    // bridge HTTP API and 401s.
    const basePath = req.nextUrl.basePath ?? "";
    const original = `${basePath}${url.pathname}${url.search}`;
    // Set pathname WITHOUT basePath — Next.js's redirect helper
    // prepends basePath itself when constructing the final Location
    // header. Including `/dashboard` here gives `/dashboard/dashboard/login`.
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(original)}`;
    return NextResponse.redirect(url);
  }
  return new NextResponse(
    JSON.stringify({ error: "session_required" }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function middleware(req: NextRequest) {
  const expected = process.env.DASHBOARD_PASSWORD ?? "";
  const secret = process.env.DASHBOARD_SESSION_SECRET ?? "";

  // No password configured — let traffic through unless production
  // explicitly forbids it. Mirrors the prior basic-auth behavior.
  if (!expected || !secret) {
    if (process.env.NODE_ENV === "production" && !ALLOW_UNAUTHENTICATED) {
      return new NextResponse(
        "Dashboard auth not configured. Set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET (and remove DASHBOARD_ALLOW_UNAUTHENTICATED).",
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  // Login page itself must be reachable without a session. Next.js
  // strips basePath before matching, so the internal pathname is
  // `/login` even though the external URL is `/dashboard/login`.
  if (
    req.nextUrl.pathname === "/login" ||
    req.nextUrl.pathname === "/dashboard/login"
  ) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySession(cookie);
  if (!session.valid) return unauthenticated(req);
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect all routes except Next.js internals, public assets, marketplace,
    // and the bridge-relay endpoint.
    //
    // `api/relay/push` is exempted because it's the bridge → dashboard push
    // handshake — it has its own Bearer-token auth (PATCHWORK_PUSH_TOKEN,
    // timing-safe).
    //
    // `api/login` is exempted so a not-yet-authed client can authenticate.
    //
    // PWA + SW machinery exemptions (these paths must be reachable
    // without a session so the PWA can install and the service worker
    // can register before login):
    //   - sw.js: registered by `navigator.serviceWorker.register` on
    //     page load; must be cacheable by the browser before login.
    //   - icons/: PWA icons referenced from manifest.json.
    //   - api/push/vapid-key: SW context fetches this on
    //     pushsubscriptionchange. Read-only, public; safe to expose.
    //
    // api/push/{subscribe,unsubscribe} used to be exempt here too on
    // the theory that the SW couldn't carry the session cookie. In
    // practice SW fetches default to `credentials: "same-origin"` and
    // DO send the cookie, so the exemption was wrong — it left two
    // mutation endpoints unauthenticated. Removed 2026-05-17 (#600).
    // Defense-in-depth: those handlers also re-check the session.
    //
    // Root path (basePath bare) explicitly — the negative-lookahead
    // matcher below doesn't reliably catch `/` alone in Next.js, which
    // means the dashboard's overview page would otherwise be unprotected.
    "/",
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|manifest\\.json|robots\\.txt|schema/|marketplace|api/login|api/relay/push|api/relay/halt|sw\\.js|icons/|api/push/vapid-key).*)",
  ],
};
