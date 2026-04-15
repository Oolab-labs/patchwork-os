import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { ActivityLog } from "./activityLog.js";
import { buildSummary } from "./analyticsAggregator.js";
import { getAnalyticsPref } from "./analyticsPrefs.js";
import { sendAnalytics } from "./analyticsSend.js";
import { AutomationHooks, loadPolicy } from "./automation.js";
import { loadOrCreateBridgeToken } from "./bridgeToken.js";
import { repairBridgeToolsRulesIfStale } from "./bridgeToolsRules.js";
import { createDriver } from "./claudeDriver.js";
import { ClaudeOrchestrator } from "./claudeOrchestrator.js";
import type { Config } from "./config.js";
import { ExtensionClient } from "./extensionClient.js";
import { FileLock } from "./fileLock.js";
import { buildEnforcementReminder } from "./instructionsUtils.js";
import { LockFileManager } from "./lockfile.js";
import { Logger } from "./logger.js";
import { OAuthServerImpl } from "./oauth.js";
import type { LoadedPluginTool } from "./pluginLoader.js";
import { loadPlugins, loadPluginsFull } from "./pluginLoader.js";
import { PluginWatcher } from "./pluginWatcher.js";
import type { ProbeResults } from "./probe.js";
import { probeAll } from "./probe.js";
import { Server } from "./server.js";
import { type CheckpointData, SessionCheckpoint } from "./sessionCheckpoint.js";
import { StreamableHttpHandler } from "./streamableHttp.js";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";
import { readNote, writeNote } from "./tools/handoffNote.js";
import { registerAllTools } from "./tools/index.js";
import { cleanupTempDirs } from "./tools/openDiff.js";
import { resolveFilePath } from "./tools/utils.js";
import { McpTransport } from "./transport.js";
import { PACKAGE_VERSION } from "./version.js";

const SHUTDOWN_TIMEOUT_MS = 5000;
let globalHandlersRegistered = false;

