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

export async function POST(req: NextRequest): Promise<Response> {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  if (await isDemoModeServer()) {
    return new Response(
      JSON.stringify({
        error:
          "Install requires a running Patchwork bridge. Run `npm i -g patchwork-os && patchwork start` locally, then revisit this page.",
      }),
      { status: 501, headers: { "content-type": "application/json" } },
    );
  }

  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.install);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.install);
  try {
    const res = await bridgeFetch("/recipes/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
