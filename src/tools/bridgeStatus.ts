import { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { ExtensionClient } from "../extensionClient.js";
import { success } from "./utils.js";

const startTime = Date.now();

export function createBridgeStatusTool(
  extensionClient: ExtensionClient,
  sessions?: Map<string, unknown>,
  orchestrator?: ClaudeOrchestrator | null,
) {
  return {
    schema: {
      name: "getBridgeStatus",
      description:
        "Get the current status of the IDE bridge, including extension connection state, " +
        "circuit breaker status, and uptime. Use this to diagnose when tools are " +
        "unavailable or the extension appears disconnected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
    },
    handler: async () => {
      const extensionConnected = extensionClient.isConnected();
      const circuitBreaker = extensionClient.getCircuitBreakerState();
      const uptimeMs = Date.now() - startTime;

      return success({
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
        ...(orchestrator !== null &&
          orchestrator !== undefined && {
            tokenBudget: {
              activeTokens: orchestrator.activeTokens,
              maxTokenBudget: ClaudeOrchestrator.MAX_TOKEN_BUDGET,
            },
          }),
        hint: extensionConnected
          ? "All tools available."
          : "Extension disconnected — extension-dependent tools (LSP, terminal, debugging, etc.) are temporarily unavailable. " +
            "Native tools (file search, git, GitHub) still work. " +
            "The extension will auto-reconnect, or the user can run the 'Claude IDE Bridge: Reconnect' command.",
      });
    },
  };
}
