import { bridgeFetch } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const res = await bridgeFetch("/connections");
    if (!res.ok) {
      // #600: don't leak upstream body — log server-side, return generic.
      const text = await res.text().catch(() => "");
      console.error(
        `[connections GET] bridge returned ${res.status}:`,
        text,
      );
      return new Response(
        JSON.stringify({ error: `Bridge returned ${res.status}` }),
        { status: res.status, headers: { "content-type": "application/json" } },
      );
    }
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    // #600: don't leak err.message detail.
    console.error("[connections GET] bridge fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
