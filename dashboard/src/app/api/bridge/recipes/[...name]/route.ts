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
type RouteContext = { params: Promise<{ name: string[] }> };

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { name } = await ctx.params;
  try {
    const encodedName = name.join("/");
    const res = await bridgeFetch(`/recipes/${encodedName}`);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // Audit 2026-05-17 (#600): don't leak err.message (file paths,
    // ECONNREFUSED detail). Generic proxy was fixed in #120; these
    // per-route handlers were missed.
    console.error("[recipes/:name] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

async function forwardWithMethod(
  req: NextRequest,
  ctx: RouteContext,
  method: "PUT" | "PATCH",
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.content);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.content);
  try {
    const { name } = await ctx.params;
    const encodedName = name.join("/");
    const res = await bridgeFetch(`/recipes/${encodedName}`, {
      method,
      headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
      body: read.body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // Audit 2026-05-17 (#600): don't leak err.message (file paths,
    // ECONNREFUSED detail). Generic proxy was fixed in #120; these
    // per-route handlers were missed.
    console.error("[recipes/:name] bridge fetch failed:", err);
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
  return forwardWithMethod(req, ctx, "PUT");
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  return forwardWithMethod(req, ctx, "PATCH");
}

export async function DELETE(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  try {
    const { name } = await ctx.params;
    const encodedName = name.join("/");
    const res = await bridgeFetch(`/recipes/${encodedName}`, {
      method: "DELETE",
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // Audit 2026-05-17 (#600): don't leak err.message (file paths,
    // ECONNREFUSED detail). Generic proxy was fixed in #120; these
    // per-route handlers were missed.
    console.error("[recipes/:name] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
