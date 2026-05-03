import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_CONNECTORS = new Set([
  "gmail", "github", "linear", "sentry", "google-calendar", "google-drive", "slack",
  "notion", "confluence", "datadog", "hubspot", "intercom", "stripe", "zendesk",
]);

export async function DELETE(
  req: Request,
  ctx: { params: { connector: string } },
): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;
  const { connector } = ctx.params;
  if (!ALLOWED_CONNECTORS.has(connector)) {
    return new Response(JSON.stringify({ error: "Unknown connector" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  try {
    const res = await bridgeFetch(`/connections/${connector}`, {
      method: "DELETE",
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "fetch failed" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
