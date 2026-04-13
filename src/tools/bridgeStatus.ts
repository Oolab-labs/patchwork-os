import type { AutomationHooks } from "../automation.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { ExtensionClient } from "../extensionClient.js";
import type { ProbeResults } from "../probe.js";
import { successStructured } from "./utils.js";

const startTime = Date.now();

export interface DisconnectInfo {
  at: string | null;
  code: number | null;
  reason: string | null;
}

/**
 * Table of known tools with their availability requirements. Populated manually
 * from src/tools/index.ts registration — a drift-guard test that walks the
 * registry is a follow-up. Tools NOT in this table are assumed always available
 * (pure-bridge tools like gitCommit that don't depend on probes or the extension).
 *
 * Used by the toolAvailability field in getBridgeStatus to answer
 * "why can't Claude call X?" in a single call.
 */
const TOOL_AVAILABILITY_TABLE: Record<
  string,
  { probe?: keyof ProbeResults; extensionRequired?: boolean }
> = {
  // Extension-required tools (schema.extensionRequired: true)
  findImplementations: { extensionRequired: true },
  getHoverAtCursor: { extensionRequired: true },
  getTypeHierarchy: { extensionRequired: true },
  getWorkspaceSettings: { extensionRequired: true },
  setWorkspaceSetting: { extensionRequired: true },
  setEditorDecorations: { extensionRequired: true },
  clearEditorDecorations: { extensionRequired: true },
  getSemanticTokens: { extensionRequired: true },
  getCodeLens: { extensionRequired: true },
  // Probe-gated CLI/formatter tools (extension path also works when connected)
  formatDocument: { probe: "prettier" },
  runTests: { probe: "vitest" },
  getGitStatus: { probe: "git" },
  getGitDiff: { probe: "git" },
  getGitLog: { probe: "git" },
  githubListPRs: { probe: "gh" },
  githubCreatePR: { probe: "gh" },
  githubViewPR: { probe: "gh" },
};

export function createBridgeStatusTool(
  extensionClient: ExtensionClient,
  probes: ProbeResults,
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
          toolAvailability: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                available: { type: "boolean" },
                reason: { type: "string" },
              },
              required: ["available"],
            },
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

      // Compute tool availability: answers "why can't Claude call X?" without
      // requiring the caller to try the tool first and parse the error.
      const toolAvailability: Record<
        string,
        { available: boolean; reason?: string }
      > = {};
      for (const [name, spec] of Object.entries(TOOL_AVAILABILITY_TABLE)) {
        if (spec.extensionRequired && !extensionConnected) {
          toolAvailability[name] = {
            available: false,
            reason: "extension_disconnected",
          };
        } else if (spec.extensionRequired && circuitBreaker.suspended) {
          toolAvailability[name] = {
            available: false,
            reason: "circuit_breaker_open",
          };
        } else if (spec.probe && !probes[spec.probe]) {
          toolAvailability[name] = {
            available: false,
            reason: `missing_probe:${spec.probe}`,
          };
        } else {
          toolAvailability[name] = { available: true };
        }
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
        toolAvailability,
      });
    },
  };
}
