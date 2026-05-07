import { bridgeFetch } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Bridge caps `/recipes/generate` body at 4 KB. Cap the proxy at 8 KB
// (2× headroom for Content-Type / Content-Length variance) so an
// authenticated caller can't burn dashboard heap streaming a multi-GB
// body before the bridge cap kicks in (security audit 2026-05-07).
const MAX_BODY_BYTES = 8 * 1024;

function tooLarge(): Response {
  return new Response(
    JSON.stringify({ error: "request body too large" }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

async function readBodyWithCap(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false };
  }
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, body: "" };
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort drain — already over the cap, response is 413
      }
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

export async function POST(req: Request): Promise<Response> {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (isDemoModeServer()) {
    return new Response(
      JSON.stringify({
        ok: false,
        unavailable: true,
        error: "AI generation is not available in demo mode.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const read = await readBodyWithCap(req, MAX_BODY_BYTES);
  if (!read.ok) return tooLarge();
  try {
    const res = await bridgeFetch("/recipes/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: read.body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "fetch failed",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}
