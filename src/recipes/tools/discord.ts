/**
 * Discord tools — read-only wrappers for guilds, channels, messages, user.
 *
 * Self-registering tool module for the recipe tool registry. Read-only this PR;
 * write methods (sendMessage) are deferred.
 *
 * Each tool wraps connector throws into the `{count, items, error}` shape that
 * the runner's silent-fail detector (PR #75) catches as a step error rather
 * than a silent empty list.
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
