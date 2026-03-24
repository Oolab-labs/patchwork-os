import type { ToolHandler, ToolSchema } from "../transport.js";
import type { ChildBridgeRegistry } from "./childBridgeRegistry.js";
import type { OrchestratorConfig } from "./orchestratorConfig.js";

interface OrchestratorToolDeps {
  registry: ChildBridgeRegistry;
  config: OrchestratorConfig;
  startedAt: number;
  getActiveSessions: () => number;
  setStickyBridge: (port: number) => void;
}

export interface OrchestratorTool {
  schema: ToolSchema;
  handler: ToolHandler;
}

export function createOrchestratorTools(
  deps: OrchestratorToolDeps,
): OrchestratorTool[] {
  return [
    createGetOrchestratorStatusTool(deps),
    createListBridgesTool(deps),
    createSwitchWorkspaceTool(deps),
    createListWorkspacesTool(deps),
  ];
}

function createGetOrchestratorStatusTool(
  deps: OrchestratorToolDeps,
): OrchestratorTool {
  return {
    schema: {
      name: "getOrchestratorStatus",
      description:
        "Show the orchestrator bridge status: which IDE instances are connected, their workspaces, health, and how many Claude sessions are active.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const uptimeSeconds = Math.floor((Date.now() - deps.startedAt) / 1000);
      const bridges = deps.registry.getAll().map((b) => ({
        port: b.port,
        ideName: b.ideName,
        workspace: b.workspace,
        healthy: b.healthy,
        warmingUp: b.warmingUp,
        toolCount: b.tools.length,
        lastCheckedAt: b.lastCheckedAt,
        consecutiveFailures: b.consecutiveFailures,
        discoveredAt: b.discoveredAt,
      }));

      const text = JSON.stringify(
        {
          orchestratorPort: deps.config.port,
          uptimeSeconds,
          activeSessions: deps.getActiveSessions(),
          childBridges: bridges,
          skippedLockFiles: deps.registry.getRejected().length,
        },
        null,
        2,
      );

      return { content: [{ type: "text", text }] };
    },
  };
}

function createListBridgesTool(deps: OrchestratorToolDeps): OrchestratorTool {
  return {
    schema: {
      name: "listBridges",
      description:
        "List all known IDE bridge instances (healthy and unhealthy) with their ports, workspace paths, and connection details.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const bridges = deps.registry.getAll().map((b) => ({
        port: b.port,
        ideName: b.ideName,
        workspace: b.workspace,
        workspaceFolders: b.workspaceFolders,
        healthy: b.healthy,
        warmingUp: b.warmingUp,
        pid: b.pid,
        startedAt: new Date(b.startedAt).toISOString(),
        discoveredAt: new Date(b.discoveredAt).toISOString(),
        lastCheckedAt: b.lastCheckedAt
          ? new Date(b.lastCheckedAt).toISOString()
          : null,
        consecutiveFailures: b.consecutiveFailures,
        availableTools: b.tools.map((t) => t.name),
      }));

      const rejected = deps.registry.getRejected();

      const parts: string[] = [];

      if (bridges.length === 0 && rejected.length === 0) {
        parts.push(
          "No child bridges found. Make sure at least one IDE is running with the claude-ide-bridge extension installed.",
        );
      } else {
        if (bridges.length > 0) {
          parts.push(JSON.stringify(bridges, null, 2));
        }
        if (rejected.length > 0) {
          parts.push(
            "\n[INFO] Skipped lock files (non-bridge or invalid processes):",
          );
          for (const r of rejected) {
            parts.push(`  port ${r.port}: ${r.reason}`);
          }
        }
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    },
  };
}

