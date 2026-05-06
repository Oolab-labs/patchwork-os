import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const res = await bridgeFetch("/connections");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: text || `Bridge returned ${res.status}` }),
        { status: res.status, headers: { "content-type": "application/json" } },
      );
    }
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
