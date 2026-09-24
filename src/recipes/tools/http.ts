/**
 * HTTP tools — http.post
 *
 * Built-in step type for POSTing JSON / text bodies to a URL without
 * spawning an agent. Designed for fire-and-forget notifications
 * (ntfy.sh, generic webhooks). Outbound safety — private-range refusal,
 * DNS pre-resolution + pinning, per-hop redirect re-validation — is the
 * shared `safeFetch` in src/ssrfGuard.ts, the same implementation behind
 * the bridge's `sendHttpRequest`. Private/loopback hosts are refused unless
 * the recipe explicitly opts in with `allowPrivate: true`.
 */

import dns from "node:dns/promises";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";
import {
  assertWriteAllowed,
  FLAG_BLOCK_RECIPE_ALLOW_PRIVATE,
  isEnabled,
} from "../../featureFlags.js";
// Canonical SSRF guard — single source of truth. `isPrivateHost` is
// re-exported below for the lexical unit tests; execution goes through
// `safeFetch`, which ALSO resolves DNS and re-validates every redirect hop
// (the lexical check alone let a private-resolving public name through).
import {
  isPrivateHost,
  OutboundHttpError,
  safeFetch,
} from "../../ssrfGuard.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { UncertainOutcomeError } from "../uncertainOutcome.js";

// Custom dispatcher pinning DNS resolution to IPv4. Node's Happy-Eyeballs
// implementation (autoSelectFamily) is documented to flip families after
// 250 ms, but on macOS networks that lack a usable IPv6 path
// (most home/office LANs, despite the host having public AAAA records)
// the IPv6 attempt stalls past Node's request timeout and surfaces as
// ETIMEDOUT — even though IPv4 would have succeeded instantly. Probing
// repro'd this against ntfy.sh on 2026-05-12.
//
// IPv6-only networks are vanishingly rare in 2026; if one comes up we
// can add a step-level `family: 6` override.
const httpAgent = new Agent({
  // biome-ignore lint/suspicious/noExplicitAny: undici's TcpNetConnectOpts type insists on `port` but it isn't required at the Agent-default-connect level
  connect: { family: 4 } as any,
  // Keep idle sockets short to avoid stale connections to the same host
  // hanging across recipe fires.
  keepAliveTimeout: 5_000,
  keepAliveMaxTimeout: 10_000,
});

/**
 * The "sent" boundary. A per-request view over the shared agent whose ONLY
 * job is to record whether undici ever handed this request to a socket.
 *
 * undici invokes the handler's `onConnect` immediately before it writes the
 * request to the connection — pooled or fresh, it fires per request. Nothing
 * observable from `fetch`'s rejection distinguishes "refused before a byte
 * left" from "accepted, then the response died": both arrive as
 * `TypeError: fetch failed`, and the abort from our own timer arrives the
 * same way whether the connect stalled or the target swallowed the write.
 * So the boundary is recorded on the way OUT rather than inferred from the
 * error on the way back.
 *
 * Deliberately `onConnect` and not `onBodySent`: once headers are on the
 * wire the target may already be acting on them (a 100-continue server, or
 * one that ignores the body), so "sent" means "handed to the socket", not
 * "body fully flushed". Anything that fails after this point is treated as
 * uncertain; a connect stall that our timer aborts before `onConnect` stays
 * an ordinary (retriable) failure, because nothing reached the target.
 */
function trackedDispatcher(): { dispatcher: Dispatcher; sent: () => boolean } {
  let sent = false;
  const dispatcher = httpAgent.compose(
    (dispatch) => (opts, handler) =>
      dispatch(opts, {
        ...handler,
        onConnect(abort) {
          sent = true;
          handler.onConnect?.(abort);
        },
      }),
  );
  return { dispatcher, sent: () => sent };
}

