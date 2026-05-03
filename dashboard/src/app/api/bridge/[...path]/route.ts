import type { NextRequest } from "next/server";
import { bridgeFetch, findBridge, resolveBridgeUrl } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";
import { mockBridgeResponse } from "@/lib/mockData";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** SSE stream that emits an immediate empty snapshot then heartbeats — used in
 *  demo mode where there's no real bridge to forward from. Without this the
 *  client polls indefinitely against a stream that doesn't exist. */
function demoStream(req: Request): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      const id = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(id);
        }
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(id);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function proxy(req: NextRequest, segments: string[]): Promise<Response> {
  const qs = req.nextUrl.search;
  const target = `/${segments.join("/")}${qs}`;
  const demo = isDemoModeServer();

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
    if (demo) return demoStream(req);
    const lock = findBridge();
    if (!lock) {
      return new Response(
        JSON.stringify({ error: "No running bridge found" }),
        { status: 503 },
      );
    }
    const upstream = await fetch(resolveBridgeUrl(lock, target), {
      headers: { Authorization: `Bearer ${lock.authToken}` },
    });
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
    const sfs = req.headers.get("sec-fetch-site");
    if (sfs && sfs !== "same-origin" && sfs !== "none") {
      return new Response(JSON.stringify({ error: "CSRF check failed" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // In demo mode short-circuit to fixture data instead of hitting a bridge
  // that isn't there. Without this every dashboard route below /marketplace
  // shows raw 401 banners on the public demo site.
  if (demo) {
    const mock = mockBridgeResponse(`/${segments.join("/")}${qs}`, req.method);
    if (mock) return mock;
  }

  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.text();
  const forwardHeaders: Record<string, string> = {
    "content-type": req.headers.get("content-type") ?? "",
  };
  const tracePassphrase = req.headers.get("x-trace-passphrase");
  if (tracePassphrase) forwardHeaders["x-trace-passphrase"] = tracePassphrase;
  const res = await bridgeFetch(target, {
    method: req.method,
    headers: forwardHeaders,
    body,
  });
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

export async function GET(
  req: NextRequest,
  ctx: { params: { path: string[] } },
) {
  return proxy(req, ctx.params.path);
}
export async function POST(
  req: NextRequest,
  ctx: { params: { path: string[] } },
) {
  return proxy(req, ctx.params.path);
}
export async function DELETE(
  req: NextRequest,
  ctx: { params: { path: string[] } },
) {
  return proxy(req, ctx.params.path);
}
export async function PUT(
  req: NextRequest,
  ctx: { params: { path: string[] } },
) {
  return proxy(req, ctx.params.path);
}
export async function PATCH(
  req: NextRequest,
  ctx: { params: { path: string[] } },
) {
  return proxy(req, ctx.params.path);
}
