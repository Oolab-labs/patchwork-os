import { NextResponse } from "next/server";

/**
 * Public VAPID key delivery for the service worker.
 *
 * The service worker fires `pushsubscriptionchange` when the browser
 * invalidates a subscription (commonly: SW update, iOS expiration,
 * Apple-side token rotation). To re-subscribe in the background the SW
 * needs the same `applicationServerKey` (VAPID public key) the page used
 * at first subscribe. Loading it from a public endpoint avoids baking
 * the key into the SW source (which would require a build-time template)
 * and avoids storing it in IndexedDB (which is per-origin and per-SW).
 *
 * Returns 503 if VAPID isn't configured server-side — same shape the
 * other push endpoints use.
 */
export async function GET() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  if (!publicKey) {
    return NextResponse.json(
      { error: "VAPID keys not configured" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { publicKey },
    {
      headers: {
        // Public key — safe to cache. The page bundle already gets it via
        // NEXT_PUBLIC_VAPID_PUBLIC_KEY at build time, so the SW fetching
        // it independently is redundant when the page is alive but the
        // only path when the SW runs without any open clients.
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
