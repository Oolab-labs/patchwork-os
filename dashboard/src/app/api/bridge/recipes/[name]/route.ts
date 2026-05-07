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

const demoOk = () =>
  new Response(JSON.stringify({ ok: true, demo: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { name } = await ctx.params;
  if (await isDemoModeServer()) {
    return new Response(
      JSON.stringify({ name, demo: true, content: "" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  try {
    const encodedName = encodeURIComponent(name);
    const res = await bridgeFetch(`/recipes/${encodedName}`);
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

async function forwardWithMethod(
  req: NextRequest,
  ctx: RouteContext,
  method: "PUT" | "PATCH",
): Promise<Response> {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (await isDemoModeServer()) return demoOk();
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.content);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.content);
  try {
    const { name } = await ctx.params;
    const encodedName = encodeURIComponent(name);
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
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "fetch failed" }),
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
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (await isDemoModeServer()) return demoOk();
  try {
    const { name } = await ctx.params;
    const encodedName = encodeURIComponent(name);
    const res = await bridgeFetch(`/recipes/${encodedName}`, {
      method: "DELETE",
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
