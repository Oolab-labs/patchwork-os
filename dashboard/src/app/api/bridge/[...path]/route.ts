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
    // Abort the upstream bridge fetch when the browser disconnects.
    // Without this, closing an EventSource (tab close, page reload,
    // navigation) cancels the downstream response but leaves the upstream
    // fetch reader looping forever. The bridge keeps the subscriber
    // registered, its 15s keep-alive ping keeps succeeding into the
    // orphaned proxy socket, and its cleanup() never runs — every reload
    // leaks one subscriber until the bridge's 20-cap saturates and
    // /stream returns 503 forever (kill-switch + activity ticker die).
    const upstreamAbort = new AbortController();
    const abortUpstream = () => {
      if (!upstreamAbort.signal.aborted) upstreamAbort.abort();
    };
    // Propagate client disconnect: req.signal aborts when the browser
    // goes away. If it's already aborted, abort the upstream immediately.
    if (req.signal) {
      if (req.signal.aborted) abortUpstream();
      else req.signal.addEventListener("abort", abortUpstream, { once: true });
    }
    let upstream: Response;
    try {
      upstream = await fetch(resolveBridgeUrl(lock, target), {
        headers: { Authorization: `Bearer ${lock.authToken}` },
        signal: upstreamAbort.signal,
      });
    } catch (err) {
      console.error("[dashboard /api/bridge] upstream fetch failed:", err);
      return new Response(
        JSON.stringify({ error: "Bridge unreachable" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    // Upstream rejected the subscription (e.g. 503 — the bridge's SSE
    // subscriber cap is saturated). Don't wrap a non-OK response in a
    // fake `text/event-stream` body with a `: connected` heartbeat —
    // that misleads the client into thinking it briefly connected.
    // Pass the upstream status + JSON error straight through so the
    // EventSource fails cleanly and the UI shows "Live stream offline".
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return new Response(
        errText || JSON.stringify({ error: "Bridge stream unavailable" }),
        {
          status: upstream.status,
          headers: {
            "content-type":
              upstream.headers.get("content-type") ?? "application/json",
          },
        },
      );
    }
    // Wrap the upstream body so we can flush an initial heartbeat comment
    // immediately. Without this, the browser's EventSource.onopen never fires
    // until the first real event arrives (the bridge holds /stream idle).
    const encoder = new TextEncoder();
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const out = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        upstreamReader = reader;
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
      // Fires when the downstream consumer goes away (Next.js cancels the
      // response when the browser closes the connection). Abort the
      // upstream fetch and cancel its reader so the bridge sees the socket
      // close and runs cleanup() — decrementing sseSubscriberCount.
      cancel() {
        abortUpstream();
        upstreamReader?.cancel().catch(() => {});
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
  if (tracePassphrase && tracePassphrase.length <= 512) {
    forwardHeaders["x-trace-passphrase"] = tracePassphrase;
  }
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
