/**
 * Proxy for the bridge's `GET /recipes/:name/simulate` (What-If Preview).
 *
 * A dedicated static `recipes/simulate` segment is required: without it the
 * request falls through to the dynamic `recipes/[...name]` proxy, which would
 * treat "simulate" as part of a recipe name. We accept the recipe as a
 * `?recipe=` query here (no `[name]` sibling — that conflicts with the
 * `[...name]` catch-all slug) and translate it to the bridge's path param.
 * Mirrors the `recipes/doctor` proxy.
 */

import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const recipe = req.nextUrl.searchParams.get("recipe") ?? "";
  if (!recipe) {
    return new Response(JSON.stringify({ error: "missing_recipe" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const target = `/recipes/${encodeURIComponent(recipe)}/simulate`;
  try {
    const res = await bridgeFetch(target, { method: "GET" });
    // Mirror the upstream content-type so a non-JSON body (e.g. a reverse-proxy
    // HTML error page in remote mode) isn't mislabelled application/json.
    const upstreamCt = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const ct =
      upstreamCt.includes("application/json") || upstreamCt === ""
        ? "application/json"
        : upstreamCt;
    return new Response(text, {
      status: res.status,
      headers: { "content-type": ct },
    });
  } catch (err) {
    console.error("[recipes/simulate] bridge fetch failed:", err);
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
