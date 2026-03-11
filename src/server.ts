import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { WebSocket, WebSocketServer as WsServer } from "ws";
import type { Logger } from "./logger.js";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

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

export interface ServerEvents {
  connection: [ws: WebSocket];
  extension: [ws: WebSocket];
}

function timingSafeTokenCompare(a: string, b: string): boolean {
  const bA = Buffer.from(a);
  const bB = Buffer.from(b);
  const len = Math.max(bA.length, bB.length);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bA.copy(padA);
  bB.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && bA.length === bB.length;
}

function setupPongHandler(ws: AliveWebSocket): void {
  ws.on("pong", (data: Buffer) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    const sentAt = Number.parseInt(data.toString(), 10);
    ws.lastPongTime = Number.isNaN(sentAt) ? Date.now() : sentAt;
  });
}

const MIN_CONNECTION_INTERVAL_MS = 50; // Allow multiple agents to connect within same second

export class Server extends EventEmitter {
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

  constructor(
    private authToken: string,
    private logger: Logger,
  ) {
    super();
    this.httpServer = http.createServer((req, res) => {
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

      // Validate Host header to defend against DNS rebinding
      const host = request.headers.host?.replace(/:\d+$/, "");
      if (!host || !ALLOWED_HOSTS.has(host)) {
        this.logger.warn(
          `Rejected connection with invalid Host header: ${host}`,
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
      this.logger.info("Claude Code connected");
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
        preferredPort = null;
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
