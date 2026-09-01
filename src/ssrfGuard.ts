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
 * `validateSafeUrl` does NOT pin the URL hostname to the resolved IP; the
 * install routes call `fetch` once and accept the marginal TOCTOU window.
 *
 * Two further surfaces carry the full outbound-request discipline and are
 * the ONE implementation behind both `sendHttpRequest` (bridge tool) and the
 * recipe `http.post` tool (Phase 0 step 9 — previously the recipe tool did
 * only the lexical check and handed the raw URL to fetch with default
 * redirect following, so DNS-resolves-to-private and redirect-to-private
 * both walked straight past it):
 *   - `validateOutboundUrl(url, opts)` — parse, protocol, userinfo strip,
 *     lexical check, DNS pre-resolution re-check, returns the address to pin.
 *   - `safeFetch(url, init, opts)` — validates, pins the connection to the
 *     resolved address (hostname rewritten to the IP, original name carried
 *     in the Host header so SNI / virtual hosting keep working), follows up
 *     to N redirects manually re-validating EVERY hop, downgrades method/body
 *     per RFC 7231 on 301/302/303, and drops credential headers on a
 *     cross-origin hop.
 */

import dns from "node:dns/promises";

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

// ---------------------------------------------------------------------------
// Outbound request guard — the ONE implementation (Phase 0 step 9)
// ---------------------------------------------------------------------------

export type OutboundRefusal =
  | "invalid_url"
  | "unsupported_protocol"
  | "private_host"
  | "private_host_after_dns"
  | "too_many_redirects"
  | "invalid_redirect";

export interface OutboundUrlOptions {
  /**
   * Permit private/loopback targets (operator opt-in — `--allow-private-http`
   * on the bridge tool, `allowPrivate: true` on the recipe step). DNS is still
   * resolved so the connection is pinned; only the range check is skipped.
   */
  allowPrivate?: boolean;
  /**
   * Resolve a hostname to ONE address. Defaults to `dns.lookup`. A rejection
   * is treated as "could not resolve" and the request proceeds UNPINNED so the
   * transport reports the real DNS error — the behaviour `sendHttpRequest` has
   * always had and its tests assert.
   */
  resolveDns?: (hostname: string) => Promise<string>;
}

export interface OutboundUrlValidation {
  ok: boolean;
  reason?: OutboundRefusal;
  /** Human-readable detail (never includes credentials). */
  detail?: string;
  /** Parsed URL with userinfo stripped, when ok. */
  url?: URL;
  /** Resolved address to pin the connection to, when DNS succeeded. */
  pinnedAddress?: string;
}

const defaultResolveDns = async (hostname: string): Promise<string> => {
  // Via the default-import object so `vi.spyOn(dns, "lookup")` in the
  // existing suites still intercepts it (a named import would not).
  const { address } = await dns.lookup(hostname);
  return address;
};

/**
 * Validate an outbound URL. Rules, in order:
 *   1. must parse; 2. http(s) only; 3. userinfo is stripped, never sent;
 *   4. hostname is refused by `isPrivateHost` (localhost / *.localhost,
 *      0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16,
 *      ::1, fc00::/7, fe80::/10, 2002::/16, ::ffff: mapped forms, and the
 *      decimal / hex / octal / short IPv4 notations) unless `allowPrivate`;
 *   5. the hostname is resolved ONCE and the answer re-checked the same way
 *      unless `allowPrivate`; the answer is returned as `pinnedAddress`.
 */
export async function validateOutboundUrl(
  input: string | URL,
  opts: OutboundUrlOptions = {},
): Promise<OutboundUrlValidation> {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input.toString());
  } catch {
    return {
      ok: false,
      reason: "invalid_url",
      detail: typeof input === "string" ? input : String(input),
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_protocol", detail: url.protocol };
  }
  url.username = "";
  url.password = "";

  const allowPrivate = opts.allowPrivate === true;
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    return { ok: false, reason: "private_host", detail: url.hostname, url };
  }

  let pinnedAddress: string | undefined;
  try {
    pinnedAddress = await (opts.resolveDns ?? defaultResolveDns)(url.hostname);
  } catch {
    // Unresolvable — let the transport surface the real error.
    return { ok: true, url };
  }
  if (!allowPrivate && isPrivateHost(pinnedAddress)) {
    return {
      ok: false,
      reason: "private_host_after_dns",
      detail: `${url.hostname} → ${pinnedAddress}`,
      url,
    };
  }
  return { ok: true, url, pinnedAddress };
}

export class OutboundHttpError extends Error {
  constructor(
    public readonly code: OutboundRefusal,
    message: string,
  ) {
    super(message);
    this.name = "OutboundHttpError";
  }
}

/** Minimal fetch shape so undici's fetch and globalThis.fetch both fit. */
export type FetchLike = (
  url: string,
  init: Record<string, unknown>,
) => Promise<Response>;

