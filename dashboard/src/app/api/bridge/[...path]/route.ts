import type { NextRequest } from "next/server";
import { bridgeFetch, findBridge } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxy(req: NextRequest, segments: string[]): Promise<Response> {
  const qs = req.nextUrl.search;
  const target = `/${segments.join("/")}${qs}`;

  // SSE passthrough for /stream — stream the response body back to the client.
  if (segments[0] === "stream") {
    const lock = findBridge();
    if (!lock) {
      return new Response(
        JSON.stringify({ error: "No running bridge found" }),
        { status: 503 },
      );
    }
    const upstream = await fetch(`http://127.0.0.1:${lock.port}${target}`, {
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

  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.text();
  const res = await bridgeFetch(target, {
    method: req.method,
    headers: { "content-type": req.headers.get("content-type") ?? "" },
    body,
  });
  const text = await res.text();
  const upstreamCt = res.headers.get("content-type") ?? "";
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
export async function PATCH(
  req: NextRequest,
  ctx: { params: { path: string[] } },
) {
  return proxy(req, ctx.params.path);
}
