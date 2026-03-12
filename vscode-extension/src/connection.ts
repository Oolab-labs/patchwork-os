import * as fs from "node:fs";
import * as vscode from "vscode";
import WebSocket from "ws";

import {
  EXTENSION_PROTOCOL_VERSION,
  HANDLER_TIMEOUT,
  LOCK_DIR,
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_DELAY,
} from "./constants";
import { readLockFilesAsync } from "./lockfiles";
import type { LockFileData, RequestHandler } from "./types";

enum ConnectionState {
  IDLE = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  DISCONNECTING = 3,
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
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
  private connecting = false;
  reconnectDelay = RECONNECT_BASE_DELAY;
  lockWatcher: fs.FSWatcher | null = null;
  private lockPollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongHandler: (() => void) | null = null;
  private lastBridgePong = Date.now();
  private lastTickTime = Date.now();
  private reconnectAttempts = 0;
  /** Monotonically increasing generation — prevents stale listeners from acting */
  private generation = 0;
  statusBar: vscode.StatusBarItem | null = null;
  output: vscode.OutputChannel | null = null;
  logLevel = "info";
  /** Override the lock file directory (empty string = use default LOCK_DIR) */
  lockDirOverride = "";

  private handlers: Record<string, RequestHandler> = {};
  private onDispose: (() => void) | null = null;
  private pendingNotifications: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  private pendingHandlers: Map<
    number | string,
    { timeout: ReturnType<typeof setTimeout>; controller: AbortController }
  > = new Map();
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

  /** Resolved lock directory — prefers override, falls back to default */
  get lockDir(): string {
    return this.lockDirOverride || LOCK_DIR;
  }

  log(message: string): void {
    const line = `[Claude IDE Bridge] ${message}`;
    console.log(line);
    this.output?.appendLine(`${new Date().toISOString()} ${message}`);
  }

  logDebug(message: string): void {
    if (this.logLevel !== "debug") return;
    const line = `[Claude IDE Bridge] ${message}`;
    console.log(line);
    this.output?.appendLine(`${new Date().toISOString()} DEBUG: ${message}`);
  }

  logError(message: string): void {
    const line = `[Claude IDE Bridge] ${message}`;
    console.error(line);
    this.output?.appendLine(`${new Date().toISOString()} ERROR: ${message}`);
  }

  claudeConnected = false;

