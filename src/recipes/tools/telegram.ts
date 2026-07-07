/**
 * Telegram tools — send messages via a Telegram bot, read chat info and
 * recent updates.
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * connector throws into the `{count, items, error}` shape that the runner's
 * silent-fail detector (PR #75) catches as a step error rather than a silent
 * empty list. The write tool uses a single-object response shape (no
 * count/items) but still surfaces failures via an `error` field.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// telegram.send_message
// ============================================================================

registerTool({
  id: "telegram.send_message",
  namespace: "telegram",
  description:
    "Send a message to a Telegram chat via the connected bot. The bot must already be a member of the chat (or the chat must have started a conversation with it).",
  paramsSchema: {
    type: "object",
    properties: {
      chat_id: {
        type: "string",
        description:
          "Telegram chat id or @channelusername to send the message to",
      },
      text: { type: "string", description: "Message text" },
      parse_mode: {
        type: "string",
        enum: ["Markdown", "MarkdownV2", "HTML"],
        description: "Optional formatting mode for the message text",
      },
      into: CommonSchemas.into,
    },
    required: ["chat_id", "text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      message_id: { type: "number" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getTelegramConnector } = await import(
      "../../connectors/telegram.js"
    );
    try {
      const connector = getTelegramConnector();
      const message = await connector.sendMessage({
        chatId: params.chat_id as string,
        text: params.text as string,
        parseMode:
          params.parse_mode === "Markdown" ||
          params.parse_mode === "MarkdownV2" ||
          params.parse_mode === "HTML"
            ? (params.parse_mode as "Markdown" | "MarkdownV2" | "HTML")
            : undefined,
      });
      return JSON.stringify({ ok: true, message_id: message.message_id });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// telegram.get_chat
// ============================================================================

registerTool({
  id: "telegram.get_chat",
  namespace: "telegram",
  description:
    "Fetch info about a Telegram chat (title, type, username) by chat id.",
  paramsSchema: {
    type: "object",
    properties: {
      chat_id: {
        type: "string",
        description: "Telegram chat id or @channelusername",
      },
      into: CommonSchemas.into,
    },
    required: ["chat_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getTelegramConnector } = await import(
      "../../connectors/telegram.js"
    );
    try {
      const connector = getTelegramConnector();
      const chat = await connector.getChat(params.chat_id as string);
      return JSON.stringify({ count: 1, items: [chat] });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ============================================================================
// telegram.get_updates
// ============================================================================

registerTool({
  id: "telegram.get_updates",
  namespace: "telegram",
  description:
    "Poll recent incoming updates (messages) the bot has received. Uses Telegram's long-poll getUpdates endpoint — not for use alongside a webhook integration on the same bot.",
  paramsSchema: {
    type: "object",
    properties: {
      offset: {
        type: "number",
        description:
          "Only return updates with update_id >= this value (for pagination)",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array", items: { type: "object" } },
      error: { type: "string" },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: async ({ params }) => {
    const { getTelegramConnector } = await import(
      "../../connectors/telegram.js"
    );
    const limit = typeof params.max === "number" ? params.max : 25;
    try {
      const connector = getTelegramConnector();
      const { updates } = await connector.getUpdates({
        offset: typeof params.offset === "number" ? params.offset : undefined,
        limit,
      });
      return JSON.stringify({ count: updates.length, items: updates });
    } catch (err) {
      return JSON.stringify({
        count: 0,
        items: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
