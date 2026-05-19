import { bridgeFetch } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";
import { assertValidInstallSource } from "@/lib/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonError(
  status: number,
  error: string,
  code?: string,
): Response {
  return new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const guard = requireSameOrigin(req);
  if (guard) return guard;

  const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.install);
  if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.install);

  // Server-side `source` validation — defense in depth. Browser-side
  // assertValidInstallSource is easily bypassed by a direct POST, and the
  // bridge's own validation is the only remaining gate without this. Reject
  // anything that isn't `github:owner/repo[/path][@ref]` shape BEFORE we
  // touch the bridge socket — keeps dashboard logs clean and removes one
  // forward-step from any tampered-registry / curl-style attack path.
  let parsed: { source: unknown } | null = null;
  try {
    parsed = JSON.parse(read.body) as { source: unknown };
  } catch {
    return jsonError(400, "Request body is not valid JSON", "bad_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError(
      400,
      "Request body must be an object with a `source` string",
      "bad_body_shape",
    );
  }
  if (typeof parsed.source !== "string") {
    return jsonError(
      400,
      "Missing or non-string `source` field",
      "bad_source_type",
    );
  }
  try {
    assertValidInstallSource(parsed.source);
  } catch (e) {
    return jsonError(
      400,
      e instanceof Error ? e.message : "Invalid install source",
      "bad_source_shape",
    );
  }

  try {
    const res = await bridgeFetch("/recipes/install", {
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
    // #600: don't leak err.message detail; see [name]/route.ts.
    console.error("[recipes/install] bridge fetch failed:", err);
    return jsonError(502, "Bridge unreachable");
  }
}
