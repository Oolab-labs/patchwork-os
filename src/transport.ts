import { Ajv, type ValidateFunction } from "ajv";
import { WebSocket } from "ws";
import type { ActivityLog } from "./activityLog.js";
import { ErrorCodes } from "./errors.js";
import type { Logger } from "./logger.js";
import { withSpan } from "./telemetry.js";
import { BRIDGE_PROTOCOL_VERSION, PACKAGE_VERSION } from "./version.js";
import { safeSend } from "./wsUtils.js";

const TOOL_TIMEOUT_MS = 60_000; // 60s — prevents tools from blocking indefinitely
const MAX_CONCURRENT_TOOLS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX = 200; // max requests per window
const NOTIFICATION_RATE_LIMIT = 500; // max notifications per minute (separate from request limit)
const TOOLS_LIST_PAGE_SIZE = 200; // Most MCP clients (Claude Desktop) only fetch page 1 — keep all tools visible
// When a tool result's total text content exceeds this threshold, inject
// _meta["anthropic/maxResultSizeChars"] into the result so Claude Code 2.1.91+
// persists the full result instead of truncating at its own internal limit.
const META_SIZE_HINT_THRESHOLD = 50_000; // 50 KB
// Supported MCP protocol versions, newest first.
// Extend this array when new protocol versions are ratified; keep oldest supported version last.
const SUPPORTED_VERSIONS = ["2025-11-25"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** JSON Schema describing the structured output (MCP 2025-06-18). When present, the tool also returns `structuredContent`. */
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** If true, this tool requires the VS Code extension. When disconnected, calling it returns an error. */
  extensionRequired?: boolean;
  /** Override the global 60s tool timeout for this specific tool (milliseconds). */
  timeoutMs?: number;
  /** Prompt caching hint passed through to wire schema. */
  cache_control?: { type: "ephemeral" };
}

export type ProgressFn = (
  progress: number,
  total?: number,
  message?: string,
) => void;

export type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
  progress?: ProgressFn,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  /** Typed structured output (MCP 2025-06-18). Present when the tool declares `outputSchema`. */
  structuredContent?: unknown;
}>;

export class McpTransport {
  private tools = new Map<
    string,
    { schema: ToolSchema; handler: ToolHandler; timeoutMs?: number }
  >();
  /** Optional fallback for tool names not found in the static registry. Used by the orchestrator. */
  private dynamicToolDispatch: ToolHandler | null = null;
  /** Optional instructions string injected into the MCP initialize response. */
  private instructions: string | null = null;

  setDynamicToolDispatch(fn: ToolHandler): void {
    this.dynamicToolDispatch = fn;
  }

