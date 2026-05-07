/**
 * Resolve the client IP for rate-limiting / lockout bucketing.
 *
 * Trusts the leftmost entry of x-forwarded-for, falls back to x-real-ip,
 * then to the literal "unknown" so unidentified clients share a single
 * bucket. The "unknown" bucket only DOSes itself; legitimate identifiable
 * clients are unaffected.
 *
 * Next 15 dropped NextRequest.ip, so we rely on forwarded headers. The
 * canonical Patchwork deploy (deploy/deploy-dashboard.sh) sets both headers
 * via nginx; if you front the dashboard differently, ensure your terminator
 * sets one of them.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

export function clientKey(headers: HeadersLike): string {
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
  return "unknown";
}
