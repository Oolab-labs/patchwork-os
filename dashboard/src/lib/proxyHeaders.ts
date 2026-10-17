/**
 * Security headers for a response that RELAYS a bridge body.
 *
 * Security sweep L4: rebuilding a response with only `content-type` stripped
 * the bridge's own CSP / X-Frame-Options, so bridge HTML was re-served from
 * the dashboard origin with no script policy. Forward those headers, and give
 * HTML that arrives without a CSP a sandboxed, script-free policy. The
 * dashboard never renders proxied HTML as a page, so this costs nothing.
 *
 * Every route that relays a bridge body with the upstream content type uses
 * this (audit M30): the L4 fix first lived inside the generic proxy only, so
 * dedicated proxies re-served bridge HTML with no script policy. The OAuth
 * callback route is the deliberate exception — it RENDERS the bridge's
 * callback page, whose script notifies the opener that a connect finished.
 */
export const FORWARDED_SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
] as const;
export const HTML_FALLBACK_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

export function securityHeadersFor(
  upstream: Headers,
  ct: string,
): Record<string, string> {
  const out: Record<string, string> = { "content-type": ct };
  for (const name of FORWARDED_SECURITY_HEADERS) {
    const v = upstream.get(name);
    if (v) out[name] = v;
  }
  if (ct.toLowerCase().includes("text/html")) {
    out["content-security-policy"] ??= HTML_FALLBACK_CSP;
    out["x-content-type-options"] = "nosniff";
  }
  return out;
}
