import { EventEmitter } from "node:events";
import http from "node:http";
import { WebSocket, WebSocketServer as WsServer } from "ws";
import { timingSafeStringEqual } from "./crypto.js";
import type { Logger } from "./logger.js";
import type { OAuthServer } from "./oauth.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  PACKAGE_LICENSE,
  PACKAGE_VERSION,
} from "./version.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

import type { ActivityListener } from "./activityTypes.js";

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
 * Loopback origins are always allowed. Additional origins can be passed via
 * --cors-origin (e.g. https://claude.ai for remote deployments).
 */
export function corsOrigin(
  requestOrigin: string | undefined,
  extraOrigins: string[] = [],
): string | null {
  if (!requestOrigin) return null;
  if (extraOrigins.includes(requestOrigin)) return requestOrigin;
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

// Re-export canonical constant-time comparison for use in this module.
// Implementation lives in src/crypto.ts — see there for security notes.
const timingSafeTokenCompare = timingSafeStringEqual;

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

// 500ms minimum between connections per client type.
// Tradeoff: multi-agent scenarios where two agents connect simultaneously may
// hit this limit; they will retry and connect successfully on the next attempt.
// Raised from 50ms to reduce connection-storm DoS surface in public deployments.
const MIN_CONNECTION_INTERVAL_MS = 500;

export class Server extends EventEmitter<ServerEvents> {
  private httpServer: http.Server;
  private wss: WsServer;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastClaudeConnectionTime = 0;
  private lastExtensionConnectionTime = 0;
  private startTime = Date.now();
  /** OAuth 2.0 Authorization Server — set via setOAuthServer() when running in remote mode */
  private oauthServer: OAuthServer | null = null;
  private oauthIssuerUrl: string | null = null;
  private sseSubscriberCount = 0;
  private static readonly MAX_SSE_SUBSCRIBERS = 20;

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

  /**
   * Attach an OAuth 2.0 Authorization Server.
   * When set, the bridge exposes:
   *   GET  /.well-known/oauth-authorization-server
   *   GET  /oauth/authorize
   *   POST /oauth/token
   *   POST /oauth/revoke
   * Bearer tokens issued via the OAuth flow are accepted in addition to the
   * static bridge token, enabling claude.ai's authenticated MCP server flow.
   */
  setOAuthServer(oauth: OAuthServer, issuerUrl: string): void {
    this.oauthServer = oauth;
    this.oauthIssuerUrl = issuerUrl;
  }

  /** Hosts accepted in the WebSocket upgrade Host header (DNS-rebinding guard). */
  private readonly allowedHosts: Set<string>;

  constructor(
    private authToken: string,
    private logger: Logger,
    private extraCorsOrigins: string[] = [],
  ) {
    super();
    // Defense-in-depth: ensure token is non-empty so timingSafeTokenCompare
    // cannot accept a blank Authorization header against an empty token.
    if (authToken.length === 0) {
      throw new Error("authToken must not be empty");
    }

    // Build the WS Host allowlist: loopback always allowed, plus hostnames
    // extracted from --cors-origin values so remote reverse-proxy deployments
    // (where the proxy forwards the real Host header) are not rejected.
    this.allowedHosts = new Set(LOOPBACK_HOSTS);
    for (const origin of extraCorsOrigins) {
      try {
        this.allowedHosts.add(new URL(origin).hostname);
      } catch {
        // ignore malformed origins — already validated at startup
      }
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

      // CORS — set on every response so browsers can read 401s and initiate OAuth
      const allowedOrigin = corsOrigin(
        req.headers.origin,
        this.extraCorsOrigins,
      );
      if (allowedOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
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

      const parsedUrl = new URL(req.url ?? "/", "http://localhost");

      // ── OAuth 2.0 endpoints (unauthenticated — handled before bearer check) ──

      // RFC 8414 discovery document
      if (
        parsedUrl.pathname === "/.well-known/oauth-authorization-server" &&
        req.method === "GET"
      ) {
        if (this.oauthServer) {
          this.oauthServer.handleDiscovery(res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // RFC 9396 Protected Resource Metadata — Claude.ai probes this to discover
      // which authorization server protects this resource. Both the bare and
      // resource-path variants are handled.
      if (
        req.method === "GET" &&
        (parsedUrl.pathname === "/.well-known/oauth-protected-resource" ||
          parsedUrl.pathname.startsWith(
            "/.well-known/oauth-protected-resource/",
          ))
      ) {
        if (this.oauthServer && this.oauthIssuerUrl) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(
            JSON.stringify({
              resource: this.oauthIssuerUrl,
              authorization_servers: [this.oauthIssuerUrl],
            }),
          );
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Authorization endpoint
      if (
        parsedUrl.pathname === "/oauth/authorize" &&
        (req.method === "GET" || req.method === "POST")
      ) {
        if (this.oauthServer) {
          this.oauthServer.handleAuthorize(req, res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Dynamic Client Registration endpoint (RFC 7591)
      if (parsedUrl.pathname === "/oauth/register") {
        if (this.oauthServer) {
          this.oauthServer.handleRegister(req, res).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Token endpoint
      if (parsedUrl.pathname === "/oauth/token" && req.method === "POST") {
        if (this.oauthServer) {
          this.oauthServer.handleToken(req, res).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("OAuth not configured");
        }
        return;
      }

      // Revocation endpoint (RFC 7009)
      if (parsedUrl.pathname === "/oauth/revoke" && req.method === "POST") {
        if (this.oauthServer) {
          this.oauthServer.handleRevoke(req, res).catch(() => {
            // RFC 7009: always 200
            if (!res.headersSent) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end("{}");
            }
          });
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
        return;
      }

      // ── MCP server-card (public) ──────────────────────────────────────────

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
          license: PACKAGE_LICENSE,
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
      if (req.method === "OPTIONS" && parsedUrl.pathname === "/mcp") {
        const origin = corsOrigin(req.headers.origin, this.extraCorsOrigins);
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

      // ── Bearer token authentication ───────────────────────────────────────
      // All other HTTP endpoints require a valid Bearer token.
      // Accepts either:
      //   (a) the bridge's static token (--fixed-token / generated on start), or
      //   (b) an OAuth 2.0 access token issued via /oauth/token (when oauthServer is set)
      const authHeader = req.headers.authorization ?? "";
      const bearerFromHeader = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";
      // ?token= query param support was removed — tokens in URLs appear in
      // HTTP access logs, proxy logs, and Referrer headers. Use the
      // Authorization: Bearer header exclusively.
      const bearer = bearerFromHeader;

      const isStaticToken = timingSafeTokenCompare(bearer, this.authToken);
      const oauthResolved =
        !isStaticToken && this.oauthServer
          ? this.oauthServer.resolveBearerToken(bearer)
          : null;
      // oauthResolved is the bridge token if the OAuth token is valid; null otherwise
      if (!isStaticToken && !oauthResolved) {
        // RFC 6750: only include error= when a token was actually presented but invalid
        const tokenPresented = bearer.length > 0;
        const wwwAuth =
          this.oauthServer && this.oauthIssuerUrl
            ? `Bearer realm="claude-ide-bridge", resource_metadata="${this.oauthIssuerUrl}/.well-known/oauth-protected-resource"${tokenPresented ? `, error="invalid_token"` : ""}`
            : `Bearer realm="claude-ide-bridge"${tokenPresented ? `, error="invalid_token"` : ""}`;
        res.writeHead(401, {
          "Content-Type": "text/plain",
          "WWW-Authenticate": wwwAuth,
        });
        res.end("Unauthorized");
        return;
      }

      if (parsedUrl.pathname === "/metrics" && req.method === "GET") {
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
        if (this.sseSubscriberCount >= Server.MAX_SSE_SUBSCRIBERS) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Too many SSE subscribers (max 20)" }),
          );
          return;
        }
        this.sseSubscriberCount++;
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
          this.sseSubscriberCount--;
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
      // Bearer auth is already checked above, so all requests here are authenticated.
      // The Mcp-Session-Id header routes to the correct session.
      // OPTIONS is handled before auth so CORS preflight works.
      if (parsedUrl.pathname === "/mcp" && this.httpMcpHandler) {
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
      if (!host || !this.allowedHosts.has(host)) {
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
