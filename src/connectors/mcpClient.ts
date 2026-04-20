/**
 * Minimal Streamable-HTTP MCP client for calling upstream MCP servers
 * (GitHub, Linear, Sentry) from Patchwork connectors.
 *
 * Supports:
 *   - initialize handshake
 *   - tools/list
 *   - tools/call (with argument object)
 *   - SSE response parsing (when server returns text/event-stream)
 *   - Bearer token auth (OAuth access token)
 *   - 15s default timeout
 *   - Best-effort 60s in-memory result cache (opt-in per call)
 *
 * Wire format reference: MCP spec 2024-11-05 / 2025-03-26, Streamable HTTP transport.
 */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** If set, cache the result under this key for `cacheTtlMs` ms. */
  cacheKey?: string;
  cacheTtlMs?: number;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: JsonValue;
}

interface CacheEntry {
  value: McpToolResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const DEFAULT_TIMEOUT = 15_000;

function getCached(key: string): McpToolResult | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

function setCached(key: string, value: McpToolResult, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function clearMcpCache(): void {
  cache.clear();
}

/**
 * Parse a Streamable-HTTP response body. The server may reply with:
 *   - application/json  → single JSON-RPC response
 *   - text/event-stream → SSE frames, last `data:` line is the response
 */
async function parseMcpResponse(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    // Find last `data:` line carrying a JSON payload
    const lines = text.split(/\r?\n/);
    let last: string | null = null;
    for (const l of lines) {
      if (l.startsWith("data:")) {
        const payload = l.slice(5).trim();
        if (payload && payload !== "[DONE]") last = payload;
      }
    }
    if (!last) throw new Error("MCP SSE response had no data frame");
    return JSON.parse(last);
  }
  if (!text) return null;
  return JSON.parse(text);
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const t = setTimeout(() => ctl.abort(new Error("MCP request timeout")), ms);
  ctl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return ctl.signal;
}

export class McpClient {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  private async post(
    body: unknown,
    opts: McpCallOptions = {},
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const signal = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    // Pick up session id if server issued one
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 300);
      throw new Error(`MCP HTTP ${res.status} at ${this.endpoint}: ${snippet}`);
    }
    return parseMcpResponse(res);
  }

  private async ensureInitialized(opts: McpCallOptions = {}): Promise<void> {
    if (this.initialized) return;
    const id = this.nextId++;
    const resp = (await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "patchwork-os", version: "0.1" },
        },
      },
      opts,
    )) as { error?: { message: string }; result?: unknown };
    if (resp?.error)
      throw new Error(`MCP initialize failed: ${resp.error.message}`);
    // Notify initialized (fire-and-forget, no id)
    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      opts,
    ).catch(() => {});
    this.initialized = true;
  }

  async listTools(
    opts: McpCallOptions = {},
  ): Promise<
    Array<{ name: string; description?: string; inputSchema?: JsonValue }>
  > {
    await this.ensureInitialized(opts);
    const id = this.nextId++;
    const resp = (await this.post(
      { jsonrpc: "2.0", id, method: "tools/list" },
      opts,
    )) as {
      error?: { message: string };
      result?: {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: JsonValue;
        }>;
      };
    };
    if (resp?.error) throw new Error(`tools/list: ${resp.error.message}`);
    return resp.result?.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: McpCallOptions = {},
  ): Promise<McpToolResult> {
    if (opts.cacheKey) {
      const hit = getCached(opts.cacheKey);
      if (hit) return hit;
    }
    await this.ensureInitialized(opts);
    const id = this.nextId++;
    const resp = (await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      opts,
    )) as { error?: { message: string }; result?: McpToolResult };
    if (resp?.error)
      throw new Error(`tools/call ${name}: ${resp.error.message}`);
    const result = resp.result ?? { content: [] };
    if (result.isError) {
      const msg = result.content
        .map((c) => c.text)
        .filter(Boolean)
        .join(" ")
        .slice(0, 300);
      throw new Error(`MCP tool ${name} returned error: ${msg || "unknown"}`);
    }
    if (opts.cacheKey && opts.cacheTtlMs) {
      setCached(opts.cacheKey, result, opts.cacheTtlMs);
    }
    return result;
  }

  /** Convenience: extract the first `structuredContent` object, or parse the first text block as JSON. */
  static extractJson<T = unknown>(result: McpToolResult): T {
    if (result.structuredContent !== undefined) {
      return result.structuredContent as T;
    }
    const text = result.content.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("MCP result had no text content");
    return JSON.parse(text) as T;
  }

  /** Ping by listing tools; returns true if reachable + authorized. */
  async ping(opts: McpCallOptions = {}): Promise<boolean> {
    try {
      await this.listTools(opts);
      return true;
    } catch {
      return false;
    }
  }
}
