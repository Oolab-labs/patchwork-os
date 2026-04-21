import { loadTokens, postMessage } from "../connectors/slack.js";
import { optionalString, requireString, successStructured } from "./utils.js";

export function createSlackPostMessageTool() {
  return {
    schema: {
      name: "slackPostMessage",
      description:
        "Post a message to a Slack channel. Use channel name (e.g. 'general') or channel ID. " +
        "Optionally reply in a thread by providing threadTs.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object" as const,
        required: ["channel", "text"],
        properties: {
          channel: {
            type: "string",
            description:
              "Channel name (e.g. 'general') or channel ID (e.g. 'C12345').",
            maxLength: 200,
          },
          text: {
            type: "string",
            description: "Message text (Markdown supported via mrkdwn).",
            maxLength: 40000,
          },
          threadTs: {
            type: "string",
            description:
              "Thread timestamp to reply in. Omit to post as a new message.",
            maxLength: 50,
          },
        },
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          ts: { type: "string" },
          channel: { type: "string" },
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
          ts: "",
          channel: "",
          slackConnected: false,
          error: "Slack not connected. GET /connections/slack/authorize first.",
        });
      }

      const channel = requireString(args, "channel", 200);
      const text = requireString(args, "text", 40000);
      const threadTs = optionalString(args, "threadTs", 50);

      try {
        const result = await postMessage(
          channel,
          text,
          threadTs ?? undefined,
          signal,
        );
        return successStructured({
          ts: result.ts,
          channel: result.channel,
          slackConnected: true,
        });
      } catch (err) {
        const notConnected =
          err instanceof Error && err.message.includes("not connected");
        return successStructured({
          ts: "",
          channel: "",
          slackConnected: !notConnected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
