import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { WebSocket, WebSocketServer as WsServer } from "ws";
import type { Logger } from "./logger.js";
import { BRIDGE_PROTOCOL_VERSION, PACKAGE_VERSION } from "./version.js";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// ActivityEntry|LifecycleEntry live in activityLog.ts — importing them here creates a
// circular dependency, so we use `any` and suppress the rule with a named alias.
// biome-ignore lint/suspicious/noExplicitAny: circular dep — see comment above
type ActivityListener = (kind: string, entry: any) => void;

interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
  missedPongs: number;
  lastPongTime: number;
  lastPingTime: number;
}

function enableTcpKeepalive(ws: WebSocket): void {
  const rawSocket = (ws as unknown as { _socket?: import("net").Socket })
    ._socket;
  if (rawSocket?.setKeepAlive) {
    rawSocket.setKeepAlive(true, 60_000); // 60s TCP keepalive as defense-in-depth
  }
}

interface ServerEvents {
  connection: [ws: WebSocket];
  extension: [ws: WebSocket];
}

/**
 * Return the CORS origin to reflect, or null if the origin is untrusted.
 * Only loopback origins are allowed — the bridge binds locally and does not
 * need to serve cross-origin requests from arbitrary sites.
 * Covers: localhost, 127.0.0.1, and [::1] (IPv6 loopback for --bind ::1 users).
 */
export function corsOrigin(requestOrigin: string | undefined): string | null {
  if (!requestOrigin) return null;
  try {
    const { hostname, protocol } = new URL(requestOrigin);
    if (
      protocol === "http:" &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]")
    ) {
      return requestOrigin;
    }
  } catch {
    // malformed origin — deny
  }
  return null;
}

function timingSafeTokenCompare(a: string, b: string): boolean {
  const bA = Buffer.from(a);
  const bB = Buffer.from(b);
  const len = Math.max(bA.length, bB.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bA.copy(padA);
  bB.copy(padB);
  // Use timingSafeEqual for the length comparison too so an attacker on a
  // remote deployment cannot distinguish "wrong length" from "right length,
  // wrong bytes" via timing.  Encode each length as a fixed-width 4-byte BE
  // integer before comparing.
  const lenA = Buffer.allocUnsafe(4);
  const lenB = Buffer.allocUnsafe(4);
  lenA.writeUInt32BE(bA.length, 0);
  lenB.writeUInt32BE(bB.length, 0);
  return (
    crypto.timingSafeEqual(padA, padB) && crypto.timingSafeEqual(lenA, lenB)
  );
}

function setupPongHandler(ws: AliveWebSocket): void {
  ws.on("pong", (data: Buffer) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    const now = Date.now();
    const sentAt = Number.parseInt(data.toString(), 10);
    // Accept the echoed timestamp only if it's within a plausible ping window
    // (±60s from now). A spoofed pong payload with a far-future value would
    // otherwise corrupt lastPongTime and skew diagnostics.
    ws.lastPongTime =
      !Number.isNaN(sentAt) && Math.abs(now - sentAt) <= 60_000 ? sentAt : now;
  });
}

const MIN_CONNECTION_INTERVAL_MS = 50; // Allow multiple agents to connect within same second

export class Server extends EventEmitter<ServerEvents> {
  private httpServer: http.Server;
  private wss: WsServer;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastClaudeConnectionTime = 0;
  private lastExtensionConnectionTime = 0;
  private startTime = Date.now();

  /** Set by bridge to provide health data */
  public healthDataFn: (() => Record<string, unknown>) | null = null;
  /** Set by bridge to provide Prometheus metrics */
  public metricsFn: (() => string) | null = null;
  /** Set by bridge to provide rich status data */
  public statusFn: (() => Record<string, unknown>) | null = null;
  /** Set by bridge to provide readiness data (MCP handshake complete, tool count, extension) */
  public readyFn:
    | (() => { ready: boolean; toolCount: number; extensionConnected: boolean })
    | null = null;
  /** Set by bridge to provide task list data (sanitized — no raw prompts) */
  public tasksFn: (() => { tasks: Record<string, unknown>[] }) | null = null;
  /** Set by bridge to handle MCP Streamable HTTP sessions (POST/GET/DELETE /mcp) */
  public httpMcpHandler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
    | null = null;
  /** Set by bridge to subscribe a caller to real-time activity events. Returns unsubscribe fn. */
  public streamFn: ((listener: ActivityListener) => () => void) | null = null;

