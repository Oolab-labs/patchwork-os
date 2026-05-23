/**
 * Phase 2A.2 proxy for the bridge's `/recipes/repair` LLM-driven fix
 * endpoint. Same shape as `/recipes/lint` proxy — same-origin guard,
 * body cap, bridgeFetch passthrough, structured error mapping.
 *
 * The bridge gates this behind the `recipe.repair-ai` feature flag —
 * returns 503 `{code:"feature_disabled"}` when off. Surface that
 * through the proxy unchanged so the dashboard can render the
 * "enable the flag" toast inline rather than a generic "bridge said
 * no" message.
 */

import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Signature uses bare `Request` (not `NextRequest`) to match the
// existing /api/bridge/recipes/generate proxy so the test file can
// pass `new Request(...)` directly without a NextRequest cast.
export async function POST(req: Request): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  // Same cap as `/recipes/lint` since the body carries the full YAML
  // plus a small `lintIssues[]` array (cap on bridge side matches).
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.content);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.content);
  try {
    const res = await bridgeFetch("/recipes/repair", {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
      },
      body: read.body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "content-type": "application/json",
        // Pass through Retry-After so the dashboard toast can show
        // "wait N seconds" on 429 without re-parsing the body.
        ...(res.headers.get("retry-after") && {
          "retry-after": res.headers.get("retry-after") as string,
        }),
      },
    });
  } catch (err) {
    console.error("[recipes/repair] bridge fetch failed:", err);
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
