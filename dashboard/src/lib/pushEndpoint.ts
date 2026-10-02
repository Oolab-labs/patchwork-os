/**
 * Is this a push-service endpoint the dashboard may deliver to?
 *
 * `/api/push/subscribe` stored whatever `endpoint` the body carried, and the
 * relay routes then `https.request` it on every fan-out through `web-push`.
 * An authenticated dashboard user could therefore make the dashboard server
 * POST to any host and port — RFC 1918, the cloud metadata address, a
 * service on this box — with the response never shown to them (blind SSRF).
 *
 * A browser push endpoint is an HTTPS URL on a public host with nothing in
 * the userinfo. That is the whole rule; the private-range decision is the
 * bridge's `isPrivateHost`, imported rather than copied so the two surfaces
 * cannot disagree about what "private" means (it already handles decimal
 * and hex IPv4 spellings, mapped IPv6 and the metadata range).
 *
 * The reason never echoes the URL: a 400 body is the one place a rejected
 * private address would otherwise be reflected back.
 */

import { isPrivateHost } from "../../../src/privateHost";

export type PushEndpointVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export function validatePushEndpoint(endpoint: unknown): PushEndpointVerdict {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return { ok: false, reason: "endpoint must be a string" };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "endpoint must use https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "endpoint must not carry credentials" };
  }
  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      reason: "endpoint must be a public host (no loopback, private or link-local address)",
    };
  }
  return { ok: true };
}
