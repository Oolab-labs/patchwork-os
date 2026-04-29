/**
 * Discord tools — wrappers for guilds, channels, messages, user, and send.
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * connector throws into the `{count, items, error}` shape; the write tool
 * (`discord.send_message`) returns the single-object `{ok, ..., error?}` shape
 * and is gated through the approval queue (`isWrite: true`).
 *
 * Each tool wraps connector throws into the `{count, items, error}` shape that
 * the runner's silent-fail detector (PR #75) catches as a step error rather
 * than a silent empty list.
 *
 * NOTE on `discord.send_message`: Discord's REST API only accepts message
 * sends from bot-scope OAuth tokens. The connector currently uses user-scope
 * (identify/guilds/messages.read), so the underlying call will surface a
 * `permission_denied` error until operators re-auth with the bot scope.
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";

// ============================================================================
// discord.get_current_user
// ============================================================================

registerTool({
  id: "discord.get_current_user",
  namespace: "discord",
  description:
    "Fetch the authenticated Discord user (username, id, discriminator).",
  paramsSchema: {
    type: "object",
    properties: {
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
  execute: async () => {
    const { getDiscordConnector } = await import("../../connectors/discord.js");
    try {
      const connector = getDiscordConnector();
      const user = await connector.getCurrentUser();
      return JSON.stringify({ count: 1, items: [user] });
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
// discord.list_guilds
// ============================================================================

registerTool({
  id: "discord.list_guilds",
  namespace: "discord",
  description:
    "List Discord guilds (servers) the authenticated user belongs to.",
  paramsSchema: {
    type: "object",
    properties: {
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
    const { getDiscordConnector } = await import("../../connectors/discord.js");
    const limit = typeof params.max === "number" ? params.max : 100;
    try {
      const connector = getDiscordConnector();
      const guilds = await connector.listGuilds({ limit });
      return JSON.stringify({ count: guilds.length, items: guilds });
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
// discord.list_channels
// ============================================================================

registerTool({
  id: "discord.list_channels",
  namespace: "discord",
  description:
    "List text channels in a Discord guild (filters out voice / category / threads).",
  paramsSchema: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Discord guild (server) id",
      },
      into: CommonSchemas.into,
    },
    required: ["guildId"],
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
    const { getDiscordConnector } = await import("../../connectors/discord.js");
    try {
      const connector = getDiscordConnector();
      const channels = await connector.listChannels(params.guildId as string);
      return JSON.stringify({ count: channels.length, items: channels });
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
// discord.list_messages
// ============================================================================

registerTool({
  id: "discord.list_messages",
  namespace: "discord",
  description: "List recent messages in a Discord channel (newest first).",
  paramsSchema: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Discord channel id",
      },
      max: CommonSchemas.max,
      into: CommonSchemas.into,
    },
    required: ["channelId"],
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
    const { getDiscordConnector } = await import("../../connectors/discord.js");
    const limit = typeof params.max === "number" ? params.max : 50;
    try {
      const connector = getDiscordConnector();
      const messages = await connector.listMessages(
        params.channelId as string,
        { limit },
      );
      return JSON.stringify({ count: messages.length, items: messages });
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
// discord.send_message  (write-gated)
// ============================================================================

registerTool({
  id: "discord.send_message",
  namespace: "discord",
  description:
    "Send a message to a Discord channel. Requires bot-scope OAuth — user-context tokens will fail with permission_denied.",
  paramsSchema: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "Discord channel id" },
      content: {
        type: "string",
        description: "Message content (≤2000 chars)",
      },
      tts: {
        type: "boolean",
        description: "Send as text-to-speech (default false)",
      },
      into: CommonSchemas.into,
    },
    required: ["channel_id", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      id: { type: "string" },
      channel_id: { type: "string" },
      content: { type: "string" },
      timestamp: { type: "string" },
      error: { type: "string" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: async ({ params }) => {
    const { getDiscordConnector } = await import("../../connectors/discord.js");
    try {
      const connector = getDiscordConnector();
      const message = await connector.sendMessage(params.channel_id as string, {
        content: params.content as string,
        tts: typeof params.tts === "boolean" ? params.tts : undefined,
      });
      return JSON.stringify({
        ok: true,
        id: message.id,
        channel_id: message.channel_id,
        content: message.content,
        timestamp: message.timestamp,
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
