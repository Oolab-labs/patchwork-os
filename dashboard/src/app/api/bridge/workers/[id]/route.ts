/**
 * Proxy for the bridge's `GET/PUT /workers/:id` — load/save raw worker
 * manifest content by id. Mirrors `api/bridge/recipes/[...name]/route.ts`'s
 * GET/PUT handlers (worker ids are single-segment, so no catch-all needed).
 */

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

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const res = await bridgeFetch(`/workers/${encodeURIComponent(id)}`);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("[workers/:id] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

export async function PUT(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.content);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.content);
  try {
    const { id } = await ctx.params;
    const res = await bridgeFetch(`/workers/${encodeURIComponent(id)}`, {
      method: "PUT",
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
    console.error("[workers/:id] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
