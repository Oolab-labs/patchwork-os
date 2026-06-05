import { createHash } from "node:crypto";

import { checkRateLimit } from "@/lib/authRateLimit";
import { bridgeFetch } from "@/lib/bridge";
import { clientKey } from "@/lib/clientIp";
import { requireSameOrigin } from "@/lib/csrf";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";
import { assertValidInstallSource } from "@/lib/registry";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonError(
  status: number,
  error: string,
  code?: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/**
 * Derive an opaque per-caller key for the install rate limiter.
 *
 * Preferred identity is the session cookie — hashed (SHA-256, truncated) so
 * the raw token never lives in the limiter's in-memory map. When no session
 * cookie is present (e.g. unauthenticated dev deploy, or a malformed
 * request), fall back to the coarse client-IP bucket from clientKey() so the
 * route is never left completely unbounded. clientKey returns "unknown"
 * without a trusted proxy, which collapses to a single shared global bucket
 * — intentionally conservative.
 */
function rateLimitKey(req: Request): string {
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      if (value) {
        const digest = createHash("sha256").update(value).digest("hex");
        return `sess:${digest.slice(0, 32)}`;
      }
    }
  }
  return `ip:${clientKey(req.headers)}`;
}

export async function POST(req: Request): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;

  // Per-session call-count cap BEFORE any bridge work. Each install triggers
  // a GitHub fetch + filesystem write on the bridge; an unbounded POST loop
  // (stolen cookie / insider) can exhaust disk or GitHub's 60 req/hr limit
  // for everyone. See B3-C in docs/marketplace-investigation-2026-06-04.md.
  const rl = checkRateLimit(rateLimitKey(req));
  if (rl.limited) {
    return jsonError(
      429,
      "Too many install requests — slow down and retry shortly.",
      "rate_limited",
      { "retry-after": String(rl.retryAfterSec) },
    );
  }

  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.install);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.install);

  // Server-side `source` validation — defense in depth. Browser-side
  // assertValidInstallSource is easily bypassed by a direct POST, and the
  // bridge's own validation is the only remaining gate without this. Reject
  // anything that isn't `github:owner/repo[/path][@ref]` shape BEFORE we
  // touch the bridge socket — keeps dashboard logs clean and removes one
  // forward-step from any tampered-registry / curl-style attack path.
  let parsed: { source: unknown } | null = null;
  try {
    parsed = JSON.parse(read.body) as { source: unknown };
  } catch {
    return jsonError(400, "Request body is not valid JSON", "bad_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError(
      400,
      "Request body must be an object with a `source` string",
      "bad_body_shape",
    );
  }
  if (typeof parsed.source !== "string") {
    return jsonError(
      400,
      "Missing or non-string `source` field",
      "bad_source_type",
    );
  }
  try {
    assertValidInstallSource(parsed.source);
  } catch (e) {
    return jsonError(
      400,
      e instanceof Error ? e.message : "Invalid install source",
      "bad_source_shape",
    );
  }

  try {
    const res = await bridgeFetch("/recipes/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: read.body,
    });
    // Mirror the upstream content-type so a non-JSON body (e.g. a
    // reverse-proxy HTML error page in remote mode) isn't mislabelled
    // application/json — that makes the client silently fail to parse it.
    // Same logic as the catch-all `[...path]` proxy.
    const upstreamCt = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const ct =
      upstreamCt.includes("application/json") || upstreamCt === ""
        ? "application/json"
        : upstreamCt;
    return new Response(text, {
      status: res.status,
      headers: { "content-type": ct },
    });
  } catch (err) {
    // #600: don't leak err.message detail; see [name]/route.ts.
    console.error("[recipes/install] bridge fetch failed:", err);
    return jsonError(502, "Bridge unreachable");
  }
}
