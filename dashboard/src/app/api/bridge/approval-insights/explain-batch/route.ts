import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readJsonWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-side fan-out so the client makes one round trip instead of N.
// Bridge endpoint is per-tool only (/approval-insights/explain?tool=X);
// proxying here keeps the wire unchanged and avoids touching bridge code.
export async function POST(req: NextRequest): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const parsed = await readJsonWithCap<{ tools?: unknown }>(
    req,
    DASHBOARD_API_BODY_CAPS.explainBatch,
  );
  if (!parsed.ok) {
    if (parsed.reason === "too_large") return bodyTooLargeResponse(parsed.maxBytes);
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const body = parsed.value ?? {};
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((t): t is string => typeof t === "string").slice(0, 100)
    : [];
  if (tools.length === 0) {
    return Response.json({ explanations: {} });
  }

  const entries = await Promise.all(
    tools.map(async (tool) => {
      try {
        const res = await bridgeFetch(
          `/approval-insights/explain?tool=${encodeURIComponent(tool)}`,
        );
        if (!res.ok) return [tool, null] as const;
        const json = (await res.json()) as { explanation?: unknown };
        return [tool, json.explanation ?? null] as const;
      } catch {
        return [tool, null] as const;
      }
    }),
  );

  return Response.json({ explanations: Object.fromEntries(entries) });
}
