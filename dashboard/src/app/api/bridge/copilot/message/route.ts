import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Proxy for POST /copilot/message — the Overview deck's 7:copilot pane.
// The bridge route only ever PROPOSES ({ reply, action? }); it never
// executes a write. Confirming an action card is a separate call through
// the same gated handlers the rest of the dashboard already uses
// (useToggleRecipeEnabled / useRunRecipe) — never routed through here.
export async function POST(req: Request): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.copilotMessage);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.copilotMessage);
  try {
    const res = await bridgeFetch("/copilot/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: read.body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // #600: don't leak err.message detail; see recipes/[name]/route.ts.
    console.error("[copilot/message] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
