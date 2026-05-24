import { findBridge, resolveBridgeUrl } from "@/lib/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const lock = findBridge();
  if (!lock) {
    return new Response(
      'event: bridge-error\ndata: {"error":"bridge unavailable"}\n\n: retry\n\n',
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  }

  const { searchParams } = new URL(req.url);
  const session = searchParams.get("session");
  const qs = session ? `?session=${encodeURIComponent(session)}` : "";

  const upstreamUrl = resolveBridgeUrl(lock, `/approvals/stream${qs}`);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${lock.authToken}` },
      signal: req.signal,
      // @ts-expect-error — Node.js fetch needs this to avoid buffering
      duplex: "half",
    });
  } catch {
    return new Response(
      'event: bridge-error\ndata: {"error":"bridge unavailable"}\n\n: retry\n\n',
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  }

  if (!upstream.ok) {
    // Upstream bridge doesn't speak /approvals/stream (older version) or is
    // erroring. Surface as a `bridge-error` SSE event with a 200 status so
    // EventSource treats it as a clean signal — not a fatal error that
    // triggers immediate browser-side reconnect.
    return new Response(
      `event: bridge-error\ndata: {"error":"upstream ${upstream.status}"}\n\n: retry\n\n`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  }

  if (!upstream.body) {
    return new Response(
      `event: bridge-error\ndata: {"error":"upstream ${upstream.status}"}\n\n: retry\n\n`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  }

  // Pipe through a passthrough TransformStream so that when the client
  // disconnects and cancels the response ReadableStream, the cancellation
  // propagates back upstream and closes the bridge SSE subscriber.
  // Without this, the upstream fetch stays open even after the tab closes.
  return new Response(upstream.body.pipeThrough(new TransformStream()), {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
