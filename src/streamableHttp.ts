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
import type { Config } from "./config.js";
import type { ExtensionClient } from "./extensionClient.js";
import type { FileLock } from "./fileLock.js";
import type { Logger } from "./logger.js";
import type { LoadedPluginTool } from "./pluginLoader.js";
import type { PluginWatcher } from "./pluginWatcher.js";
import type { ProbeResults } from "./probe.js";
import { corsOrigin } from "./server.js";
import { registerAllTools } from "./tools/index.js";
import { McpTransport } from "./transport.js";

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour idle TTL
const MAX_HTTP_SESSIONS = 5;
const BODY_SIZE_LIMIT = 1_048_576; // 1 MB
const MAX_PENDING_SENDS = 100; // per-session response queue cap
const SSE_HEARTBEAT_MS = 20_000; // keep SSE streams alive through proxies/firewalls

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

  /**
   * Called by safeSend() / McpTransport to deliver a message.
   * Responses (JSON-RPC messages with `id`) go to the matching pending POST resolver.
   * Notifications (no `id` — e.g. progress, list_changed) go to the SSE stream.
   * This prevents notifications from consuming a response slot.
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
      // Unparseable — fall through to SSE path
    }

    if (responseId !== null) {
      const resolve = this.pendingSends.get(responseId);
      if (resolve) {
        this.pendingSends.delete(responseId);
        resolve(str);
        cb?.();
        return;
      }
    }

    if (this.sseRes && !this.sseRes.writableEnded) {
      this.sseRes.write(`data: ${str}\n\n`);
      this.onSseSend(); // refresh session lastActivity so idle pruner doesn't kill open SSE connections
      cb?.();
      return;
    }
    // Neither pending POST waiter nor SSE stream — message is silently dropped.
    // Log a warning so operators can detect stale or missing SSE connections.
    if (responseId !== null) {
      this.warn(
        `HTTP: dropped response id=${responseId} — no pending waiter or active SSE stream`,
      );
    }
    cb?.();
  }

  /** Attach (or detach, when null) a GET /mcp SSE response for server-initiated notifications. */
  attachSSE(res: http.ServerResponse | null): void {
    if (this.sseHeartbeatTimer) {
      clearInterval(this.sseHeartbeatTimer);
      this.sseHeartbeatTimer = null;
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
  lastActivity: number;
}

/** Handles POST/GET/DELETE /mcp for all HTTP sessions. */
export class StreamableHttpHandler {
  private sessions = new Map<string, HttpSession>();
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
        "Content-Type, Authorization, Mcp-Session-Id",
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
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
      // Capacity guard — try to evict the oldest idle session before rejecting.
      // If a client crashed without sending DELETE, its session lingers until
      // the TTL prune fires. Eviction here gives new connections a seat without
      // waiting up to 10 minutes for the idle sweep.
      if (this.sessions.size >= MAX_HTTP_SESSIONS) {
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
      session = this.createSession();
      sessionIsNew = true;
      res.setHeader("Mcp-Session-Id", session.id);
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
    }

    session.lastActivity = Date.now();

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

    // Request → feed to adapter, wait for transport's response keyed by request ID
    const requestId = (msg.id as string | number) ?? 0;
    let responsePromise: Promise<string>;
    try {
      responsePromise = session.adapter.waitForSend(requestId);
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
      }
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(responseData);
  }

  private handleGet(req: http.IncomingMessage, res: http.ServerResponse): void {
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

    // Establish SSE stream for server→client notifications.
    // Disable the per-request timeout for this long-lived stream only.
    res.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n"); // SSE comment to flush headers

    session.adapter.attachSSE(res);
    session.lastActivity = Date.now();

    req.on("close", () => {
      session.adapter.attachSSE(null); // detach SSE stream on client disconnect
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
    if (!this.sessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Session not found");
      return;
    }
    this.destroySession(sessionId);
    res.writeHead(204);
    res.end();
  }

  private createSession(): HttpSession {
    const id = crypto.randomUUID();
    const session = {
      id,
      adapter: null as unknown,
      transport: null as unknown,
      openedFiles: new Set<string>(),
      terminalPrefix: `http-${id.slice(0, 8)}`,
      lastActivity: Date.now(),
    } as HttpSession;
    const adapter = new HttpAdapter(
      (msg) => this.logger.warn(msg),
      () => {
        session.lastActivity = Date.now();
      }, // refresh on SSE writes
    );
    const transport = new McpTransport(this.logger);
    transport.workspace = this.config.workspace;
    transport.sessionId = id;
    transport.setActivityLog(this.activityLog);
    transport.setToolRateLimit(this.config.toolRateLimit);
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

    const terminalPrefix = `h${id.slice(0, 8)}-`; // "h" prefix distinguishes HTTP sessions

    // Populate the early session stub so onSseSend callback can reference it.
    session.adapter = adapter;
    session.transport = transport;
    session.terminalPrefix = terminalPrefix;

    // Join the plugin watcher BEFORE registerAllTools so that if a reload fires
    // between the two, this transport is already tracked and will receive fresh tools.
    this.getPluginWatcher()?.addTransport(transport);
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
    );

    transport.attach(adapter as unknown as import("ws").WebSocket);

    this.sessions.set(id, session);
    this.logger.info(
      `HTTP session created (${id.slice(0, 8)}) — ${this.sessions.size} HTTP sessions`,
    );
    return session;
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
   * Evict the oldest idle HTTP session to make room for a new connection.
   * Only evicts if the oldest session has been idle for more than 60 seconds,
   * which indicates the client is gone (crashed, network dropped, no DELETE sent).
   * Returns true if a slot was freed, false if all sessions are actively in use.
   */
  private evictOldestIdleSession(): boolean {
    const IDLE_THRESHOLD_MS = 60_000;
    const now = Date.now();
    let oldestId: string | null = null;
    let oldestActivity = now;
    for (const [id, session] of this.sessions) {
      if (session.lastActivity < oldestActivity) {
        oldestActivity = session.lastActivity;
        oldestId = id;
      }
    }
    if (oldestId && now - oldestActivity > IDLE_THRESHOLD_MS) {
      this.logger.warn(
        `Evicting idle HTTP session ${oldestId.slice(0, 8)} (idle ${Math.round((now - oldestActivity) / 1000)}s) to make room`,
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
    for (const id of [...this.sessions.keys()]) {
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
