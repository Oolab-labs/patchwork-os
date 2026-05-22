import { bridgeFetch } from "@/lib/bridge";
import { forwardOrGeneric } from "@/lib/forwardOrGeneric";

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
  "asana",
  "discord",
  "gitlab",
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
  ctx: { params: Promise<{ connector: string }> },
): Promise<Response> {
  const { connector } = await ctx.params;
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
    return await forwardOrGeneric(res, `connections/${connector}/auth GET`);
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error(`[connections/${connector}/auth GET] bridge fetch failed:`, err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
