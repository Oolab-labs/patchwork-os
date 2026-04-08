import type { AutomationHooks } from "../automation.js";
import { success } from "./utils.js";

/**
 * Called by a Claude Code CwdChanged hook (CC 2.1.83+) to notify the bridge
 * that the working directory has changed. When the automation policy has an
 * `onCwdChanged` block configured, this enqueues the policy prompt as a
 * Claude task.
 *
 * Example settings.json hook:
 *   "CwdChanged": [{ "command": "claude --mcp ... notifyCwdChanged --cwd $CWD" }]
 *
 * The tool is only registered when --automation is active.
 */
export function createNotifyCwdChangedTool(automationHooks: AutomationHooks) {
  return {
    schema: {
      name: "notifyCwdChanged",
      description:
        "Notify the bridge that Claude Code's working directory changed. " +
        "Triggers the onCwdChanged automation policy if configured. " +
        "Call this from a Claude Code CwdChanged hook (CC 2.1.83+).",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "The new working directory path",
          },
        },
        required: ["cwd"],
        additionalProperties: false,
      },
    },
    handler: async (args: Record<string, unknown>) => {
      const cwd = args.cwd as string;
      automationHooks.handleCwdChanged(cwd);
      return success(`cwd-changed event received for: ${cwd}`);
    },
  };
}
