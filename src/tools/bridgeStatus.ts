import type { AutomationHooks } from "../automation.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { ExtensionClient } from "../extensionClient.js";
import { successStructured } from "./utils.js";

const startTime = Date.now();

export interface DisconnectInfo {
  at: string | null;
  code: number | null;
  reason: string | null;
}

export function createBridgeStatusTool(
  extensionClient: ExtensionClient,
  sessions?: Map<string, unknown>,
  orchestrator?: ClaudeOrchestrator | null,
  automationHooks?: AutomationHooks | null,
  getDisconnectInfo?: () => DisconnectInfo,
) {
  return {
    schema: {
      name: "getBridgeStatus",
      description:
        "Get the current status of the IDE bridge: extension connection state, circuit breaker status, and uptime.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object",
        properties: {
          extensionConnected: { type: "boolean" },
          activeSessions: { type: "integer" },
          circuitBreaker: {
            type: "object",
            properties: {
              suspended: { type: "boolean" },
              consecutiveFailures: { type: "integer" },
              resumesInMs: { type: "integer" },
            },
            required: ["suspended", "consecutiveFailures"],
          },
          uptimeSeconds: { type: "integer" },
          latencyMs: { type: ["integer", "null"] },
          connectionQuality: {
            type: "string",
            enum: ["healthy", "degraded", "poor"],
          },
          tier: { type: "string", enum: ["full", "basic"] },
          tierDescription: { type: "string" },
          hint: { type: "string" },
          suggestedActions: { type: "array", items: { type: "string" } },
          lastDisconnect: {
            type: "object",
            properties: {
              at: { type: ["string", "null"] },
              code: { type: ["integer", "null"] },
              reason: { type: ["string", "null"] },
            },
            required: ["at", "code", "reason"],
          },
        },
        required: [
          "extensionConnected",
          "activeSessions",
          "circuitBreaker",
          "uptimeSeconds",
          "tier",
        ],
      },
    },
    handler: async () => {
      const extensionConnected = extensionClient.isConnected();
      const circuitBreaker = extensionClient.getCircuitBreakerState();
      const uptimeMs = Date.now() - startTime;
      const latencyMs = extensionConnected ? extensionClient.lastRttMs : null;
      const connectionQuality =
        latencyMs === null
          ? undefined
          : latencyMs < 100
            ? ("healthy" as const)
            : latencyMs < 500
              ? ("degraded" as const)
              : ("poor" as const);

      const automationStatus = automationHooks?.getStatus() ?? null;
      const unwired = automationStatus?.unwiredEnabledHooks ?? [];

      const baseSuggestedActions = extensionConnected
        ? [
            "Use explainSymbol to understand any function in one call",
            "Use refactorPreview to see what a refactoring would change before applying",
            "Use setEditorDecorations to highlight code review findings inline",
          ]
        : [
            "Connect the VS Code extension for LSP, debugger, and terminal tools",
            "File operations, Git, GitHub, and CLI tools are available without the extension",
          ];

      if (unwired.length > 0) {
        baseSuggestedActions.push(
          `Automation hooks enabled but not wired in settings.json: ${unwired.join(", ")}. ` +
            `Add CC hook entries calling the bridge notify tools (see CLAUDE.md Automation Policy section).`,
        );
      }

      return successStructured({
        extensionConnected,
        activeSessions: sessions?.size ?? 1,
        circuitBreaker: {
          suspended: circuitBreaker.suspended,
          consecutiveFailures: circuitBreaker.failures,
          ...(circuitBreaker.suspended && {
            resumesInMs: Math.max(
              0,
              circuitBreaker.suspendedUntil - Date.now(),
            ),
          }),
        },
        uptimeSeconds: Math.round(uptimeMs / 1000),
        latencyMs: latencyMs ?? null,
        ...(connectionQuality !== undefined && { connectionQuality }),
        ...(orchestrator !== null &&
          orchestrator !== undefined && {
            tokenBudget: {
              activeTokens: orchestrator.activeTokens,
              maxTokenBudget: ClaudeOrchestrator.MAX_TOKEN_BUDGET,
            },
          }),
        ...(automationStatus !== null && { automation: automationStatus }),
        tier: extensionConnected ? "full" : "basic",
        tierDescription: extensionConnected
          ? "All tools available including LSP, debugger, and terminal integration"
          : "File operations, Git, GitHub, and CLI tools available. Connect the VS Code extension for LSP, debugger, and terminal tools.",
        suggestedActions: baseSuggestedActions,
        hint: extensionConnected
          ? "All tools available."
          : "Extension disconnected — extension-dependent tools (LSP, terminal, debugging, etc.) are temporarily unavailable. " +
            "Native tools (file search, git, GitHub) still work. " +
            "The extension will auto-reconnect, or the user can run the 'Claude IDE Bridge: Reconnect' command.",
        ...(getDisconnectInfo && {
          lastDisconnect: getDisconnectInfo(),
        }),
      });
    },
  };
}
