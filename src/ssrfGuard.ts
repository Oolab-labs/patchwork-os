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
 *   - `safeFetch(url, init, opts)` — validates, pins the CONNECTION to the
 *     resolved address through an undici dispatcher whose `connect.lookup`
 *     returns that address, follows up to N redirects manually re-validating
 *     EVERY hop, downgrades method/body per RFC 7231 on 301/302/303, and
 *     drops credential headers on a cross-origin hop.
 *
 * The pin lives in the connection, never in the URL. #1572 first pinned by
 * rewriting the URL's hostname to the IP and carrying the name in a `Host`
 * header; TLS takes SNI and the certificate check from the URL, so every
 * public HTTPS request failed ERR_TLS_CERT_ALTNAME_INVALID, and `fetch`
 * silently drops a caller-set `Host`, so plain HTTP reached virtual hosts
 * with the wrong one. Found 2026-10-02 against the installed build; nothing
 * in the suite could see it because every test used a mocked fetch or a
 * loopback HTTP server.
 */

import dns from "node:dns/promises";
import { Agent, type Dispatcher } from "undici";
import {
  isLoopbackHost,
  isPrivateHost,
  isPrivateNonLoopbackHost,
} from "./privateHost.js";

// Re-exported so every existing `from "./ssrfGuard.js"` importer is unchanged.
export { isLoopbackHost, isPrivateHost, isPrivateNonLoopbackHost };

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
  /**
   * Defaults to `globalThis.fetch`. Node's built-in fetch accepts the pinning
   * `Agent` from the `undici` package as its `dispatcher` — verified against a
   * public HTTPS endpoint on Node 24 (2026-10-02).
   */
  fetchImpl?: FetchLike;
  /**
   * Extra socket options for every hop's connection (e.g. `{ family: 4 }`).
   * `lookup` is always overridden when a hop is pinned.
   */
  connect?: Record<string, unknown>;
  /**
   * Wrap the per-hop dispatcher safeFetch builds — the seam `http.post` uses
   * to observe `onConnect` (its "was anything sent" boundary). A caller's
   * `init.dispatcher` is IGNORED: honouring it would let a caller route
   * around the pin, which is the whole guard.
   */
  wrapDispatcher?: (d: Dispatcher) => Dispatcher;
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

/**
 * A dispatcher whose connections go to `address` (when given), however the
 * URL's hostname would resolve. The URL is left alone, so TLS uses the real
 * name for SNI and certificate verification and the Host header is derived
 * from it. Node's `net`/`tls` call `lookup` with `{ all: true }` when
 * autoSelectFamily is on, so both callback shapes are answered.
 *
 * One Agent per hop, with short keep-alive: the pin is per-hostname-per-hop,
 * and a shared pool keyed only on origin would happily reuse a socket pinned
 * for a previous answer.
 */
function hopDispatcher(
  address: string | undefined,
  opts: SafeFetchOptions,
): Dispatcher {
  const connect: Record<string, unknown> = { ...(opts.connect ?? {}) };
  if (address !== undefined) {
    const family = address.includes(":") ? 6 : 4;
    connect.lookup = (
      _hostname: string,
      lookupOpts: { all?: boolean } | undefined,
      cb: (...args: unknown[]) => void,
    ) => {
      if (lookupOpts?.all) cb(null, [{ address, family }]);
      else cb(null, address, family);
    };
  }
  const agent = new Agent({
    connect,
    keepAliveTimeout: 1_000,
    keepAliveMaxTimeout: 1_000,
  });
  return opts.wrapDispatcher ? opts.wrapDispatcher(agent) : agent;
}

/**
 * Fetch with the full outbound discipline. Throws `OutboundHttpError` on any
 * refusal (initial URL or any redirect hop); transport errors propagate from
 * `fetchImpl` untouched so callers keep their own timeout/abort messages.
 *
 * `init.headers` must be a plain object; keys are lowercased. A caller's
 * `host` header and `dispatcher` are DROPPED: Host is derived from the URL,
 * and the dispatcher is the pin — accepting either from the caller is a way
 * to steer the request somewhere the validation never looked. Every other
 * `init` field (signal, …) is passed through.
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
    const key = k.toLowerCase();
    if (key === "host") continue;
    headers[key] = v;
  }
  const {
    method: initMethod,
    headers: _h,
    body: initBody,
    dispatcher: _callerDispatcher,
    ...rest
  } = init;

  let currentMethod = (initMethod ?? "GET").toUpperCase();
  let currentBody = initBody;
  let displayUrl = first.url;
  let currentUrl = first.url.toString();
  let currentDispatcher = hopDispatcher(first.pinnedAddress, opts);
  const originalOrigin = first.url.origin;
  let redirects = 0;

  while (true) {
    const response = await fetchImpl(currentUrl, {
      ...rest,
      method: currentMethod,
      headers,
      body: currentBody,
      redirect: "manual",
      dispatcher: currentDispatcher,
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

    // The previous hop's response is fully handled (a redirect body is never
    // read), so its dispatcher can close; the next hop gets its own pin.
    void (currentDispatcher as Agent).close?.().catch?.(() => {});
    displayUrl = next.url;
    currentUrl = next.url.toString();
    currentDispatcher = hopDispatcher(next.pinnedAddress, opts);
    redirects++;
  }
}
