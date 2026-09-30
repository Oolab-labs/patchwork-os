/**
 * Resolve the client IP for rate-limiting / lockout bucketing.
 *
 * Forwarding headers are only trusted when BRIDGE_TRUST_PROXY=true is set —
 * reading them unconditionally lets any client spoof an arbitrary IP to bypass
 * the brute-force lockout. Set the env var only when a trusted reverse proxy
 * (nginx, Caddy) is known to set them.
 *
 * Without BRIDGE_TRUST_PROXY, all requests fall into the "unknown" bucket.
 * This is intentionally conservative for local / direct deployments. Note
 * that NO file under deploy/ sets the variable, so this is the shipped
 * default; the nginx configs there set the headers, and an operator who
 * wants per-IP lockout must set the variable as well.
 *
 * ## Which header, and which end of it
 *
 * `X-Real-IP` first. nginx writes it from `$remote_addr` — the peer it
 * actually accepted the connection from — and never from client input, so
 * behind a single trusted proxy it is the one value that cannot be forged.
 *
 * `X-Forwarded-For` second, and the RIGHTMOST hop, not the leftmost. Every
 * shipped nginx config uses `$proxy_add_x_forwarded_for`, which APPENDS the
 * real peer to whatever the client sent. The leftmost entry is therefore
 * attacker-controlled: keying the lockout on it let a client send a fresh
 * `X-Forwarded-For: <random>` per attempt, land each one in a new bucket,
 * and never trip `MAX_FAILURES`. The bridge's own resolver
 * (`src/server.ts` `getClientIp`) already walks right-to-left; this copy did
 * not, and its tests pinned the leftmost choice as intended.
 *
 * This assumes ONE trusted proxy hop. A chain of trusted proxies would need
 * a trusted-address list to walk past (as the bridge does); the dashboard has
 * no such setting, and adding one is a config surface this module should
 * not grow on its own.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

export function clientKey(headers: HeadersLike): string {
  if (process.env.BRIDGE_TRUST_PROXY === "true") {
    const xri = headers.get("x-real-ip");
    if (xri) {
      const trimmed = xri.trim();
      if (trimmed.length > 0) return trimmed;
    }
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  return "unknown";
}
