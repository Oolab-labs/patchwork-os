import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const allowed = ["code", "state", "error"];
  const qs = new URLSearchParams();
  for (const key of allowed) {
    const v = url.searchParams.get(key);
    if (v !== null) qs.set(key, v);
  }

  const res = await bridgeFetch(`/connections/slack/callback?${qs.toString()}`);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
