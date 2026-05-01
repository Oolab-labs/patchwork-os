import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";

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
  ctx: { params: { connector: string } },
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const { connector } = ctx.params;
  if (!ALLOWED_CONNECTORS.has(connector)) {
    return new Response(JSON.stringify({ error: "Unknown connector" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const body = await req.text();
  const res = await bridgeFetch(`/connections/${connector}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}