  constructor(
    private authToken: string,
    private logger: Logger,
  ) {
    super();
    // Defense-in-depth: ensure token is non-empty so timingSafeTokenCompare
    // cannot accept a blank Authorization header against an empty token.
    if (authToken.length === 0) {
      throw new Error("authToken must not be empty");
    }
    if (authToken.length < 32) {
      logger.warn(
        `authToken is only ${authToken.length} chars — production tokens should be ≥ 32 chars (crypto.randomBytes(32).toString('hex'))`,
      );
    }
    this.httpServer = http.createServer((req, res) => {
      // Security headers on all responses
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");

      // Public discovery endpoint — no auth required
      if (
        req.url === "/.well-known/mcp/server-card.json" ||
        req.url === "/.well-known/mcp"
      ) {
        const card = {
          name: "claude-ide-bridge",
          version: BRIDGE_PROTOCOL_VERSION,
          description:
            "MCP bridge providing full IDE integration for Claude Code — LSP, diagnostics, file operations, terminal, debug adapters, and AI task orchestration",
          homepage: "https://github.com/Oolab-labs/claude-ide-bridge",
          transport: ["websocket", "stdio", "streamable-http"],
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            elicitation: true,
          },
          author: "Oolab Labs",
          license: "MIT",
          repository: "https://github.com/Oolab-labs/claude-ide-bridge",
        };
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(card, null, 2));
        return;
      }

      // CORS preflight for /mcp — browsers (and Claude Desktop's web renderer) send
      // OPTIONS before POST. Respond without requiring auth so the preflight succeeds.
      if (req.method === "OPTIONS" && req.url === "/mcp") {
        const origin = corsOrigin(req.headers.origin);
        if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, Mcp-Session-Id",
        );
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        res.writeHead(204);
        res.end();
        return;
      }