  private updateStatusBar(
    state: "connected" | "disconnected" | "reconnecting",
  ): void {
    if (!this.statusBar) return;
    switch (state) {
      case "connected":
        if (this.claudeConnected) {
          this.statusBar.text = "$(check) Claude Bridge";
          this.statusBar.tooltip =
            "Claude IDE Bridge: Connected — Claude Code active";
        } else {
          this.statusBar.text = "$(plug) Claude Bridge";
          this.statusBar.tooltip =
            "Claude IDE Bridge: Connected — waiting for Claude Code";
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
      } catch (err) {
        this.logError(
          `Send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Buffer important notifications during transient disconnects
      if (BridgeConnection.BUFFERABLE_METHODS.has(method)) {
        if (
          this.pendingNotifications.length >=
          BridgeConnection.MAX_PENDING_NOTIFICATIONS
        ) {
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

    // Clean up any in-flight WebSocket from a concurrent tryConnect() to
    // prevent orphaned sockets (e.g. double-clicking "Reconnect").
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch {
        /* best-effort */
      }
      try {
        this.ws.terminate();
      } catch {
        /* best-effort */
      }
      this.ws = null;
    }

    // Re-assert CONNECTING state before creating the WebSocket. This makes connect()
    // self-guarding: if state drifted to DISCONNECTING while tryConnect() was awaiting
    // readLockFilesAsync (e.g. due to a concurrent ws error), a second tryConnect()
    // that fires after connecting=false is cleared but before the "open" event will
    // be blocked by the state=CONNECTING guard in tryConnect().
    this.state = ConnectionState.CONNECTING;

    // Increment generation so any stale listener callbacks from a previous
    // connect() call self-discard instead of acting on the new socket.
    const gen = ++this.generation;

    const url = `ws://127.0.0.1:${lockData.port}`;
    this.ws = new WebSocket(url, {
      headers: { "x-claude-ide-extension": lockData.authToken },
      maxPayload: 4 * 1024 * 1024, // 4MB — match server-side limit
    });

    // If the WebSocket handshake never completes, force a reconnect after 30s
    // to avoid hanging silently in CONNECTING state indefinitely.
    const openTimeout = setTimeout(() => {
      if (gen !== this.generation) return;
      this.log(
        "WebSocket handshake timed out (30s) — bridge may still be starting up, will retry",
      );
      this.ws?.terminate();
      this.handleDisconnect();
    }, 30_000);

    this.ws.on("open", () => {
      clearTimeout(openTimeout);
      if (gen !== this.generation) return;
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
      if (gen !== this.generation) return;
      this.handleMessage(data.toString("utf-8"));
    });

    this.ws.on("close", () => {
      clearTimeout(openTimeout);
      if (gen !== this.generation) return;
      this.log("Disconnected from bridge");
      this.handleDisconnect();
    });

    this.ws.on("error", (err) => {
      clearTimeout(openTimeout);
      if (gen !== this.generation) return;
      this.logError(`Connection error: ${err.message}`);
      this.handleDisconnect();
    });

    this.ws.on("unexpected-response", (_req, res) => {
      clearTimeout(openTimeout);
      if (gen !== this.generation) return;
      const hint =
        res.statusCode === 401
          ? " — auth token mismatch; try reloading the window"
          : res.statusCode === 403
            ? " — Host header rejected; bridge may be on a different interface"
            : res.statusCode === 429
              ? " — too many connections; another VS Code window may already be connected"
              : "";
      this.logError(`Upgrade rejected: HTTP ${res.statusCode}${hint}`);
      // Use handleDisconnect() for full cleanup (heartbeat, pending handlers,
      // listener removal, status bar). Must call BEFORE setting DISCONNECTING
      // state so the re-entrancy guard doesn't skip cleanup.
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    if (this.state === ConnectionState.DISCONNECTING) return;
    this.state = ConnectionState.DISCONNECTING;
    this.updateStatusBar("disconnected");
    // Cancel all pending handler timeouts and abort controllers
    for (const [, pending] of this.pendingHandlers) {
      clearTimeout(pending.timeout);
      pending.controller.abort();
    }
    this.pendingHandlers.clear();
    // Clear debounce timers to release closures referencing VS Code API objects
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
    this.pendingDiagnosticUris.clear();
    const oldWs = this.ws;
    // Stop heartbeat before nulling ws so pong listener is removed from the socket
    this.stopHeartbeat();
    if (oldWs) {
      try {
        oldWs.removeAllListeners();
      } catch {
        /* best-effort */
      }
      try {
        oldWs.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastBridgePong = Date.now();
    this.lastTickTime = Date.now();
    this.pongHandler = () => {
      this.lastBridgePong = Date.now();
    };
    this.ws?.on("pong", this.pongHandler);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastTickTime > 60_000) {
        this.log("Probable sleep/wake detected, checking connection");
        this.lastTickTime = now;
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.terminate();
          this.handleDisconnect();
          return;
        }
        // After sleep/wake, reset pong baseline to give bridge time to recover
        this.lastBridgePong = now;
      }
      this.lastTickTime = now;
      // Bridge pings every 30s; terminates after 3 missed pongs (90s).
      // Extension waits 120s so bridge always cleans up first on true failure.
      if (now - this.lastBridgePong > 120_000) {
        this.log("Bridge unresponsive (no pong in 120s), forcing reconnect");
        this.ws?.terminate();
        this.handleDisconnect();
        return;
      }
    }, 45_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongHandler) {
      this.ws?.removeListener("pong", this.pongHandler);
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
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      RECONNECT_MAX_DELAY,
    );
    const jitteredDelay = Math.round(500 + Math.random() * baseDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect();
    }, jitteredDelay);
  }

  forceReconnect(): void {
    if (this.disposed) return;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch {
        /* best-effort */
      }
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.connecting = false;
    this.state = ConnectionState.IDLE;
    this.tryConnect();
  }

  tryConnect(): void {
    if (
      this.disposed ||
      this.state === ConnectionState.CONNECTING ||
      this.state === ConnectionState.CONNECTED
    )
      return;
    if (this.connecting) return;
    this.connecting = true;
    this.state = ConnectionState.CONNECTING;
    readLockFilesAsync(this.lockDirOverride || undefined)
      .then((lockData) => {
        this.connecting = false;
        if (this.disposed) {
          this.state = ConnectionState.IDLE;
          return;
        }
        if (lockData) {
          this.connect(lockData);
        } else {
          this.state = ConnectionState.DISCONNECTING;
          this.scheduleReconnect();
        }
      })
      .catch((err: unknown) => {
        this.connecting = false;
        this.log(
          `Lock file read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
          const params = msg.params as
            | {
                connected?: boolean;
                stats?: {
                  callCount: number;
                  errorCount: number;
                  durationMs: number;
                };
              }
            | undefined;
          this.claudeConnected = params?.connected === true;
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.updateStatusBar("connected");
          }
          this.log(
            `Claude Code ${this.claudeConnected ? "connected" : "disconnected"}`,
          );
          if (!this.claudeConnected && params?.stats !== undefined) {
            const { callCount, errorCount, durationMs } = params.stats;
            const errorPart =
              errorCount > 0
                ? `, ${errorCount} error${errorCount === 1 ? "" : "s"}`
                : "";
            const notification = `Claude session ended — ${callCount} tool${callCount === 1 ? "" : "s"}${errorPart}, ${formatDuration(durationMs)}`;
            vscode.window
              .showInformationMessage(notification, "Show Logs")
              .then((choice) => {
                if (choice === "Show Logs") this.output?.show();
              })
              .catch(() => {
                /* best-effort */
              });
          }
        }
        return;
      }

      if (msg.id !== undefined && msg.method) {
        // Validate id type before using as Map key — malformed ids cause [object Object] collisions
        if (typeof msg.id !== "string" && typeof msg.id !== "number") {
          return;
        }
        if (this.pendingHandlers.size >= 50) {
          this.sendResponse(msg.id, undefined, {
            code: -32000,
            message: "Too many pending handlers — try again later",
          });
          return;
        }
        const handler = this.handlers[msg.method as string];
        if (handler) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            controller.abort();
          }, HANDLER_TIMEOUT);
          this.pendingHandlers.set(msg.id, { timeout: timeoutId, controller });
          const cleanup = () => {
            clearTimeout(timeoutId);
            this.pendingHandlers.delete(msg.id);
          };
          const timeoutPromise = new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("Handler timed out")),
              { once: true },
            );
          });
          const handlerGen = this.generation;
          Promise.race([
            handler(msg.params ?? {}, controller.signal),
            timeoutPromise,
          ])
            .then((result) => {
              cleanup();
              // Guard against sending responses after disconnect/reconnect —
              // if generation changed, the socket is gone or belongs to a new connection
              if (handlerGen !== this.generation) return;
              this.sendResponse(msg.id, result);
            })
            .catch((err: unknown) => {
              cleanup();
              if (handlerGen !== this.generation) return;
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
      this.logError(
        `Failed to handle message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  startWatchingLockDir(): void {
    const dir = this.lockDir;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      this.lockWatcher = fs.watch(dir, (_event, filename) => {
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
        this.reconnectDelay = Math.min(
          this.reconnectDelay,
          RECONNECT_BASE_DELAY * 2,
        );
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
