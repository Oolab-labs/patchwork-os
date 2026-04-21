import { listChannels, loadTokens } from "../connectors/slack.js";
import { optionalInt, successStructured } from "./utils.js";

export function createSlackListChannelsTool() {
  return {
    schema: {
      name: "slackListChannels",
      description:
        "List public Slack channels the bot has access to. Returns id, name, member count.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "integer",
            description: "Max channels to return (1–200). Default: 100.",
            minimum: 1,
            maximum: 200,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          channels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                isMember: { type: "boolean" },
                isPrivate: { type: "boolean" },
                numMembers: { type: "number" },
              },
              required: ["id", "name", "isMember", "isPrivate"],
            },
          },
          slackConnected: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["slackConnected"],
      },
    },
    timeoutMs: 15_000,
    async handler(args: Record<string, unknown>, signal?: AbortSignal) {
      const tokens = loadTokens();
      if (!tokens) {
        return successStructured({
          channels: [],
          slackConnected: false,
          error: "Slack not connected. GET /connections/slack/authorize first.",
        });
      }

      const limit = optionalInt(args, "limit", 1, 200) ?? 100;

      try {
        const channels = await listChannels(limit, signal);
        return successStructured({ channels, slackConnected: true });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          channels: [],
          slackConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