function createSwitchWorkspaceTool(
  deps: OrchestratorToolDeps,
): OrchestratorTool {
  return {
    schema: {
      name: "switchWorkspace",
      description:
        "Switch the current session to target a specific workspace. All subsequent tool calls will be routed to the IDE bridge that owns that workspace. Use listBridges to see available workspaces.",
      inputSchema: {
        type: "object",
        required: ["workspace"],
        additionalProperties: false,
        properties: {
          workspace: {
            type: "string",
            description: "Absolute path to the workspace to switch to",
          },
          port: {
            type: "number",
            description:
              "Port number of a specific bridge to target — required when the same workspace is open in multiple IDEs simultaneously",
          },
        },
      },
      annotations: { readOnlyHint: false },
    },
    handler: async (args) => {
      const workspace = args.workspace as string;
      const port = args.port as number | undefined;

      // If a specific port was provided, bypass workspace routing entirely
      if (port !== undefined) {
        const bridge = deps.registry.get(port);
        if (!bridge) {
          return {
            content: [
              {
                type: "text",
                text: `No bridge found on port ${port}. Call listBridges to see available bridges.`,
              },
            ],
          };
        }
        if (!bridge.healthy) {
          return {
            content: [
              {
                type: "text",
                text: `Bridge on port ${port} (${bridge.ideName}) is not healthy (${bridge.consecutiveFailures} consecutive failures). Try a different bridge.`,
              },
            ],
          };
        }
        deps.setStickyBridge(bridge.port);
        return {
          content: [
            {
              type: "text",
              text: `Switched to: ${bridge.workspace}\nIDE: ${bridge.ideName} (port ${bridge.port})\nTools available: ${bridge.tools.length}`,
            },
          ],
        };
      }

      // Check for duplicate workspaces before picking
      const dupes = deps.registry.getDuplicateWorkspaces();
      const ambiguous = dupes.get(workspace);
      if (ambiguous && ambiguous.length > 1) {
        const options = ambiguous
          .map((b) => `  port ${b.port}: ${b.ideName}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: [
                `Workspace "${workspace}" is open in ${ambiguous.length} IDE instances:`,
                options,
                "",
                `Call switchWorkspace again with the "port" argument to specify which one.`,
              ].join("\n"),
            },
          ],
        };
      }

      const bridge = deps.registry.pickForWorkspace(workspace);
      if (!bridge) {
        const healthy = deps.registry.getHealthy();
        const warming = deps.registry.getWarmingUp();
        let hint: string;
        if (warming.length > 0) {
          hint = `Some bridges are still starting up: ${warming.map((b) => `${b.ideName} port ${b.port}`).join(", ")}. Try again in a moment.`;
        } else if (healthy.length > 0) {
          hint = `Available workspaces: ${healthy.map((b) => b.workspace).join(", ")}`;
        } else {
          hint = "No healthy bridges are currently connected.";
        }
        return {
          content: [
            {
              type: "text",
              text: `No bridge found for workspace: ${workspace}\n${hint}`,
            },
          ],
        };
      }

      deps.setStickyBridge(bridge.port);

      return {
        content: [
          {
            type: "text",
            text: `Switched to workspace: ${bridge.workspace}\nIDE: ${bridge.ideName} (port ${bridge.port})\nTools available: ${bridge.tools.length}`,
          },
        ],
      };
    },
  };
}

function createListWorkspacesTool(
  deps: OrchestratorToolDeps,
): OrchestratorTool {
  return {
    schema: {
      name: "listWorkspaces",
      description:
        "List all currently available IDE workspaces. Call this to discover which workspaces you can work in before using workspace-specific tools.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    handler: async () => {
      const healthy = deps.registry.getHealthy();
      const warming = deps.registry.getWarmingUp();
      const dupes = deps.registry.getDuplicateWorkspaces();

      if (healthy.length === 0 && warming.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No IDE workspaces are currently available. Make sure at least one IDE is running with the extension connected.",
            },
          ],
        };
      }

      const lines: string[] = [];

      if (healthy.length > 0) {
        lines.push("Available workspaces:");
        healthy.forEach((b, i) => {
          const isDupe = dupes.has(b.workspace);
          const dupeWarning = isDupe
            ? (() => {
                const others = dupes
                  .get(b.workspace)
                  ?.filter((o) => o.port !== b.port)
                  .map((o) => `${o.ideName} (port ${o.port})`)
                  .join(", ");
                return `\n  [WARNING: same workspace also open in ${others}]`;
              })()
            : "";
          lines.push(
            `ws${i + 1}: ${b.workspace}\n  IDE: ${b.ideName} (port ${b.port})\n  Folders: ${b.workspaceFolders.join(", ")}${dupeWarning}`,
          );
        });
      }

      if (warming.length > 0) {
        lines.push("\nStarting up (not yet ready):");
        for (const b of warming) {
          const elapsed = Math.round((Date.now() - b.discoveredAt) / 1000);
          lines.push(
            `  ${b.workspace} — ${b.ideName} port ${b.port} (${elapsed}s elapsed)`,
          );
        }
      }

      lines.push("\nUse switchWorkspace to target a specific one.");
      if (dupes.size > 0) {
        lines.push(
          "Use switchWorkspace with the port argument to disambiguate when multiple IDEs share a workspace.",
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  };
}
