/**
 * MCP Streamable HTTP transport (spec 2025-03-26).
 *
 * Mounts POST/GET/DELETE on /mcp alongside the existing WebSocket server.
 * This allows the Claude Desktop app "Custom Connectors" UI and claude.ai web
 * to connect to the bridge without the stdio shim.
 *
 * Architecture:
 *  - Each HTTP session gets its own McpTransport instance (same as WebSocket sessions).
 *  - HttpAdapter mimics the WebSocket interface so McpTransport.attach() works unchanged.
 *  - POST /mcp  — client→server JSON-RPC (notifications return 202, requests return JSON).
 *  - GET  /mcp  — optional SSE stream for server-initiated notifications.
 *  - DELETE /mcp — terminate session.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { WebSocket } from "ws";
import type { ActivityLog } from "./activityLog.js";
import { getApprovalQueue } from "./approvalQueue.js";
import type { Config } from "./config.js";
import type { ExtensionClient } from "./extensionClient.js";
import type { FileLock } from "./fileLock.js";
import type { Logger } from "./logger.js";
import type { LoadedPluginTool } from "./pluginLoader.js";
import type { PluginWatcher } from "./pluginWatcher.js";
import type { ProbeResults } from "./probe.js";
import { classifyTool } from "./riskTier.js";
import { corsOrigin } from "./server.js";
import { registerAllTools } from "./tools/index.js";
import { McpTransport } from "./transport.js";

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hour idle TTL — reduced from 24h to limit captured-session-ID reuse window
const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HTTP_SESSIONS = 5;
const BODY_SIZE_LIMIT = 1_048_576; // 1 MB
const MAX_PENDING_SENDS = 100; // per-session response queue cap
// Buffer added over a tool's own timeout when sizing the HTTP response wait, so
// the wait always outlives the tool (audit 2026-06-08 transport-1).
const HTTP_SEND_TIMEOUT_BUFFER_MS = 10_000;
// Upper bound on a tool's effective execution timeout over Streamable HTTP.
// Claude Code hard-aborts remote MCP tool calls at 5 min (CC 2.1.183/2.1.187),
// so we reject ~20s earlier with a clean TOOL_TIMEOUT isError the model can act
// on, rather than letting a 610s tool run to a silently-discarded result. The
// HTTP response wait is sized at this + HTTP_SEND_TIMEOUT_BUFFER_MS = 290s,
// still under CC's 300s abort. (audit P0-1)
const HTTP_TOOL_TIMEOUT_CEILING_MS = 280_000;
const SSE_HEARTBEAT_MS = 20_000; // keep SSE streams alive through proxies/firewalls
const SSE_BUFFER_MAX = 100; // max events retained per session for Last-Event-ID replay
const SSE_BUFFER_TTL_MS = 30_000; // events older than 30s are not replayed

/** Mimics the WebSocket interface so McpTransport works unchanged. */
class HttpAdapter extends EventEmitter {
  /** WebSocket.OPEN = 1; WebSocket.CLOSED = 3 */
  readyState: number = WebSocket.OPEN;

  constructor(
    private readonly warn: (msg: string) => void = () => {},
    /** Called when the adapter writes to the SSE stream so the session's
     *  lastActivity is refreshed even during long-idle SSE connections. */
    private readonly onSseSend: () => void = () => {},
  ) {
    super();
  }
  /** Always 0 — no send buffer for HTTP (bypasses backpressure drain). */
  readonly bufferedAmount = 0;

  /**
   * Pending POST resolvers keyed by JSON-RPC request `id`.
   * Keying by ID fixes the FIFO ordering race: if two concurrent tool calls arrive
   * on the same HTTP session, each POST waits for *its own* response rather than
   * the first response that arrives.
   *
   * Duplicate-ID guard: if a second POST arrives with the same id while the first
   * is still pending (client bug per JSON-RPC spec), waitForSend() rejects it
   * immediately with a 400 rather than silently overwriting the first waiter.
   */
  private pendingSends: Map<string | number, (data: string | null) => void> =
    new Map();
  private sseRes: http.ServerResponse | null = null;
  private sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Monotonic event ID counter and replay buffer for SSE Last-Event-ID resumption.
  private eventCounter = 0;
  private eventBuffer: Array<{ id: number; data: string; ts: number }> = [];

