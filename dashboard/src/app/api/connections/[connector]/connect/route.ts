import { bridgeFetch } from "@/lib/bridge";
import { forwardOrGeneric } from "@/lib/forwardOrGeneric";
import { requireSameOrigin } from "@/lib/csrf";
import {
  DASHBOARD_API_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Token-paste connectors only — OAuth vendors (gmail, google-calendar,
// github, linear, sentry, slack) authenticate via /api/connections/<id>/auth
// and have no bridge /connections/<id>/connect handler.
const ALLOWED_CONNECTORS = new Set([
  "notion", "confluence", "datadog", "hubspot", "intercom", "stripe", "zendesk",
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ connector: string }> },
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const { connector } = await ctx.params;
  if (!ALLOWED_CONNECTORS.has(connector)) {
    return new Response(JSON.stringify({ error: "Unknown connector" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const read = await readBodyWithCap(req, DASHBOARD_API_BODY_CAPS.connectionsConnect);
  if (!read.ok) return bodyTooLargeResponse(DASHBOARD_API_BODY_CAPS.connectionsConnect);
  try {
    const res = await bridgeFetch(`/connections/${connector}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: read.body,
    });
    return await forwardOrGeneric(res, `connections/${connector}/connect POST`);
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error(`[connections/${connector}/connect POST] bridge fetch failed:`, err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
