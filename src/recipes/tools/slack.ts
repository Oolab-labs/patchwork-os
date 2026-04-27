/**
 * Slack tools — slack.post_message
 *
 * Self-registering tool module for the recipe tool registry.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// slack.post_message
// ============================================================================

registerTool({
  id: "slack.post_message",
  namespace: "slack",
  description:
    "Post a message to a Slack channel (requires Slack connector auth).",
  paramsSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name or ID (e.g., 'general', 'C123456')",
        default: "general",
      },
      text: {
        type: "string",
        description: "Message text (supports {{template}} substitution)",
      },
      blocks: {
        type: "array",
        description:
          "Slack Block Kit blocks array (optional, used instead of text)",
        items: { type: "object" },
      },
      thread_ts: {
        type: "string",
        description: "Thread timestamp to reply in a thread (optional)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      ts: { type: "string" },
      channel: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    assertWriteAllowed("slack.post_message");
    const { postMessage, loadTokens: loadSlackTokens } = await import(
      "../../connectors/slack.js"
    );

    if (!loadSlackTokens()) {
      return JSON.stringify({ ok: false, error: "Slack not connected" });
    }

    const channel = params.channel ? String(params.channel) : "general";
    const text = params.text ? String(params.text) : "";
    const blocks = Array.isArray(params.blocks) ? params.blocks : undefined;
    const threadTs = params.thread_ts ? String(params.thread_ts) : undefined;

    try {
      const result = await postMessage(
        channel,
        text,
        threadTs,
        blocks,
        undefined,
      );
      return JSON.stringify({
        ok: true,
        ts: result.ts,
        channel: result.channel,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
