import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { ActivityLog } from "./activityLog.js";
import type { Config } from "./config.js";
import { ExtensionClient } from "./extensionClient.js";
import { FileLock } from "./fileLock.js";
import { LockFileManager } from "./lockfile.js";
import { Logger } from "./logger.js";
import type { ProbeResults } from "./probe.js";
import { probeAll } from "./probe.js";
import { Server } from "./server.js";
import { type CheckpointData, SessionCheckpoint } from "./sessionCheckpoint.js";
import { registerAllTools } from "./tools/index.js";
import { cleanupTempDirs } from "./tools/openDiff.js";
import { McpTransport } from "./transport.js";

const SHUTDOWN_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 5;
let globalHandlersRegistered = false;

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

interface AgentSession {
  id: string;
  ws: WebSocket;
  transport: McpTransport;
  openedFiles: Set<string>;
  terminalPrefix: string;
  graceTimer: ReturnType<typeof setTimeout> | null;
  connectedAt: number;
}

export class Bridge {
  private logger: Logger;
  private lockFile: LockFileManager;
  private server: Server;
  private extensionClient: ExtensionClient;
  private activityLog: ActivityLog;
  private authToken: string;
  private sessions = new Map<string, AgentSession>();
  private fileLock = new FileLock();
  private probes: ProbeResults | null = null;
  private ready = false;
  private stopped = false;
  private listChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectAt: string | null = null;
  private lastDisconnectAt: string | null = null;
  private checkpoint: SessionCheckpoint | null = null;