  setInstructions(text: string): void {
    this.instructions = text;
  }
  private readonly serverInfo = {
    name: "claude-ide-bridge",
    version: BRIDGE_PROTOCOL_VERSION,
    _meta: { packageVersion: PACKAGE_VERSION },
  };
  private activeWs: WebSocket | null = null;
  public workspace = "";
  private activeListener: ((data: Buffer) => void) | null = null;
  private inFlightControllers = new Map<string | number, AbortController>();
  private inFlightToolNames = new Map<string | number, string>();
  /** Pending elicitation/create requests waiting for a client response. */
  private pendingElicitations = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      requestedSchema: Record<string, unknown>;
    }
  >();
  private initialized = false;
  /** Called once after the MCP handshake completes (notifications/initialized received). */
  onInitialized?: () => void;
  private activeToolCalls = 0;
  private callCount = 0;
  private errorCount = 0;
  private generation = 0; // incremented on each attach; stale handlers check this
  private readonly sessionStartedAt = Date.now();
  private readonly resultSizeTracker = new Map<string, number>();
  // Ring buffer for O(1) sliding-window rate limiting — avoids array scan + splice
  private rateLimitBuf = new Float64Array(RATE_LIMIT_MAX); // initialised to 0 (epoch 1970, always outside window)
  private rateLimitHead = 0; // index of oldest entry / next write position
  // Separate lightweight rate limit for notifications (no response sent, so can't use main ring buffer)
  private notifCount = 0;
  private notifWindowStart = 0;

  public sessionId: string | null = null;
  /** X-Claude-Code-Session-Id from the HTTP initialize request, for proxy-level correlation. */
  public claudeCodeSessionId: string | null = null;
  /** OAuth scope for this session. null = full access (static bridge token). "mcp:read" = read-only. */
  private sessionScope: string | null = null;
  /** Per-session tool deny list. Tools in this set return isError:true at dispatch. */
  private denyTools: Set<string> = new Set();
  /** Called on each progress notification — HTTP sessions use this to refresh lastActivity. */
  public onActivity: (() => void) | undefined = undefined;
  private activityLog: ActivityLog | null = null;
  private isExtensionConnectedFn: (() => boolean) | null = null;
  private readonly ajv = new Ajv({ strict: false, allErrors: true });
  private readonly schemaValidators = new Map<string, ValidateFunction>();
  private readonly outputValidators = new Map<string, ValidateFunction>();
  /** Cached wire-schema array for tools/list. Invalidated on any tool registration change. */
  private wireSchemaCache: unknown[] | null = null;
  /** Per-session tool-call rate limit (calls/minute). 0 = disabled. */
  private toolRateLimit = 60;
  /**
   * Token bucket for tool-call rate limiting. Stored as a mutable object so it
   * can be shared across multiple transport instances (e.g. HTTP session cycling
   * bypass prevention — see StreamableHttpHandler.sharedHttpRateLimitBucket).
   */
  private toolBucket: { tokens: number; lastRefill: number } = {
    tokens: 60,
    lastRefill: Date.now(),
  };

  constructor(private logger: Logger) {}

  /**
   * Set the OAuth scope for this session.
   * - null / "mcp"  → full access (all tools allowed)
   * - "mcp:read"    → read-only access (only readOnlyHint:true tools allowed)
   */
  setSessionScope(scope: string | null): void {
    this.sessionScope = scope;
  }

  /**
   * Set a per-session tool deny list. Tools whose name is in this set will
   * return isError:true at dispatch time (they still appear in tools/list).
   * Called at HTTP session initialize time from X-Bridge-Deny-Tools header.
   */
  setDenyTools(tools: Set<string>): void {
    this.denyTools = tools;
  }

  /** Configure per-session tool call rate limiting (calls/minute, 0 = disabled). */
  setToolRateLimit(limit: number): void {
    this.toolRateLimit = limit;
    this.toolBucket.tokens = limit;
    this.toolBucket.lastRefill = Date.now();
  }

  /**
   * Replace the token bucket with a shared object.
   * All transports using the same bucket share one rate-limit pool — prevents
   * bypassing the limit by cycling HTTP sessions (each new session would otherwise
   * start with a full bucket).
   */
  setSharedToolRateLimitBucket(bucket: {
    tokens: number;
    lastRefill: number;
  }): void {
    this.toolBucket = bucket;
  }

  /** Refill the token bucket and return whether at least one token is available (does NOT consume). */
  private peekToolRateLimit(): boolean {
    if (this.toolRateLimit <= 0) return true;
    const now = Date.now();
    const elapsed = now - this.toolBucket.lastRefill;
    const refill = (elapsed / 60_000) * this.toolRateLimit;
    this.toolBucket.tokens = Math.min(
      this.toolRateLimit,
      this.toolBucket.tokens + refill,
    );
    this.toolBucket.lastRefill = now;
    return this.toolBucket.tokens >= 1;
  }

  /** Consume one token. Call only after peekToolRateLimit() returned true. */
  private consumeToolRateLimitToken(): void {
    if (this.toolRateLimit <= 0) return;
    this.toolBucket.tokens -= 1;
  }

  private getValidator(toolName: string): ValidateFunction | null {
    if (this.schemaValidators.has(toolName)) {
      // biome-ignore lint/style/noNonNullAssertion: has() guard above proves this is defined
      return this.schemaValidators.get(toolName)!;
    }
    const tool = this.tools.get(toolName);
    if (!tool) return null;
    const schema = tool.schema.inputSchema;
    if (typeof schema !== "object" || schema === null) return null;
    const fn = this.ajv.compile(schema as object);
    this.schemaValidators.set(toolName, fn);
    return fn;
  }

  /** Returns true once the MCP handshake is complete (notifications/initialized received). */
  get isReady(): boolean {
    return this.initialized;
  }

  /**
   * Mark the transport as initialized without requiring the MCP handshake.
   * Use this when the caller has already authenticated the client at a higher
   * level (e.g. the orchestrator validates auth at WebSocket upgrade time).
   */
  markInitialized(): void {
    this.initialized = true;
  }

  /** Number of tools currently registered (useful for /ready endpoint). */
  get toolCount(): number {
    return this.tools.size;
  }

  /**
   * Return a static snapshot of all registered tool schemas.
   * Used by scripts/audit-schema-changes.mjs to diff against a committed baseline.
   */
  getSchemaSnapshot(): Array<{
    name: string;
    inputSchema: unknown;
    outputSchema?: unknown;
  }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.schema.name,
      inputSchema: t.schema.inputSchema,
      ...(t.schema.outputSchema !== undefined && {
        outputSchema: t.schema.outputSchema,
      }),
    }));
  }

  setExtensionConnectedFn(fn: () => boolean): void {
    this.isExtensionConnectedFn = fn;
  }

  setActivityLog(log: ActivityLog): void {
    this.activityLog = log;
  }

  /**
   * Send an `elicitation/create` request to the MCP client (Claude Code 2.1.76+) and
   * wait for the user's response. Resolves with the client's result object, or rejects
   * if the client declines, disconnects, or does not support elicitation.
   *
   * @param message Human-readable question shown to the user.
   * @param requestedSchema JSON Schema describing the shape of the expected response.
   * @param timeoutMs Maximum time to wait for a response (default: 5 minutes).
   */
  async elicit(
    message: string,
    requestedSchema: Record<string, unknown>,
    timeoutMs = 300_000,
  ): Promise<unknown> {
    if (!this.activeWs || this.activeWs.readyState !== WebSocket.OPEN) {
      throw new Error("No active MCP client connected");
    }
    if (!this.initialized) {
      throw new Error("MCP client not yet initialized");
    }
    const ws = this.activeWs;

    const id = `elicit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: { message, requestedSchema },
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingElicitations.delete(id)) {
          reject(new Error(`Elicitation timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingElicitations.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        requestedSchema,
      });

      safeSend(ws, JSON.stringify(request), this.logger).then((sent) => {
        // Guard: only reject if the entry hasn't already been resolved (e.g. fast loopback
        // where a response arrives before safeSend's .then() fires under backpressure).
        if (!sent && this.pendingElicitations.has(id)) {
          this.pendingElicitations.delete(id);
          clearTimeout(timer);
          reject(
            new Error("Failed to send elicitation/create — socket closed"),
          );
        }
      });
    });
  }

  registerTool(
    schema: ToolSchema,
    handler: ToolHandler,
    timeoutMs?: number,
  ): void {
    if (!/^[a-zA-Z0-9_]+$/.test(schema.name)) {
      throw new Error(
        `Invalid tool name "${schema.name}": must contain only letters, digits, and underscores`,
      );
    }
    if (this.tools.has(schema.name)) {
      throw new Error(
        `Duplicate tool name "${schema.name}": a tool with this name is already registered`,
      );
    }
    this.tools.set(schema.name, {
      schema,
      handler,
      timeoutMs: timeoutMs ?? schema.timeoutMs,
    });
  }

  /** Upsert a tool by name — replaces if already registered, inserts if new. */
  replaceTool(
    schema: ToolSchema,
    handler: ToolHandler,
    timeoutMs?: number,
  ): void {
    if (!/^[a-zA-Z0-9_]+$/.test(schema.name)) {
      throw new Error(
        `Invalid tool name "${schema.name}": must contain only letters, digits, and underscores`,
      );
    }
    // Clear cached AJV validators and wire schema so the new schema takes effect
    this.schemaValidators.delete(schema.name);
    this.outputValidators.delete(schema.name);
    this.wireSchemaCache = null;
    this.tools.set(schema.name, {
      schema,
      handler,
      timeoutMs: timeoutMs ?? schema.timeoutMs,
    });
  }

  /** Remove all tools whose name starts with `prefix`. Returns count removed. */
  deregisterTool(name: string): boolean {
    this.schemaValidators.delete(name);
    this.outputValidators.delete(name);
    this.wireSchemaCache = null;
    return this.tools.delete(name);
  }

  deregisterToolsByPrefix(prefix: string): number {
    if (!prefix) return 0;
    let count = 0;
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        this.schemaValidators.delete(name);
        this.outputValidators.delete(name);
        count++;
      }
    }
    if (count > 0) this.wireSchemaCache = null;
    return count;
  }

  detach(): void {
    // Remove listener from old WebSocket to prevent accumulation
    if (this.activeWs && this.activeListener) {
      this.activeWs.removeListener("message", this.activeListener);
      this.activeListener = null;
    }
    // Abort all in-flight tool calls to prevent resource leaks
    for (const [, controller] of this.inFlightControllers) {
      controller.abort();
    }
    this.inFlightControllers.clear();
    this.inFlightToolNames.clear();
    // Reject all pending elicitation requests so callers don't hang after disconnect
    for (const [, pending] of this.pendingElicitations) {
      pending.reject(
        new Error("Client disconnected before responding to elicitation"),
      );
    }
    this.pendingElicitations.clear();
    this.activeWs = null;
    this.initialized = false;
    this.activeToolCalls = 0;
    // Do NOT reset rateLimitBuf/rateLimitHead here — resetting on reconnect would allow
    // a client to bypass the rate limit by rapidly cycling connections (200 req / 50ms reconnect).
    // The sliding window continues across reconnects from the same session.
    // notifCount IS reset because it is a per-connection counter (counts outbound notifications
    // since the current client connected), not a cross-session security gate.
    this.notifCount = 0;
    this.notifWindowStart = 0;
  }

  getStats(): {
    callCount: number;
    errorCount: number;
    activeToolCalls: number;
    inFlightTools: string[];
    startedAt: number;
  } {
    return {
      callCount: this.callCount,
      errorCount: this.errorCount,
      activeToolCalls: this.activeToolCalls,
      inFlightTools: [...this.inFlightToolNames.values()],
      startedAt: this.sessionStartedAt,
    };
  }

  /** Returns the byte length of the wire-schema cache, or null if not yet built. */
  getWireSchemaCacheSize(): number | null {
    if (this.wireSchemaCache === null) return null;
    return JSON.stringify(this.wireSchemaCache).length;
  }

  /** Top-N tools by largest result seen this session (descending by sizeChars). */
  getTopResultSizes(n = 10): Array<{ tool: string; sizeChars: number }> {
    return [...this.resultSizeTracker.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([tool, sizeChars]) => ({ tool, sizeChars }));
  }

  attach(ws: WebSocket): void {
    this.activeWs = ws;
    this.initialized = false; // Force re-initialization on every new connection
    const gen = ++this.generation;
    const listener = async (data: Buffer) => {
      // Ignore messages from superseded connections
      if (gen !== this.generation) return;
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString("utf-8"));
      } catch {
        // Malformed JSON — send PARSE_ERROR per JSON-RPC 2.0 spec §5.1
        await safeSend(
          ws,
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: ErrorCodes.PARSE_ERROR,
              message: "Parse error: message is not valid JSON",
            },
          }),
          this.logger,
        );
        return;
      }
      try {
        if (typeof raw !== "object" || raw === null) {
          this.logger.debug("Ignoring non-object JSON-RPC message");
          return;
        }
        if (Array.isArray(raw)) {
          await safeSend(
            ws,
            JSON.stringify([
              {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Batch requests are not supported",
                },
              },
            ]),
            this.logger,
          );
          return;
        }
        const msg = raw as JsonRpcRequest;
        // Sanitize method name before logging to prevent log injection.
        // A malicious client could embed newlines or ANSI codes in the method field.
        const safeMethod = (s: unknown): string =>
          typeof s === "string"
            ? s.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128)
            : String(s);

        // Detect client-to-server responses (elicitation/create results, etc.)
        // JSON-RPC responses have no "method" but have an "id" and "result" or "error".
        if (
          !msg.method &&
          msg.id !== undefined &&
          msg.id !== null &&
          ("result" in msg || "error" in msg)
        ) {
          const pending = this.pendingElicitations.get(msg.id);
          if (pending) {
            this.pendingElicitations.delete(msg.id);
            const resp = raw as JsonRpcResponse;
            if (resp.error) {
              pending.reject(
                new Error(resp.error.message ?? "Elicitation declined"),
              );
            } else {
              // Validate that the result conforms to the schema type before resolving.
              // Full AJV validation is deferred to callers; here we guard against
              // obviously malformed payloads regardless of whether the schema has a
              // top-level `type` field — null is never a valid elicitation result.
              const result = resp.result;
              const schemaType = pending.requestedSchema.type;
              const jsType =
                result === null
                  ? "null"
                  : Array.isArray(result)
                    ? "array"
                    : typeof result;
              let typeError: string | null = null;
              if (result === null || result === undefined) {
                typeError = "Elicitation result must not be null/undefined";
              } else if (
                schemaType === "object" &&
                (typeof result !== "object" || Array.isArray(result))
              ) {
                typeError = `Elicitation result type mismatch: expected object, got ${jsType}`;
              } else if (
                schemaType === "string" &&
                typeof result !== "string"
              ) {
                typeError = `Elicitation result type mismatch: expected string, got ${jsType}`;
              } else if (
                schemaType === "number" &&
                typeof result !== "number"
              ) {
                typeError = `Elicitation result type mismatch: expected number, got ${jsType}`;
              } else if (
                schemaType === "boolean" &&
                typeof result !== "boolean"
              ) {
                typeError = `Elicitation result type mismatch: expected boolean, got ${jsType}`;
              } else if (schemaType === "array" && !Array.isArray(result)) {
                typeError = `Elicitation result type mismatch: expected array, got ${jsType}`;
              }
              if (typeError) {
                pending.reject(new Error(typeError));
              } else {
                // Defense-in-depth: reject prototype-poisoning keys from object results
                if (
                  schemaType === "object" &&
                  result !== null &&
                  typeof result === "object"
                ) {
                  const dangerous = ["__proto__", "constructor", "prototype"];
                  if (dangerous.some((k) => Object.hasOwn(result, k))) {
                    pending.reject(
                      new Error(
                        "Elicitation result contains disallowed keys (__proto__, constructor, prototype)",
                      ),
                    );
                    return; // don't fall through to pending.resolve
                  }
                }
                pending.resolve(result);
              }
            }
          } else {
            this.logger.debug(
              `Received unexpected response for id=${msg.id} — ignored`,
            );
          }
          return;
        }

        this.logger.debug(`<-- ${safeMethod(msg.method)} (id=${msg.id})`);

        if (!msg.method) return;

        // Notifications (no id)
        if (msg.id === undefined || msg.id === null) {
          // Lightweight rate limit for notifications — they have no response channel
          // so they bypass the main ring-buffer rate limiter.
          const nowNotif = Date.now();
          if (nowNotif - this.notifWindowStart >= RATE_LIMIT_WINDOW_MS) {
            this.notifCount = 0;
            this.notifWindowStart = nowNotif;
          }
          this.notifCount++;
          if (this.notifCount >= NOTIFICATION_RATE_LIMIT) {
            this.logger.warn(
              `Notification rate limit exceeded (${NOTIFICATION_RATE_LIMIT}/min) — dropping notification`,
            );
            return;
          }

          if (msg.method === "notifications/cancelled") {
            const requestId = (msg.params as { requestId?: string | number })
              ?.requestId;
            if (requestId !== undefined) {
              const controller = this.inFlightControllers.get(requestId);
              if (controller) controller.abort();
            }
          } else if (msg.method === "notifications/initialized") {
            this.initialized = true;
            this.logger.debug("Client initialized");
            this.onInitialized?.();
          }
          return;
        }

        // Rate limiting — O(1) ring buffer sliding window.
        // rateLimitBuf holds the last RATE_LIMIT_MAX timestamps in insertion order.
        // rateLimitHead points to the oldest entry (next write position).
        // If the oldest timestamp is still within the window, all 200 slots are
        // occupied by recent requests → limit exceeded.
        const now = Date.now();
        // biome-ignore lint/style/noNonNullAssertion: ring buffer is pre-filled with 0s, index always valid
        const oldest = this.rateLimitBuf[this.rateLimitHead]!;
        if (oldest >= now - RATE_LIMIT_WINDOW_MS) {
          this.logger.warn(
            `Rate limit exceeded: ${RATE_LIMIT_MAX} requests in ${RATE_LIMIT_WINDOW_MS}ms`,
          );
          await safeSend(
            ws,
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: ErrorCodes.RATE_LIMIT_EXCEEDED,
                message: `Rate limit exceeded — max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s window`,
              },
            }),
            this.logger,
          );
          return;
        }
        // Record this timestamp and advance the head pointer
        this.rateLimitBuf[this.rateLimitHead] = now;
        this.rateLimitHead = (this.rateLimitHead + 1) % RATE_LIMIT_MAX;

        let response: JsonRpcResponse = {
          jsonrpc: "2.0",
          // biome-ignore lint/style/noNonNullAssertion: only reachable for requests (not notifications), which always have an id
          id: msg.id!,
          error: { code: -32603, message: "Internal error" },
        };

        switch (msg.method) {
          case "initialize": {
            const clientParams = msg.params as
              | { protocolVersion?: string }
              | undefined;
            const clientVersion = clientParams?.protocolVersion;
            const negotiatedVersion =
              clientVersion && SUPPORTED_VERSIONS.includes(clientVersion)
                ? clientVersion
                : // biome-ignore lint/style/noNonNullAssertion: SUPPORTED_VERSIONS is a non-empty constant array
                  SUPPORTED_VERSIONS[0]!;
            if (clientVersion && !SUPPORTED_VERSIONS.includes(clientVersion)) {
              this.logger.warn(
                `Client requested unsupported protocol version ${clientVersion}, responding with ${negotiatedVersion}`,
              );
            }
            this.initialized = false; // Reset — waiting for notifications/initialized
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: negotiatedVersion,
                capabilities: {
                  tools: { listChanged: true },
                  resources: { listChanged: false },
                  prompts: { listChanged: false },
                  logging: {},
                  // Advertise elicitation support (MCP 2025-11-25 / Claude Code 2.1.76+).
                  // Enables the bridge to send elicitation/create requests to the client
                  // so tools can ask the user for input mid-task.
                  elicitation: {},
                },
                serverInfo: this.serverInfo,
                ...(this.instructions !== null && {
                  instructions: this.instructions,
                }),
              },
            };
            break;
          }

          case "tools/list": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            if (!this.wireSchemaCache) {
              this.wireSchemaCache = Array.from(this.tools.values()).map(
                (t) => {
                  // Strip internal-only fields before sending on the wire.
                  // cache_control is intentionally NOT stripped — it passes through to clients.
                  const {
                    extensionRequired: _ext,
                    timeoutMs: _timeout,
                    ...wireSchema
                  } = t.schema;
                  return wireSchema;
                },
              );
            }
            const allTools = this.wireSchemaCache;

            // Parse cursor (opaque base64-encoded decimal offset)
            const listParams = msg.params as { cursor?: unknown } | undefined;
            let offset = 0;
            if (typeof listParams?.cursor === "string") {
              try {
                const decoded = Number.parseInt(
                  Buffer.from(listParams.cursor, "base64").toString("utf-8"),
                  10,
                );
                if (
                  Number.isFinite(decoded) &&
                  decoded >= 0 &&
                  decoded < 1_000_000 // sanity cap: no realistic registry exceeds 1M tools
                )
                  offset = decoded;
              } catch {
                // malformed cursor — start from beginning
              }
            }

            const page = allTools.slice(offset, offset + TOOLS_LIST_PAGE_SIZE);
            const nextOffset = offset + TOOLS_LIST_PAGE_SIZE;
            const hasMore = nextOffset < allTools.length;
            const nextCursor = hasMore
              ? Buffer.from(String(nextOffset)).toString("base64")
              : undefined;

            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: page,
                ...(nextCursor !== undefined && { nextCursor }),
              },
            };
            break;
          }

          case "tools/call": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            // Reject duplicate request IDs — second call would overwrite the first's AbortController
            if (msg.id !== undefined && this.inFlightControllers.has(msg.id)) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32600, message: "Duplicate request ID" },
              };
              break;
            }
            // Per-session token-bucket rate limit — consume token before dispatch
            // (applies to both known tools and dynamic dispatch)
            if (!this.peekToolRateLimit()) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32029, message: "Tool rate limit exceeded" },
              };
              break;
            }
            // Concurrent tool-call limit
            if (this.activeToolCalls >= MAX_CONCURRENT_TOOLS) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Too many concurrent tool calls (max ${MAX_CONCURRENT_TOOLS}). Retry after current calls complete.`,
                    },
                  ],
                  isError: true,
                },
              };
              break;
            }

            const params = msg.params as {
              name: string;
              arguments?: unknown;
              _meta?: { progressToken?: string | number };
            };
            const tool = this.tools.get(params.name);
            if (!tool && this.dynamicToolDispatch) {
              // Read-only scope check — unknown tools are not in the registry so
              // we cannot inspect their annotations; block them under mcp:read.
              if (this.sessionScope === "mcp:read") {
                this.callCount++;
                this.errorCount++;
                response = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: `Tool "${params.name}" is not available with read-only scope.`,
                      },
                    ],
                    isError: true,
                  },
                };
                break;
              }
              // Consume rate-limit token before dynamic dispatch
              this.consumeToolRateLimitToken();
              // Delegate to orchestrator proxy handler for unknown tool names
              const dynDispatch = this.dynamicToolDispatch;
              const dynId = msg.id;
              const dynGen = this.generation;
              const dynArgs = (
                typeof params.arguments === "object" &&
                params.arguments !== null
                  ? params.arguments
                  : {}
              ) as Record<string, unknown>;
              this.activeToolCalls++;
              setImmediate(async () => {
                try {
                  const result = await dynDispatch(dynArgs);
                  if (dynGen !== this.generation || !this.activeWs) return;
                  const dynResponse: JsonRpcResponse = {
                    jsonrpc: "2.0",
                    id: dynId ?? 0,
                    result,
                  };
                  safeSend(
                    this.activeWs,
                    JSON.stringify(dynResponse),
                    this.logger,
                  );
                } catch (err) {
                  if (dynGen !== this.generation || !this.activeWs) return;
                  const dynErrResponse: JsonRpcResponse = {
                    jsonrpc: "2.0",
                    id: dynId ?? 0,
                    error: {
                      code: -32603,
                      message: err instanceof Error ? err.message : String(err),
                    },
                  };
                  safeSend(
                    this.activeWs,
                    JSON.stringify(dynErrResponse),
                    this.logger,
                  );
                } finally {
                  this.activeToolCalls--;
                }
              });
              break;
            }
            if (!tool) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.TOOL_NOT_FOUND,
                  message: "Tool not found",
                  data: params.name,
                },
              };
            } else if (
              this.sessionScope === "mcp:read" &&
              !(
                tool.schema.annotations?.readOnlyHint === true &&
                !tool.schema.annotations?.destructiveHint &&
                !tool.schema.annotations?.openWorldHint
              )
            ) {
              this.callCount++;
              this.errorCount++;
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Tool "${params.name}" requires full mcp scope. This session has mcp:read (read-only) scope.`,
                    },
                  ],
                  isError: true,
                },
              };
            } else if (this.denyTools.has(params.name)) {
              this.callCount++;
              this.errorCount++;
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `Tool "${params.name}" is denied for this session.`,
                    },
                  ],
                  isError: true,
                },
              };
            } else if (
              tool.schema.extensionRequired &&
              !(this.isExtensionConnectedFn?.() ?? true)
            ) {
              this.callCount++;
              this.errorCount++;
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: 'The VS Code extension is not connected. This tool requires the extension to be running.\n\nTo reconnect: open the Command Palette in VS Code and run "Claude IDE Bridge: Reconnect".\nIf the extension is not installed, install it from the marketplace: oolab-labs.claude-ide-bridge-extension',
                    },
                  ],
                  isError: true,
                },
              };
            } else {
              const startTime = Date.now();
              const callId = Math.random().toString(36).slice(2, 10);
              const callLog = this.logger.child({ tool: params.name, callId });
              let timedOut = false;
              let handlerPromise: Promise<unknown> | null = null;
              try {
                const rawArgs = params.arguments ?? {};
                if (
                  typeof rawArgs !== "object" ||
                  rawArgs === null ||
                  Array.isArray(rawArgs)
                ) {
                  this.callCount++;
                  this.errorCount++;
                  response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                      code: ErrorCodes.INVALID_PARAMS,
                      message: "Tool arguments must be a JSON object",
                    },
                  };
                  break;
                }
                // Guard against oversized argument payloads before they reach tool handlers.
                // Check rawArgs (before _meta strip) so a large _meta cannot bypass the limit.
                if (JSON.stringify(rawArgs).length > 1_048_576) {
                  this.callCount++;
                  this.errorCount++;
                  response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                      code: ErrorCodes.INVALID_PARAMS,
                      message: "Tool arguments exceed 1 MB size limit",
                    },
                  };
                  break;
                }
                // Strip _meta from arguments — it's a reserved MCP protocol field
                // that clients (e.g. Claude Code) may embed inside arguments. Tool
                // schemas use additionalProperties:false, so leaving it in causes
                // AJV to reject the call with -32602.
                const { _meta: _stripped, ...toolArgs } = rawArgs as Record<
                  string,
                  unknown
                >;
                // AJV structural validation
                const validate = this.getValidator(params.name);
                if (validate && !validate(toolArgs)) {
                  this.callCount++;
                  this.errorCount++;
                  const messages = (validate.errors ?? [])
                    .map((e) => `${e.instancePath || "."} ${e.message}`)
                    .join("; ");
                  response = {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: {
                      code: ErrorCodes.INVALID_PARAMS,
                      message: `Invalid tool arguments: ${messages}`,
                    },
                  };
                  break;
                }
                this.consumeToolRateLimitToken(); // Consume after AJV passes — not on validation failures
                this.callCount++; // Count after validation — only real execution attempts
                callLog.debug(`Calling tool: ${params.name}`);
                this.logger.event("tool_call", { tool: params.name, callId });
                const controller = new AbortController();
                this.inFlightControllers.set(msg.id, controller);
                // Build progress callback if client provided a valid progressToken.
                // Reject non-primitive tokens to prevent object injection into notifications.
                const rawToken = params._meta?.progressToken;
                const progressToken =
                  typeof rawToken === "string" || typeof rawToken === "number"
                    ? rawToken
                    : undefined;
                const progressFn: ProgressFn | undefined =
                  progressToken !== undefined
                    ? (progress: number, total?: number, message?: string) => {
                        this.onActivity?.();
                        this.sendProgress(
                          ws,
                          progressToken,
                          progress,
                          total,
                          message,
                        );
                      }
                    : undefined;
                this.activeToolCalls++;
                this.inFlightToolNames.set(msg.id, params.name);
                let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                try {
                  const effectiveTimeout = tool.timeoutMs ?? TOOL_TIMEOUT_MS;
                  const timeoutPromise = new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                      timedOut = true;
                      controller.abort();
                      reject(
                        new Error(
                          `Tool "${params.name}" timed out after ${effectiveTimeout}ms`,
                        ),
                      );
                    }, effectiveTimeout);
                  });

                  handlerPromise = withSpan(
                    "mcp.tool_call",
                    {
                      "mcp.tool.name": params.name,
                      "mcp.session.id": this.sessionId ?? "unknown",
                      ...(this.claudeCodeSessionId && {
                        "claude.session.id": this.claudeCodeSessionId,
                      }),
                    },
                    async () =>
                      tool.handler(
                        toolArgs as Record<string, unknown>,
                        controller.signal,
                        progressFn,
                      ),
                  );

                  const result = await Promise.race([
                    handlerPromise,
                    timeoutPromise,
                  ]);
                  const durationMs = Date.now() - startTime;
                  this.activityLog?.record(params.name, durationMs, "success");
                  callLog.debug(`Tool completed in ${durationMs}ms`);
                  // Validate structuredContent against outputSchema before sending.
                  // Strips structuredContent rather than forwarding non-conforming data
                  // to MCP clients (prevents plugin tools leaking out-of-schema fields).
                  const toolResult = result as {
                    content: Array<{ type: string; text: string }>;
                    structuredContent?: unknown;
                    isError?: boolean;
                  };
                  // Inject _meta["anthropic/maxResultSizeChars"] for large results so
                  // Claude Code 2.1.91+ persists the full content rather than truncating
                  // it at its own internal limit (MCP tool result persistence override).
                  const totalContentChars = Array.isArray(toolResult.content)
                    ? toolResult.content.reduce(
                        (sum, item) =>
                          sum +
                          (typeof item.text === "string"
                            ? item.text.length
                            : 0),
                        0,
                      )
                    : 0;
                  // Track largest result seen per tool for getSessionUsage reporting.
                  this.resultSizeTracker.set(
                    params.name,
                    Math.max(
                      this.resultSizeTracker.get(params.name) ?? 0,
                      totalContentChars,
                    ),
                  );
                  const resultWithMeta =
                    totalContentChars > META_SIZE_HINT_THRESHOLD
                      ? {
                          ...toolResult,
                          _meta: {
                            "anthropic/maxResultSizeChars": totalContentChars,
                          },
                        }
                      : toolResult;
                  if (
                    tool.schema.outputSchema !== undefined &&
                    toolResult.structuredContent !== undefined
                  ) {
                    let outValidator = this.outputValidators.get(params.name);
                    if (!outValidator) {
                      outValidator = this.ajv.compile(
                        tool.schema.outputSchema as object,
                      );
                      this.outputValidators.set(params.name, outValidator);
                    }
                    if (!outValidator(toolResult.structuredContent)) {
                      callLog.warn(
                        `structuredContent failed outputSchema validation for tool "${params.name}" — stripping`,
                      );
                      const { structuredContent: _dropped, ...safeResult } =
                        resultWithMeta as Record<string, unknown>;
                      response = {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: safeResult,
                      };
                    } else {
                      response = {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: resultWithMeta,
                      };
                    }
                  } else {
                    response = {
                      jsonrpc: "2.0",
                      id: msg.id,
                      result: resultWithMeta,
                    };
                  }
                } finally {
                  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
                  // Only touch shared state if we're still on the same generation.
                  // detach() clears inFlightControllers and resets activeToolCalls for
                  // new connections; an orphaned finally from a previous generation must
                  // not delete the new session's controller or skew its counter.
                  if (gen === this.generation) {
                    this.inFlightControllers.delete(msg.id);
                    this.inFlightToolNames.delete(msg.id);
                    this.activeToolCalls = Math.max(
                      0,
                      this.activeToolCalls - 1,
                    );
                  }
                }
              } catch (err: unknown) {
                // MCP spec: tool execution errors are returned as successful
                // JSON-RPC responses with isError: true in the content, NOT as
                // JSON-RPC error responses. This lets the LLM understand and
                // potentially recover from tool failures.
                const message =
                  err instanceof Error ? err.message : String(err);
                const errCode =
                  err instanceof Error &&
                  typeof (err as Error & { code?: unknown }).code === "string"
                    ? (err as Error & { code: string }).code
                    : undefined;
                callLog.error(`Tool ${params.name} failed: ${message}`);
                this.errorCount++;
                this.activityLog?.record(
                  params.name,
                  Date.now() - startTime,
                  "error",
                  message,
                );
                const errPayload: Record<string, string> = { error: message };
                if (errCode !== undefined) errPayload.code = errCode;
                response = {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    content: [
                      { type: "text", text: JSON.stringify(errPayload) },
                    ],
                    isError: true,
                  },
                };

                // Track zombie tool completion after timeout
                if (timedOut && handlerPromise) {
                  handlerPromise
                    .then(() => {
                      this.logger.warn(
                        `Zombie tool "${params.name}" completed ${Date.now() - startTime}ms after start (timed out at ${tool.timeoutMs ?? TOOL_TIMEOUT_MS}ms)`,
                      );
                    })
                    .catch(() => {
                      // Already logged the timeout error above; suppress the zombie's error
                    });
                }
              }
            }
            break;
          }

          case "resources/list": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            const resListParams = msg.params as
              | { cursor?: unknown }
              | undefined;
            const resCursor =
              typeof resListParams?.cursor === "string"
                ? resListParams.cursor
                : undefined;
            const { listResources } = await import("./resources.js");
            const listResult = listResources(this.workspace, resCursor);
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: listResult,
            };
            break;
          }

          case "resources/read": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            const resReadParams = msg.params as { uri?: unknown } | undefined;
            if (typeof resReadParams?.uri !== "string") {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_PARAMS,
                  message: "resources/read requires a string uri parameter",
                },
              };
              break;
            }
            const { readResource } = await import("./resources.js");
            const readResult = readResource(this.workspace, resReadParams.uri);
            if ("error" in readResult) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_PARAMS,
                  message: readResult.error,
                  data: { code: readResult.code },
                },
              };
            } else {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                result: readResult,
              };
            }
            break;
          }

          case "prompts/list": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            const { PROMPTS } = await import("./prompts.js");
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: { prompts: PROMPTS },
            };
            break;
          }

          case "prompts/get": {
            if (!this.initialized) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: "Not initialized — send initialize first",
                },
              };
              break;
            }
            const promptParams = msg.params as
              | { name?: unknown; arguments?: unknown }
              | undefined;
            if (typeof promptParams?.name !== "string") {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_PARAMS,
                  message: "prompts/get requires a string name parameter",
                },
              };
              break;
            }
            const promptArgs =
              typeof promptParams.arguments === "object" &&
              promptParams.arguments !== null &&
              !Array.isArray(promptParams.arguments)
                ? (promptParams.arguments as Record<string, string>)
                : {};
            const { getPrompt } = await import("./prompts.js");
            const promptResult = getPrompt(promptParams.name, promptArgs);
            if (!promptResult) {
              response = {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: ErrorCodes.INVALID_PARAMS,
                  message: `Unknown prompt or missing required argument: "${promptParams.name}"`,
                },
              };
              break;
            }
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: promptResult,
            };
            break;
          }

          case "ping":
            response = { jsonrpc: "2.0", id: msg.id, result: {} };
            break;

          default:
            response = {
              jsonrpc: "2.0",
              id: msg.id,
              error: {
                code: ErrorCodes.METHOD_NOT_FOUND,
                message: `Method not found: ${safeMethod(msg.method)}`,
              },
            };
        }

        this.logger.debug(`--> response for ${safeMethod(msg.method)}`);
        const sent = await safeSend(ws, JSON.stringify(response), this.logger);
        if (!sent) {
          this.logger.warn(
            `Response for ${safeMethod(msg.method)} (id=${msg.id}) dropped — socket closed`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to handle message: ${err}`);
      }
    };
    this.activeListener = listener;
    ws.on("message", listener);
  }

  /** Send progress notification for a long-running tool */
  private sendProgress(
    ws: WebSocket,
    progressToken: string | number,
    progress: number,
    total?: number,
    message?: string,
  ): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        ...(total !== undefined && { total }),
        ...(message !== undefined && { message }),
      },
    };
    if (ws.readyState !== WebSocket.OPEN) return;
    safeSend(ws, JSON.stringify(msg), this.logger).catch(() => {
      /* best-effort */
    });
  }

  /** Send a server-initiated notification */
  static sendNotification(
    ws: WebSocket,
    method: string,
    params?: unknown,
    logger?: { warn: (msg: string) => void },
  ): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    if (ws.readyState !== WebSocket.OPEN) return;
    safeSend(
      ws,
      JSON.stringify(msg),
      (logger ?? { warn: () => {}, error: () => {} }) as unknown as Logger,
    ).catch((err) => {
      logger?.warn(`Failed to send notification ${method}: ${err}`);
    });
  }
}
