/**
 * Proxy for the bridge's `GET /recipes/doctor?recipe=<name>` endpoint.
 *
 * A dedicated static `recipes/doctor` segment is required: without it the
 * request falls through to the dynamic `recipes/[...name]` proxy, which
 * treats "doctor" as a recipe name and drops the `?recipe=` query — the
 * bridge then 400s with `missing_recipe`. Forwarding the query string
 * here keeps the doctor diagnosis reaching the right endpoint.
 */

import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const recipe = req.nextUrl.searchParams.get("recipe") ?? "";
  const target = `/recipes/doctor?recipe=${encodeURIComponent(recipe)}`;
  try {
    const res = await bridgeFetch(target, { method: "GET" });
    // Mirror the upstream content-type so a non-JSON body (e.g. a
    // reverse-proxy HTML error page in remote mode) isn't mislabelled
    // application/json. Same logic as the catch-all `[...path]` proxy.
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
    console.error("[recipes/doctor] bridge fetch failed:", err);
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