  /**
   * Called by safeSend() / McpTransport to deliver a message.
   * Responses (JSON-RPC messages with `id`) go to the matching pending POST resolver.
   * Notifications (no `id` — e.g. progress, list_changed) go to the SSE stream with
   * a monotonic `id:` field and are buffered for Last-Event-ID replay on reconnect.
   */
  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    const str = typeof data === "string" ? data : data.toString("utf-8");

    // Parse response `id` to route it to the correct waiting POST handler.
    let responseId: string | number | null = null;
    try {
      const parsed = JSON.parse(str);
      if (parsed.id !== undefined && parsed.id !== null) {
        responseId = parsed.id as string | number;
      }
    } catch {
      // Unparseable — treat as notification
    }

    if (responseId !== null) {
      // Response path: deliver to the waiting POST handler.
      const resolve = this.pendingSends.get(responseId);
      if (resolve) {
        this.pendingSends.delete(responseId);
        resolve(str);
        cb?.();
        return;
      }
      // Orphaned response (waiter timed out): try SSE as fallback.
      if (this.sseRes && !this.sseRes.writableEnded) {
        this.sseRes.write(`data: ${str}\n\n`);
        this.onSseSend();
        cb?.();
        return;
      }
      this.warn(
        `HTTP: dropped response id=${responseId} — no pending waiter or active SSE stream`,
      );
      cb?.();
      return;
    }

    // Notification path: assign monotonic event ID, buffer for replay, send to SSE.
    const eventId = this.eventCounter++;
    this.bufferEvent(eventId, str);
    if (this.sseRes && !this.sseRes.writableEnded) {
      this.sseRes.write(`id: ${eventId}\ndata: ${str}\n\n`);
      this.onSseSend(); // refresh lastActivity so idle pruner doesn't kill open SSE connections
    }
    // If no SSE stream: buffered above for replay when the client reconnects.
    cb?.();
  }

  /** Buffer a notification event, pruning expired entries and capping at MAX. */
  private bufferEvent(id: number, data: string): void {
    const now = Date.now();
    // Prune expired events from the front (buffer is append-only so oldest are first).
    let i = 0;
    while (
      i < this.eventBuffer.length &&
      now - (this.eventBuffer[i]?.ts ?? 0) > SSE_BUFFER_TTL_MS
    ) {
      i++;
    }
    if (i > 0) this.eventBuffer.splice(0, i);
    // Cap BEFORE pushing so the buffer never transiently exceeds SSE_BUFFER_MAX.
    if (this.eventBuffer.length >= SSE_BUFFER_MAX) {
      this.eventBuffer.shift(); // drop oldest to make room
    }
    this.eventBuffer.push({ id, data, ts: now });
  }

  /**
   * Returns buffered events with id > lastId whose timestamps are within the TTL.
   * Called by handleGet to replay missed notifications on SSE reconnect.
   */
  getEventsAfter(lastId: number): Array<{ id: number; data: string }> {
    const now = Date.now();
    const result: Array<{ id: number; data: string }> = [];
    for (const e of this.eventBuffer) {
      if (e.id > lastId && now - e.ts <= SSE_BUFFER_TTL_MS)
        result.push({ id: e.id, data: e.data });
    }
    return result;
  }

  /** Detach only if the given response is still the active SSE stream.
   *  Prevents a stale close-handler from a superseded GET tearing down the new stream. */
  detachSSEIfCurrent(res: http.ServerResponse): void {
    if (this.sseRes === res) {
      this.attachSSE(null);
    }
  }

  /** Attach (or detach, when null) a GET /mcp SSE response for server-initiated notifications. */
  attachSSE(res: http.ServerResponse | null): void {
    // LOW #15 — clear the heartbeat timer for the PREVIOUS SSE connection
    // BEFORE storing the new one. If this step were omitted, the old interval
    // would keep a reference to the old (now-superseded) `res` and continue
    // writing heartbeats to a closed socket, causing write-after-close errors
    // and preventing the socket from being GC'd.
    if (this.sseHeartbeatTimer) {
      clearInterval(this.sseHeartbeatTimer);
      this.sseHeartbeatTimer = null;
    }
    // If a previous SSE stream is being superseded by a new one, close the old
    // response so it doesn't leak a pending socket.
    if (
      res !== null &&
      this.sseRes &&
      this.sseRes !== res &&
      !this.sseRes.writableEnded
    ) {
      try {
        this.sseRes.end();
      } catch {
        /* already closed */
      }
    }
    this.sseRes = res;
    if (res) {
      const timer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(timer);
          this.sseHeartbeatTimer = null;
        } else {
          try {
            res.write(": heartbeat\n\n");
          } catch {
            // Client disconnected between the writableEnded check and the write
            // (TOCTOU). Swallow the error — the req "close" listener will call
            // attachSSE(null) which clears this timer on its next tick.
          }
        }
      }, SSE_HEARTBEAT_MS);
      this.sseHeartbeatTimer = timer;
      timer.unref();
    }
  }

  /** Returns a promise that resolves with the response for the given request ID.
   *  Rejects if the session is closed or the timeout fires. */
  waitForSend(requestId: string | number, timeoutMs = 90_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.pendingSends.size >= MAX_PENDING_SENDS) {
        reject(new Error("HTTP session send queue full"));
        return;
      }
      // Reject duplicate in-flight IDs — reusing the same id while a request
      // is pending is a client-side JSON-RPC spec violation.
      if (this.pendingSends.has(requestId)) {
        reject(
          new Error(`Duplicate request id=${requestId} — already in flight`),
        );
        return;
      }
      const timer = setTimeout(() => {
        this.pendingSends.delete(requestId);
        reject(new Error("HTTP session send timeout"));
      }, timeoutMs);
      this.pendingSends.set(requestId, (data) => {
        clearTimeout(timer);
        if (data === null) {
          reject(new Error("Session closed"));
        } else {
          resolve(data);
        }
      });
    });
  }

  /** Feed an incoming POST body to the McpTransport's message listener. */
  receive(data: string): void {
    this.emit("message", Buffer.from(data, "utf-8"));
  }

  /** Closes the adapter and any attached SSE stream. */
  close(): void {
    this.readyState = WebSocket.CLOSED;
    if (this.sseHeartbeatTimer) {
      clearInterval(this.sseHeartbeatTimer);
      this.sseHeartbeatTimer = null;
    }
    if (this.sseRes && !this.sseRes.writableEnded) {
      this.sseRes.end();
    }
    this.sseRes = null;
    // Reject any pending sends so callers get a 504, not a 200 with error body
    for (const resolve of this.pendingSends.values()) {
      resolve(null);
    }
    this.pendingSends.clear();
  }
}

