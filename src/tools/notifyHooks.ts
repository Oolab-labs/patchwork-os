import type { AutomationHooks } from "../automation.js";
import { successStructured } from "./utils.js";

/**
 * Called by a Claude Code PostCompact hook (CC 2.1.76+) to notify the bridge
 * that the conversation context was just compacted. Triggers onPostCompact.
 *
 * Example settings.json hook:
 *   "PostCompact": [{ "command": "claude --mcp ... notifyPostCompact" }]
 */
export function createNotifyPostCompactTool(automationHooks: AutomationHooks) {
  return {
    schema: {
      name: "notifyPostCompact",
      description:
        "Notify the bridge that Claude Code just compacted its context. " +
        "Triggers the onPostCompact automation policy if configured. " +
        "Call this from a Claude Code PostCompact hook (CC 2.1.76+).",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          received: { type: "boolean" },
        },
        required: ["received"],
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      automationHooks.handlePostCompact();
      return successStructured({ received: true });
    },
  };
}

/**
 * Called by a Claude Code InstructionsLoaded hook (CC 2.1.76+) to notify the
 * bridge that the session started or CLAUDE.md was reloaded. Triggers
 * onInstructionsLoaded.
 *
 * Example settings.json hook:
 *   "InstructionsLoaded": [{ "command": "claude --mcp ... notifyInstructionsLoaded" }]
 */
export function createNotifyInstructionsLoadedTool(
  automationHooks: AutomationHooks,
) {
  return {
    schema: {
      name: "notifyInstructionsLoaded",
      description:
        "Notify the bridge that Claude Code loaded or reloaded its instructions. " +
        "Triggers the onInstructionsLoaded automation policy if configured. " +
        "Call this from a Claude Code InstructionsLoaded hook (CC 2.1.76+).",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          received: { type: "boolean" },
        },
        required: ["received"],
      },
    },
    handler: async (_args: Record<string, unknown>) => {
      automationHooks.handleInstructionsLoaded();
      return successStructured({ received: true });
    },
  };
}

/**
 * Called by a Claude Code TaskCreated hook (CC 2.1.84+) to notify the bridge
 * that a subagent task was created. Triggers onTaskCreated.
 *
 * Example settings.json hook:
 *   "TaskCreated": [{ "command": "claude --mcp ... notifyTaskCreated --taskId $TASK_ID --prompt $PROMPT" }]
 */
export function createNotifyTaskCreatedTool(automationHooks: AutomationHooks) {
  return {
    schema: {
      name: "notifyTaskCreated",
      description:
        "Notify the bridge that Claude Code created a subagent task. " +
        "Triggers the onTaskCreated automation policy if configured. " +
        "Call this from a Claude Code TaskCreated hook (CC 2.1.84+).",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {
          taskId: {
            type: "string",
            description: "The task ID assigned by Claude Code",
          },
          prompt: {
            type: "string",
            description:
              "The prompt given to the subagent (truncated to 500 chars)",
          },
        },
        required: ["taskId", "prompt"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          received: { type: "boolean" },
          taskId: { type: "string" },
        },
        required: ["received", "taskId"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const taskId = args.taskId as string;
      const prompt = args.prompt as string;
      automationHooks.handleTaskCreated({ taskId, prompt });
      return successStructured({ received: true, taskId });
    },
  };
}

/**
 * Called by a Claude Code PermissionDenied hook (CC 2.1.89+) to notify the
 * bridge that a tool call was blocked. Triggers onPermissionDenied.
 *
 * Example settings.json hook:
 *   "PermissionDenied": [{ "command": "claude --mcp ... notifyPermissionDenied --tool $TOOL --reason $REASON" }]
 */
export function createNotifyPermissionDeniedTool(
  automationHooks: AutomationHooks,
) {
  return {
    schema: {
      name: "notifyPermissionDenied",
      description:
        "Notify the bridge that Claude Code blocked a tool call. " +
        "Triggers the onPermissionDenied automation policy if configured. " +
        "Call this from a Claude Code PermissionDenied hook (CC 2.1.89+).",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {
          tool: {
            type: "string",
            description: "The tool name that was denied",
          },
          reason: {
            type: "string",
            description: "The reason the tool call was blocked",
          },
        },
        required: ["tool", "reason"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          received: { type: "boolean" },
          tool: { type: "string" },
        },
        required: ["received", "tool"],
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const tool = args.tool as string;
      const reason = args.reason as string;
      automationHooks.handlePermissionDenied({ tool, reason });
      return successStructured({ received: true, tool });
    },
  };
}
