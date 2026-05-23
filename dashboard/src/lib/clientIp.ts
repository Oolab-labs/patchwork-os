/**
 * Resolve the client IP for rate-limiting / lockout bucketing.
 *
 * x-forwarded-for is only trusted when BRIDGE_TRUST_PROXY=true is set —
 * reading it unconditionally lets any client spoof an arbitrary IP to bypass
 * the brute-force lockout. Set the env var only when a trusted reverse proxy
 * (nginx, Caddy) is known to set the header.
 *
 * Without BRIDGE_TRUST_PROXY, all requests fall into the "unknown" bucket.
 * This is intentionally conservative for local / direct deployments.
 *
 * Next 15 dropped NextRequest.ip, so we rely on forwarded headers. The
 * canonical Patchwork deploy (deploy/deploy-dashboard.sh) sets both headers
 * via nginx; if you front the dashboard differently, ensure your terminator
 * sets one of them and sets BRIDGE_TRUST_PROXY=true.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

export function clientKey(headers: HeadersLike): string {
  if (process.env.BRIDGE_TRUST_PROXY === "true") {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0];
      if (first) {
        const trimmed = first.trim();
        if (trimmed.length > 0) return trimmed;
      }
    }
    const xri = headers.get("x-real-ip");
    if (xri) {
      const trimmed = xri.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "unknown";
}
