import * as fs from "fs";
import * as vscode from "vscode";
import WebSocket from "ws";

import {
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_DELAY,
  HANDLER_TIMEOUT,
  LOCK_DIR,
  EXTENSION_PROTOCOL_VERSION,
} from "./constants";
import type { LockFileData, RequestHandler } from "./types";
import { readLockFilesAsync } from "./lockfiles";

const enum ConnectionState {
  IDLE,
  CONNECTING,
  CONNECTED,
  DISCONNECTING,
}

export class BridgeConnection {
  ws: WebSocket | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  pendingDiagnosticUris: Set<string> = new Set();
  aiCommentsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  disposed = false;
  private state = ConnectionState.IDLE;
  reconnectDelay = RECONNECT_BASE_DELAY;
  lockWatcher: fs.FSWatcher | null = null;
  private lockPollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private pongHandler: (() => void) | null = null;
  private lastTickTime = Date.now();
  private reconnectAttempts = 0;
  statusBar: vscode.StatusBarItem | null = null;
  output: vscode.OutputChannel | null = null;

  private handlers: Record<string, RequestHandler> = {};
  private onDispose: (() => void) | null = null;
  private pendingNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  private static readonly MAX_PENDING_NOTIFICATIONS = 20;
  /** Notifications worth buffering during transient disconnects */
  private static readonly BUFFERABLE_METHODS = new Set([
    "extension/diagnosticsChanged",
    "extension/fileChanged",
    "extension/aiCommentsChanged",
  ]);

  setHandlers(handlers: Record<string, RequestHandler>): void {
    this.handlers = handlers;
  }

  setOnDispose(fn: () => void): void {
    this.onDispose = fn;
  }

  log(message: string): void {
    const line = `[Claude IDE Bridge] ${message}`;
    console.log(line);
    this.output?.appendLine(`${new Date().toISOString()} ${message}`);
  }

  logError(message: string): void {
    const line = `[Claude IDE Bridge] ${message}`;
    console.error(line);
    this.output?.appendLine(`${new Date().toISOString()} ERROR: ${message}`);
  }

  claudeConnected = false;

  private updateStatusBar(state: "connected" | "disconnected" | "reconnecting"): void {
    if (!this.statusBar) return;
    switch (state) {
      case "connected":
        if (this.claudeConnected) {
          this.statusBar.text = "$(check) Claude Bridge";
          this.statusBar.tooltip = "Claude IDE Bridge: Connected — Claude Code active";
        } else {
          this.statusBar.text = "$(plug) Claude Bridge";
          this.statusBar.tooltip = "Claude IDE Bridge: Connected — waiting for Claude Code";
        }
        break;
      case "disconnected":
        this.claudeConnected = false;
        this.statusBar.text = "$(debug-disconnect) Claude Bridge";
        this.statusBar.tooltip = "Claude IDE Bridge: Disconnected";
        break;
      case "reconnecting":
        this.claudeConnected = false;
        this.statusBar.text = "$(sync~spin) Claude Bridge";
        this.statusBar.tooltip = "Claude IDE Bridge: Reconnecting...";
        break;
    }
  }

