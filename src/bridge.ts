import { randomUUID } from "node:crypto";
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
import { registerAllTools } from "./tools/index.js";
import { cleanupTempDirs } from "./tools/openDiff.js";
import { McpTransport } from "./transport.js";

const SHUTDOWN_TIMEOUT_MS = 5000;
const CLAUDE_RECONNECT_GRACE_MS = 30_000;
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
  private stopped = false;
  private listChangedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: Config) {
    this.logger = new Logger(config.verbose, config.jsonl);
    this.lockFile = new LockFileManager(this.logger);
    this.authToken = randomUUID();
    this.server = new Server(this.authToken, this.logger);
    this.activityLog = new ActivityLog();
    this.extensionClient = new ExtensionClient(this.logger);

    // Handle new Claude Code connections
    this.server.on("connection", (ws: WebSocket) => {
      // Reject connections beyond capacity
      if (this.sessions.size >= MAX_SESSIONS) {
        this.logger.warn(
          `Session capacity reached (${MAX_SESSIONS}). Rejecting connection.`,
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

      // Register tools for this session using probes stored at start() time
      if (this.probes) {
        registerAllTools(
          transport,
          this.config,
          session.openedFiles,
          this.probes,
          this.extensionClient,
          this.activityLog,
          session.terminalPrefix,
          this.fileLock,
          this.sessions,
        );
      }

      transport.attach(ws);
      this.sessions.set(sessionId, session);
      this.logger.event("claude_connected", {
        sessionId,
        activeSessions: this.sessions.size,
      });
      // Only notify on the first active session — subsequent agents don't need to re-signal
      if (this.sessions.size === 1) {
        this.extensionClient.notifyClaudeConnectionState(true);
      }

      ws.on("close", () => {
        this.logger.info(
          `Claude Code disconnected (session ${sessionId.slice(0, 8)})`,
        );
        this.logger.event("claude_disconnected", { sessionId });
        const s = this.sessions.get(sessionId);
        if (s && !s.graceTimer) {
          s.graceTimer = setTimeout(() => {
            this.cleanupSession(sessionId);
          }, CLAUDE_RECONNECT_GRACE_MS);
          this.logger.info(
            `Grace period started for session ${sessionId.slice(0, 8)} (${CLAUDE_RECONNECT_GRACE_MS / 1000}s)`,
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
          }, CLAUDE_RECONNECT_GRACE_MS);
        }
      });
    });

    // Debounced tools/list_changed notification — max one per 2 seconds
    const sendListChanged = () => {
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
      this.logger.info("VS Code extension connected");
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

  private cleanupSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
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
    this.server.healthDataFn = () => ({
      claudeCode: this.sessions.size > 0,
      activeSessions: this.sessions.size,
      extension: this.extensionClient.isConnected(),
      extensionCircuitBreaker: this.extensionClient.getCircuitBreakerState(),
    });
    this.server.metricsFn = () => this.activityLog.toPrometheus();

    // 3. Check for stale lock files
    this.lockFile.cleanStale();

    // 4. Find port and start server
    const port = await this.server.findAndListen(
      this.config.port,
      this.config.bindAddress,
    );

    // 5. Write lock file
    const lockPath = this.lockFile.write(
      port,
      this.authToken,
      [this.config.workspace],
      this.config.ideName,
    );

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
      process.once("unhandledRejection", (reason) => {
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
    this.logger.info("claude-ide-bridge running");
    this.logger.info(`  Port:       ${port}`);
    this.logger.info(`  Workspace:  ${this.config.workspace}`);
    this.logger.info(`  Editor:     ${this.config.editorCommand || "none"}`);
    this.logger.info(`  Lock file:  ${lockPath}`);
    this.logger.info(
      "  To connect: CLAUDE_CODE_IDE_SKIP_VALID_CHECK=true claude",
    );
    this.logger.info(`  Then type "/ide" in the Claude Code session.`);
    this.logger.info(
      '  For Remote Control: run "npm run remote" from the claude-ide-bridge directory (auto-restarts on disconnect)',
    );
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
    await this.server.close();
    this.lockFile.delete();
    cleanupTempDirs();
  }
}
