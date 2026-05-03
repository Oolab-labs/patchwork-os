import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: { name: string } };

const demoOk = () =>
  new Response(JSON.stringify({ ok: true, demo: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  if (isDemoModeServer()) {
    return new Response(
      JSON.stringify({ name: ctx.params.name, demo: true, content: "" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  try {
    const name = encodeURIComponent(ctx.params.name);
    const res = await bridgeFetch(`/recipes/${name}`);
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
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (isDemoModeServer()) return demoOk();
  try {
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
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "fetch failed" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

export async function PATCH(
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
  if (isDemoModeServer()) return demoOk();
  try {
    const name = encodeURIComponent(ctx.params.name);
    const body = await req.text();
    const res = await bridgeFetch(`/recipes/${name}`, {
      method: "PATCH",
      headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
      body,
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
