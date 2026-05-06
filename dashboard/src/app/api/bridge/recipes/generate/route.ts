import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (isDemoModeServer()) {
    return new Response(
      JSON.stringify({
        ok: false,
        unavailable: true,
        error: "AI generation is not available in demo mode.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  try {
    const body = await req.text();
    const res = await bridgeFetch("/recipes/generate", {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
      },
      body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "fetch failed",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