  constructor(private config: Config) {
    this.logger = new Logger(config.verbose, config.jsonl);
    this.lockFile = new LockFileManager(this.logger);
    this.authToken = randomUUID();
    this.server = new Server(this.authToken, this.logger);
    this.activityLog = new ActivityLog();
    this.extensionClient = new ExtensionClient(this.logger);

    // Handle new Claude Code connections
    this.server.on("connection", (ws: WebSocket) => {
      // Reject connections before probes are ready
      if (!this.ready) {
        this.logger.warn("Connection rejected — bridge not ready yet");
        ws.close(1013, "Bridge not ready");
        return;
      }
      // Reject connections beyond capacity (grace-period sessions don't count)
      const activeSessionCount = [...this.sessions.values()].filter(
        (s) => !s.graceTimer,
      ).length;
      if (activeSessionCount >= MAX_SESSIONS) {
        this.logger.warn(
          `Session capacity reached (${MAX_SESSIONS} active). Rejecting connection.`,
        );
        ws.close(1013, "Bridge at capacity");
        return;
      }

      const sessionId = randomUUID();
      const transport = new McpTransport(this.logger);
      transport.setActivityLog(this.activityLog);
      transport.setExtensionConnectedFn(() =>
        this.extensionClient.isConnected(),
      );

      const session: AgentSession = {
        id: sessionId,
        ws,
        transport,
        openedFiles: new Set(),
        terminalPrefix: `s${sessionId.slice(0, 8)}-`,
        graceTimer: null,
        connectedAt: Date.now(),
      };

      // Register tools for this session — probes guaranteed non-null due to ready guard above
      const probes = this.probes ?? ({} as ProbeResults);
      registerAllTools(
        transport,
        this.config,
        session.openedFiles,
        probes,
        this.extensionClient,
        this.activityLog,
        session.terminalPrefix,
        this.fileLock,
        this.sessions,
      );

      transport.attach(ws);
      this.sessions.set(sessionId, session);
      this.logger.info(
        `Claude Code connected (session ${sessionId.slice(0, 8)}) — ${this.sessions.size} active session${this.sessions.size === 1 ? "" : "s"}`,
      );
      this.lastConnectAt = new Date().toISOString();
      this.activityLog.recordEvent("claude_connected", {
        sessionId: sessionId.slice(0, 8),
        activeSessions: this.sessions.size,
      });
      this.logger.event("claude_connected", {
        sessionId,
        activeSessions: this.sessions.size,
      });
      // Only notify on the first active session — subsequent agents don't need to re-signal
      if (this.sessions.size === 1) {
        this.extensionClient.notifyClaudeConnectionState(true);
      }

      ws.on("close", () => {
        this.lastDisconnectAt = new Date().toISOString();
        this.logger.info(
          `Claude Code disconnected (session ${sessionId.slice(0, 8)})`,
        );
        this.activityLog.recordEvent("claude_disconnected", {
          sessionId: sessionId.slice(0, 8),
        });
        this.logger.event("claude_disconnected", { sessionId });
        const s = this.sessions.get(sessionId);
        if (s && !s.graceTimer) {
          s.graceTimer = setTimeout(() => {
            this.cleanupSession(sessionId);
          }, this.config.gracePeriodMs);
          this.activityLog.recordEvent("grace_started", {
            sessionId: sessionId.slice(0, 8),
            gracePeriodMs: this.config.gracePeriodMs,
          });
          this.logger.info(
            `Grace period started for session ${sessionId.slice(0, 8)} (${this.config.gracePeriodMs / 1000}s)`,
          );
        }
      });

      ws.on("error", (err) => {
        this.logger.error(
          `WebSocket error (session ${sessionId.slice(0, 8)}): ${err.message}`,
        );
        const s = this.sessions.get(sessionId);
        if (s && !s.graceTimer) {
          s.graceTimer = setTimeout(() => {
            this.cleanupSession(sessionId);
          }, this.config.gracePeriodMs);
          this.activityLog.recordEvent("grace_started", {
            sessionId: sessionId.slice(0, 8),
            gracePeriodMs: this.config.gracePeriodMs,
            reason: "ws_error",
          });
          this.logger.info(
            `Grace period started for session ${sessionId.slice(0, 8)} (${this.config.gracePeriodMs / 1000}s) due to ws error`,
          );
        }
      });
    });

    // Debounced tools/list_changed notification — max one per 2 seconds
    const sendListChanged = () => {
      if (this.stopped) return; // Don't fire after stop()
      if (this.listChangedTimer) return; // Already scheduled
      this.listChangedTimer = setTimeout(() => {
        this.listChangedTimer = null;
        for (const session of this.sessions.values()) {
          if (session.ws.readyState === WebSocket.OPEN) {
            McpTransport.sendNotification(
              session.ws,
              "notifications/tools/list_changed",
              undefined,
              this.logger,
            );
          }
        }
      }, 2000);
    };

    // Handle VS Code extension connections — notify Claude immediately (no debounce)
    // so it re-queries capabilities and discovers LSP/terminal/selection are now available.
    this.server.on("extension", (ws: WebSocket) => {
      this.logger.info(
        "VS Code extension connected — LSP, terminal, and editor tools now available",
      );
      this.activityLog.recordEvent("extension_connected");
      this.logger.event("extension_connected");
      this.extensionClient.handleExtensionConnection(ws);
      // Refresh workspace folders from extension (multi-root workspace support)
      this.extensionClient
        .getWorkspaceFolders()
        .then((folders) => {
          if (folders && folders.length > 0) {
            this.config.workspaceFolders = folders.map((f) => f.path);
            this.logger.info(
              `Workspace folders: ${this.config.workspaceFolders.join(", ")}`,
            );
            // Broadcast to all active sessions
            for (const session of this.sessions.values()) {
              if (session.ws.readyState === WebSocket.OPEN) {
                McpTransport.sendNotification(
                  session.ws,
                  "notifications/tools/list_changed",
                  undefined,
                  this.logger,
                );
              }
            }
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `getWorkspaceFolders failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      // Immediate list_changed to all active sessions
      for (const session of this.sessions.values()) {
        if (session.ws.readyState === WebSocket.OPEN) {
          McpTransport.sendNotification(
            session.ws,
            "notifications/tools/list_changed",
            undefined,
            this.logger,
          );
        }
      }
    });

    // Notify Claude when extension disconnects so it knows to fall back to CLI/grep mode
    this.extensionClient.onExtensionDisconnected = () => {
      this.logger.info(
        "VS Code extension disconnected — falling back to file-system tools only",
      );
      this.activityLog.recordEvent("extension_disconnected");
      this.logger.event("extension_disconnected_notify");
      sendListChanged();
    };

    // Forward diagnostics changes from extension to Claude Code
    this.extensionClient.onDiagnosticsChanged = (_file) => {
      this.logger.event("diagnostics_changed", { file: _file });
      sendListChanged();
    };

    // Forward AI comment changes from extension to Claude Code
    this.extensionClient.onAICommentsChanged = (_comments) => {
      this.logger.event("ai_comments_changed", { count: _comments.length });
      sendListChanged();
    };

    // Forward file change notifications from extension to Claude Code
    this.extensionClient.onFileChanged = (id, type, file) => {
      this.logger.event("file_changed", { id, type, file });
      sendListChanged();
    };

    // Forward debug session changes from extension to Claude Code
    this.extensionClient.onDebugSessionChanged = (_state) => {
      this.logger.event("debug_session_changed");
      sendListChanged();
    };
  }

  private _buildCheckpoint(port: number): CheckpointData {
    const sessions = [];
    for (const s of this.sessions.values()) {
      sessions.push({
        id: s.id.slice(0, 8),
        connectedAt: s.connectedAt,
        openedFiles: [...s.openedFiles],
        terminalPrefix: s.terminalPrefix,
        inGrace: s.graceTimer !== null,
      });
    }
    return {
      port,
      savedAt: Date.now(),
      sessions,
      extensionConnected: this.extensionClient.isConnected(),
      gracePeriodMs: this.config.gracePeriodMs,
    };
  }

  private cleanupSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      this.activityLog.recordEvent("grace_expired", {
        sessionId: id.slice(0, 8),
      });
    }
    // Read stats before detach() — counters survive detach
    const { callCount, errorCount } = session.transport.getStats();
    const durationMs = Date.now() - session.connectedAt;
    session.transport.detach();
    session.openedFiles.clear();
    this.sessions.delete(id);

    const errorPart =
      errorCount > 0
        ? ` (${errorCount} error${errorCount === 1 ? "" : "s"})`
        : "";
    this.logger.info(
      `Session ${id.slice(0, 8)} done — ${callCount} tool call${callCount === 1 ? "" : "s"}${errorPart}, ${formatDuration(durationMs)}`,
    );
    if (this.sessions.size === 0) {
      this.logger.info("Bridge idle — waiting for next connection");
      // Only notify for normal disconnects; stop() sends its own aggregate notification
      if (!this.stopped) {
        this.extensionClient.notifyClaudeConnectionState(false, {
          callCount,
          errorCount,
          durationMs,
        });
      }
    } else {
      this.logger.info(`Active sessions: ${this.sessions.size}`);
    }
  }

  async start(): Promise<void> {
    // 1. Probe available CLI tools
    this.probes = await probeAll();
    this.ready = true;
    const probes = this.probes;
    const probeList = (keys?: string[]) =>
      Object.entries(probes)
        .filter(([k, v]) => v && (!keys || keys.includes(k)))
        .map(([k]) => k)
        .join(", ") || "none";
    this.logger.info(`Probed tools: ${probeList()}`);
    this.logger.info(
      `Available linters: ${probeList(["tsc", "eslint", "pyright", "ruff", "cargo", "go", "biome"])}`,
    );
    this.logger.info(
      `Available test runners: ${probeList(["vitest", "jest", "pytest", "cargo", "go"])}`,
    );

    // 2. Wire up /health endpoint data and /metrics
    this.server.healthDataFn = () => {
      let sessionsInGrace = 0;
      for (const s of this.sessions.values()) {
        if (s.graceTimer) sessionsInGrace++;
      }
      return {
        claudeCode: this.sessions.size > 0,
        activeSessions: this.sessions.size,
        sessionsInGrace,
        gracePeriodMs: this.config.gracePeriodMs,
        lastConnectAt: this.lastConnectAt,
        lastDisconnectAt: this.lastDisconnectAt,
        extension: this.extensionClient.isConnected(),
        extensionCircuitBreaker: this.extensionClient.getCircuitBreakerState(),
        recentActivity: this.activityLog.query({ last: 10 }),
      };
    };
    this.server.metricsFn = () => this.activityLog.toPrometheus();
    this.server.statusFn = () => {
      let sessionsInGrace = 0;
      const sessionList: Record<string, unknown>[] = [];
      for (const s of this.sessions.values()) {
        if (s.graceTimer) sessionsInGrace++;
        sessionList.push({
          id: s.id.slice(0, 8),
          connectedAt: new Date(s.connectedAt).toISOString(),
          inGrace: s.graceTimer !== null,
          openedFiles: s.openedFiles.size,
          terminalPrefix: s.terminalPrefix,
        });
      }
      return {
        claudeCode: this.sessions.size > 0,
        activeSessions: this.sessions.size,
        sessionsInGrace,
        gracePeriodMs: this.config.gracePeriodMs,
        lastConnectAt: this.lastConnectAt,
        lastDisconnectAt: this.lastDisconnectAt,
        sessions: sessionList,
        extension: this.extensionClient.isConnected(),
        extensionCircuitBreaker: this.extensionClient.getCircuitBreakerState(),
        timeline: this.activityLog.queryTimeline({ last: 50 }),
      };
    };

    // 3. Check for stale lock files
    this.lockFile.cleanStale();

    // 4. Find port and start server
    const port = await this.server.findAndListen(
      this.config.port,
      this.config.bindAddress,
    );

    // 5. Enable activity log disk persistence
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    this.activityLog.setPersistPath(
      path.join(configDir, "ide", `activity-${port}.jsonl`),
    );

    // 6. Check for recent checkpoint from previous run and log summary
    const prevCheckpoint = SessionCheckpoint.loadLatest();
    if (prevCheckpoint) {
      const ageSec = Math.round((Date.now() - prevCheckpoint.savedAt) / 1000);
      this.logger.info(
        `Previous session checkpoint found (${ageSec}s ago, port ${prevCheckpoint.port}):`,
      );
      this.logger.info(
        `  ${prevCheckpoint.sessions.length} session(s), ${prevCheckpoint.sessions.reduce((n, s) => n + s.openedFiles.length, 0)} tracked file(s)`,
      );
      if (prevCheckpoint.sessions.length > 0) {
        for (const s of prevCheckpoint.sessions) {
          this.logger.info(
            `  Session ${s.id}: ${s.openedFiles.length} file(s) — prefix: ${s.terminalPrefix}`,
          );
        }
      }
    }

    // 7. Write lock file
    const lockPath = this.lockFile.write(
      port,
      this.authToken,
      [this.config.workspace],
      this.config.ideName,
    );

    // 8. Start session checkpoint (write every 30s)
    this.checkpoint = new SessionCheckpoint(port);
    this.checkpoint.start(() => this._buildCheckpoint(port));

    // Register shutdown handlers
    let shuttingDown = false;
    const shutdown = async (signal: string, exitCode: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      this.logger.info(`Shutdown initiated by ${signal}`);
      const forceTimer = setTimeout(() => {
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceTimer.unref();
      await this.stop();
      process.exit(exitCode);
    };
    process.once("SIGINT", () => shutdown("SIGINT", 130));
    process.once("SIGTERM", () => shutdown("SIGTERM", 143));
    process.once("SIGHUP", () => shutdown("SIGHUP", 143));

    // Catch unhandled rejections and exceptions to prevent silent crashes
    // Guard against accumulating handlers across multiple start() calls.
    if (!globalHandlersRegistered) {
      globalHandlersRegistered = true;
      process.on("unhandledRejection", (reason) => {
        this.logger.error(
          `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
        );
      });
      process.once("uncaughtException", (err) => {
        this.logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
        shutdown("uncaughtException", 1);
      });
    }

    // Startup banner to stderr (not stdout) to avoid capture by parent processes
    this.logger.info("claude-ide-bridge ready");
    this.logger.info(`  Port:       ${port}`);
    this.logger.info(`  Workspace:  ${this.config.workspace}`);
    this.logger.info(`  Editor:     ${this.config.ideName || "none"}`);
    this.logger.info(`  Lock file:  ${lockPath}`);
    this.logger.info("  Connect:    run `claude` in a new terminal, then /ide");
    if (this.config.gracePeriodMs !== 30_000) {
      this.logger.info(
        `  Grace:      ${this.config.gracePeriodMs / 1000}s reconnect window`,
      );
    }
    if (
      !process.env.TMUX &&
      !process.env.STY &&
      !process.env.ZELLIJ &&
      !process.env.ZELLIJ_SESSION_NAME
    ) {
      this.logger.warn(
        "WARNING: Not running inside tmux, screen, or zellij. SSH disconnection will kill this process.",
      );
      this.logger.warn(
        "  Recommended: use 'npm run start-all' or wrap in tmux/screen.",
      );
    }
    this.logger.event("bridge_started", {
      port,
      workspace: this.config.workspace,
      editor: this.config.editorCommand,
    });
    if (this.config.verbose) {
      this.logger.debug(
        `Resolved config: ${JSON.stringify({
          workspace: this.config.workspace,
          editor: this.config.editorCommand,
          linters: this.config.linters,
          commandTimeout: this.config.commandTimeout,
          maxResultSize: this.config.maxResultSize,
          commandAllowlist: this.config.commandAllowlist,
        })}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info("Shutting down...");
    if (this.listChangedTimer) {
      clearTimeout(this.listChangedTimer);
      this.listChangedTimer = null;
    }
    // Snapshot aggregate stats before cleanup removes sessions from the map
    let totalSessions = 0;
    let totalCalls = 0;
    let totalErrors = 0;
    let maxDurationMs = 0;
    for (const session of this.sessions.values()) {
      totalSessions++;
      const stats = session.transport.getStats();
      totalCalls += stats.callCount;
      totalErrors += stats.errorCount;
      maxDurationMs = Math.max(maxDurationMs, Date.now() - session.connectedAt);
    }
    // Clean up all active sessions (cleanupSession skips the extension notification
    // during shutdown because this.stopped is already true)
    for (const id of [...this.sessions.keys()]) {
      this.cleanupSession(id);
    }
    const shutdownErrorPart =
      totalErrors > 0
        ? `, ${totalErrors} error${totalErrors === 1 ? "" : "s"}`
        : "";
    this.logger.info(
      `Shutdown complete — ${totalSessions} session${totalSessions === 1 ? "" : "s"}, ${totalCalls} tool call${totalCalls === 1 ? "" : "s"}${shutdownErrorPart}`,
    );
    // Send aggregate session-end notification to the extension before disconnecting
    if (totalSessions > 0) {
      this.extensionClient.notifyClaudeConnectionState(false, {
        callCount: totalCalls,
        errorCount: totalErrors,
        durationMs: maxDurationMs,
      });
    }
    this.extensionClient.disconnect();
    // Clear any listChanged timer that may have been set during concurrent extension disconnect
    if (this.listChangedTimer) {
      clearTimeout(this.listChangedTimer);
      this.listChangedTimer = null;
    }
    try {
      await this.server.close();
    } catch {
      // Server may already be closed
    }
    this.lockFile.delete();
    this.checkpoint?.stop();
    cleanupTempDirs();
  }
}
