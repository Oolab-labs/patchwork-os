import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: { name: string } };

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const name = encodeURIComponent(ctx.params.name);
  const res = await bridgeFetch(`/recipes/${name}`);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

export async function PUT(
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
  const name = encodeURIComponent(ctx.params.name);
  const body = await req.text();
  const res = await bridgeFetch(`/recipes/${name}`, {
    method: "PUT",
    headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
    body,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
