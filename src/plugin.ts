/**
 * Public type contract for Claude IDE Bridge plugin authors.
 *
 * A plugin is an npm package or local directory that:
 *  1. Contains a `claude-ide-bridge-plugin.json` manifest at its root.
 *  2. Exports a `register` function from the declared entrypoint.
 *
 * @example
 * ```typescript
 * // my-plugin/src/index.ts
 * import type { PluginRegisterFn } from "claude-ide-bridge/plugin";
 *
 * const register: PluginRegisterFn = (ctx) => ({
 *   tools: [
 *     {
 *       schema: {
 *         name: "myOrgFetchTicket",
 *         description: "Fetch a Jira ticket by ID",
 *         inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
 *       },
 *       handler: async (args) => ({
 *         content: [{ type: "text", text: JSON.stringify({ id: args.id }) }],
 *       }),
 *     },
 *   ],
 * });
 * export default register;
 * ```
 */

// ── Tool types (re-exported from internal definitions) ────────────────────────

export interface PluginToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** When true, the tool is hidden from tools/list when the VS Code extension is disconnected. */
  extensionRequired?: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export type PluginToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// ── Context provided to the plugin's register() function ─────────────────────

/** Safe subset of Config exposed to plugins — never includes auth tokens or security-sensitive fields. */
export interface PluginSafeConfig {
  workspace: string;
  workspaceFolders: string[];
  commandTimeout: number;
  maxResultSize: number;
}

export interface PluginLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

export interface PluginContext {
  workspace: string;
  workspaceFolders: string[];
  config: Readonly<PluginSafeConfig>;
  logger: PluginLogger;
}

// ── What a plugin's register() must return ───────────────────────────────────

export interface PluginToolRegistration {
  schema: PluginToolSchema;
  handler: PluginToolHandler;
  /** Override the default 60s tool timeout. */
  timeoutMs?: number;
}

export interface PluginRegistration {
  tools: PluginToolRegistration[];
}

/** The function a plugin's entrypoint module must export as `register` (or default). */
export type PluginRegisterFn = (
  context: PluginContext,
) => Promise<PluginRegistration> | PluginRegistration;

// ── Manifest format (claude-ide-bridge-plugin.json) ──────────────────────────

export interface PluginManifest {
  /** Must be 1 for this version of the bridge. */
  schemaVersion: number;
  /** Identifying name, e.g. "my-org/my-plugin". Used in log output only. */
  name: string;
  /** Plugin semver version string. Used in log output. */
  version?: string;
  /** Human-readable description shown at bridge startup. */
  description?: string;
  /** Relative path from the package root to the entrypoint module. */
  entrypoint: string;
  /**
   * Required prefix for all tool names registered by this plugin.
   * Must match /^[a-zA-Z][a-zA-Z0-9_]{1,19}$/.
   * All tool names must start with this exact prefix.
   * Enforced at load time to prevent collisions with built-in tools.
   */
  toolNamePrefix: string;
  /** Minimum bridge version required (semver string). Warning if running version is older. */
  minBridgeVersion?: string;
  /** Declared capabilities — informational only in v1, logged at startup. */
  permissions?: string[];
}
