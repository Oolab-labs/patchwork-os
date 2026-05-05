import { findBridge, resolveBridgeUrl } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";
import { mockBridgeResponse } from "@/lib/mockData";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (isDemoModeServer()) {
    // In demo mode there's no live bridge — emit a snapshot built from
    // mockBridgeResponse('/approvals') so the page shows seeded approvals
    // instead of the empty all-clear state.
    let snapshot = "[]";
    try {
      const mock = mockBridgeResponse("/approvals", "GET");
      if (mock) snapshot = await mock.text();
    } catch {
      // fall back to empty
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`event: snapshot\ndata: ${snapshot}\n\n`),
        );
        // heartbeat every 15s to keep the connection alive
        const id = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
          } catch {
            clearInterval(id);
          }
        }, 15_000);
        req.signal.addEventListener("abort", () => {
          clearInterval(id);
          try { controller.close(); } catch { /* already closed */ }
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
