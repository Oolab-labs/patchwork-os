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
}

function enableTcpKeepalive(ws: WebSocket): void {
  const rawSocket = (ws as unknown as { _socket?: import("net").Socket })._socket;
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
  if (bA.length !== bB.length) return false;
  return crypto.timingSafeEqual(bA, bB);
}

function setupPongHandler(ws: AliveWebSocket): void {
  ws.on("pong", (data: Buffer) => {
    ws.isAlive = true;
    ws.missedPongs = 0;
    const sentAt = parseInt(data.toString(), 10);
    if (!isNaN(sentAt)) {
      ws.lastPongTime = Date.now();
    }
  });
}

const MIN_CONNECTION_INTERVAL_MS = 1000;

export class Server extends EventEmitter {
  private httpServer: http.Server;
  private wss: WsServer;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastConnectionTime = 0;
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
        const body = this.metricsFn?.() ?? "";
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(body);
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        const data = {
          status: "ok",
          uptimeMs: Date.now() - this.startTime,
          connections: this.wss.clients.size,
          ...(this.healthDataFn?.() ?? {}),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    // Do NOT pass server — we handle upgrade manually for pre-handshake auth
    this.wss = new WsServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });

    // Authenticate on upgrade BEFORE completing the WebSocket handshake
    this.httpServer.on("upgrade", (request, socket, head) => {
      // Prevent unhandled error events on the raw socket during upgrade
      socket.on("error", () => socket.destroy());

      // Rate limit connections to prevent connection-storm DoS
      const now = Date.now();
      if (now - this.lastConnectionTime < MIN_CONNECTION_INTERVAL_MS) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }
      this.lastConnectionTime = now;

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

      // Check for extension connection (distinct header)
      const extensionToken = request.headers["x-claude-ide-extension"];
      if (
        typeof extensionToken === "string" &&
        timingSafeTokenCompare(extensionToken, this.authToken)
      ) {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          const alive = ws as AliveWebSocket;
          alive.isAlive = true;
          alive.missedPongs = 0;
          alive.lastPongTime = Date.now();
          enableTcpKeepalive(ws);
          setupPongHandler(alive);
          this.emit("extension", ws);
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
            reject(new Error("Unexpected server address"));
            return;
          }
          // Ping clients every 15s; terminate after 2 missed pongs (30s tolerance)
          this.pingInterval = setInterval(() => {
            for (const raw of this.wss.clients) {
              const client = raw as AliveWebSocket;
              if (!client.isAlive) {
                client.missedPongs = (client.missedPongs ?? 0) + 1;
                if (client.missedPongs >= 2) {
                  this.logger.warn("Terminating unresponsive client (2 missed pongs)");
                  client.terminate();
                  continue;
                }
              }
              client.isAlive = false;
              if (client.readyState === WebSocket.OPEN) {
                client.ping(Buffer.from(Date.now().toString()));
              }
            }
          }, 15000);
          resolve(addr.port);
        })
        .on("error", reject);
    });
  }

  async findAndListen(preferredPort: number | null, bindAddress = "127.0.0.1"): Promise<number> {
    if (preferredPort) {
      return this.listen(preferredPort, bindAddress);
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
    await new Promise<void>((resolve) => {
      this.httpServer.close((err) => {
        if (err) this.logger.error(`HTTP server close error: ${err.message}`);
        resolve();
      });
    });
  }
}
