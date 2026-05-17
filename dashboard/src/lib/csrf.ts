/**
 * Centralised CSRF guard for dashboard mutation routes.
 *
 * Primary check is the browser-issued `sec-fetch-site` Fetch Metadata
 * header — accept only `same-origin` / `none` (the latter for direct
 * address-bar navigation), reject anything else with 403.
 *
 * `sec-fetch-site` is forgeable from a non-browser client, but it CAN NOT
 * be set by JavaScript inside a page — which is exactly the threat model
 * (cross-origin page submitting a form / fetch with the user's cookies).
 *
 * Audit 2026-05-17 (#605): when `sec-fetch-site` is absent (server-to-
 * server, very-old browsers, `curl --cookie session=…`), the previous
 * implementation allowed the request. That bypassed CSRF for any
 * cookie-bearing script on the same machine targeting a mutating route.
 * Now: if the header is absent, fall back to an Origin/Host equality
 * check. Requests with neither header are rejected.
 *
 * Returns `null` when the request is allowed, or a 403 NextResponse to be
 * returned directly to the client otherwise.
 */

import { NextResponse } from "next/server";

export function requireSameOrigin(
  req: { headers: { get(name: string): string | null } },
): NextResponse | null {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs) {
    if (sfs !== "same-origin" && sfs !== "none") {
      return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
    }
    return null;
  }
  // Header absent — defense-in-depth fallback. Require Origin to match
  // Host (a same-origin browser request always sends Origin on
  // mutating verbs since 2020-ish). Server-side / curl callers that
  // need to hit mutating routes must set Origin explicitly.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json(
      { error: "CSRF check failed (missing Origin)" },
      { status: 403 },
    );
  }
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
  }
  return null;
}
