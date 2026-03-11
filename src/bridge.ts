import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { ActivityLog } from "./activityLog.js";
import type { Config } from "./config.js";
import { ExtensionClient } from "./extensionClient.js";
import { LockFileManager } from "./lockfile.js";
import { Logger } from "./logger.js";
import { probeAll } from "./probe.js";
import { Server } from "./server.js";
import { registerAllTools } from "./tools/index.js";
import { cleanupTempDirs } from "./tools/openDiff.js";
import { McpTransport } from "./transport.js";

const SHUTDOWN_TIMEOUT_MS = 5000;
const CLAUDE_RECONNECT_GRACE_MS = 30_000;
let globalHandlersRegistered = false;

export class Bridge {
  private logger: Logger;
  private lockFile: LockFileManager;
  private server: Server;
  private transport: McpTransport;
  private extensionClient: ExtensionClient;
  private activityLog: ActivityLog;
  private authToken: string;
  private openedFiles = new Set<string>();
  private currentWs: WebSocket | null = null;
  private stopped = false;
  private listChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private claudeDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: Config) {
    this.logger = new Logger(config.verbose, config.jsonl);
    this.lockFile = new LockFileManager(this.logger);
    this.authToken = randomUUID();
    this.server = new Server(this.authToken, this.logger);
    this.transport = new McpTransport(this.logger);
    this.activityLog = new ActivityLog();
    this.transport.setActivityLog(this.activityLog);
    this.extensionClient = new ExtensionClient(this.logger);
    this.transport.setExtensionConnectedFn(() =>
      this.extensionClient.isConnected(),
    );

    // Handle new Claude Code connections
    this.server.on("connection", (ws: WebSocket) => {
      // If reconnecting within grace period, cancel the deferred cleanup
      if (this.claudeDisconnectTimer) {
        clearTimeout(this.claudeDisconnectTimer);
        this.claudeDisconnectTimer = null;
        this.logger.info("Claude Code reconnected within grace period");
        // Clear stale file tracking — we can't distinguish "same client
        // reconnecting" from "different client connecting during grace period",
        // so always reset. The reconnecting client doesn't rely on this state.
        this.openedFiles.clear();
      }

      // Clean up previous connection if any
      if (this.currentWs) {
        this.logger.info("Replacing existing connection");
        this.transport.detach();
        this.currentWs.removeAllListeners();
        if (this.currentWs.readyState === WebSocket.OPEN) {
          this.currentWs.terminate();
        }
        // Don't clear openedFiles — preserve state for reconnecting session
      } else if (!this.claudeDisconnectTimer) {
        // First connection ever (no prior session) — reset file tracking
        this.openedFiles.clear();
      }

      this.currentWs = ws;
      this.transport.attach(ws);
      this.logger.event("claude_connected");
      this.extensionClient.notifyClaudeConnectionState(true);

      ws.on("close", () => {
        this.logger.info("Claude Code disconnected");
        this.logger.event("claude_disconnected");
        if (this.currentWs === ws) {
          this.currentWs = null;
          // Start grace period — defer transport detach and state cleanup
          this.startClaudeDisconnectGrace();
        }
      });

      ws.on("error", (err) => {
        this.logger.error(`WebSocket error: ${err.message}`);
        if (this.currentWs === ws) {
          this.currentWs = null;
          this.startClaudeDisconnectGrace();
        }
      });
    });

    // Debounced tools/list_changed notification — max one per 2 seconds
    const sendListChanged = () => {
      if (this.listChangedTimer) return; // Already scheduled
      this.listChangedTimer = setTimeout(() => {
        this.listChangedTimer = null;
        if (this.currentWs && this.currentWs.readyState === WebSocket.OPEN) {
          McpTransport.sendNotification(
            this.currentWs,
            "notifications/tools/list_changed",
            undefined,
            this.logger,
          );
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
            // Send a second list_changed now that workspace paths are up-to-date,
            // so Claude re-queries with accurate workspace validation.
            if (
              this.currentWs &&
              this.currentWs.readyState === WebSocket.OPEN
            ) {
              McpTransport.sendNotification(
                this.currentWs,
                "notifications/tools/list_changed",
                undefined,
                this.logger,
              );
            }
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `getWorkspaceFolders failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      if (this.currentWs && this.currentWs.readyState === WebSocket.OPEN) {
        McpTransport.sendNotification(
          this.currentWs,
          "notifications/tools/list_changed",
          undefined,
          this.logger,
        );
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

  async start(): Promise<void> {
    // 1. Probe available CLI tools
    const probes = await probeAll();
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

    // 2. Register all tools (needs probes + extensionClient)
    registerAllTools(
      this.transport,
      this.config,
      this.openedFiles,
      probes,
      this.extensionClient,
      this.activityLog,
    );

    // 3. Wire up /health endpoint data and /metrics
    this.server.healthDataFn = () => ({
      claudeCode: this.currentWs !== null,
      extension: this.extensionClient.isConnected(),
      extensionCircuitBreaker: this.extensionClient.getCircuitBreakerState(),
    });
    this.server.metricsFn = () => this.activityLog.toPrometheus();

    // 4. Check for stale lock files
    this.lockFile.cleanStale();

    // 5. Find port and start server
    const port = await this.server.findAndListen(
      this.config.port,
      this.config.bindAddress,
    );

    // 6. Write lock file
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

  private startClaudeDisconnectGrace(): void {
    if (this.claudeDisconnectTimer) return; // Already in grace period
    this.logger.info(
      `Claude Code grace period started (${CLAUDE_RECONNECT_GRACE_MS / 1000}s)`,
    );
    this.claudeDisconnectTimer = setTimeout(() => {
      this.claudeDisconnectTimer = null;
      this.logger.info("Grace period expired — cleaning up session state");
      this.transport.detach();
      this.openedFiles.clear();
      this.extensionClient.notifyClaudeConnectionState(false);
    }, CLAUDE_RECONNECT_GRACE_MS);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info("Shutting down...");
    if (this.listChangedTimer) {
      clearTimeout(this.listChangedTimer);
      this.listChangedTimer = null;
    }
    if (this.claudeDisconnectTimer) {
      clearTimeout(this.claudeDisconnectTimer);
      this.claudeDisconnectTimer = null;
    }
    // Abort in-flight tool calls before closing the server
    this.transport.detach();
    this.extensionClient.disconnect();
    await this.server.close();
    this.lockFile.delete();
    cleanupTempDirs();
  }
}