interface HttpSession {
  id: string;
  adapter: HttpAdapter;
  transport: McpTransport;
  openedFiles: Set<string>;
  terminalPrefix: string;
  /**
   * Last interaction of any kind (POST/GET/DELETE OR server-initiated SSE
   * push). Used by the long-TTL idle pruner so a healthy SSE client receiving
   * server-pushed notifications is not pruned during quiet periods.
   */
  lastActivity: number;
  /**
   * Last *client-initiated* request (POST/GET/DELETE only). Used by the
   * capacity-eviction guard so an attacker holding 5 open SSE streams cannot
   * keep refreshing their slot via server-side broadcasts and DoS new
   * clients. Diverges from `lastActivity` only when SSE pushes happen
   * without paired client traffic.
   */
  lastClientActivity: number;
  /** Number of POST requests currently being processed (tool calls in flight). */
  inFlight: number;
  /** X-Claude-Code-Session-Id from the initialize request, if present. */
  claudeCodeSessionId: string | null;
  /**
   * Per-session ownership secret returned in the initialize response as
   * `Mcp-Session-Token`. Subsequent POST/GET/DELETE requests must echo it
   * in the same header. Closes the session-takeover hole where any caller
   * with a valid bridge bearer plus a known `Mcp-Session-Id` could DELETE
   * the session, hijack its SSE stream via GET, or impersonate POST
   * traffic. 32 bytes hex (256-bit). Necessary because the bridge often
   * runs with a single shared bearer token, so bearer-binding alone is
   * insufficient.
   */
  ownershipToken: string;
}

