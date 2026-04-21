import { getProfile, loadTokens } from "../connectors/slack.js";
import { successStructured } from "./utils.js";

export function createFetchSlackProfileTool() {
  return {
    schema: {
      name: "fetchSlackProfile",
      description:
        "Get the connected Slack workspace name, team ID, and bot user ID. Use to confirm Slack is connected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          teamId: { type: "string" },
          teamName: { type: "string" },
          botUserId: { type: "string" },
          slackConnected: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["slackConnected"],
      },
    },
    timeoutMs: 5_000,
    async handler(_args: Record<string, unknown>, _signal?: AbortSignal) {
      const tokens = loadTokens();
      if (!tokens) {
        return successStructured({
          slackConnected: false,
          error: "Slack not connected. GET /connections/slack/authorize first.",
        });
      }
      const profile = getProfile();
      if (!profile) {
        return successStructured({
          slackConnected: false,
          error: "Could not load Slack profile.",
        });
      }
      return successStructured({ ...profile, slackConnected: true });
    },
  };
}
