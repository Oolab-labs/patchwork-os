import dns from "node:dns/promises";
import fs from "node:fs/promises";
import {
  error,
  optionalBool,
  optionalInt,
  optionalString,
  requireString,
  resolveFilePath,
  success,
  truncateOutput,
} from "./utils.js";

const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const DEFAULT_RESPONSE_BYTES = 50 * 1024; // 50 KB
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB hard cap

/**
 * Block requests to private/loopback addresses to prevent SSRF.
 * Checks hostname patterns only — DNS resolution happens separately in the
 * handler via dns.lookup() so that hostnames that resolve to private IPs are
 * also blocked.
 */
function isPrivateHost(hostname: string): boolean {
  // Strip IPv6 brackets: [::1] → ::1
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;

  // Reject non-decimal IPv4 notations that bypass the dotted-quad regex below:
  //   hex:   0x7f000001  → 127.0.0.1
  //   octal: 0177.0.0.1  → 127.0.0.1
  // Node's URL parser may normalize these on some platforms; block unconditionally.
  if (/^0x[0-9a-f]+$/i.test(host) || /^0[0-7]{7,}$/.test(host)) return true;

  // IPv4 range checks
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // 127.0.0.0/8  loopback
    if (a === 10) return true; // 10.0.0.0/8   RFC 1918 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / AWS metadata endpoint
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
    if (a === 0) return true; // 0.0.0.0/8
  }

  // IPv6 checks
  if (host === "::1") return true; // loopback
  if (host.startsWith("fe80:")) return true; // link-local
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA (RFC 4193)
  // IPv6-mapped IPv4 addresses (::ffff:x.x.x.x) bypass the IPv4 block above
  // on dual-stack systems — recurse on the embedded IPv4 part.
  if (host.startsWith("::ffff:")) return isPrivateHost(host.slice(7));

  return false;
}

