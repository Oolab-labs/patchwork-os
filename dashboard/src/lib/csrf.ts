/**
 * Centralised CSRF guard for dashboard mutation routes.
 *
 * Mirrors the inline check that previously lived in the bridge proxy and a
 * handful of recipe routes: rely on the browser-issued `sec-fetch-site`
 * Fetch Metadata header, accept only `same-origin` / `none` (the latter for
 * direct address-bar navigation in the dashboard's same-origin XHR flow),
 * reject anything else with 403.
 *
 * `sec-fetch-site` is forgeable from a non-browser client, but it can NOT be
 * set by JavaScript inside a page — which is exactly the threat model
 * (cross-origin page submitting a form / fetch with the user's cookies).
 * For server-to-server callers there is no header at all, which we allow:
 * those callers either present a Bearer token, hit a separate auth path, or
 * are blocked by the bridge itself.
 *
 * Returns `null` when the request is allowed, or a 403 NextResponse to be
 * returned directly to the client otherwise.
 */

import { NextResponse } from "next/server";

export function requireSameOrigin(
  req: { headers: { get(name: string): string | null } },
): NextResponse | null {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return NextResponse.json(
      { error: "CSRF check failed" },
      { status: 403 },
    );
  }
  return null;
}
