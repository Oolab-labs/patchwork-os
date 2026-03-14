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
import type { ProbeResults } from "./probe.js";
import { registerAllTools } from "./tools/index.js";
import { McpTransport } from "./transport.js";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle TTL
const MAX_HTTP_SESSIONS = 5;
const BODY_SIZE_LIMIT = 1_048_576; // 1 MB
const MAX_PENDING_SENDS = 100; // per-session response queue cap
const SSE_HEARTBEAT_MS = 20_000; // keep SSE streams alive through proxies/firewalls

/** Mimics the WebSocket interface so McpTransport works unchanged. */
class HttpAdapter extends EventEmitter {
  /** WebSocket.OPEN = 1; WebSocket.CLOSED = 3 */
  readyState: number = WebSocket.OPEN;
  /** Always 0 — no send buffer for HTTP (bypasses backpressure drain). */
  readonly bufferedAmount = 0;

  private pendingSends: Array<(data: string | null) => void> = [];
  private sseRes: http.ServerResponse | null = null;
  private sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Called by safeSend() / McpTransport to deliver a message.
   * Responses (JSON-RPC messages with `id`) go to the pending POST resolver.
   * Notifications (no `id` — e.g. progress, list_changed) go to the SSE stream.
   * This prevents notifications from consuming the response slot.
   */
  send(data: string | Buffer, cb?: (err?: Error) => void): void {
    const str = typeof data === "string" ? data : data.toString("utf-8");

    // Determine if this is a response (has `id`) or a notification (no `id`).
    let isResponse = false;
    try {
      const parsed = JSON.parse(str);
      isResponse = parsed.id !== undefined && parsed.id !== null;
    } catch {
      // If we can't parse, treat as response to avoid dropping data.
      isResponse = true;
    }

    if (isResponse && this.pendingSends.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length guard above
      const resolve = this.pendingSends.shift()!;
      resolve(str);
    } else if (this.sseRes && !this.sseRes.writableEnded) {
      this.sseRes.write(`data: ${str}\n\n`);
    }
    // If neither path matches (no SSE, not a response), the message is dropped.
    // This matches WebSocket behavior where the client may not be listening.
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
      this.sseHeartbeatTimer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(this.sseHeartbeatTimer!);
          this.sseHeartbeatTimer = null;
        } else {
          res.write(": heartbeat\n\n");
        }
      }, SSE_HEARTBEAT_MS);
      this.sseHeartbeatTimer.unref();
    }
  }

  /** Returns a promise that resolves with the next message McpTransport sends.
   *  Rejects if the session is closed or the timeout fires. */
  waitForSend(timeoutMs = 30_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("HTTP session send timeout")),
        timeoutMs,
      );
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        clearTimeout(timer);
        reject(new Error("HTTP session send queue full"));
        return;
      }
      this.pendingSends.push((data) => {
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
    for (const resolve of this.pendingSends) {
      resolve(null);
    }
    this.pendingSends = [];
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

  constructor(
    private config: Config,
    private probes: ProbeResults,
    private extensionClient: ExtensionClient,
    private activityLog: ActivityLog,
    private fileLock: FileLock,
    private allSessions: Map<string, unknown>, // bridge sessions — for capacity guard
    private orchestrator: unknown,
    private logger: Logger,
  ) {
    // Prune idle sessions every 5 minutes
    this.cleanupTimer = setInterval(() => this.pruneIdle(), 5 * 60 * 1000);
  }

  /** Handle an incoming HTTP request to /mcp */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id",
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

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
      msg = JSON.parse(body);
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

    if (msg.method === "initialize") {
      // Capacity guard
      if (this.sessions.size >= MAX_HTTP_SESSIONS) {
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
      session = this.createSession();
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

    // Notifications have no `id` field at all per JSON-RPC 2.0 — id:null is a malformed request
    const isNotification = !Object.hasOwn(msg, "id");
    if (isNotification) {
      session.adapter.receive(body);
      res.writeHead(202);
      res.end();
      return;
    }

    // Request → feed to adapter, wait for transport's response
    const responsePromise = session.adapter.waitForSend();
    session.adapter.receive(body);

    let responseData: string;
    try {
      responseData = await responsePromise;
    } catch {
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

    // Establish SSE stream for server→client notifications
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
    const adapter = new HttpAdapter();
    const transport = new McpTransport(this.logger);
    transport.workspace = this.config.workspace;
    transport.sessionId = id;
    transport.setActivityLog(this.activityLog);
    transport.setExtensionConnectedFn(() => this.extensionClient.isConnected());

    const openedFiles = new Set<string>();
    const terminalPrefix = `h${id.slice(0, 8)}-`; // "h" prefix distinguishes HTTP sessions

    registerAllTools(
      transport,
      this.config,
      openedFiles,
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
    );

    transport.attach(adapter as unknown as import("ws").WebSocket);

    const session: HttpSession = {
      id,
      adapter,
      transport,
      openedFiles,
      terminalPrefix,
      lastActivity: Date.now(),
    };
    this.sessions.set(id, session);
    this.logger.info(
      `HTTP session created (${id.slice(0, 8)}) — ${this.sessions.size} HTTP sessions`,
    );
    return session;
  }

  private destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.adapter.close();
    session.transport.detach();
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
