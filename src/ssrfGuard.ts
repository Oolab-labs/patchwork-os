/**
 * Shared SSRF guard helpers.
 *
 * Both `tools/httpClient.ts` (`sendHttpRequest`) and `recipeRoutes.ts`
 * (`/recipes/install`) plus `commands/recipeInstall.ts` (`httpsGet`) need to
 * reject hostnames that resolve to private/loopback ranges. Previously each
 * site re-implemented the check; this module is the single source of truth
 * to prevent drift (see Round-2 finding R2 I-1 / dogfood A-PR2).
 *
 * Two surfaces are exported:
 *   - `isPrivateHost(hostname)` — purely-lexical check (handles IPv4 dotted
 *     quads, IPv6, hex/octal IPv4, mapped IPv6→IPv4). Use synchronously when
 *     you only have a hostname string.
 *   - `validateSafeUrl(urlString)` — full async check that ALSO performs
 *     `dns.lookup()` and re-validates the resolved IP. Returns either a
 *     normalized `{ ok: true, url, resolvedIp? }` or `{ ok: false, reason }`.
 *
 * `validateSafeUrl` does NOT pin the URL hostname to the resolved IP. The
 * `sendHttpRequest` tool needs more elaborate header juggling for IP-pinning;
 * the install routes call `fetch` once and accept the marginal TOCTOU window.
 * Callers that need pinning should consult `tools/httpClient.ts` for the
 * full pattern (host header override, IPv6 bracketing, redirect re-validation).
 */

import dns from "node:dns/promises";

export interface UrlValidationResult {
  ok: boolean;
  /** Parsed URL when ok === true. */
  url?: URL;
  /** Resolved address when DNS lookup succeeded. */
  resolvedIp?: string;
  /** Failure reason when ok === false (machine-readable code). */
  reason?:
    | "invalid_url"
    | "unsupported_protocol"
    | "private_host"
    | "private_host_after_dns";
  /** Human-readable detail for logs. */
  detail?: string;
}

/**
 * Block requests to private/loopback addresses. Lexical-only check.
 *
 * Mirrors the predicate previously inlined in `tools/httpClient.ts`. Updates
 * here MUST stay in sync with the test fixtures in
 * `src/tools/__tests__/httpClient.test.ts`.
 */
export function isPrivateHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;

  // Reject non-decimal IPv4 notations (hex/octal) that bypass the dotted-quad
  // regex below. Node's URL parser may normalize them on some platforms.
  if (/^0x[0-9a-f]+$/i.test(host) || /^0[0-7]{7,}$/.test(host)) return true;

  // IPv4 range checks
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 RFC 1918 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / AWS metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
    if (a === 0) return true; // 0.0.0.0/8
  }

  // IPv6 checks
  if (host === "::1") return true; // loopback
  if (host.startsWith("fe80:")) return true; // link-local
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA (RFC 4193)
  if (host.startsWith("2002:")) return true; // 6to4 (RFC 3056) — embeds IPv4 in bits 16-47;
  // a 6to4 address for a private IPv4 (e.g. 2002:c0a8:0101:: → 192.168.1.1) bypasses
  // the IPv4 checks above unless we block the entire /16 here.
  // Check longer prefix first — ::ffff:0: (IPv4-translated) before ::ffff: (IPv4-mapped)
  if (host.startsWith("::ffff:0:")) return isPrivateHost(host.slice(9));
  if (host.startsWith("::ffff:")) return isPrivateHost(host.slice(7));

  return false;
}

/**
 * Loopback-only check (127.0.0.0/8, ::1, localhost). Lexical-only.
 *
 * Used by `isPrivateNonLoopbackHost` and by automation webhook fan-out, which
 * intentionally ALLOWS loopback (sidecars) but blocks every other private
 * range (RFC 1918, link-local, ULA, IMDS, 6to4-wrapped private, etc.).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 && Number(ipv4[1]) === 127) return true;
  // IPv6-mapped/translated loopback: ::ffff:127.0.0.1 / ::ffff:0:127.0.0.1
  if (host.startsWith("::ffff:0:")) return isLoopbackHost(host.slice(9));
  if (host.startsWith("::ffff:")) return isLoopbackHost(host.slice(7));
  return false;
}

/**
 * Private host MINUS loopback. Lexical-only.
 *
 * Use when a sink intentionally allows loopback (e.g. webhook fan-out to local
 * sidecars) but must still block RFC 1918, link-local, IMDS, ULA, 6to4-wrapped
 * private, and IPv4-mapped/translated private addresses.
 */
export function isPrivateNonLoopbackHost(hostname: string): boolean {
  if (isLoopbackHost(hostname)) return false;
  return isPrivateHost(hostname);
}

/**
 * Async URL safety gate used by `/recipes/install` and `commands/recipeInstall.ts`.
 *
 * Steps:
 *   1. Parse URL — reject malformed strings.
 *   2. Reject non-http(s) protocols.
 *   3. Reject hostname matched lexically by `isPrivateHost`.
 *   4. `dns.lookup(hostname)` and re-check resolved IP. DNS failures are
 *      surfaced as `ok: true` (no IP), letting the caller's fetch report the
 *      error naturally — same behaviour as `sendHttpRequest`.
 */
export async function validateSafeUrl(
  urlString: string,
): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: "invalid_url", detail: urlString };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      ok: false,
      reason: "unsupported_protocol",
      detail: parsed.protocol,
    };
  }

  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: "private_host", detail: parsed.hostname };
  }

  try {
    const { address } = await dns.lookup(parsed.hostname);
    if (isPrivateHost(address)) {
      return {
        ok: false,
        reason: "private_host_after_dns",
        detail: `${parsed.hostname} → ${address}`,
      };
    }
    return { ok: true, url: parsed, resolvedIp: address };
  } catch {
    // DNS failure — let caller's fetch surface the actual error.
    return { ok: true, url: parsed };
  }
}