export interface SafeFetchOptions extends OutboundUrlOptions {
  /** Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Follow 3xx redirects (default true). */
  followRedirects?: boolean;
  /** Redirect hop cap (default 10). */
  maxRedirects?: number;
}

export interface SafeFetchResult {
  response: Response;
  /** Redirect hops actually followed. */
  redirects: number;
  /** Un-pinned URL of the final hop (real hostname, no userinfo). */
  finalUrl: string;
}

const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "proxy-authorization",
] as const;

function refusalMessage(v: OutboundUrlValidation, hop: "request" | "redirect") {
  const where = hop === "redirect" ? "Redirect " : "";
  switch (v.reason) {
    case "invalid_url":
      return hop === "redirect"
        ? `Invalid redirect location: "${v.detail}"`
        : `Invalid URL: "${v.detail}"`;
    case "unsupported_protocol":
      return `${where}URL must use http:// or https://, got "${v.detail}"`;
    case "private_host":
      return `${where}target is a private/loopback address ("${v.detail}") — blocked`;
    case "private_host_after_dns":
      return `${where}hostname resolves to a private/loopback address (${v.detail}) — blocked`;
    default:
      return `${where}request refused`;
  }
}

function pin(url: URL, address: string | undefined): string {
  if (address === undefined) return url.toString();
  const pinned = new URL(url.toString());
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  return pinned.toString();
}

/**
 * Fetch with the full outbound discipline. Throws `OutboundHttpError` on any
 * refusal (initial URL or any redirect hop); transport errors propagate from
 * `fetchImpl` untouched so callers keep their own timeout/abort messages.
 *
 * `init.headers` must be a plain object; keys are lowercased. `host` is set
 * by this function AFTER caller headers so a caller cannot un-pin a hop.
 * Every other `init` field (signal, dispatcher, …) is passed through.
 */
export async function safeFetch(
  input: string | URL,
  init: Record<string, unknown> & {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? ((u, i) => globalThis.fetch(u, i as RequestInit));
  const followRedirects = opts.followRedirects ?? true;
  const maxRedirects = opts.maxRedirects ?? 10;

  const first = await validateOutboundUrl(input, opts);
  if (!first.ok || first.url === undefined) {
    throw new OutboundHttpError(
      first.reason ?? "invalid_url",
      refusalMessage(first, "request"),
    );
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  const { method: initMethod, headers: _h, body: initBody, ...rest } = init;

  let currentMethod = (initMethod ?? "GET").toUpperCase();
  let currentBody = initBody;
  let displayUrl = first.url;
  let currentUrl = pin(first.url, first.pinnedAddress);
  if (first.pinnedAddress !== undefined) headers.host = first.url.hostname;
  const originalOrigin = first.url.origin;
  let redirects = 0;

  while (true) {
    const response = await fetchImpl(currentUrl, {
      ...rest,
      method: currentMethod,
      headers,
      body: currentBody,
      redirect: "manual",
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (!followRedirects || !isRedirect) {
      return { response, redirects, finalUrl: displayUrl.toString() };
    }
    const location = response.headers.get("location");
    if (!location) {
      return { response, redirects, finalUrl: displayUrl.toString() };
    }
    if (redirects >= maxRedirects) {
      throw new OutboundHttpError(
        "too_many_redirects",
        `Too many redirects (>${maxRedirects})`,
      );
    }

    // Resolve against the UN-pinned URL so a relative Location lands on the
    // real hostname rather than the previous hop's IP.
    let nextRaw: URL;
    try {
      nextRaw = new URL(location, displayUrl);
    } catch {
      throw new OutboundHttpError(
        "invalid_redirect",
        `Invalid redirect location: "${location}"`,
      );
    }
    const next = await validateOutboundUrl(nextRaw, opts);
    if (!next.ok || next.url === undefined) {
      throw new OutboundHttpError(
        next.reason ?? "invalid_redirect",
        refusalMessage(next, "redirect"),
      );
    }

    // Host always from the real name — even when this hop's DNS failed —
    // so the previous hop's Host never leaks onto the new request.
    headers.host = next.url.hostname;

    // RFC 7231 + browser/fetch semantics: 301/302 of a non-GET/HEAD and any
    // 303 become GET without a body; 307/308 preserve both.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        currentMethod !== "GET" &&
        currentMethod !== "HEAD")
    ) {
      currentMethod = "GET";
      currentBody = undefined;
      delete headers["content-type"];
      delete headers["content-length"];
    }

    if (next.url.origin !== originalOrigin) {
      for (const h of CREDENTIAL_HEADERS) delete headers[h];
    }

    displayUrl = next.url;
    currentUrl = pin(next.url, next.pinnedAddress);
    redirects++;
  }
}
