import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import { isDemoModeServer } from "@/lib/demoModeServer";
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
  if (await isDemoModeServer()) {
    return new Response(
      JSON.stringify({
        ok: false,
        unavailable: true,
        error: "AI generation is not available in demo mode.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.generate);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.generate);
  try {
    const res = await bridgeFetch("/recipes/generate", {
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
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "fetch failed",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
