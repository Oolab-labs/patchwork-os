import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_CONNECTORS = new Set(["linear", "sentry", "google-calendar"]);

export async function POST(
  req: Request,
  ctx: { params: { connector: string } },
): Promise<Response> {
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
