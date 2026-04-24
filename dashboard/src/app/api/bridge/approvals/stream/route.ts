import { findBridge } from "@/lib/bridge";
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
    return new Response(": no bridge\n\n", {
      status: 503,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const { searchParams } = new URL(req.url);
  const session = searchParams.get("session");
  const qs = session ? `?session=${encodeURIComponent(session)}` : "";

  const remoteUrl = process.env.PATCHWORK_BRIDGE_URL;
  const upstreamUrl =
    lock.port === 0 && remoteUrl
      ? `${remoteUrl.replace(/\/$/, "")}/approvals/stream${qs}`
      : `http://127.0.0.1:${lock.port}/approvals/stream${qs}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${lock.authToken}` },
      signal: req.signal,
      // @ts-expect-error — Node.js fetch needs this to avoid buffering
      duplex: "half",
    });
  } catch {
    return new Response(": bridge unreachable\n\n", {
      status: 503,
      headers: { "Content-Type": "text/event-stream" },
    });
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
