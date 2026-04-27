import { findBridge, resolveBridgeUrl } from "@/lib/bridge";
import { isDemoModeServer } from "@/lib/demoModeServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (isDemoModeServer()) {
    // In demo mode there's no live bridge — return an empty stream that
    // sends a snapshot of [] immediately and stays open with heartbeats.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("event: snapshot\ndata: []\n\n"),
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
