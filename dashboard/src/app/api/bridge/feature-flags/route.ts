/**
 * Proxy for the bridge's `POST /feature-flags` endpoint — toggle a
 * user-opt-in UI flag (currently `recipe.repair-ai`, via the recipe
 * editor's "Enable & retry" affordance). Same shape as the other bridge
 * proxies: same-origin guard, body cap, bridgeFetch passthrough,
 * structured errors surfaced unchanged.
 *
 * The bridge scopes this to opt-in UI flags only — a 403
 * `not_user_toggleable` or 409 `env_override` is passed straight through
 * so the dashboard can render an accurate message rather than a generic
 * failure.
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

export async function POST(req: Request): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  // Tiny body — `{id, value}`. Reuse the smallest available cap.
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.content);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.content);
  try {
    const res = await bridgeFetch("/feature-flags", {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
      },
      body: read.body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[feature-flags] bridge fetch failed:", err);
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
