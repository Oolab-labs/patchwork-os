/**
 * Lexical private-range checks for hostnames and IP literals — pure string
 * work, no DNS and no network.
 *
 * Split out of `ssrfGuard.ts` (2026-10-02) so code that only needs the range
 * decision does not inherit ssrfGuard's I/O dependencies. The trigger: the
 * dashboard's push-endpoint validator imports `isPrivateHost`, and once
 * ssrfGuard imported `undici` (to pin connections) the dashboard package —
 * which does not depend on undici — failed to typecheck. `ssrfGuard.ts`
 * re-exports everything here, so every existing importer is unchanged.
 */

/**
 * Convert the hex-compressed form that `new URL()` may return for an
 * IPv4-mapped/translated IPv6 address back to dotted-decimal so the existing
 * `isPrivateHost` checks apply.
 *
 * Handles:
 *   "xxxx:yyyy"  — two 16-bit groups (up to 4 hex digits each, no leading zeros)
 *   "xxxxxxxx"   — a single 32-bit group
 *
 * Returns null when the input is not recognisable as 32-bit hex-IPv4.
 */
function hexIpv4ToDotted(s: string): string | null {
  const colon = s.indexOf(":");
  if (colon !== -1) {
    const hi = s.slice(0, colon);
    const lo = s.slice(colon + 1);
    if (!/^[0-9a-f]{1,4}$/i.test(hi) || !/^[0-9a-f]{1,4}$/i.test(lo))
      return null;
    const hiN = parseInt(hi, 16);
    const loN = parseInt(lo, 16);
    return `${(hiN >>> 8) & 0xff}.${hiN & 0xff}.${(loN >>> 8) & 0xff}.${loN & 0xff}`;
  }
  if (!/^[0-9a-f]{1,8}$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/**
 * inet_aton-style loose IPv4 parse: 1-4 parts, each decimal, octal (leading
 * 0) or hex (0x). Returns canonical dotted-quad or null when the string is
 * not an all-numeric IPv4 form. `new URL()` already canonicalises these, but
 * callers that hand `isPrivateHost` a raw string (a DNS answer, a Location
 * header hostname) must not be bypassable by `0x7f000001`, `2130706433`,
 * `0177.0.0.1` or `127.1`.
 */
function looseIpv4ToDotted(host: string): string | null {
  if (
    !/^[0-9a-fx.]+$/i.test(host) ||
    host.startsWith(".") ||
    host.endsWith(".")
  )
    return null;
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  // Last part fills the remaining bytes (inet_aton semantics).
  const last = nums[nums.length - 1] as number;
  const remainingBytes = 4 - (nums.length - 1);
  if (last >= 2 ** (8 * remainingBytes)) return null;
  for (let i = 0; i < nums.length - 1; i++) {
    if ((nums[i] as number) > 255) return null;
  }
  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    value = value * 256 + (nums[i] as number);
  }
  value = value * 2 ** (8 * remainingBytes) + last;
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
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

  // Unusual IPv4 notations (decimal integer, short-form "127.1", zero-padded
  // octal, per-part hex): canonicalise and re-check the dotted form.
  const canonicalIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!canonicalIpv4) {
    const dotted = looseIpv4ToDotted(host);
    if (dotted !== null) return isPrivateHost(dotted);
  }

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
  // Also handle hex-compressed form that new URL() may return (e.g. "7f00:1" = 127.0.0.1).
  if (host.startsWith("::ffff:0:")) {
    const rest = host.slice(9);
    const dotted = hexIpv4ToDotted(rest);
    return isPrivateHost(dotted ?? rest);
  }
  if (host.startsWith("::ffff:")) {
    const rest = host.slice(7);
    const dotted = hexIpv4ToDotted(rest);
    return isPrivateHost(dotted ?? rest);
  }

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
  // Also handle hex-compressed form from new URL() (e.g. "7f00:1" = 127.0.0.1).
  if (host.startsWith("::ffff:0:")) {
    const rest = host.slice(9);
    const dotted = hexIpv4ToDotted(rest);
    return isLoopbackHost(dotted ?? rest);
  }
  if (host.startsWith("::ffff:")) {
    const rest = host.slice(7);
    const dotted = hexIpv4ToDotted(rest);
    return isLoopbackHost(dotted ?? rest);
  }
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
