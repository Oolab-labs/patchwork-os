/**
 * Proxy for the bridge's `GET /workers/boundary?recipe=<name>` endpoint.
 *
 * A dedicated static `workers/boundary` segment is required for the same
 * reason `recipes/doctor` needs one: without it, the request falls through
 * to the dynamic `workers/[id]` proxy, which treats "boundary" as a worker
 * id and drops the `?recipe=` query — the bridge then 400s with
 * "recipe query param required".
 */

import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const recipe = req.nextUrl.searchParams.get("recipe") ?? "";
  const target = `/workers/boundary?recipe=${encodeURIComponent(recipe)}`;
  try {
    const res = await bridgeFetch(target, { method: "GET" });
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
    console.error("[workers/boundary] bridge fetch failed:", err);
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