export function createSendHttpRequestTool(options?: {
  allowPrivateHttp?: boolean;
}) {
  const allowPrivateHttp = options?.allowPrivateHttp ?? false;
  return {
    schema: {
      name: "sendHttpRequest",
      description:
        "Send an HTTP/HTTPS request and return the response status, headers, and body. " +
        "Response body is truncated at maxResponseBytes (default 50 KB) to protect context.",
      annotations: { openWorldHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["method", "url"],
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            description: "HTTP method",
          },
          url: {
            type: "string",
            description:
              "Full URL including protocol (must be http:// or https://)",
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional request headers as key/value pairs",
          },
          body: {
            type: "string",
            description:
              "Optional request body. For JSON, pass a serialized JSON string and set " +
              "Content-Type: application/json in headers. Ignored for GET and HEAD.",
          },
          timeoutMs: {
            type: "integer",
            description:
              "Request timeout in milliseconds. Default: 30000, max: 120000.",
          },
          maxResponseBytes: {
            type: "integer",
            description: `Maximum bytes to read from response body. Default: ${DEFAULT_RESPONSE_BYTES}, max: ${MAX_RESPONSE_BYTES}.`,
          },
          followRedirects: {
            type: "boolean",
            description:
              "Follow HTTP redirects (capped at 10 hops). Default: true.",
          },
        },
      },
    },

    timeoutMs: 30_000,

    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const method = requireString(args, "method", 16).toUpperCase();
      if (!ALLOWED_METHODS.has(method)) {
        return error(
          `Unsupported method "${method}". Allowed: ${[...ALLOWED_METHODS].join(", ")}`,
        );
      }

      const urlStr = requireString(args, "url", 4096);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        return error(`Invalid URL: "${urlStr}"`);
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return error(
          `URL must use http:// or https://, got "${parsedUrl.protocol}"`,
        );
      }
      if (!allowPrivateHttp && isPrivateHost(parsedUrl.hostname)) {
        return error(
          `Requests to private/loopback addresses are not allowed ("${parsedUrl.hostname}"). Only public hosts are permitted. Use --allow-private-http to enable.`,
        );
      }

      // DNS pre-resolution SSRF guard: resolve the hostname and re-check the
      // resulting IP against the private-range blocklist. This catches hostnames
      // like "internal.corp.example.com" that resolve to RFC-1918 addresses and
      // would bypass the purely-lexical isPrivateHost check above.
      //
      // After validation, we pin the connection to the resolved IP by rewriting
      // the request URL's hostname. This closes the TOCTOU window between
      // dns.lookup() and the actual fetch — without pinning, an attacker can
      // serve a public IP on the first DNS response and a private IP on the
      // second. We preserve the original hostname in a Host header so virtual
      // hosting and SNI still work. DNS failures fall through to fetch naturally.
      let resolvedIp: string | null = null;
      try {
        const { address } = await dns.lookup(parsedUrl.hostname);
        if (!allowPrivateHttp && isPrivateHost(address)) {
          return error(
            `Hostname "${parsedUrl.hostname}" resolves to a private address (${address}) — request blocked`,
          );
        }
        resolvedIp = address;
      } catch {
        // DNS lookup failed — let fetch report the error with its own message
      }

      // Build the initial URL: if we successfully resolved an IP, use it as the
      // hostname so Node's fetch does not re-resolve (closes the TOCTOU window).
      // IPv6 addresses require bracket wrapping in URLs.
      let initialUrl = urlStr;
      if (resolvedIp !== null) {
        const pinnedUrl = new URL(urlStr);
        pinnedUrl.hostname = resolvedIp.includes(":")
          ? `[${resolvedIp}]`
          : resolvedIp;
        initialUrl = pinnedUrl.toString();
      }

      // Validate and collect headers
      const rawHeaders = args.headers;
      const headers: Record<string, string> = {};
      if (rawHeaders != null) {
        if (typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
          return error("headers must be a plain object of string values");
        }
        for (const [k, v] of Object.entries(
          rawHeaders as Record<string, unknown>,
        )) {
          if (typeof v !== "string") {
            return error(`Header value for "${k}" must be a string`);
          }
          // Block CRLF and null bytes — header injection prevention
          if (/[\r\n\x00]/.test(k) || /[\r\n\x00]/.test(v)) {
            return error(
              `Header "${k}" contains invalid characters (CR, LF, or null byte)`,
            );
          }
          headers[k] = v;
        }
      }
      // Override Host AFTER user headers so a caller-supplied Host cannot
      // bypass IP-pinning SSRF protection. Virtual hosting / SNI still works
      // because we use the original hostname (before IP substitution).
      if (resolvedIp !== null) {
        headers.Host = parsedUrl.hostname;
      }

      const body = optionalString(args, "body", 1024 * 1024);
      const timeoutMs = Math.min(
        optionalInt(args, "timeoutMs", 1, 120_000) ?? 30_000,
        120_000,
      );
      const maxBytes = Math.min(
        optionalInt(args, "maxResponseBytes", 1, MAX_RESPONSE_BYTES) ??
          DEFAULT_RESPONSE_BYTES,
        MAX_RESPONSE_BYTES,
      );
      const followRedirects = optionalBool(args, "followRedirects") ?? true;
      const MAX_REDIRECTS = 10;

      // Compose AbortSignal: merge caller signal with our own timeout.
      // Capture the forwarder so we can remove it once the request settles —
      // without cleanup the listener would accumulate on long-lived signals.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let abortForwarder: (() => void) | undefined;
      if (signal) {
        abortForwarder = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortForwarder, { once: true });
      }
      const cleanup = () => {
        clearTimeout(timeoutId);
        if (abortForwarder !== undefined)
          signal?.removeEventListener("abort", abortForwarder);
      };

      const requestBody =
        body !== undefined && method !== "GET" && method !== "HEAD"
          ? body
          : undefined;

      const start = Date.now();
      try {
        let currentUrl = initialUrl;
        let redirectCount = 0;
        let resp: Response;

        // Manual redirect loop so we can cap hops and re-validate each location
        while (true) {
          resp = await fetch(currentUrl, {
            method,
            headers,
            body: requestBody,
            signal: controller.signal,
            redirect: "manual", // always manual — we control the loop
          });

          const isRedirect = resp.status >= 300 && resp.status < 400;
          if (!followRedirects || !isRedirect) break;

          const location = resp.headers.get("location");
          if (!location) break;

          if (redirectCount >= MAX_REDIRECTS) {
            cleanup();
            return error(`Too many redirects (>${MAX_REDIRECTS})`);
          }

          // Resolve relative redirect URL and re-validate it
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, currentUrl);
          } catch {
            cleanup();
            return error(`Invalid redirect location: "${location}"`);
          }
          if (!["http:", "https:"].includes(nextUrl.protocol)) {
            cleanup();
            return error(
              `Redirect to non-http(s) protocol blocked: "${nextUrl.protocol}"`,
            );
          }
          if (!allowPrivateHttp && isPrivateHost(nextUrl.hostname)) {
            cleanup();
            return error(
              `Redirect to private/loopback address blocked ("${nextUrl.hostname}")`,
            );
          }

          // Pin the redirect hop to its resolved IP to close the TOCTOU window.
          // DNS failures fall through — fetch will report the error naturally.
          try {
            const { address: redirectIp } = await dns.lookup(nextUrl.hostname);
            if (!allowPrivateHttp && isPrivateHost(redirectIp)) {
              cleanup();
              return error(
                `Redirect hostname "${nextUrl.hostname}" resolves to a private address (${redirectIp}) — blocked`,
              );
            }
            // Mutate nextUrl in-place to pin to the resolved IP
            nextUrl.hostname = redirectIp.includes(":")
              ? `[${redirectIp}]`
              : redirectIp;
            // Preserve original Host for virtual hosting / SNI
            headers.Host = new URL(location, currentUrl).hostname;
          } catch {
            // DNS failed — use un-pinned URL; fetch will fail naturally
          }

          currentUrl = nextUrl.toString();
          redirectCount++;
        }

        cleanup();

        // Collect response headers
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          respHeaders[k] = v;
        });

        // Check Content-Length before reading to avoid loading a known-huge body into memory
        const contentLengthHeader = resp.headers.get("content-length");
        if (contentLengthHeader !== null) {
          const declaredLength = Number(contentLengthHeader);
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            return error(
              `Response Content-Length (${declaredLength} bytes) exceeds maxResponseBytes (${maxBytes} bytes). Increase maxResponseBytes or use a different approach to fetch this resource.`,
            );
          }
        }

        // Read body with size cap enforced during streaming so a chunked response
        // with no Content-Length cannot exhaust the bridge process heap.
        const reader = resp.body?.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let streamTruncated = false;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || value === undefined) break;
              if (totalBytes + value.byteLength > maxBytes) {
                chunks.push(value.slice(0, maxBytes - totalBytes));
                totalBytes = maxBytes;
                streamTruncated = true;
                await reader.cancel();
                break;
              }
              chunks.push(value);
              totalBytes += value.byteLength;
            }
          } finally {
            reader.releaseLock();
          }
        }
        const fullBytes = totalBytes;
        const rawBody = Buffer.concat(
          chunks.map((c) => Buffer.from(c)),
        ).toString("utf-8");
        const { text: responseBody, truncated } = streamTruncated
          ? { text: rawBody, truncated: true }
          : truncateOutput(rawBody, maxBytes);

        return success({
          status: resp.status,
          statusText: resp.statusText,
          headers: respHeaders,
          body: responseBody,
          durationMs: Date.now() - start,
          ...(redirectCount > 0 ? { redirects: redirectCount } : {}),
          ...(truncated ? { truncated: true, fullBytes } : {}),
        });
      } catch (err: unknown) {
        cleanup();
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError")
        ) {
          return error(`Request timed out after ${timeoutMs}ms`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return error(`Request failed: ${msg}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// .http / .rest file parser (VS Code REST Client format)
// ---------------------------------------------------------------------------

interface ParsedRequest {
  name?: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const REQUEST_LINE_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;

function parseHttpFileContent(content: string): ParsedRequest[] {
  const requests: ParsedRequest[] = [];

  // Split on "###" separators (with optional trailing label on same line)
  const sections = content.split(/^###[^\S\r\n]*/m);

  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    let i = 0;

    // Skip leading blank lines
    while (i < lines.length && !lines[i]?.trim()) i++;
    if (i >= lines.length) continue;

    // If the first non-blank line is NOT a request line, treat it as the request name
    let name: string | undefined;
    const candidate = lines[i]?.trim();
    if (candidate && !REQUEST_LINE_RE.test(candidate)) {
      name = candidate;
      i++;
      // Skip blank lines between name and request line
      while (i < lines.length && !lines[i]?.trim()) i++;
    }

    const requestLine = (lines[i] ?? "").trim();
    const match = REQUEST_LINE_RE.exec(requestLine);
    if (!match) continue; // Section has no valid request line

    const method = (match[1] ?? "").toUpperCase();
    const url = match[2] ?? "";
    i++;

    // Parse headers: non-blank lines immediately following the request line
    // Credential headers are redacted to prevent token leakage into MCP responses
    // and the activity log.
    const CREDENTIAL_HEADERS = new Set([
      "authorization",
      "x-api-key",
      "x-auth-token",
      "cookie",
      "set-cookie",
      "proxy-authorization",
      "x-amz-security-token",
      "x-goog-api-key",
    ]);
    const headers: Record<string, string> = {};
    while (i < lines.length) {
      const line = (lines[i] ?? "").trim();
      if (!line) break; // blank line separates headers from body
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) break; // not a header line
      const headerName = line.slice(0, colonIdx).trim();
      const headerValue = line.slice(colonIdx + 1).trim();
      headers[headerName] = CREDENTIAL_HEADERS.has(headerName.toLowerCase())
        ? "[REDACTED]"
        : headerValue;
      i++;
    }

    // Skip the blank separator line
    i++;

    // Everything remaining is the body
    const bodyLines: string[] = [];
    while (i < lines.length) {
      bodyLines.push(lines[i] ?? "");
      i++;
    }
    const body = bodyLines.join("\n").trim() || undefined;

    requests.push({
      ...(name ? { name } : {}),
      method,
      url,
      headers,
      ...(body ? { body } : {}),
    });
  }

  return requests;
}

export function createParseHttpFileTool(workspace: string) {
  return {
    schema: {
      name: "parseHttpFile",
      description:
        "Parse a VS Code REST Client file (.http or .rest) and return the requests defined in it. " +
        "Each entry includes method, URL, headers, and body. " +
        "Pass any entry directly to sendHttpRequest to execute it.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        required: ["filePath"],
        properties: {
          filePath: {
            type: "string",
            description: "Path to the .http or .rest file within the workspace",
          },
        },
      },
    },

    async handler(args: Record<string, unknown>) {
      const rawPath = requireString(args, "filePath");
      const filePath = resolveFilePath(rawPath, workspace);

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        return error(`Cannot read file: ${rawPath}`);
      }

      const requests = parseHttpFileContent(content);
      return success({ requests, count: requests.length });
    },
  };
}