      // Unauthenticated liveness probe — safe to expose; contains no sensitive data.
      if (req.url === "/ping" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, v: PACKAGE_VERSION }));
        return;
      }

      // All other HTTP endpoints require Bearer token authentication.
      // This prevents any local process or network peer (if --bind 0.0.0.0 is used)
      // from reading internal state without possessing the session auth token.
      const authHeader = req.headers.authorization ?? "";
      const bearerFromHeader = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";
      // Also accept token via ?token= query param for clients that cannot set
      // Authorization headers (e.g. claude.ai Custom Connectors UI).
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const bearerFromQuery = parsedUrl.searchParams.get("token") ?? "";
      const bearer = bearerFromHeader || bearerFromQuery;
      if (!timingSafeTokenCompare(bearer, this.authToken)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }

      if (req.url === "/metrics" && req.method === "GET") {
        try {
          const body = this.metricsFn?.() ?? "";
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        try {
          const data = {
            status: "ok",
            uptimeMs: Date.now() - this.startTime,
            connections: this.wss.clients.size,
            ...(this.healthDataFn?.() ?? {}),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/status" && req.method === "GET") {
        try {
          const data = {
            uptimeMs: Date.now() - this.startTime,
            ...(this.statusFn?.() ?? {}),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/ready" && req.method === "GET") {
        try {
          const info = this.readyFn?.() ?? {
            ready: false,
            toolCount: 0,
            extensionConnected: false,
          };
          if (info.ready) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ready: true,
                toolCount: info.toolCount,
                extensionConnected: info.extensionConnected,
              }),
            );
          } else {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ready: false,
                reason: "awaiting MCP handshake",
              }),
            );
          }
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      if (req.url === "/stream" && req.method === "GET") {
        // Disable socket timeout — SSE connections are long-lived by design
        res.socket?.setTimeout(0);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();

        const unsub =
          this.streamFn?.((kind, entry) => {
            try {
              res.write(`data: ${JSON.stringify({ kind, ...entry })}\n\n`);
            } catch {
              // Client disconnected — unsubscribe on next tick
              unsub?.();
            }
          }) ?? (() => {});

        // Keep-alive comment ping every 15s so proxies don't close idle connections
        const ping = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            clearInterval(ping);
            unsub();
          }
        }, 15_000);
        ping.unref();

        req.on("close", () => {
          clearInterval(ping);
          unsub();
        });
        return;
      }
      if (req.url === "/tasks" && req.method === "GET") {
        try {
          const data = this.tasksFn?.() ?? { tasks: [] };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }
      // MCP Streamable HTTP transport — POST/GET/DELETE /mcp.
      // Bearer auth is already checked above (line ~138), so all requests here
      // are authenticated. The Mcp-Session-Id header routes to the correct session.
      // OPTIONS is handled before auth (line ~126) so CORS preflight works.
      if (req.url === "/mcp" && this.httpMcpHandler) {
        if (
          req.method === "POST" ||
          req.method === "GET" ||
          req.method === "DELETE"
        ) {
          this.httpMcpHandler(req, res).catch((err) => {
            this.logger.error(
              `HTTP MCP handler error: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    // Do NOT pass server — we handle upgrade manually for pre-handshake auth
    this.wss = new WsServer({
      noServer: true,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });

    // Authenticate on upgrade BEFORE completing the WebSocket handshake
    this.httpServer.on("upgrade", (request, socket, head) => {
      // Prevent unhandled error events on the raw socket during upgrade
      socket.on("error", () => socket.destroy());

      // Validate Host header to defend against DNS rebinding.
      // Strip port suffix, handling both IPv4 (host:port) and IPv6 ([::1]:port).
      const rawHost = request.headers.host ?? "";
      const host = rawHost.startsWith("[")
        ? rawHost.slice(0, rawHost.indexOf("]") + 1) // [::1]:port → [::1]
        : rawHost.replace(/:\d+$/, ""); // host:port → host
      if (!host || !ALLOWED_HOSTS.has(host)) {
        this.logger.warn(
          `Rejected connection with invalid Host header: ${host}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      // Reject browser-originated connections — a browser tab on any origin can
      // connect to ws://localhost:<port> but will always send an Origin header.
      // VS Code extension and Claude Code CLI connections either omit Origin or
      // send "vscode-file://" / "vscode-webview://". Any other origin is a browser
      // page attempting a cross-origin WebSocket and is rejected here as defense-
      // in-depth (the auth token is the primary guard).
      const origin = request.headers.origin;
      if (
        origin !== undefined &&
        origin !== "null" &&
        !origin.startsWith("vscode-file://") &&
        !origin.startsWith("vscode-webview://") &&
        !origin.startsWith("vscode-app://")
      ) {
        this.logger.warn(
          `Rejected connection with unexpected Origin header: ${origin}`,
        );
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const now = Date.now();

      // Check for extension connection (distinct header)
      const extensionToken = request.headers["x-claude-ide-extension"];
      if (
        typeof extensionToken === "string" &&
        timingSafeTokenCompare(extensionToken, this.authToken)
      ) {
        // Rate limit per client type to prevent connection-storm DoS
        if (
          now - this.lastExtensionConnectionTime <
          MIN_CONNECTION_INTERVAL_MS
        ) {
          socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
          socket.destroy();
          return;
        }
        this.lastExtensionConnectionTime = now;
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          const alive = ws as AliveWebSocket;
          alive.isAlive = true;
          alive.missedPongs = 0;
          alive.lastPongTime = Date.now();
          enableTcpKeepalive(ws);
          setupPongHandler(alive);
          this.emit("extension", ws);
          ws.once("close", () => {
            this.lastExtensionConnectionTime = 0;
          });
        });
        return;
      }

      // Check for Claude Code connection
      const token = request.headers["x-claude-code-ide-authorization"];
      if (
        typeof token !== "string" ||
        !timingSafeTokenCompare(token, this.authToken)
      ) {
        this.logger.warn("Rejected unauthorized WebSocket upgrade");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // Rate limit per client type to prevent connection-storm DoS
      if (now - this.lastClaudeConnectionTime < MIN_CONNECTION_INTERVAL_MS) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }
      this.lastClaudeConnectionTime = now;

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (raw) => {
      const ws = raw as AliveWebSocket;
      this.logger.debug("Claude Code connected");
      ws.isAlive = true;
      ws.missedPongs = 0;
      ws.lastPongTime = Date.now();
      enableTcpKeepalive(raw);
      setupPongHandler(ws);
      ws.on("error", (err) => {
        this.logger.error(`WebSocket client error: ${err.message}`);
      });
      this.emit("connection", ws);
    });
  }

  async listen(port: number, bindAddress = "127.0.0.1"): Promise<number> {
    const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
    if (!LOOPBACK.has(bindAddress)) {
      this.logger.warn(
        `WARNING: Bridge bound to ${bindAddress} — not a loopback address. Any host that can reach this address and obtain the auth token can connect. Use --bind 127.0.0.1 (default) for local-only access.`,
      );
    }
    // Mitigate slow-loris attacks: bound the headers phase.
    // requestTimeout is NOT disabled globally — SSE handlers must disable it
    // per-response via `res.socket?.setTimeout(0)` for their own long-lived stream.
    this.httpServer.headersTimeout = 5_000;
    this.httpServer.requestTimeout = 30_000;
    return new Promise((resolve, reject) => {
      this.httpServer
        .listen(port, bindAddress, () => {
          const addr = this.httpServer.address();
          if (!addr || typeof addr === "string") {
            if (this.pingInterval) {
              clearInterval(this.pingInterval);
              this.pingInterval = null;
            }
            reject(new Error("Unexpected server address"));
            return;
          }
          // Ping clients every 30s; terminate after 3 missed pongs (90s tolerance)
          this.pingInterval = setInterval(() => {
            const now = Date.now();
            for (const raw of this.wss.clients) {
              const client = raw as AliveWebSocket;
              // Sleep/wake detection: if timer fired much later than expected,
              // the system likely slept. Reset and probe instead of killing.
              if (client.lastPingTime && now - client.lastPingTime > 45_000) {
                client.missedPongs = 0;
                client.isAlive = false;
                client.lastPingTime = now;
                if (client.readyState === WebSocket.OPEN) {
                  client.ping(Buffer.from(now.toString()));
                }
                continue;
              }
              if (!client.isAlive) {
                client.missedPongs = (client.missedPongs ?? 0) + 1;
                if (client.missedPongs >= 3) {
                  this.logger.warn(
                    "Terminating unresponsive client (3 missed pongs)",
                  );
                  client.terminate();
                  continue;
                }
              }
              client.isAlive = false;
              client.lastPingTime = now;
              if (client.readyState === WebSocket.OPEN) {
                client.ping(Buffer.from(now.toString()));
              }
            }
          }, 30_000);
          resolve(addr.port);
        })
        .on("error", reject);
    });
  }

  async findAndListen(
    preferredPort: number | null,
    bindAddress = "127.0.0.1",
  ): Promise<number> {
    if (preferredPort) {
      if (preferredPort < 1 || preferredPort > 65535) {
        this.logger.warn(
          `Invalid port ${preferredPort} (must be 1-65535), falling back to OS-assigned port`,
        );
        // Fall through to OS-assigned port below
      } else {
        return this.listen(preferredPort, bindAddress);
      }
    }
    // Port 0 lets the OS kernel assign a free port atomically
    return this.listen(0, bindAddress);
  }

  async close(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const client of this.wss.clients) {
      client.close(1001, "Server shutting down");
    }
    // Wait up to 2s for graceful disconnect, then force-terminate
    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        for (const client of this.wss.clients) {
          client.terminate();
        }
        resolve();
      }, 2000);
      this.wss.close(() => {
        clearTimeout(forceTimer);
        resolve();
      });
    });
    // Drain idle keep-alive HTTP connections (Node 20+ native)
    this.httpServer.closeIdleConnections();
    await new Promise<void>((resolve) => {
      // Hard failsafe: force-close any remaining HTTP connections after 10s
      const hardTimer = setTimeout(() => {
        this.httpServer.closeAllConnections();
        resolve();
      }, 10_000);
      this.httpServer.close((err) => {
        clearTimeout(hardTimer);
        if (err) this.logger.error(`HTTP server close error: ${err.message}`);
        resolve();
      });
    });
  }
}