/** Constant-time hex-string comparison; both inputs must be same length. */
function hexEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verifies the `Mcp-Session-Token` header matches the session's ownership
 * token. Returns `true` if authorized.
 * The header is optional — standard MCP clients (Gemini CLI, Codex, etc.)
 * don't send it and the Bearer token already authenticated them. The check
 * only applies when the header is present, preventing session-ID hijacking
 * in shared-bridge-token / OAuth deployments where multiple clients share a
 * single Bearer token and could theoretically know each other's session IDs.
 */
function checkOwnership(
  req: http.IncomingMessage,
  session: { ownershipToken: string },
): boolean {
  const presented = req.headers["mcp-session-token"];
  if (typeof presented !== "string") return true; // header absent → allowed
  return hexEquals(presented, session.ownershipToken);
}

/** Handles POST/GET/DELETE /mcp for all HTTP sessions. */
export class StreamableHttpHandler {
  private sessions = new Map<string, HttpSession>();
  /**
   * Number of `createSession` calls currently in flight. Folded into the
   * capacity check so two concurrent POSTs that both observe `sessions.size
   * < MAX` cannot both pass the guard, await `instructionsProvider`, and
   * `sessions.set` past the cap.
   */
  private pendingSessionCreates = 0;
  private cleanupTimer: ReturnType<typeof setInterval>;
  /**
   * Shared token-bucket for all HTTP sessions.
   * Prevents rate-limit bypass via session cycling: a client that repeatedly
   * creates new sessions would otherwise get a fresh full bucket each time.
   * Initialised lazily on first session creation using the configured limit.
   */
  private sharedHttpRateLimitBucket: {
    tokens: number;
    lastRefill: number;
  } | null = null;

  constructor(
    private config: Config,
    private probes: ProbeResults,
    private extensionClient: ExtensionClient,
    private activityLog: ActivityLog,
    private fileLock: FileLock,
    private allSessions: Map<string, unknown>, // bridge sessions — for capacity guard
    private orchestrator: unknown,
    private logger: Logger,
    private getPluginTools: () => LoadedPluginTool[] = () => [],
    private getPluginWatcher: () => PluginWatcher | null = () => null,
    /** Optional: resolves the OAuth scope string for a bearer token, or null for full access. */
    private resolveScopeFn: ((token: string) => string | null) | null = null,
    /**
     * Optional: provider for the instructions string injected into the
     * MCP initialize response. Called per session so digests stay fresh
     * across sessions without restarting the bridge.
     */
    private instructionsProvider:
      | (() => Promise<string> | string)
      | null = null,
    /**
     * Tail-end deps that `registerAllTools` needs for the Patchwork-layer
     * tools (`ctxSaveTrace`, `ctxQueryTraces`, recipe-run helpers,
     * disconnect-aware compaction tools, etc.). Without these, those
     * tools were silently NOT registered for Streamable-HTTP MCP sessions
     * — they DID register on the WebSocket path because that call site
     * passes them. This is the parity fix.
     *
     * Caught dogfooding `ctx-loop-test` against a remote MCP client.
     */
    private toolDeps: {
      automationHooks?: import("./automation.js").AutomationHooks;
      getDisconnectInfo?: () => import("./tools/bridgeStatus.js").DisconnectInfo;
      onContextCacheUpdated?: (generatedAt: string) => void;
      getExtensionDisconnectCount?: () => number;
      commitIssueLinkLog?: import("./commitIssueLinkLog.js").CommitIssueLinkLog;
      recipeRunLog?: import("./runLog.js").RecipeRunLog;
      decisionTraceLog?: import("./decisionTraceLog.js").DecisionTraceLog;
    } = {},
  ) {
    // Prune idle sessions every 2 minutes.
    // .unref() prevents this timer from keeping the Node process alive when
    // all other work is done — avoids test hangs and clean process exit.
    this.cleanupTimer = setInterval(
      () => this.pruneIdle(),
      2 * 60 * 1000,
    ).unref();
  }

