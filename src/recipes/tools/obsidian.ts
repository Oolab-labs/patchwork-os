/**
 * Obsidian tools — read/write notes via the Obsidian Local REST API plugin.
 *
 * Self-registering tool module for the recipe tool registry. Read tools wrap
 * the connector's array/string returns; the write tool (`write_note`) declares
 * `isWrite: true` so the approval queue gates it. Note `deleteNote` and
 * `executeCommand` are intentionally NOT exposed as recipe-step tools.
 *
 * Connector signatures mirrored (src/connectors/obsidian.ts):
 *   listVault(vaultPath?: string): Promise<ObsidianVaultEntry[]>
 *   readNote(notePath: string): Promise<string>
 *   writeNote(notePath: string, content: string, append?: boolean): Promise<void>
 *   searchVault(query: string): Promise<ObsidianSearchMatch[]>
 */

import { CommonSchemas, registerTool } from "../toolRegistry.js";
import { wrapConnectorExecute } from "./wrapConnectorExecute.js";

// ============================================================================
// obsidian.list_vault
// ============================================================================

registerTool({
  id: "obsidian.list_vault",
  namespace: "obsidian",
  description:
    "List files and directories in the Obsidian vault, optionally scoped to a sub-path.",
  paramsSchema: {
    type: "object",
    properties: {
      vaultPath: {
        type: "string",
        description:
          "Optional vault-relative directory path to list (omit for vault root)",
      },
      into: CommonSchemas.into,
    },
    required: [],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        path: { type: "string" },
        type: { type: "string", enum: ["file", "directory"] },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getObsidianConnector } = await import(
      "../../connectors/obsidian.js"
    );
    const connector = getObsidianConnector();
    const result = await connector.listVault(
      typeof params.vaultPath === "string" ? params.vaultPath : undefined,
    );
    return JSON.stringify(result);
  }),
});

// ============================================================================
// obsidian.read_note
// ============================================================================

registerTool({
  id: "obsidian.read_note",
  namespace: "obsidian",
  description: "Read the markdown content of a note from the Obsidian vault.",
  paramsSchema: {
    type: "object",
    properties: {
      notePath: {
        type: "string",
        description: "Vault-relative path to the note (e.g. 'Notes/idea.md')",
      },
      into: CommonSchemas.into,
    },
    required: ["notePath"],
  },
  outputSchema: {
    type: "string",
    description: "Note content as markdown text",
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getObsidianConnector } = await import(
      "../../connectors/obsidian.js"
    );
    const connector = getObsidianConnector();
    const result = await connector.readNote(params.notePath as string);
    return JSON.stringify(result);
  }),
});

// ============================================================================
// obsidian.write_note  (write-gated)
// ============================================================================

registerTool({
  id: "obsidian.write_note",
  namespace: "obsidian",
  description:
    "Write markdown content to a note in the Obsidian vault, creating or replacing it. Set append: true to append instead of replace.",
  paramsSchema: {
    type: "object",
    properties: {
      notePath: {
        type: "string",
        description: "Vault-relative path to the note (e.g. 'Notes/idea.md')",
      },
      content: {
        type: "string",
        description: "Markdown content to write",
      },
      append: {
        type: "boolean",
        description: "If true, append to the note instead of replacing it",
        default: false,
      },
      into: CommonSchemas.into,
    },
    required: ["notePath", "content"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      path: { type: "string" },
      append: { type: "boolean" },
    },
  },
  riskDefault: "medium",
  isWrite: true,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getObsidianConnector } = await import(
      "../../connectors/obsidian.js"
    );
    const connector = getObsidianConnector();
    const notePath = params.notePath as string;
    const append = params.append === true;
    await connector.writeNote(notePath, params.content as string, append);
    return JSON.stringify({ ok: true, path: notePath, append });
  }),
});

// ============================================================================
// obsidian.search_vault
// ============================================================================

registerTool({
  id: "obsidian.search_vault",
  namespace: "obsidian",
  description:
    "Search the Obsidian vault for notes matching a query string. Returns matching filenames with relevance scores.",
  paramsSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query string",
      },
      into: CommonSchemas.into,
    },
    required: ["query"],
  },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: {
        filename: { type: "string" },
        score: { type: "number" },
        matches: { type: "array", items: { type: "string" } },
      },
    },
  },
  riskDefault: "low",
  isWrite: false,
  isConnector: true,
  execute: wrapConnectorExecute(async ({ params }) => {
    const { getObsidianConnector } = await import(
      "../../connectors/obsidian.js"
    );
    const connector = getObsidianConnector();
    const result = await connector.searchVault(params.query as string);
    return JSON.stringify(result);
  }),
});
