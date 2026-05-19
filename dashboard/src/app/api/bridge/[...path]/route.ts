import type { NextRequest } from "next/server";
import { bridgeFetch, findBridge, resolveBridgeUrl } from "@/lib/bridge";
import { requireSameOrigin } from "@/lib/csrf";
import {
  BRIDGE_BODY_CAPS,
  bodyTooLargeResponse,
  readBodyWithCap,
} from "@/lib/readBodyWithCap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxy(req: NextRequest, segments: string[]): Promise<Response> {
  const qs = req.nextUrl.search;
  const target = `/${segments.join("/")}${qs}`;

  // SSE passthrough for /stream — stream the response body back to the client.
  // Browsers only initiate EventSource over GET; reject other methods up-front
  // so this branch can't be used to bypass the CSRF check on the generic path.
  if (segments[0] === "stream") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "GET, HEAD" },
      });
    }
    const lock = findBridge();
    if (!lock) {
      return new Response(
        JSON.stringify({ error: "No running bridge found" }),
        { status: 503 },
      );
    }
    let upstream: Response;
    try {
      upstream = await fetch(resolveBridgeUrl(lock, target), {
        headers: { Authorization: `Bearer ${lock.authToken}` },
      });
    } catch (err) {
      console.error("[dashboard /api/bridge] upstream fetch failed:", err);
      return new Response(
        JSON.stringify({ error: "Bridge unreachable" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    // Wrap the upstream body so we can flush an initial heartbeat comment
    // immediately. Without this, the browser's EventSource.onopen never fires
    // until the first real event arrives (the bridge holds /stream idle).
    const encoder = new TextEncoder();
    const out = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch {
          // upstream/client disconnected
        } finally {
          controller.close();
        }
      },
    });
    return new Response(out, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const guard = requireSameOrigin(req);
    if (guard) return guard;
  }

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const read = await readBodyWithCap(req, BRIDGE_BODY_CAPS.genericProxy);
    if (!read.ok) return bodyTooLargeResponse(BRIDGE_BODY_CAPS.genericProxy);
    body = read.body;
  }
  const forwardHeaders: Record<string, string> = {
    "content-type": req.headers.get("content-type") ?? "",
  };
  const tracePassphrase = req.headers.get("x-trace-passphrase");
  if (tracePassphrase) forwardHeaders["x-trace-passphrase"] = tracePassphrase;
  let res: Response;
  try {
    res = await bridgeFetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });
  } catch (err) {
    // Detail (ECONNREFUSED, file paths, etc.) goes to server logs only —
    // returning err.message to the browser exposed internals (CodeQL #120,
    // js/stack-trace-exposure). Body matches the SSE branch above.
    console.error("[dashboard /api/bridge] proxy fetch failed:", err);
    return new Response(
      JSON.stringify({ error: "Bridge unreachable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  const upstreamCt = res.headers.get("content-type") ?? "";
  // Binary downloads (encrypted export, gzip) — stream bytes through directly.
  if (
    upstreamCt.includes("application/octet-stream") ||
    upstreamCt.includes("application/gzip")
  ) {
    const cd = res.headers.get("content-disposition");
    const responseHeaders: Record<string, string> = { "content-type": upstreamCt };
    if (cd) responseHeaders["content-disposition"] = cd;
    return new Response(res.body, { status: res.status, headers: responseHeaders });
  }
  const text = await res.text();
  const ct =
    upstreamCt.includes("application/json") || upstreamCt === ""
      ? "application/json"
      : upstreamCt;
  return new Response(text, {
    status: res.status,
    headers: { "content-type": ct },
  });
}

// Next 15: dynamic route params arrive as a Promise.
type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
export async function PUT(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