  /** Handle an incoming HTTP request to /mcp */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const origin = corsOrigin(req.headers.origin, this.config.corsOrigins);
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id, Mcp-Session-Token",
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Mcp-Session-Id, Mcp-Session-Token",
      );
    }

    // OPTIONS is handled by server.ts before auth — this handler only sees POST/GET/DELETE.
    if (req.method === "POST") {
      await this.handlePost(req, res);
    } else if (req.method === "GET") {
      this.handleGet(req, res);
    } else if (req.method === "DELETE") {
      this.handleDelete(req, res);
    } else {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
    }
  }

  private async handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Fast-path 413 for honest clients that declare an oversized Content-Length
    // before any body bytes are buffered. readBody still enforces the cap for
    // clients that lie or omit the header.
    const declaredLength = Number(req.headers["content-length"]);
    if (!Number.isNaN(declaredLength) && declaredLength > BODY_SIZE_LIMIT) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
      req.resume(); // drain so TCP can close cleanly
      return;
    }

    // Read body with size limit
    let body: string;
    try {
      body = await readBody(req, BODY_SIZE_LIMIT);
    } catch {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
      return;
    }

    // Parse JSON-RPC
    let msg: { jsonrpc: string; id?: unknown; method?: string };
    try {
      const parsed = JSON.parse(body);
      // Batch requests (arrays) are not supported — reject early with a clear error
      // rather than letting the request silently fall through as a notification.
      if (Array.isArray(parsed)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message: "Batch requests are not supported",
            },
          }),
        );
        return;
      }
      msg = parsed;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }

    // Resolve session
    const sessionId = req.headers["mcp-session-id"];
    let session: HttpSession | null = null;
    let sessionIsNew = false;

    if (msg.method === "initialize") {
      // Capacity guard — fold `pendingSessionCreates` into the count so two
      // concurrent initializes can't both pass the check, await
      // `instructionsProvider`, then `sessions.set` past MAX. Try to evict
      // the oldest idle session before rejecting; clients that crashed
      // without sending DELETE leave sessions lingering until the TTL prune.
      if (
        this.sessions.size + this.pendingSessionCreates >=
        MAX_HTTP_SESSIONS
      ) {
        if (!this.evictOldestIdleSession()) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id ?? null,
              error: { code: -32000, message: "HTTP session capacity reached" },
            }),
          );
          return;
        }
      }
      // Resolve OAuth scope from bearer token (if a resolver is configured)
      let sessionScope: string | null = null;
      if (this.resolveScopeFn) {
        const authHeader = req.headers.authorization ?? "";
        const bearer = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : "";
        if (bearer) sessionScope = this.resolveScopeFn(bearer);
      }
      // Parse X-Bridge-Deny-Tools header: comma-separated tool names to block for this session.
      const denyHeader = req.headers["x-bridge-deny-tools"];
      const denyTools = new Set<string>();
      if (typeof denyHeader === "string" && denyHeader.trim().length > 0) {
        const TOOL_NAME_RE = /^[a-zA-Z0-9_]+$/;
        for (const name of denyHeader.split(",")) {
          const trimmed = name.trim();
          if (TOOL_NAME_RE.test(trimmed)) {
            denyTools.add(trimmed);
          } else if (trimmed.length > 0) {
            this.logger.warn(
              `[http] ignoring invalid X-Bridge-Deny-Tools entry: "${trimmed}"`,
            );
          }
        }
      }
      session = await this.createSession(sessionScope, denyTools);
      sessionIsNew = true;
      const ccSessionId = req.headers["x-claude-code-session-id"];
      if (typeof ccSessionId === "string" && SESSION_ID_RE.test(ccSessionId)) {
        session.claudeCodeSessionId = ccSessionId;
        session.transport.claudeCodeSessionId = ccSessionId;
      }
      res.setHeader("Mcp-Session-Id", session.id);
      // Per-session ownership secret — required on subsequent
      // POST/GET/DELETE so a known session ID alone is not enough to
      // hijack the session under shared-bridge-token deployments.
      res.setHeader("Mcp-Session-Token", session.ownershipToken);
    } else {
      if (typeof sessionId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            error: { code: -32000, message: "Missing Mcp-Session-Id header" },
          }),
        );
        return;
      }
      session = this.sessions.get(sessionId) ?? null;
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            error: {
              code: -32000,
              message: "Session not found or expired — re-initialize",
            },
          }),
        );
        return;
      }
      // Verify the caller owns this session (Mcp-Session-Token header
      // matches what was returned in the initialize response).
      // The header is optional — absent means allowed (see checkOwnership).
      if (!checkOwnership(req, session)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            error: {
              code: -32000,
              message: "Mcp-Session-Token invalid",
            },
          }),
        );
        return;
      }
    }

    session.lastActivity = Date.now();
    session.lastClientActivity = session.lastActivity;

    // Notifications have no `id` field at all per JSON-RPC 2.0.
    // id:null is technically a malformed request but treat it as a notification
    // to prevent two null-id requests from colliding in the pendingSends Map.
    const isNotification = !Object.hasOwn(msg, "id") || msg.id === null;
    if (isNotification) {
      session.adapter.receive(body);
      res.writeHead(202);
      res.end();
      return;
    }

    // Request → feed to adapter, wait for transport's response keyed by request ID.
    // Audit 2026-06-08 HIGH (transport-1): for tools/call, size the HTTP wait
    // ABOVE the tool's own declared timeout (+ buffer). Otherwise the POST 504s
    // at the default 90s while a long tool (vscodeTasks 610s, runTests 300s,
    // watchDiagnostics 120s) keeps running, and its eventual response is dropped.
    const requestId = (msg.id as string | number) ?? 0;
    let waitMs: number | undefined;
    if (msg.method === "tools/call") {
      const toolName = (msg as { params?: { name?: unknown } }).params?.name;
      if (typeof toolName === "string") {
        waitMs =
          session.transport.getToolTimeout(toolName) +
          HTTP_SEND_TIMEOUT_BUFFER_MS;
      }
    }
    let responsePromise: Promise<string>;
    try {
      responsePromise = session.adapter.waitForSend(requestId, waitMs);
    } catch (err) {
      // Duplicate in-flight id — reject before feeding to transport so the
      // transport never sees a second message with the same id.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: {
            code: -32600,
            message: err instanceof Error ? err.message : "Invalid request",
          },
        }),
      );
      return;
    }
    session.inFlight++;
    session.adapter.receive(body);

    let responseData: string;
    try {
      responseData = await responsePromise;
    } catch {
      // Destroy newly-created sessions that timed out and strip the session ID
      // header so the client doesn't attempt to reuse a session that no longer
      // exists (setHeader is in-memory until writeHead; removeHeader undoes it).
      if (sessionIsNew) {
        this.destroySession(session.id);
        res.removeHeader("Mcp-Session-Id");
        res.removeHeader("Mcp-Session-Token");
      }
      session.inFlight = Math.max(0, session.inFlight - 1);
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: { code: -32000, message: "Response timeout" },
        }),
      );
      return;
    }

    session.inFlight = Math.max(0, session.inFlight - 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(responseData);
  }

  private handleGet(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
      // No session ID — return server info so clients (e.g. Gemini CLI) that
      // probe with GET before initializing can detect the server as alive.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          server: "claude-ide-bridge",
          transport: "streamable-http",
        }),
      );
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }
    if (!checkOwnership(req, session)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Mcp-Session-Token invalid");
      return;
    }

    // Establish SSE stream for server→client notifications.
    // Disable the per-request timeout for this long-lived stream only.
    res.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // prevent nginx from buffering SSE heartbeats
    });
    res.write(": connected\n\n"); // SSE comment to flush headers

    // Replay missed events if the client supplies a Last-Event-ID header.
    // This satisfies the MCP spec's stream recovery mechanism for dropped connections.
    const lastEventIdHeader = req.headers["last-event-id"];
    if (typeof lastEventIdHeader === "string") {
      const lastId = Number.parseInt(lastEventIdHeader, 10);
      if (!Number.isNaN(lastId)) {
        for (const event of session.adapter.getEventsAfter(lastId)) {
          res.write(`id: ${event.id}\ndata: ${event.data}\n\n`);
        }
      }
    }

    session.adapter.attachSSE(res);
    session.lastActivity = Date.now();
    session.lastClientActivity = session.lastActivity;

    // Guard: only detach if THIS response is still the active SSE stream.
    // Without the guard, a stale close-handler from a superseded GET would
    // call attachSSE(null) and tear down the live replacement stream.
    req.on("close", () => {
      session.adapter.detachSSEIfCurrent(res);
    });
  }

  private handleDelete(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing Mcp-Session-Id header");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }
    if (!checkOwnership(req, session)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Mcp-Session-Token invalid");
      return;
    }
    if (session.inFlight > 0) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request in progress" }));
      return;
    }
    this.destroySession(sessionId);
    res.writeHead(204);
    res.end();
  }

  private async createSession(
    scope: string | null = null,
    denyTools: Set<string> = new Set(),
  ): Promise<HttpSession> {
    this.pendingSessionCreates++;
    try {
      return await this.createSessionImpl(scope, denyTools);
    } finally {
      this.pendingSessionCreates--;
    }
  }

  private async createSessionImpl(
    scope: string | null,
    denyTools: Set<string>,
  ): Promise<HttpSession> {
    const id = crypto.randomUUID();
    const ownershipToken = crypto.randomBytes(32).toString("hex");
    const session = {
      id,
      adapter: null as unknown,
      transport: null as unknown,
      openedFiles: new Set<string>(),
      terminalPrefix: `http-${id.slice(0, 8)}`,
      lastActivity: Date.now(),
      lastClientActivity: Date.now(),
      inFlight: 0,
      claudeCodeSessionId: null,
      ownershipToken,
    } as HttpSession;
    const adapter = new HttpAdapter(
      (msg) => this.logger.warn(msg),
      () => {
        session.lastActivity = Date.now();
      }, // refresh on SSE writes
    );
    const transport = new McpTransport(this.logger);
    transport.httpTimeoutCeilingMs = HTTP_TOOL_TIMEOUT_CEILING_MS;
    transport.workspace = this.config.workspace;
    transport.sessionId = id;
    transport.onActivity = () => {
      session.lastActivity = Date.now();
    };
    transport.setActivityLog(this.activityLog);
    transport.setToolRateLimit(this.config.toolRateLimit);
    if (this.config.lazyTools) transport.setLazyTools(true);
    // Share one rate-limit bucket across all HTTP sessions to prevent bypass via cycling.
    if (this.config.toolRateLimit > 0) {
      if (!this.sharedHttpRateLimitBucket) {
        this.sharedHttpRateLimitBucket = {
          tokens: this.config.toolRateLimit,
          lastRefill: Date.now(),
        };
      }
      transport.setSharedToolRateLimitBucket(this.sharedHttpRateLimitBucket);
    }
    transport.setExtensionConnectedFn(() => this.extensionClient.isConnected());
    if (this.instructionsProvider !== null) {
      transport.setInstructions(await this.instructionsProvider());
    }
    if (scope) transport.setSessionScope(scope);
    if (denyTools.size > 0) transport.setDenyTools(denyTools);
    if (this.config.approvalGate !== "off") {
      const gateAll = this.config.approvalGate === "all";
      transport.setApprovalGate(
        async ({ toolName, params, sessionId, onPending }) => {
          const tier = classifyTool(toolName);
          if (!gateAll && tier !== "high") return "bypass";
          const queue = getApprovalQueue();
          const { promise, callId } = queue.request({
            toolName,
            params,
            tier,
            sessionId: sessionId ?? undefined,
            riskSignals: [],
          });
          onPending?.(callId);
          return promise;
        },
      );
    }

    const terminalPrefix = `h${id.slice(0, 8)}-`; // "h" prefix distinguishes HTTP sessions

    // Populate the early session stub so onSseSend callback can reference it.
    session.adapter = adapter;
    session.transport = transport;
    session.terminalPrefix = terminalPrefix;

    // Join the plugin watcher BEFORE registerAllTools so that if a reload fires
    // between the two, this transport is already tracked and will receive fresh tools.
    // If anything between here and `sessions.set` throws (e.g. pluginTools getter
    // or registerAllTools), the watcher tracks a transport that never made it into
    // `sessions` — clean up explicitly via the catch below.
    this.getPluginWatcher()?.addTransport(transport);
    try {
      const pluginTools = this.getPluginTools();

      registerAllTools(
        transport,
        this.config,
        session.openedFiles,
        this.probes,
        this.extensionClient,
        this.activityLog,
        terminalPrefix,
        this.fileLock,
        this.allSessions as Map<
          string,
          {
            id: string;
            transport: McpTransport;
            openedFiles: Set<string>;
            terminalPrefix: string;
            graceTimer: ReturnType<typeof setTimeout> | null;
            connectedAt: number;
            ws: import("ws").WebSocket;
          }
        >,
        this.orchestrator as
          | import("./claudeOrchestrator.js").ClaudeOrchestrator
          | null,
        id,
        pluginTools,
        // Parity with the WebSocket call in bridge.ts — without these,
        // `ctxSaveTrace`, `ctxQueryTraces`, and any tool gated on the
        // remaining deps silently fail to register for Streamable-HTTP
        // MCP sessions.
        this.toolDeps.automationHooks,
        this.toolDeps.getDisconnectInfo,
        this.toolDeps.onContextCacheUpdated,
        this.toolDeps.getExtensionDisconnectCount,
        this.toolDeps.commitIssueLinkLog,
        this.toolDeps.recipeRunLog,
        this.toolDeps.decisionTraceLog,
      );

      transport.attach(adapter as unknown as import("ws").WebSocket);

      this.sessions.set(id, session);
      this.logger.info(
        `HTTP session created (${id.slice(0, 8)}) — ${this.sessions.size} HTTP sessions`,
      );
      return session;
    } catch (err) {
      // Roll back the partial session. The pluginWatcher is the only external
      // registration so far; transport.detach is a no-op if attach() never ran;
      // adapter.close releases SSE resources if any heartbeat was set up.
      this.getPluginWatcher()?.removeTransport(transport);
      try {
        transport.detach();
      } catch {}
      try {
        adapter.close();
      } catch {}
      throw err;
    }
  }

  private destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // Abort in-flight tool calls before closing the response channel so handlers
    // receive their cancellation signal while they can still observe it.
    this.getPluginWatcher()?.removeTransport(session.transport);
    session.transport.detach();
    session.adapter.close();
    this.sessions.delete(id);
    this.logger.info(
      `HTTP session closed (${id.slice(0, 8)}) — ${this.sessions.size} HTTP sessions`,
    );
  }

  private pruneIdle(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        this.logger.info(`Pruning idle HTTP session ${id.slice(0, 8)}`);
        this.destroySession(id);
      }
    }
  }

  /**
   * Evict the oldest client-idle HTTP session to make room for a new
   * connection. Only evicts if the oldest session's *client-initiated*
   * activity is more than 60 seconds stale — server-pushed SSE events do NOT
   * count, so an attacker can't hold 5 SSE streams open and DoS new clients
   * by riding on bridge-initiated broadcasts (notifications/tools/list_changed,
   * etc.) refreshing their slot.
   *
   * Returns true if a slot was freed, false if all sessions have made a
   * client request within the threshold.
   */
  private evictOldestIdleSession(): boolean {
    const IDLE_THRESHOLD_MS = 60_000;
    const now = Date.now();
    let oldestId: string | null = null;
    let oldestClientActivity = now;
    for (const [id, session] of this.sessions) {
      if (session.inFlight > 0) continue; // skip sessions with in-flight tool calls
      if (session.lastClientActivity < oldestClientActivity) {
        oldestClientActivity = session.lastClientActivity;
        oldestId = id;
      }
    }
    if (oldestId && now - oldestClientActivity > IDLE_THRESHOLD_MS) {
      this.logger.warn(
        `Evicting client-idle HTTP session ${oldestId.slice(0, 8)} (no client traffic ${Math.round((now - oldestClientActivity) / 1000)}s) to make room`,
      );
      this.destroySession(oldestId);
      return true;
    }
    return false;
  }

  /**
   * Broadcast notifications/tools/list_changed to all HTTP sessions that have
   * an open SSE stream. Called by bridge.ts sendListChanged() so HTTP clients
   * learn about plugin reloads alongside WebSocket clients.
   */
  broadcastListChanged(): void {
    for (const session of this.sessions.values()) {
      if (session.adapter.readyState === WebSocket.OPEN) {
        McpTransport.sendNotification(
          session.adapter as unknown as import("ws").WebSocket,
          "notifications/tools/list_changed",
          undefined,
          this.logger,
        );
      }
    }
  }

  /** Call on bridge shutdown to clean up all sessions and the prune timer. */
  close(): void {
    clearInterval(this.cleanupTimer);
    for (const id of this.sessions.keys()) {
      this.destroySession(id);
    }
  }
}

/** Read the full request body, enforcing a size limit. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        if (!settled) {
          settled = true;
          reject(new Error("Body too large"));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
