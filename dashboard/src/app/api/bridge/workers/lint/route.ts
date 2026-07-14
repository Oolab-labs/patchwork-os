/**
 * Proxy for the bridge's `POST /workers/lint` — validate raw worker YAML
 * without saving. Mirrors `api/bridge/recipes/lint/route.ts`.
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

export async function POST(req: NextRequest): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.content);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.content);
  try {
    const res = await bridgeFetch("/workers/lint", {
      method: "POST",
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
    console.error("[workers/lint] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
