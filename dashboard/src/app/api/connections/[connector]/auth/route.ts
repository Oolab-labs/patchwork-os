import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_CONNECTORS = new Set([
  "gmail",
  "google-calendar",
  "google-drive",
  "github",
  "linear",
  "sentry",
  "slack",
  "notion",
  "confluence",
  "datadog",
  "hubspot",
  "intercom",
  "stripe",
  "zendesk",
]);

export async function GET(
  _req: Request,
  ctx: { params: { connector: string } },
): Promise<Response> {
  const { connector } = ctx.params;
  if (!ALLOWED_CONNECTORS.has(connector)) {
    return new Response(JSON.stringify({ error: "Unknown connector" }), {
      status: 404, headers: { "content-type": "application/json" },
    });
  }
  // Fetch the bridge auth endpoint server-side (with auth token) to get the
  // OAuth redirect URL, then forward that URL to the browser.
  try {
    const res = await bridgeFetch(`/connections/${connector}/auth`, {
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) return Response.redirect(location, 302);
      return new Response(JSON.stringify({ error: "Bridge returned redirect without Location header" }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
    const body = await res.text();
    return new Response(body, {
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
