import { bridgeFetch } from "@/lib/bridge";
import { requireCallbackSession } from "../../requireSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  // LOW #39: verify active dashboard session before forwarding OAuth code.
  const authErr = await requireCallbackSession(req);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const allowed = ["code", "state", "error"];
  const qs = new URLSearchParams();
  for (const key of allowed) {
    const v = url.searchParams.get(key);
    if (v !== null) qs.set(key, v);
  }

  try {
    const res = await bridgeFetch(`/connections/google-docs/callback?${qs.toString()}`);
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    console.error("[connections/google-docs/callback GET] bridge fetch failed:", err);
    return new Response(JSON.stringify({ error: "Bridge unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