/** Collect the union of openedFiles across all sessions in a checkpoint. */
export function extractRestoredFiles(
  checkpoint: CheckpointData,
  workspace: string,
): Set<string> {
  const all = new Set<string>();
  for (const s of checkpoint.sessions) {
    for (const f of s.openedFiles) {
      // Only restore paths that resolve safely within the workspace
      try {
        resolveFilePath(f, workspace);
        all.add(f);
      } catch {
        // skip paths that fail workspace containment
      }
    }
  }
  return all;
}

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
  /** Cleared to false each heartbeat ping; reset to true on pong. Terminate if still false at next ping. */
  wsAlive: boolean;
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
  /** True when sendListChanged fired but no session had an open WS to receive it. */
  private pendingListChanged = false;
  private lastConnectAt: string | null = null;
  private lastDisconnectAt: string | null = null;
  private lastDisconnectCode: number | null = null;
  private lastDisconnectReason: string | null = null;
  private checkpoint: SessionCheckpoint | null = null;
  private orchestrator: ClaudeOrchestrator | null = null;
  /** openedFiles restored from the previous-run checkpoint; consumed by the first connecting session. */
  private restoredOpenedFiles: Set<string> | null = null;
  private checkpointRestored: { fileCount: number; ageSec: number } | null =
    null;
  private port = 0;
  private pluginTools: LoadedPluginTool[] = [];
  private pluginWatcher: PluginWatcher | null = null;
  private automationHooks: AutomationHooks | null = null;
  private httpMcpHandler: StreamableHttpHandler | null = null;
  private oauthServer: OAuthServerImpl | null = null;
  /** Incremented each time the VS Code extension (re)connects — guards stale async callbacks. */
  private extensionConnectionGeneration = 0;
  /** Tracks whether a debug session was active — detects true→false transition for onDebugSessionEnd. */
  private _lastDebugSessionActive = false;
  /** Total number of VS Code extension disconnects since bridge start. */
  private extensionDisconnectCount = 0;
  /** ISO timestamp of last getProjectContext cache write — drives status-bar "context X min ago". */
  private _lastContextCachedAt: string | null = null;
  private wsHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private config: Config) {
    this.logger = new Logger(config.verbose, config.jsonl);
    this.lockFile = new LockFileManager(this.logger);
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    this.authToken = config.fixedToken ?? loadOrCreateBridgeToken(configDir);
    this.server = new Server(this.authToken, this.logger, config.corsOrigins);
    if (config.issuerUrl) {
      this.oauthServer = new OAuthServerImpl(this.authToken, config.issuerUrl, {
        configDir,
        tokenTtlMs: config.oauthTokenTtlMs,
      });
      this.server.setOAuthServer(this.oauthServer, config.issuerUrl);
      this.logger.info(`OAuth 2.0 enabled — issuer: ${config.issuerUrl}`);
    }
    this.activityLog = new ActivityLog();
    if (config.auditLogPath) {
      this.activityLog.setPersistPath(config.auditLogPath);
      this.logger.info(`Audit log: ${config.auditLogPath}`);
    }
    this.extensionClient = new ExtensionClient(this.logger);

    // Handle new Claude Code connections
    this.server.on("connection", (ws: WebSocket) => {
      // Reject connections before probes are ready
      if (!this.ready) {
        this.logger.warn("Connection rejected — bridge not ready yet");
        ws.close(1013, "Bridge not ready");
        return;
      }

      // ── Session resumption ────────────────────────────────────────────────
      // If the client sent X-Claude-Code-Session-Id and we have a matching
      // session in the grace period, reattach the new WebSocket to it instead
      // of creating a fresh session. This eliminates re-initialization overhead
      // after brief disconnects (sleep/wake, network blip, bridge restart).
      //
      // Session resumption trust boundary: any client presenting a valid auth
      // token and a matching session ID can reattach to a grace-period session.
      // Session IDs are random UUIDs (128-bit), so guessing is infeasible. In
      // single-user local deployments this is safe. In remote deployments using
      // --fixed-token with multiple agents sharing one token, agents can inherit
      // each other's session state (openedFiles, etc.) — this is intentional
      // for the orchestrator pattern. For strict isolation between agents, use
      // separate bridge instances with separate tokens.
      const clientSessionId = (ws as WebSocket & { clientSessionId?: string })
        .clientSessionId;
      if (clientSessionId) {
        const existing = this.sessions.get(clientSessionId);
        if (existing?.graceTimer) {
          clearTimeout(existing.graceTimer);
          existing.graceTimer = null;
          existing.ws = ws;
          existing.wsAlive = true;
          existing.transport.attach(ws);
          ws.on("pong", () => {
            existing.wsAlive = true;
          });
          this.lastConnectAt = new Date().toISOString();
          this.logger.info(
            `Session ${clientSessionId.slice(0, 8)} resumed — grace period cancelled`,
          );
          this.activityLog.recordEvent("session_resumed", {
            sessionId: clientSessionId.slice(0, 8),
          });
          this.logger.event("session_resumed", { sessionId: clientSessionId });
          // Re-attach close/error handlers to the new WebSocket
          ws.on("close", (code: number, reason: Buffer) => {
            this.lastDisconnectAt = new Date().toISOString();
            this.lastDisconnectCode = code;
            this.lastDisconnectReason = reason.toString() || null;
            this.logger.info(
              `Claude Code disconnected (session ${clientSessionId.slice(0, 8)}) code=${code} reason=${reason.toString() || "(none)"}`,
            );
            this.activityLog.recordEvent("claude_disconnected", {
              sessionId: clientSessionId.slice(0, 8),
            });
            this.logger.event("claude_disconnected", {
              sessionId: clientSessionId,
            });
            const s = this.sessions.get(clientSessionId);
            if (s && !s.graceTimer) {
              s.graceTimer = setTimeout(() => {
                this.cleanupSession(clientSessionId);
              }, this.config.gracePeriodMs);
              this.activityLog.recordEvent("grace_started", {
                sessionId: clientSessionId.slice(0, 8),
                gracePeriodMs: this.config.gracePeriodMs,
              });
              this.logger.info(
                `Grace period started for session ${clientSessionId.slice(0, 8)} (${this.config.gracePeriodMs / 1000}s)`,
              );
            }
          });
          ws.on("error", (err) => {
            this.logger.error(
              `WebSocket error (session ${clientSessionId.slice(0, 8)}): ${err.message}`,
            );
          });
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Reject connections beyond capacity (grace-period sessions don't count)
      const activeSessionCount = [...this.sessions.values()].filter(
        (s) => !s.graceTimer,
      ).length;
      if (activeSessionCount >= this.config.maxSessions) {
        this.logger.warn(
          `Session capacity reached (${this.config.maxSessions} active). Rejecting connection.`,
        );
        ws.close(1013, "Bridge at capacity");
        return;
      }

      if (this.sessions.size === 0) {
        void this.maybeAutoSnapshotHandoff();
        this._startPeriodicSnapshots();
      }

      const sessionId = randomUUID();
      const transport = new McpTransport(this.logger);
      transport.workspace = this.config.workspace;
      transport.sessionId = sessionId;
      transport.setActivityLog(this.activityLog);
      transport.setToolRateLimit(this.config.toolRateLimit);
      transport.setExtensionConnectedFn(() =>
        this.extensionClient.isConnected(),
      );
      transport.setInstructions(this.buildInstructions());
      transport.onInitialized = () => {
        if (this.pendingListChanged && ws.readyState === WebSocket.OPEN) {
          McpTransport.sendNotification(
            ws,
            "notifications/tools/list_changed",
            undefined,
            this.logger,
          );
          // Delay clearing the flag so that if the socket errors immediately after
          // the send (before the client processes the notification), a reconnecting
          // session still receives the list_changed on its own onInitialized.
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              this.pendingListChanged = false;
            }
          }, 200);
        }
        if (this.checkpointRestored) {
          const { fileCount, ageSec } = this.checkpointRestored;
          this.checkpointRestored = null;
          if (ws.readyState === WebSocket.OPEN) {
            McpTransport.sendNotification(
              ws,
              "notifications/message",
              {
                level: "info",
                logger: "bridge",
                data: `Session restored from checkpoint: ${fileCount} file(s) tracked (${ageSec}s ago).`,
              },
              this.logger,
            );
          }
        }
      };

      // Restore previously-tracked files into the first connecting session, then
      // clear so subsequent sessions in the same run start with a clean slate.
      let openedFiles: Set<string>;
      if (this.sessions.size === 0 && this.restoredOpenedFiles !== null) {
        const captured = this.restoredOpenedFiles;
        this.restoredOpenedFiles = null;
        openedFiles = new Set(captured);
      } else {
        openedFiles = new Set<string>();
      }

      const session: AgentSession = {
        id: sessionId,
        ws,
        transport,
        openedFiles,
        terminalPrefix: `s${sessionId.slice(0, 8)}-`,
        graceTimer: null,
        connectedAt: Date.now(),
        wsAlive: true,
      };
      ws.on("pong", () => {
        session.wsAlive = true;
      });

      // Register tools for this session — probes guaranteed non-null due to ready guard above
      const probes = this.probes ?? ({} as ProbeResults);
      // addTransport BEFORE registerAllTools so that if a reload fires between
      // these two calls, the new transport is already tracked by the watcher.
      this.pluginWatcher?.addTransport(transport);
      const pluginTools = this.pluginWatcher?.getTools() ?? this.pluginTools;
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
        this.orchestrator,
        sessionId,
        pluginTools,
        this.automationHooks,
        () => ({
          at: this.lastDisconnectAt,
          code: this.lastDisconnectCode,
          reason: this.lastDisconnectReason,
        }),
        (generatedAt: string) => {
          this._lastContextCachedAt = generatedAt;
          this._emitLiveState();
        },
        () => this.extensionDisconnectCount,
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

      ws.on("close", (code: number, reason: Buffer) => {
        this.lastDisconnectAt = new Date().toISOString();
        this.lastDisconnectCode = code;
        this.lastDisconnectReason = reason.toString() || null;
        this.logger.info(
          `Claude Code disconnected (session ${sessionId.slice(0, 8)}) code=${code} reason=${reason.toString() || "(none)"}`,
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
        // Log the error; the "close" event always follows an "error" in the ws
        // library and is the single authoritative place to start the grace timer.
        // Starting it here too creates a dual-handler race where both handlers
        // could observe !s.graceTimer before either setTimeout returns its handle.
        this.logger.error(
          `WebSocket error (session ${sessionId.slice(0, 8)}): ${err.message}`,
        );
      });
    });

    // (sendListChanged is a private method — see below)

    // Handle VS Code extension connections — notify Claude immediately (no debounce)
    // so it re-queries capabilities and discovers LSP/terminal/selection are now available.
    this.server.on("extension", (ws: WebSocket) => {
      this.logger.info(
        "VS Code extension connected — LSP, terminal, and editor tools now available",
      );
      this.activityLog.recordEvent("extension_connected");
      this.logger.event("extension_connected");
      this.extensionClient.handleExtensionConnection(ws);
      // Push current live state to newly connected extension
      this._emitLiveState();

      // Immediate list_changed — tell Claude Code that extension tools are now available
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

      // Refresh workspace folders from extension (multi-root workspace support).
      // Only broadcast a second list_changed if the folders actually changed,
      // to avoid a spurious double-notification on every extension connect.
      //
      // Generation guard: if the extension disconnects and reconnects before
      // getWorkspaceFolders() resolves, the stale response is discarded so it
      // cannot overwrite the config populated by the newer connection.
      const myGen = ++this.extensionConnectionGeneration;
      const prevFolders = (this.config.workspaceFolders ?? []).join(",");
      this.extensionClient
        .getWorkspaceFolders()
        .then((folders) => {
          if (myGen !== this.extensionConnectionGeneration) return;
          if (folders && folders.length > 0) {
            this.config.workspaceFolders = folders.map((f) => f.path);
            this.logger.info(
              `Workspace folders: ${this.config.workspaceFolders.join(", ")}`,
            );
            // Only re-broadcast if the folder list changed
            if (this.config.workspaceFolders.join(",") !== prevFolders) {
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
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `getWorkspaceFolders failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });

    // Notify Claude when extension disconnects so it knows to fall back to CLI/grep mode
    this.extensionClient.onExtensionDisconnected = () => {
      this.logger.info(
        "VS Code extension disconnected — falling back to file-system tools only",
      );
      this.extensionDisconnectCount++;
      this.activityLog.recordEvent("extension_disconnected");
      this.logger.event("extension_disconnected_notify");
      this.sendListChanged();
    };

    // Forward diagnostics changes from extension to Claude Code
    this.extensionClient.onDiagnosticsChanged = (_file, _diagnostics) => {
      this.logger.event("diagnostics_changed", { file: _file });
      this.sendListChanged();
      this.automationHooks?.handleDiagnosticsChanged(_file, _diagnostics ?? []);
    };

    // Forward AI comment changes from extension to Claude Code
    this.extensionClient.onAICommentsChanged = (_comments) => {
      this.logger.event("ai_comments_changed", { count: _comments.length });
      this.sendListChanged();
    };

    // Forward file change notifications from extension to Claude Code
    this.extensionClient.onFileChanged = (id, type, file) => {
      this.logger.event("file_changed", { id, type, file });
      this.sendListChanged();
      this.automationHooks?.handleFileSaved(id, type, file);
      this.automationHooks?.handleFileChanged(id, type, file);
    };

    // Forward debug session changes from extension to Claude Code
    this.extensionClient.onDebugSessionChanged = (state) => {
      this.logger.event("debug_session_changed");
      this.sendListChanged();
      // Detect false→true transition (session started)
      if (!this._lastDebugSessionActive && state.hasActiveSession) {
        const breakpoints = state.breakpoints ?? [];
        this.automationHooks?.handleDebugSessionStart({
          sessionName: state.sessionName ?? "unknown",
          sessionType: state.sessionType ?? "unknown",
          breakpointCount: breakpoints.filter((b) => b.enabled).length,
          activeFile: breakpoints[0]?.file ?? "",
        });
      }
      // Detect true→false transition (session ended)
      if (this._lastDebugSessionActive && !state.hasActiveSession) {
        this.automationHooks?.handleDebugSessionEnd({
          sessionName: state.sessionName ?? "unknown",
          sessionType: state.sessionType ?? "unknown",
        });
      }
      this._lastDebugSessionActive = state.hasActiveSession;
      this._emitLiveState();
    };
  }

  /** Push live bridge state to the extension for status-bar display. */
  private _emitLiveState(): void {
    const preCompactArmed =
      this.automationHooks?.isPreCompactEnabled() ?? false;
    this.extensionClient.sendPush("extension/bridgeLiveState", {
      contextCachedAt: this._lastContextCachedAt,
      preCompactArmed,
      debugSessionActive: this._lastDebugSessionActive,
    });
  }

  /** Build a rich auto-snapshot string from live bridge state. */
  private _buildSnapshotSummary(): string {
    const ts = new Date().toISOString();
    const extConnected = this.extensionClient.isConnected();
    const lines: string[] = [`[auto-snapshot ${ts}]`];
    lines.push(`Workspace: ${this.config.workspace}`);
    lines.push(`Extension: ${extConnected ? "connected" : "disconnected"}`);
    lines.push(`Active sessions: ${this.sessions.size}`);

    // Diagnostics summary from the extension client's live cache
    if (extConnected) {
      let errors = 0;
      let warnings = 0;
      const errorFiles: string[] = [];
      for (const [file, diags] of this.extensionClient.latestDiagnostics) {
        const e = diags.filter((d) => d.severity === "error").length;
        const w = diags.filter((d) => d.severity === "warning").length;
        errors += e;
        warnings += w;
        if (e > 0) errorFiles.push(file.split("/").pop() ?? file);
      }
      lines.push(`Diagnostics: ${errors} errors, ${warnings} warnings`);
      if (errorFiles.length > 0) {
        lines.push(`Error files: ${errorFiles.slice(0, 5).join(", ")}`);
      }
    }

    // Top 3 most-called tools from activity log
    const statsMap = this.activityLog.stats();
    const topTools = Object.entries(statsMap)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3)
      .map(([name, s]) => `${name}(${s.count})`)
      .join(", ");
    if (topTools) lines.push(`Top tools: ${topTools}`);

    return lines.join("\n");
  }

  /** Write an auto-snapshot handoff note when a new first session connects, unless one was recently written. */
  private _autoSnapshotInFlight = false;

  private async maybeAutoSnapshotHandoff(): Promise<void> {
    // Guard against concurrent calls (e.g. two clients connecting simultaneously)
    if (this._autoSnapshotInFlight) return;
    this._autoSnapshotInFlight = true;
    try {
      const existing = await readNote(this.config.workspace);
      if (existing && Date.now() - existing.updatedAt < 5 * 60_000) {
        return;
      }
      await writeNote(
        this._buildSnapshotSummary(),
        this.config.workspace,
        undefined,
        true,
      );
    } catch {
      // best-effort — never let this crash the connection handler
    } finally {
      this._autoSnapshotInFlight = false;
    }
  }

  /** Write a periodic auto-snapshot while sessions are active (every 5 minutes). */
  private _periodicSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  private _startPeriodicSnapshots(): void {
    if (this._periodicSnapshotTimer) return;
    this._periodicSnapshotTimer = setInterval(
      () => {
        if (this.sessions.size === 0) return; // no active sessions — skip
        void writeNote(
          this._buildSnapshotSummary(),
          this.config.workspace,
          undefined,
          true,
        ).catch(() => {
          /* best-effort */
        });
      },
      5 * 60_000, // every 5 minutes
    );
    this._periodicSnapshotTimer.unref(); // don't prevent Node exit
  }

  private _stopPeriodicSnapshots(): void {
    if (this._periodicSnapshotTimer) {
      clearInterval(this._periodicSnapshotTimer);
      this._periodicSnapshotTimer = null;
    }
  }

  /** Debounced tools/list_changed notification — max one per 2 seconds. */
  private sendListChanged(): void {
    if (this.stopped) return; // Don't fire after stop()
    if (this.listChangedTimer) return; // Already scheduled
    this.listChangedTimer = setTimeout(() => {
      this.listChangedTimer = null;
      let notifiedAny = false;
      for (const session of this.sessions.values()) {
        if (session.ws.readyState === WebSocket.OPEN) {
          McpTransport.sendNotification(
            session.ws,
            "notifications/tools/list_changed",
            undefined,
            this.logger,
          );
          notifiedAny = true;
        }
      }
      // Also notify HTTP sessions — they have their own session map in the handler.
      this.httpMcpHandler?.broadcastListChanged();
      // No open WebSocket sessions — mark pending so the next WS session gets it on initialize.
      // HTTP sessions always receive their tools via broadcastListChanged above.
      if (!notifiedAny) {
        this.pendingListChanged = true;
      }
    }, 2000);
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

  private buildInstructions(): string {
    const lines = [`claude-ide-bridge v${PACKAGE_VERSION}`];
    lines.push("");
    lines.push("CONTEXT PLATFORM:");
    lines.push(
      "  Use ctx tools for issue/PR/error context — not gh or githubViewPR.",
    );
    lines.push(
      "  ctxGetTaskContext(ref) — unified context for any issue, PR, commit, or error",
    );
    lines.push("  ctxQueryTraces(query) — search past decisions");
    lines.push(
      "  ctxSaveTrace(ref, problem, solution) — record fix after resolving a task",
    );
    lines.push("");
    lines.push(...buildEnforcementReminder());
    return lines.join("\n");
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
    this.pluginWatcher?.removeTransport(session.transport);
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

  /** Returns the port the bridge is listening on (0 before start()). */
  getPort(): number {
    return this.port;
  }

  /** Returns the auth token for this bridge instance. */
  getAuthToken(): string {
    return this.authToken;
  }

  async start(): Promise<void> {
    // 0. Initialize OpenTelemetry (no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset)
    initTelemetry();

    // 0a. Auto-repair .claude/rules/bridge-tools.md if stale (present but missing the
    // current version sentinel). Older package versions write stale files that may
    // lack new tool substitution rules. Repair is silent on success; falls back to
    // warn-only if the template is missing or the write fails.
    repairBridgeToolsRulesIfStale(this.config.workspace, (msg) =>
      this.logger.info(msg),
    );

    // 1. Probe available CLI tools (pass workspace so local node_modules/.bin is checked)
    this.probes = await probeAll(this.config.workspace);
    this.ready = true;

    // 2. Load plugins (after probes, before accepting sessions)
    this.pluginTools = await loadPlugins(
      this.config.plugins,
      this.config,
      this.logger,
    );

    if (this.config.pluginWatch && this.config.plugins.length > 0) {
      const loadedPlugins = await loadPluginsFull(
        this.config.plugins,
        this.config,
        this.logger,
      );
      this.pluginTools = loadedPlugins.flatMap((p) => p.tools);
      this.pluginWatcher = new PluginWatcher(this.config, this.logger, () =>
        this.sendListChanged(),
      );
      this.pluginWatcher.start(loadedPlugins);
      this.logger.info(
        `[plugin-watch] Watching ${loadedPlugins.length} plugin director${loadedPlugins.length === 1 ? "y" : "ies"}`,
      );
    }

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

    // 2. Initialize Claude driver and orchestrator (if configured)
    if (this.config.claudeDriver !== "none") {
      const driver = createDriver(
        this.config.claudeDriver,
        this.config.claudeBinary,
        this.config.antBinary,
        (msg) => this.logger.info(msg),
      );
      if (driver) {
        this.orchestrator = new ClaudeOrchestrator(
          driver,
          this.config.workspace,
          (msg) => this.logger.info(msg),
          (taskId, chunk) =>
            this.extensionClient.notifyTaskOutput(taskId, chunk),
          (taskId, status) => {
            this.extensionClient.notifyTaskDone(taskId, status);
            if (status === "done" && this.automationHooks) {
              const task = this.orchestrator?.getTask(taskId);
              // Loop guard: skip automation-spawned tasks to prevent infinite chains
              if (!task?.isAutomationTask) {
                this.automationHooks.handleTaskSuccess({
                  taskId,
                  output: task?.output ?? "",
                });
              }
            }
          },
          {
            save: () => {
              if (this.checkpoint) {
                this.checkpoint.write(this._buildCheckpoint(this.port));
              }
              // Persist terminal tasks for cross-session resumability (best-effort)
              if (this.port > 0 && this.orchestrator) {
                void this.orchestrator.persistTasks(this.port).catch(() => {
                  /* best-effort */
                });
              }
            },
          },
        );
        this.logger.info(`[bridge] Claude driver: ${driver.name}`);
      }
    }

    if (this.config.automationEnabled) {
      if (!this.orchestrator) {
        throw new Error("--automation requires --claude-driver != none");
      }
      if (!this.config.automationPolicyPath) {
        throw new Error("--automation requires --automation-policy <path>");
      }
      const policy = loadPolicy(this.config.automationPolicyPath);
      this.automationHooks = new AutomationHooks(
        policy,
        this.orchestrator,
        (msg) => this.logger.info(msg),
        this.extensionClient,
        this.config.workspace,
      );
      this.logger.info(
        `[bridge] Automation enabled (policy: ${this.config.automationPolicyPath})`,
      );
    }

    // 3. Wire up /health endpoint data and /metrics
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
        lastDisconnectCode: this.lastDisconnectCode,
        lastDisconnectReason: this.lastDisconnectReason,
        extensionConnected: this.extensionClient.isConnected(),
        extensionCircuitBreaker: this.extensionClient.getCircuitBreakerState(),
        extensionDisconnectCount: this.extensionDisconnectCount,
        recentActivity: this.activityLog.query({ last: 10 }),
      };
    };
    this.server.metricsFn = () =>
      this.activityLog.toPrometheus({
        rateLimitRejected: this.activityLog.getRateLimitRejections(),
        extensionDisconnects: this.extensionDisconnectCount,
      });
    this.server.perfDataFn = () => {
      const windowMs = 60 * 60_000; // 1h window for dashboard
      const windowedS = this.activityLog.windowedStats(windowMs);
      const allPercentiles = this.activityLog.percentiles();
      let totalCalls = 0;
      let totalErrors = 0;
      for (const s of Object.values(windowedS)) {
        totalCalls += s.count;
        totalErrors += s.errors;
      }
      const p95Values = Object.values(allPercentiles).map((p) => p.p95);
      const overallP95Ms = p95Values.length > 0 ? Math.max(...p95Values) : 0;
      const perTool: Record<string, unknown> = {};
      for (const [tool, pct] of Object.entries(allPercentiles)) {
        const ws = windowedS[tool];
        perTool[tool] = {
          p50: pct.p50,
          p95: pct.p95,
          p99: pct.p99,
          sampleCount: pct.sampleCount,
          calls: ws?.count ?? 0,
        };
      }
      const cb = this.extensionClient.getCircuitBreakerState();
      const errorRatePct =
        totalCalls > 0
          ? Math.round((totalErrors / totalCalls) * 10000) / 100
          : 0;
      let score = 100;
      const signals: string[] = [];
      if (cb.suspended) {
        score -= 20;
        signals.push("Circuit breaker suspended");
      }
      if (errorRatePct > 5) {
        score -= 15;
        signals.push(`Error rate critical (${errorRatePct}%)`);
      } else if (errorRatePct > 1) {
        score -= 10;
        signals.push(`Error rate elevated (${errorRatePct}%)`);
      }
      if (overallP95Ms > 2000) {
        score -= 10;
        signals.push(`p95 latency critical (${overallP95Ms}ms)`);
      } else if (overallP95Ms > 500) {
        score -= 5;
        signals.push(`p95 latency elevated (${overallP95Ms}ms)`);
      }
      const rl = this.activityLog.getRateLimitRejections();
      if (rl > 0) {
        score -= 10;
        signals.push(`${rl} rate-limit rejection(s)`);
      }
      if (!this.extensionClient.isConnected())
        signals.push("Extension disconnected");
      score = Math.max(0, Math.min(100, score));
      return {
        latency: { perTool, overallP95Ms },
        health: { score, signals },
      };
    };
    this.server.analyticsFn = async (windowHours?: number) => {
      const wh =
        typeof windowHours === "number" && windowHours >= 1 ? windowHours : 24;
      const cutoff = Date.now() - wh * 3_600 * 1_000;
      const statsMap = this.activityLog.stats();
      const topTools = Object.entries(statsMap)
        .map(([tool, s]) => ({
          tool,
          calls: s.count,
          errors: s.errors,
          avgMs: s.avgDurationMs,
        }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 10);
      // Count automation tasks (isAutomationTask) created within the window.
      // These originate from automation hooks (onFileSave, onGitCommit, etc.)
      // and accurately represent "hooks fired" rather than session lifecycle events.
      const hooksLast24h = this.orchestrator
        ? this.orchestrator
            .list()
            .filter((t) => t.isAutomationTask && t.createdAt > cutoff).length
        : 0;
      const recentAutomationTasks = this.orchestrator
        ? this.orchestrator
            .list()
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 20)
            .map((t) => ({
              id: t.id,
              status: t.status,
              ...(t.triggerSource !== undefined && {
                triggerSource: t.triggerSource,
              }),
              ...(t.startedAt !== undefined &&
                t.doneAt !== undefined && {
                  durationMs: t.doneAt - t.startedAt,
                }),
              createdAt: new Date(t.createdAt).toISOString(),
              ...(t.output !== undefined && {
                output: t.output.slice(0, 2000),
              }),
              ...(t.errorMessage !== undefined && {
                errorMessage: t.errorMessage,
              }),
            }))
        : [];
      return {
        generatedAt: new Date().toISOString(),
        windowHours: wh,
        topTools,
        hooksLast24h,
        recentAutomationTasks,
      };
    };
    this.server.streamFn = (listener) => this.activityLog.subscribe(listener);
    this.server.tasksFn = () => ({
      tasks: (this.orchestrator?.list() ?? []).map((t) => ({
        taskId: t.id,
        sessionId: t.sessionId.slice(0, 8),
        status: t.status,
        cancelReason: t.cancelReason,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        doneAt: t.doneAt,
        // Omit prompt (may contain sensitive content) and cap output
        output: t.output !== undefined ? t.output.slice(0, 2000) : undefined,
        // Cap stderrTail at 500 chars — subprocess stderr may contain paths,
        // env fragments, or user-code errors; match existing redaction policy.
        stderrTail: t.stderrTail ? t.stderrTail.slice(-500) : undefined,
        wasAborted: t.wasAborted,
        startupMs: t.startupMs,
        errorMessage: t.errorMessage,
        timeoutMs: t.timeoutMs,
      })),
    });
    this.server.readyFn = () => {
      // Count tools from the first active session (all sessions share the same tool set)
      const anySession = [...this.sessions.values()][0];
      const toolCount = anySession?.transport.toolCount ?? 0;
      return {
        ready: this.ready,
        toolCount,
        extensionConnected: this.extensionClient.isConnected(),
      };
    };
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
        lastDisconnectCode: this.lastDisconnectCode,
        lastDisconnectReason: this.lastDisconnectReason,
        sessions: sessionList,
        extension: this.extensionClient.isConnected(),
        extensionCircuitBreaker: this.extensionClient.getCircuitBreakerState(),
        timeline: this.activityLog.queryTimeline({ last: 50 }),
      };
    };

    // 3b-notify. Wire CC hook notify endpoint
    this.server.notifyFn = (event, args) => {
      if (!this.automationHooks) {
        return { ok: false, error: "Automation not enabled" };
      }
      switch (event) {
        case "PreCompact":
          this.automationHooks.handlePreCompact();
          return { ok: true };
        case "PostCompact":
          this.automationHooks.handlePostCompact();
          return { ok: true };
        case "InstructionsLoaded":
          this.automationHooks.handleInstructionsLoaded();
          return { ok: true };
        case "TaskCreated":
          if (!args.taskId || !args.prompt) {
            return { ok: false, error: "Missing taskId or prompt" };
          }
          this.automationHooks.handleTaskCreated({
            taskId: args.taskId,
            prompt: args.prompt,
          });
          return { ok: true };
        case "PermissionDenied":
          if (!args.tool || !args.reason) {
            return { ok: false, error: "Missing tool or reason" };
          }
          this.automationHooks.handlePermissionDenied({
            tool: args.tool,
            reason: args.reason,
          });
          return { ok: true };
        case "CwdChanged":
          if (!args.cwd) return { ok: false, error: "Missing cwd" };
          this.automationHooks.handleCwdChanged(args.cwd);
          return { ok: true };
        default:
          return { ok: false, error: `Unknown CC event: ${event}` };
      }
    };

    // 3b. Set up Streamable HTTP transport handler (POST/GET/DELETE /mcp)
    this.httpMcpHandler = new StreamableHttpHandler(
      this.config,
      probes,
      this.extensionClient,
      this.activityLog,
      this.fileLock,
      this.sessions as Map<string, unknown>,
      this.orchestrator,
      this.logger,
      () => this.pluginWatcher?.getTools() ?? this.pluginTools,
      () => this.pluginWatcher,
      this.oauthServer
        ? (token) => this.oauthServer?.resolveBearerScope(token) ?? null
        : null,
      this.buildInstructions(),
    );
    this.server.httpMcpHandler = (req, res) =>
      this.httpMcpHandler?.handle(req, res) ?? Promise.resolve();

    // 3. Check for stale lock files
    this.lockFile.cleanStale();

    // 4. Find port and start server — if this throws, clean up the HTTP handler
    //    so its cleanupTimer interval does not leak.
    let port: number;
    try {
      port = await this.server.findAndListen(
        this.config.port,
        this.config.bindAddress,
      );
    } catch (err) {
      this.httpMcpHandler.close();
      this.httpMcpHandler = null;
      throw err;
    }
    this.port = port;

    // 4b. Start WebSocket keepalive heartbeat (keeps MCP session alive during long idle periods)
    this._startWsHeartbeat();

    // 4c. Load persisted tasks from previous sessions (best-effort)
    if (this.orchestrator) {
      await this.orchestrator.loadPersistedTasks(port).catch(() => {
        /* best-effort */
      });
      const reenqueued = this.orchestrator.list("pending").length;
      const interrupted = this.orchestrator.list("interrupted").length;
      if (reenqueued > 0 || interrupted > 0) {
        this.logger.info(
          `Restored from previous run: ${reenqueued} task(s) re-enqueued, ${interrupted} task(s) interrupted`,
        );
      }
    }

    // 5. Enable activity log disk persistence
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    this.activityLog.setPersistPath(
      path.join(configDir, "ide", `activity-${port}.jsonl`),
    );

    // 6. Check for recent checkpoint from previous run and restore openedFiles
    const prevCheckpoint = SessionCheckpoint.loadLatest(
      5 * 60 * 1000,
      this.config.workspace,
    );
    if (prevCheckpoint) {
      const ageSec = Math.round((Date.now() - prevCheckpoint.savedAt) / 1000);
      const allFiles = extractRestoredFiles(
        prevCheckpoint,
        this.config.workspace,
      );
      if (allFiles.size > 0) {
        this.restoredOpenedFiles = allFiles;
        this.checkpointRestored = { fileCount: allFiles.size, ageSec };
        this.logger.info(
          `Restored ${allFiles.size} tracked file(s) from previous session (${ageSec}s ago, port ${prevCheckpoint.port})`,
        );
      } else {
        this.logger.info(
          `Previous session checkpoint found (${ageSec}s ago, port ${prevCheckpoint.port}) — no files to restore`,
        );
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
    this.checkpoint = new SessionCheckpoint(port, this.config.workspace);
    this.checkpoint.start(() => this._buildCheckpoint(port));

    // Register shutdown handlers
    let shuttingDown = false;
    const shutdown = async (signal: string, exitCode: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (signal === "uncaughtException") {
        // Tool names go to stderr only (not the activity log) to avoid
        // leaking operational detail into activity-log consumers.
        const inFlightTools = [...this.sessions.values()].flatMap(
          (s) => s.transport.getStats().inFlightTools,
        );
        if (inFlightTools.length > 0) {
          this.logger.error(
            `In-flight tools at crash: ${inFlightTools.join(", ")}`,
          );
        }
        this.activityLog?.recordEvent("crash_detected", {
          signal,
          sessions: this.sessions.size,
          inFlightToolCount: inFlightTools.length,
        });
      }
      this.logger.info(`Shutdown initiated by ${signal}`);
      const forceTimer = setTimeout(() => {
        process.exit(exitCode);
      }, SHUTDOWN_TIMEOUT_MS);
      forceTimer.unref();
      await this.stop();
      await shutdownTelemetry();
      process.exit(exitCode);
    };
    // All process-level signal handlers are guarded by globalHandlersRegistered so
    // that repeated start() calls (e.g. in tests or --watch restarts) don't
    // accumulate process.once listeners and trigger MaxListenersExceededWarning.
    if (!globalHandlersRegistered) {
      globalHandlersRegistered = true;
      process.once("SIGINT", () => shutdown("SIGINT", 130));
      process.once("SIGTERM", () => shutdown("SIGTERM", 143));
      process.once("SIGHUP", () => shutdown("SIGHUP", 143));
      process.on("unhandledRejection", (reason) => {
        for (const [sid, session] of this.sessions) {
          const stats = session.transport.getStats();
          if (stats.inFlightTools.length > 0) {
            this.logger.error(
              `Session ${sid.slice(0, 8)} had ${stats.inFlightTools.length} in-flight tool(s): ${stats.inFlightTools.join(", ")}`,
            );
          }
        }
        this.logger.error(
          `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
        );
      });
      process.once("uncaughtException", (err) => {
        for (const [sid, session] of this.sessions) {
          const stats = session.transport.getStats();
          if (stats.inFlightTools.length > 0) {
            this.logger.error(
              `Session ${sid.slice(0, 8)} had ${stats.inFlightTools.length} in-flight tool(s) at crash: ${stats.inFlightTools.join(", ")}`,
            );
          }
        }
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
    this.logger.info(
      this.config.fullMode
        ? "  Tools:      full (~95 tools — git, terminal, file ops, HTTP, GitHub)"
        : "  Tools:      slim (38 IDE tools — pass --full for git/terminal/file ops/HTTP/GitHub)",
    );
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

  /** Start the bridge-level WebSocket keepalive heartbeat. Idempotent. */
  private _startWsHeartbeat(): void {
    if (this.wsHeartbeatInterval || this.config.wsPingIntervalMs === 0) return;
    this.wsHeartbeatInterval = setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (session.graceTimer) continue; // WS already closed, grace pending
        const { ws } = session;
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (!session.wsAlive) {
          this.logger.warn(
            `Session ${id.slice(0, 8)} missed pong — terminating stale WebSocket`,
          );
          ws.terminate(); // triggers 'close' → grace timer
          continue;
        }
        session.wsAlive = false;
        try {
          ws.ping();
        } catch {
          // Socket already broken; close event will fire and start the grace timer
        }
      }
    }, this.config.wsPingIntervalMs);
    this.wsHeartbeatInterval.unref(); // don't prevent Node exit when idle
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.logger.info("Shutting down...");
    this._stopPeriodicSnapshots();
    this.pluginWatcher?.stop();
    this.pluginWatcher = null;
    this.httpMcpHandler?.close();
    if (this.wsHeartbeatInterval) {
      clearInterval(this.wsHeartbeatInterval);
      this.wsHeartbeatInterval = null;
    }
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
    // Flush checkpoint with current session state before cleaning up sessions.
    // The periodic checkpoint writer runs every 30s, so up to 30s of editor
    // state can be lost on SIGTERM without this. The flush runs synchronously
    // so the checkpoint file is complete before we remove the lock file.
    if (this.checkpoint && this.port > 0) {
      try {
        this.checkpoint.write(this._buildCheckpoint(this.port));
      } catch {
        // best-effort — don't prevent clean shutdown
      }
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

    // Send analytics if opted in — awaited with 2s timeout so it completes before process.exit()
    const analyticsOn =
      this.config.analyticsEnabled !== null
        ? this.config.analyticsEnabled
        : getAnalyticsPref();
    if (analyticsOn === true && totalSessions > 0) {
      try {
        const entries = this.activityLog.query({ last: 500 });
        const summary = buildSummary(entries, maxDurationMs, PACKAGE_VERSION);
        await Promise.race([
          sendAnalytics(summary),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {
        // Swallow all errors — analytics must never affect shutdown
      }
    }
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
    // Flush tasks to disk BEFORE cancelling them so the file captures the true
    // pre-shutdown state (pending = still pending, running = interrupted).
    // Cancel AFTER flush so in-flight handlers receive their signal while the
    // transport is still reachable.
    if (this.orchestrator && this.port > 0) {
      this.orchestrator.flushTasksToDisk(this.port);
    }
    if (this.orchestrator) {
      for (const task of [
        ...this.orchestrator.list("pending"),
        ...this.orchestrator.list("running"),
      ]) {
        this.orchestrator.cancel(task.id, "shutdown");
      }
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
