import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next 15: dynamic route params arrive as a Promise.
type RouteContext = { params: Promise<{ name: string }> };

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const { name } = await ctx.params;
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.run);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.run);
  try {
    const encodedName = encodeURIComponent(name);
    const res = await bridgeFetch(`/recipes/${encodedName}/run`, {
      method: "POST",
      headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
      body: read.body || undefined,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // #600: don't leak err.message detail; see [name]/route.ts.
    console.error("[recipes/:name/run] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