registerTool({
  id: "http.post",
  namespace: "http",
  description:
    "POST/PUT/PATCH a body to a URL. Returns {status, ok, body} as JSON. " +
    "Private/loopback hosts are blocked unless `allowPrivate: true` is set.",
  paramsSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Target URL (http or https)",
      },
      method: {
        type: "string",
        enum: ["POST", "PUT", "PATCH"],
        default: "POST",
      },
      body: {
        type: "string",
        description:
          "Request body as string (supports {{template}} substitution). " +
          "For JSON, set contentType: application/json and pass a JSON string.",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Extra request headers. Override Content-Type here if needed.",
      },
      contentType: {
        type: "string",
        default: "application/json",
        description: "Shortcut for Content-Type header.",
      },
      timeoutMs: {
        type: "number",
        default: 10000,
        description: "Abort the request after this many ms (max 60000).",
      },
      allowPrivate: {
        type: "boolean",
        default: false,
        description:
          "Allow loopback/RFC1918/link-local hosts. Off by default to prevent SSRF.",
      },
      into: CommonSchemas.into,
    },
    required: ["url"],
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "number" },
      ok: { type: "boolean" },
      body: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  execute: async ({ params }) => {
    assertWriteAllowed("http.post");

    const url = params.url as string;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("http.post: 'url' is required");
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`http.post: invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `http.post: only http/https supported (got ${parsed.protocol})`,
      );
    }

    // Operator kill-flag: when on, the per-step allowPrivate:true bypass is
    // ignored so a (potentially marketplace-installed) recipe can never reach
    // a private/loopback host.
    const bypassDisabled = isEnabled(FLAG_BLOCK_RECIPE_ALLOW_PRIVATE);
    const allowPrivate = !bypassDisabled && params.allowPrivate === true;

    const method = ((params.method as string) ?? "POST").toUpperCase();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
      throw new Error(`http.post: unsupported method ${method}`);
    }

    const body = params.body as string | undefined;
    const contentType =
      (params.contentType as string | undefined) ?? "application/json";
    const extraHeaders =
      (params.headers as Record<string, string> | undefined) ?? {};
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      ...extraHeaders,
    };

    const rawTimeout = params.timeoutMs as number | undefined;
    const timeoutMs = Math.min(
      Math.max(typeof rawTimeout === "number" ? rawTimeout : 10_000, 100),
      60_000,
    );

    // Re-check immediately before the network write: the kill switch may
    // have been engaged during the SSRF/URL validation above.
    assertWriteAllowed("http.post");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const tracked = trackedDispatcher();
    // Names the destination without the body or the query string: the halt
    // sentence is rendered on the dashboard, in `patchwork halts` and in the
    // trust ledger's neighbourhood, and a write body is not for any of them.
    const destination = `${method} ${parsed.origin}${parsed.pathname}`;
    // Use undici.fetch directly (not global fetch) so we can pass the custom
    // dispatcher with Happy-Eyeballs tuning. Global fetch's type doesn't
    // expose `dispatcher`, but they're the same implementation underneath.
    // The connection is pinned to the address resolved here (IPv4 to match
    // the dispatcher), so undici never re-resolves the name.
    let res: Response;
    try {
      const result = await safeFetch(
        parsed,
        {
          method,
          body,
          headers,
          signal: ctrl.signal,
          dispatcher: tracked.dispatcher,
        },
        {
          allowPrivate,
          resolveDns: async (hostname) =>
            (await dns.lookup(hostname, { family: 4 })).address,
          // undici's Response type lags the DOM lib (no `bytes()`); same
          // object at runtime.
          fetchImpl: (u, i) =>
            undiciFetch(
              u,
              i as Parameters<typeof undiciFetch>[1],
            ) as unknown as Promise<Response>,
        },
      );
      res = result.response;
    } catch (err) {
      if (err instanceof OutboundHttpError) {
        const hint =
          (err.code === "private_host" ||
            err.code === "private_host_after_dns") &&
          !bypassDisabled
            ? " — set allowPrivate: true to override"
            : "";
        throw new Error(
          `http.post: refusing to reach private/loopback host: ${err.message}${hint}`,
        );
      }
      const detail = (err as Error).message ?? String(err);
      // Past the sent boundary the target may hold the write. Preserve the
      // failure (it is still a failure) and preserve the uncertainty; do
      // NOT let it read as "nothing happened", which is what every retry
      // loop would otherwise conclude from a generic transport error.
      if (tracked.sent()) {
        throw new UncertainOutcomeError(
          `http.post: request was sent to ${destination} but no usable response arrived — the write may have been applied; not retried: ${detail}`,
          { cause: err },
        );
      }
      throw new Error(`http.post: request failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    // Headers arrived, so the target certainly received the request: a body
    // that dies mid-read (`terminated`) is the same uncertain outcome as a
    // response that never arrived, and used to escape as a bare transport
    // error from this very line.
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const detail = (err as Error).message ?? String(err);
      throw new UncertainOutcomeError(
        `http.post: request was sent to ${destination} and answered ${res.status}, but the response body could not be read — the write may have been applied; not retried: ${detail}`,
        { cause: err },
      );
    }
    return JSON.stringify({
      status: res.status,
      ok: res.ok,
      body: text.length > 8192 ? `${text.slice(0, 8192)}…[truncated]` : text,
    });
  },
});

// Exported for direct testing of the SSRF guard.
export { isPrivateHost };
