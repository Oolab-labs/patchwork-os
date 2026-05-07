import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";
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
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  const { name } = await ctx.params;
  if (await isDemoModeServer()) {
    return new Response(
      JSON.stringify({
        ok: true,
        demo: true,
        taskId: `demo-${Date.now()}`,
        message: `Demo mode — recipe '${name}' run skipped (no live bridge)`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
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
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "fetch failed" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
