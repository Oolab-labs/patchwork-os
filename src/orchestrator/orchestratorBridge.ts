import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { ErrorCodes } from "../errors.js";
import { LockFileManager } from "../lockfile.js";
import { Logger } from "../logger.js";
import { Server } from "../server.js";
import { McpTransport } from "../transport.js";
import type { ToolSchema } from "../transport.js";
import { PACKAGE_VERSION } from "../version.js";
import { ChildBridgeClient } from "./childBridgeClient.js";
import { ChildBridgeRegistry } from "./childBridgeRegistry.js";
import type { OrchestratorConfig } from "./orchestratorConfig.js";
import { createOrchestratorTools } from "./orchestratorTools.js";

interface OrchestratorSession {
  id: string;
  ws: WebSocket;
  transport: McpTransport;
  stickyBridgePort: number | null;
  connectedAt: number;
}

export class OrchestratorBridge {
  private logger: Logger;
  private server: Server;
  private lockFile: LockFileManager;
  private registry: ChildBridgeRegistry;
  private clients = new Map<number, ChildBridgeClient>();
  private sessions = new Map<string, OrchestratorSession>();
  private authToken: string;
  private startedAt = Date.now();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: OrchestratorConfig) {
    this.logger = new Logger(config.verbose, config.jsonl);
    this.lockFile = new LockFileManager(this.logger);
    this.registry = new ChildBridgeRegistry(
      config.lockDir,
      config.healthIntervalMs,
      config.port,
    );
    this.authToken = config.fixedToken ?? randomUUID();
    this.server = new Server(this.authToken, this.logger);
  }

  async start(): Promise<void> {
    this.logger.info(
      `Orchestrator bridge starting on port ${this.config.port}`,
    );

    // Discover child bridges
    this.registry.start();

    // Initial health probe
    await this.probeAll();

    // Start health probe loop
    this.healthTimer = setInterval(async () => {
      this.registry.refresh();
      await this.probeAll();
    }, this.config.healthIntervalMs);
    this.healthTimer.unref();

    // Start HTTP/WS server
    this.server.on("connection", (ws: WebSocket) => this.handleConnection(ws));

    await this.server.listen(this.config.port, this.config.bindAddress);

    // Write lock file with orchestrator: true
    this.lockFile.write(this.config.port, this.authToken, [], "Orchestrator", {
      orchestrator: true,
    });

    this.setupShutdownHandlers();

    this.logger.info(
      `Orchestrator bridge ready on port ${this.config.port} (token: ${this.authToken.slice(0, 8)}...)`,
    );
    this.logger.info(
      `Monitoring ${this.registry.getAll().length} child bridge(s)`,
    );
  }

  private async probeAll(): Promise<void> {
    const bridges = this.registry.getAll();
    await Promise.all(
      bridges.map(async (b) => {
        let client = this.clients.get(b.port);
        if (!client) {
          client = new ChildBridgeClient(b.port, b.authToken);
          this.clients.set(b.port, client);
        }

        const alive = await client.ping();
        const elapsed = Date.now() - b.discoveredAt;
        const inGrace = b.warmingUp && elapsed < 15_000;

        if (alive) {
          // First success for a warming bridge — reset any startup failure counts
          if (b.warmingUp) {
            client.resetCircuit();
          }
          // Always re-fetch tools so plugin hot-reloads are reflected in new sessions.
          // For existing sessions, re-register proxied tools and notify clients if the
          // tool list changed (e.g., after a plugin reload in the child bridge).
          const prevToolNames = b.tools.map((t) => t.name).join(",");
          const tools = await client.listTools();
          const nextToolNames = tools.map((t: ToolSchema) => t.name).join(",");
          this.registry.markHealthy(b.port, tools);

          if (prevToolNames !== nextToolNames && this.sessions.size > 0) {
            this.logger.info(
              `Tool list changed for bridge port ${b.port} — refreshing ${this.sessions.size} session(s)`,
            );
            for (const session of this.sessions.values()) {
              this.registerProxiedTools(session.transport, session.id);
              if (session.ws.readyState === 1 /* OPEN */) {
                McpTransport.sendNotification(
                  session.ws,
                  "notifications/tools/list_changed",
                  undefined,
                  this.logger,
                );
              }
            }
          }
        } else if (inGrace) {
          // Still within startup grace window — don't penalise, just wait
          this.registry.keepWarm(b.port);
          this.logger.debug(
            `Bridge port ${b.port} (${b.ideName}) warming up — ${Math.round(elapsed / 1000)}s elapsed`,
          );
        } else {
          // Grace window expired or bridge was already healthy — count the failure
          if (b.warmingUp) this.registry.markWarm(b.port);
          this.registry.markUnhealthy(b.port);
          await client.closeSession().catch(() => {});
        }
      }),
    );
  }

  private handleConnection(ws: WebSocket): void {
    const sessionId = randomUUID();
    const transport = new McpTransport(this.logger);

    // Build the workspace-aware instructions string
    const instructions = this.buildInstructions();
    transport.setInstructions(instructions);

    // Register orchestrator-native tools
    const tools = createOrchestratorTools({
      registry: this.registry,
      config: this.config,
      startedAt: this.startedAt,
      getActiveSessions: () => this.sessions.size,
      setStickyBridge: (port) => {
        const s = this.sessions.get(sessionId);
        if (s) s.stickyBridgePort = port;
      },
    });

    for (const tool of tools) {
      transport.registerTool(tool.schema, tool.handler);
    }

    // Register proxied tools from all healthy child bridges
    this.registerProxiedTools(transport, sessionId);

    const session: OrchestratorSession = {
      id: sessionId,
      ws,
      transport,
      stickyBridgePort: null,
      connectedAt: Date.now(),
    };
    this.sessions.set(sessionId, session);

    transport.attach(ws);
    // Auth was already validated at WebSocket upgrade time (server.ts).
    // Mark the transport ready immediately so tool calls work even when
    // the MCP client reconnects without re-sending the initialize handshake
    // (e.g. after an orchestrator restart or dropped connection).
    transport.markInitialized();

    ws.on("close", () => {
      this.sessions.delete(sessionId);
      this.logger.debug(`Session closed: ${sessionId.slice(0, 8)}`);
    });

    this.logger.info(`Client connected: session ${sessionId.slice(0, 8)}`);
  }

  private registerProxiedTools(
    transport: McpTransport,
    sessionId: string,
  ): void {
    const healthy = this.registry.getHealthy();
    const toolNameCount = new Map<string, number>();

    // Count tool name occurrences to detect cross-bridge conflicts
    for (const b of healthy) {
      for (const tool of b.tools) {
        toolNameCount.set(tool.name, (toolNameCount.get(tool.name) ?? 0) + 1);
      }
    }

    // Count ideName occurrences — if two bridges share the same IDE name
    // (e.g. two VS Code windows), add port to the suffix for disambiguation
    const ideNameCount = new Map<string, number>();
    for (const b of healthy) {
      ideNameCount.set(b.ideName, (ideNameCount.get(b.ideName) ?? 0) + 1);
    }

    for (const b of healthy) {
      const ideTag = b.ideName.replace(/[^a-zA-Z0-9]/g, "");
      const ideNameAmbiguous = (ideNameCount.get(b.ideName) ?? 0) > 1;
      // Use port suffix only when two bridges share the same ideName
      const suffix =
        healthy.length > 1
          ? `__${ideTag}${ideNameAmbiguous ? `_${b.port}` : ""}`
          : "";

      for (const tool of b.tools) {
        const hasConflict = (toolNameCount.get(tool.name) ?? 0) > 1;
        const proxyName = hasConflict ? `${tool.name}${suffix}` : tool.name;

        if (!/^[a-zA-Z0-9_]+$/.test(proxyName)) continue;

        const capturedPort = b.port;
        const capturedToolName = tool.name;

        transport.registerTool(
          {
            ...tool,
            name: proxyName,
            description: `[${b.ideName}: ${b.workspace}] ${tool.description}`,
          },
          async (args, signal) => {
            return this.routeToolCall(
              capturedToolName,
              args,
              this.sessions.get(sessionId) ?? null,
              signal,
              capturedPort,
            );
          },
        );
      }
    }
  }

  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    session: OrchestratorSession | null,
    signal?: AbortSignal,
    preferredPort?: number,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Determine target bridge
    let targetPort = preferredPort ?? session?.stickyBridgePort ?? null;

    if (!targetPort) {
      // Try workspace from args
      const workspaceArg = args.workspace ?? args.path ?? args.file;
      if (typeof workspaceArg === "string") {
        const bridge = this.registry.pickForWorkspace(workspaceArg);
        if (bridge) targetPort = bridge.port;
      }
    }

    if (!targetPort) {
      const best = this.registry.pickBest();
      if (best) {
        targetPort = best.port;
        // Set sticky affinity on first successful route
        if (session && !session.stickyBridgePort) {
          session.stickyBridgePort = best.port;
        }
      }
    }

    if (!targetPort) {
      const all = this.registry.getAll();
      const warming = this.registry.getWarmingUp();
      let detail: string;
      if (all.length === 0) {
        detail =
          "No IDE bridges found. Make sure at least one IDE is running with the extension installed.";
      } else if (warming.length > 0) {
        const warmingDesc = warming
          .map(
            (b) =>
              `${b.ideName} port ${b.port} (warming up, ${Math.round((Date.now() - b.discoveredAt) / 1000)}s elapsed)`,
          )
          .join(", ");
        detail = `IDE bridge(s) are starting up: ${warmingDesc}. Retry in a few seconds.`;
      } else {
        detail = `Known bridges (all unhealthy): ${all.map((b) => `${b.ideName} port ${b.port} (${b.consecutiveFailures} failures)`).join(", ")}`;
      }

      return {
        content: [
          {
            type: "text",
            text: `[ORCHESTRATOR ERROR] No healthy bridge available to handle tool "${toolName}".\n${detail}`,
          },
        ],
      };
    }

    const client = this.clients.get(targetPort);
    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: `[ORCHESTRATOR ERROR] Internal error: no client for bridge port ${targetPort}`,
          },
        ],
      };
    }

    try {
      return await client.callTool(toolName, args, signal);
    } catch (err) {
      const isBridgeError =
        err instanceof Error &&
        (err as { code?: unknown }).code === ErrorCodes.BRIDGE_UNAVAILABLE;

      this.logger.warn(
        `Tool "${toolName}" failed on bridge port ${targetPort}: ${err instanceof Error ? err.message : String(err)}`,
      );

      if (isBridgeError && session?.stickyBridgePort === targetPort) {
        // Clear sticky affinity — bridge is dead
        session.stickyBridgePort = null;
      }

      // Hard error — do not silently re-route (session state may be inconsistent)
      const bridgeInfo = this.registry.get(targetPort);
      return {
        content: [
          {
            type: "text",
            text: [
              `[BRIDGE_UNAVAILABLE] Child bridge on port ${targetPort} (${bridgeInfo?.ideName ?? "unknown"}) is unavailable.`,
              `Tool "${toolName}" was not executed.`,
              `Last successful workspace: ${bridgeInfo?.workspace ?? "unknown"}`,
              `Reason: ${err instanceof Error ? err.message : String(err)}`,
              "",
              "Call listBridges to see current bridge status, or switchWorkspace to target a different IDE.",
            ].join("\n"),
          },
        ],
      };
    }
  }

  private buildInstructions(): string {
    const healthy = this.registry.getHealthy();
    const warming = this.registry.getWarmingUp();
    const dupes = this.registry.getDuplicateWorkspaces();
    const lines = [
      `You are connected to the claude-ide-bridge orchestrator (v${PACKAGE_VERSION}).`,
      "",
    ];

    if (healthy.length === 0 && warming.length === 0) {
      lines.push(
        "No IDE workspaces are currently connected. Call listWorkspaces to check for newly connected IDEs.",
      );
    } else {
      if (healthy.length > 0) {
        lines.push("Available IDE workspaces:");
        healthy.forEach((b, i) => {
          lines.push(
            `  ws${i + 1}: ${b.workspace} (${b.ideName}, port ${b.port})`,
          );
        });
      }
      if (warming.length > 0) {
        lines.push("Starting up (not yet ready):");
        for (const b of warming) {
          const elapsed = Math.round((Date.now() - b.discoveredAt) / 1000);
          lines.push(
            `  ${b.workspace} (${b.ideName}, port ${b.port}) — ${elapsed}s elapsed`,
          );
        }
      }
      lines.push("");
      lines.push(
        "Tools from each workspace are available with the IDE name as a suffix when names conflict.",
      );
      lines.push(
        "Call listWorkspaces to refresh this list. Call switchWorkspace to explicitly target a workspace.",
      );
      if (dupes.size > 0) {
        lines.push("");
        lines.push(
          "[CAUTION] The following workspaces are open in multiple IDEs simultaneously:",
        );
        for (const [ws, bridges] of dupes) {
          lines.push(
            `  ${ws} → ${bridges.map((b) => `${b.ideName} (port ${b.port})`).join(", ")}`,
          );
        }
        lines.push(
          "Use switchWorkspace with the port argument to target a specific IDE.",
        );
      }
    }

    return lines.join("\n");
  }

  private setupShutdownHandlers(): void {
    const shutdown = async () => {
      this.logger.info("Orchestrator shutting down...");

      if (this.healthTimer) {
        clearInterval(this.healthTimer);
      }
      this.registry.stop();

      // Close all child sessions
      await Promise.all(
        Array.from(this.clients.values()).map((c) =>
          c.closeSession().catch(() => {}),
        ),
      );

      for (const c of this.clients.values()) c.destroy();

      this.lockFile.delete();
      this.server.close();
      process.exit(0);
    };

    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  }
}