  send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch {
        // Socket closed between readyState check and send
      }
    }
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Buffer important notifications during transient disconnects
      if (BridgeConnection.BUFFERABLE_METHODS.has(method)) {
        if (this.pendingNotifications.length >= BridgeConnection.MAX_PENDING_NOTIFICATIONS) {
          this.pendingNotifications.shift(); // Drop oldest
        }
        this.pendingNotifications.push({ method, params });
      }
      return;
    }
    this.send({ jsonrpc: "2.0", method, params });
  }

  private flushPendingNotifications(): void {
    const pending = this.pendingNotifications.splice(0);
    for (const { method, params } of pending) {
      this.send({ jsonrpc: "2.0", method, params });
    }
  }

  sendResponse(
    id: number | string,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    if (error) {
      this.send({ jsonrpc: "2.0", id, error });
    } else {
      this.send({ jsonrpc: "2.0", id, result });
    }
  }

  connect(lockData: LockFileData): void {
    if (this.disposed) return;

    const url = `ws://127.0.0.1:${lockData.port}`;
    this.ws = new WebSocket(url, {
      headers: { "x-claude-ide-extension": lockData.authToken },
      maxPayload: 4 * 1024 * 1024, // 4MB — match server-side limit
    });

    this.ws.on("open", () => {
      this.state = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      this.log("Connected to bridge");
      this.updateStatusBar("connected");
      this.reconnectDelay = RECONNECT_BASE_DELAY;
      this.startHeartbeat();
      this.send({
        jsonrpc: "2.0",
        method: "extension/hello",
        params: {
          extensionVersion: EXTENSION_PROTOCOL_VERSION,
          vscodeVersion: vscode.version,
        },
      });
      this.flushPendingNotifications();
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data.toString("utf-8"));
    });

    this.ws.on("close", () => {
      this.log("Disconnected from bridge");
      this.handleDisconnect();
    });

    this.ws.on("error", (err) => {
      this.logError(`Connection error: ${err.message}`);
      this.handleDisconnect();
    });

    this.ws.on("unexpected-response", (_req, res) => {
      this.logError(`Upgrade rejected: HTTP ${res.statusCode}`);
      this.ws?.terminate();
      this.state = ConnectionState.DISCONNECTING;
      this.scheduleReconnect();
    });
  }

  private handleDisconnect(): void {
    if (this.state === ConnectionState.DISCONNECTING) return;
    this.state = ConnectionState.DISCONNECTING;
    this.updateStatusBar("disconnected");
    const oldWs = this.ws;
    // Stop heartbeat before nulling ws so pong listener is removed from the socket
    this.stopHeartbeat();
    if (oldWs) {
      try { oldWs.removeAllListeners(); } catch { /* best-effort */ }
      try { oldWs.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pongReceived = true;
    this.lastTickTime = Date.now();
    this.pongHandler = () => { this.pongReceived = true; };
    this.ws?.on("pong", this.pongHandler);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastTickTime > 40_000) {
        this.log("Probable sleep/wake detected, checking connection");
        this.lastTickTime = now;
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.terminate();
          this.handleDisconnect();
          return;
        }
      }
      this.lastTickTime = now;

      if (!this.pongReceived) {
        this.log("Bridge unresponsive, forcing reconnect");
        this.ws?.terminate();
        this.handleDisconnect();
        return;
      }
      this.pongReceived = false;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongHandler && this.ws) {
      this.ws.removeListener("pong", this.pongHandler);
      this.pongHandler = null;
    }
  }

  scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectAttempts++;
    this.updateStatusBar("reconnecting");
    if (this.reconnectAttempts === 3) {
      vscode.window
        .showWarningMessage(
          "Claude IDE Bridge: Connection lost. Retrying...",
          "Show Logs",
        )
        .then((choice) => {
          if (choice === "Show Logs") this.output?.show();
        });
    }
    const baseDelay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY);
    const jitteredDelay = Math.round(500 + Math.random() * baseDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect();
    }, jitteredDelay);
  }

  tryConnect(): void {
    if (this.disposed || this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) return;
    this.state = ConnectionState.CONNECTING;
    readLockFilesAsync().then((lockData) => {
      if (this.disposed) { this.state = ConnectionState.IDLE; return; }
      if (lockData) {
        this.connect(lockData);
      } else {
        this.state = ConnectionState.DISCONNECTING;
        this.scheduleReconnect();
      }
    }).catch(() => {
      this.state = ConnectionState.DISCONNECTING;
      this.scheduleReconnect();
    });
  }

  handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      // Handle notifications (no id) from the bridge
      if (msg.method && msg.id === undefined) {
        if (msg.method === "bridge/claudeConnectionChanged") {
          const params = msg.params as { connected?: boolean } | undefined;
          this.claudeConnected = params?.connected === true;
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.updateStatusBar("connected");
          }
          this.log(`Claude Code ${this.claudeConnected ? "connected" : "disconnected"}`);
        }
        return;
      }

      if (msg.id !== undefined && msg.method) {
        const handler = this.handlers[msg.method as string];
        if (handler) {
          const controller = new AbortController();
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new Error("Handler timed out"));
            }, HANDLER_TIMEOUT);
          });
          Promise.race([handler(msg.params ?? {}, controller.signal), timeoutPromise])
            .then((result) => {
              clearTimeout(timeoutId);
              this.sendResponse(msg.id, result);
            })
            .catch((err: unknown) => {
              clearTimeout(timeoutId);
              const message = err instanceof Error ? err.message : String(err);
              this.sendResponse(msg.id, undefined, {
                code: -32000,
                message: message || "Unknown handler error",
              });
            });
        } else {
          this.sendResponse(msg.id, undefined, {
            code: -32601,
            message: `Unknown method: ${msg.method}`,
          });
        }
      }
    } catch (err) {
      this.logError(`Failed to handle message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  startWatchingLockDir(): void {
    try {
      if (!fs.existsSync(LOCK_DIR)) {
        fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
      }
      this.lockWatcher = fs.watch(LOCK_DIR, (_event, filename) => {
        if (!filename?.endsWith(".lock")) return;
        if (this.disposed) return;
        if (this.ws?.readyState === WebSocket.OPEN) return;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // Only reset backoff if we were deeply backed off (lock file appearance
        // suggests a fresh bridge). Cap at base delay rather than resetting to
        // zero to avoid reconnect storms during bridge crash loops.
        this.reconnectDelay = Math.min(this.reconnectDelay, RECONNECT_BASE_DELAY * 2);
        setTimeout(() => this.tryConnect(), 200);
      });
      this.lockWatcher.on("error", () => {
        this.lockWatcher = null;
        this.startLockPolling();
      });
    } catch {
      this.startLockPolling();
    }
  }

  private startLockPolling(): void {
    if (this.lockPollTimer) return;
    this.lockPollTimer = setInterval(() => {
      if (this.disposed) {
        clearInterval(this.lockPollTimer!);
        this.lockPollTimer = null;
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) return;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectDelay = RECONNECT_BASE_DELAY;
      this.tryConnect();
    }, 5000);
  }

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    if (this.lockWatcher) {
      this.lockWatcher.close();
      this.lockWatcher = null;
    }
    if (this.lockPollTimer) {
      clearInterval(this.lockPollTimer);
      this.lockPollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
      this.selectionDebounceTimer = null;
    }
    if (this.diagnosticsDebounceTimer) {
      clearTimeout(this.diagnosticsDebounceTimer);
      this.diagnosticsDebounceTimer = null;
    }
    if (this.aiCommentsDebounceTimer) {
      clearTimeout(this.aiCommentsDebounceTimer);
      this.aiCommentsDebounceTimer = null;
    }
    this.onDispose?.();
    if (this.ws) {
      this.ws.close(1000, "Extension deactivating");
      this.ws = null;
    }
  }
}
