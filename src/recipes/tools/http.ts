/**
 * HTTP tools — http.post
 *
 * Built-in step type for POSTing JSON / text bodies to a URL without
 * spawning an agent. Designed for fire-and-forget notifications
 * (ntfy.sh, generic webhooks). Includes a lexical SSRF guard that
 * blocks private/loopback hosts unless the recipe explicitly opts in.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

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

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  if (h.startsWith("::ffff:")) return isPrivateHost(h.slice(7));
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  if (/^fc[0-9a-f]{2}:/.test(h) || /^fd[0-9a-f]{2}:/.test(h)) return true;
  if (/^fe80:/.test(h)) return true;
  return false;
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

    const allowPrivate = params.allowPrivate === true;
    if (!allowPrivate && isPrivateHost(parsed.hostname)) {
      throw new Error(
        `http.post: refusing to reach private/loopback host "${parsed.hostname}" — set allowPrivate: true to override`,
      );
    }

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

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Use undici.fetch directly (not global fetch) so we can pass the custom
    // dispatcher with Happy-Eyeballs tuning. Global fetch's type doesn't
    // expose `dispatcher`, but they're the same implementation underneath.
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, {
        method,
        body,
        headers,
        signal: ctrl.signal,
        dispatcher: httpAgent,
      });
    } catch (err) {
      throw new Error(
        `http.post: request failed: ${(err as Error).message ?? String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    return JSON.stringify({
      status: res.status,
      ok: res.ok,
      body: text.length > 8192 ? `${text.slice(0, 8192)}…[truncated]` : text,
    });
  },
});

// Exported for direct testing of the SSRF guard.
export { isPrivateHost };
