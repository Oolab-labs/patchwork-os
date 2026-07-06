/**
 * Tool Registry — central dispatch for recipe step tools.
 *
 * Replaces the switch statement in yamlRunner.ts with a declarative,
 * self-describing registry that supports:
 *   - Schema generation for editor autocomplete
 *   - Dry-run / mock execution
 *   - Risk tier metadata for approval gates
 *   - Namespace isolation for connectors
 */

import { assertWriteAllowed } from "../featureFlags.js";
import { registerTierResolver } from "../riskTier.js";
import { deriveIdempotencyKey } from "./idempotencyKey.js";
import type { RunContext, StepDeps } from "./yamlRunner.js";

/**
 * Static metadata describing a recipe-callable tool: identity, schemas, and
 * the risk/write flags that feed the approval-gate and kill-switch systems.
 * All fields except `isConnector` are required — there is no partial
 * registration path.
 */
export interface ToolMetadata {
  /** Unique tool identifier: "namespace.action" */
  id: string;
  /** Namespace for grouping: "file", "git", "github", "jira", etc. */
  namespace: string;
  /** Human-readable description for hover docs */
  description: string;
  /** JSON Schema for input parameters */
  paramsSchema: unknown;
  /**
   * JSON Schema for output (enables template linting, e.g. `{{steps.x.foo}}`
   * autocomplete/validation). Mandatory per CLAUDE.md's "Testing Requirements"
   * section — `scripts/audit-lsp-tools.mjs` enforces this per-schema-block;
   * see `scripts/audit-output-schema-allowlist.json` for the narrow exception
   * path.
   */
  outputSchema: unknown;
  /**
   * Default risk tier consumed by `classifyTool` (via `registerTierResolver`
   * below) to decide approval-gate behavior: `"low"` tools may run
   * autonomously, `"medium"`/`"high"` tools are queued for human confirmation
   * unless the operator's approval-gate policy explicitly allows them. This
   * is the primary security-relevant field on this interface — get it wrong
   * and a mutating tool executes without oversight.
   */
  riskDefault: "low" | "medium" | "high";
  /**
   * Whether this tool performs a write/mutation. Security-relevant on two
   * axes: (1) gates the tool behind `assertWriteAllowed` in `executeTool`
   * below, so it is refused outright when the global write kill-switch is
   * engaged (read-tier tools are never affected); (2) routes execution
   * through the idempotency ledger so a single write executes at most once
   * per recipe run even if re-dispatched by a parallel branch or retry.
   */
  isWrite: boolean;
  /**
   * Whether this tool calls an external SaaS connector (vs a local/built-in tool).
   * Drives fixture-backed mocking for `recipe test` and `recipe record`.
   */
  isConnector?: boolean;
}

export interface ToolContext {
  /** Rendered step parameters after template substitution */
  params: Record<string, unknown>;
  /** Original step for access to raw fields if needed */
  step: Record<string, unknown>;
  /** Execution context with prior step outputs */
  ctx: RunContext;
  /** Dependencies injected for I/O and connector access */
  deps: StepDeps;
}

export type ToolExecute = (context: ToolContext) => Promise<string | null>;

export interface RegisteredTool extends ToolMetadata {
  execute: ToolExecute;
}

/** Internal registry map */
const registry = new Map<string, RegisteredTool>();

// Make the recipe tool registry the authoritative source of risk tiers for
// namespaced tool ids in classifyTool (approval gate, simulation, dashboard).
// Lazy: resolves at call time so it reflects whatever has registered so far.
// (Dependency points registry → riskTier; riskTier imports nothing → no cycle.)
registerTierResolver((id) => registry.get(id)?.riskDefault);

/**
 * Register a tool into the recipe-callable registry.
 *
 * @param tool - Full metadata + `execute` implementation. All `ToolMetadata`
 *   fields are required (only `isConnector` is optional) — there is no
 *   partial/lazy registration.
 * @throws {Error} If `tool.id` is already registered. Registration is
 *   register-once: there is no update-in-place or override path, so
 *   re-registering the same id (e.g. a plugin reload) must go through
 *   `clearRegistry()` first or be guarded by a `hasTool()` check
 *   (see `registerPluginTools`, which skips instead of throwing).
 *
 * `tool.riskDefault` and `tool.isWrite` are the security-relevant fields:
 * `riskDefault` feeds `classifyTool` (via the `registerTierResolver` call
 * below) to decide whether the approval gate lets the tool run autonomously
 * (`"low"`) or queues it for human confirmation (`"medium"`/`"high"`).
 * `isWrite` independently subjects the tool to the write kill-switch and
 * the idempotency-dedup ledger in `executeTool`, regardless of risk tier.
 */
export function registerTool(tool: RegisteredTool): void {
  if (registry.has(tool.id)) {
    throw new Error(`Tool "${tool.id}" is already registered`);
  }
  registry.set(tool.id, tool);
}

/**
 * Look up a registered tool by id.
 *
 * @param id - Tool id in `"namespace.action"` form.
 * @returns The `RegisteredTool`, or `undefined` if no tool with that id has
 *   been registered — this function never throws on a miss. Callers that
 *   need throw-on-miss semantics (e.g. `executeTool`) check the result
 *   themselves and raise their own error.
 */
export function getTool(id: string): RegisteredTool | undefined {
  return registry.get(id);
}

/**
 * Check if a tool exists.
 */
export function hasTool(id: string): boolean {
  return registry.has(id);
}

/**
 * List all registered tools, optionally filtered by namespace.
 */
export function listTools(namespace?: string): RegisteredTool[] {
  if (!namespace) return Array.from(registry.values());
  const result: RegisteredTool[] = [];
  for (const t of registry.values()) {
    if (t.namespace === namespace) result.push(t);
  }
  return result;
}

/**
 * Get all namespaces that have registered tools.
 */
export function getNamespaces(): string[] {
  const namespaces = new Set<string>();
  for (const tool of registry.values()) {
    namespaces.add(tool.namespace);
  }
  return Array.from(namespaces).sort();
}

/**
 * Execute a tool by ID. Throws if tool not found.
 *
 * Refuses to execute write-tier tools when the global write kill switch is
 * active (`kill-switch.writes` flag — set via `PATCHWORK_FLAG_KILL_SWITCH_WRITES=1`
 * env var or persisted flag). Read-tier tools are always allowed; the kill
 * switch is a one-way emergency brake on mutating operations.
 */
export async function executeTool(
  id: string,
  context: ToolContext,
): Promise<string | null> {
  const tool = getTool(id);
  if (!tool) {
    throw new Error(`Unknown tool: "${id}"`);
  }

  // Telemetry chokepoint (bug 2026-06-24): record every recipe/agent tool
  // execution to the bridge ActivityLog so dashboard tool-call telemetry
  // counts recipe-driven work — not just MCP-session calls. Fail-soft: CLI /
  // test runs without a bridge omit `activityLog`, so `?.record` no-ops.
  // Both the flat (yaml) runner and the chained runner funnel tool dispatch
  // through this function (chained: buildChainedDeps → executeStep →
  // executeTool), so instrumenting here covers both.
  const activityLog = context.deps.activityLog;
  const start = Date.now();
  const recordOutcome = (ok: boolean, errMsg?: string): void => {
    activityLog?.record(
      id,
      Date.now() - start,
      ok ? "success" : "error",
      errMsg,
    );
  };

  const run = async (): Promise<string | null> => {
    if (tool.isWrite) {
      assertWriteAllowed(id);

      // PR5a — idempotency dedup. Within a single recipe run, the same
      // write tool with the same params must execute exactly once. If a
      // parallel branch (chained recipe) or a re-dispatch reaches this
      // function with a key already in the ledger, return the cached
      // output so downstream `{{steps.x.data}}` references stay coherent.
      // Errors are NOT recorded — retry-after-failure still re-executes
      // (correct: a failed call may not have completed its side effect).
      const ledger = context.deps.writeEffectLedger;
      if (ledger) {
        const key = deriveIdempotencyKey(id, context.params);
        return ledger.getOrExecute(key, () => tool.execute(context));
      }
    }
    return tool.execute(context);
  };

  try {
    const result = await run();
    recordOutcome(true);
    return result;
  } catch (err) {
    recordOutcome(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Clear registry — primarily for testing.
 */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * Register tools from a loaded plugin into the recipe tool registry.
 *
 * Plugin tools use a flat `name` (e.g. "myPrefix_doThing") rather than the
 * "namespace.action" convention used by built-in tools. We derive a namespace
 * from the tool name prefix and wrap the plugin handler so it satisfies
 * ToolExecute.
 *
 * Rules:
 *  - If a tool with the same ID is already registered, skip it (built-ins win).
 *  - Errors in individual tool registration are swallowed — other tools proceed.
 */
export function registerPluginTools(
  tools: Array<{
    name: string;
    handler: (...args: unknown[]) => Promise<unknown>;
    schema: unknown;
  }>,
): number {
  let registered = 0;
  for (const t of tools) {
    if (!t.name || hasTool(t.name)) continue;
    try {
      // Derive namespace from tool name: everything before the first underscore,
      // or the full name if there is no underscore.
      const underscoreIdx = t.name.indexOf("_");
      const namespace =
        underscoreIdx > 0 ? t.name.slice(0, underscoreIdx) : t.name;

      const execute: ToolExecute = async (context) => {
        const result = await t.handler(context.params);
        if (result === null || result === undefined) return null;
        return typeof result === "string" ? result : JSON.stringify(result);
      };

      // Honour the plugin tool's `annotations.destructiveHint` (PluginToolSchema
      // in src/plugin.ts). A destructive plugin tool must be treated as a write
      // so it participates in the kill-switch gate (assertWriteAllowed) and the
      // idempotency dedup ledger in executeTool. Authors who omit the hint keep
      // the prior read-only behaviour — zero API change.
      const schema = t.schema as Record<string, unknown> | null;
      const annotations = schema?.annotations as
        | Record<string, unknown>
        | undefined;
      const isWrite = annotations?.destructiveHint === true;

      registerTool({
        id: t.name,
        namespace,
        description:
          (schema?.description as string | undefined) ??
          `Plugin tool: ${t.name}`,
        paramsSchema: schema?.inputSchema ?? {},
        outputSchema: {},
        riskDefault: isWrite ? "medium" : "low",
        isWrite,
        execute,
      });
      registered++;
    } catch {
      // skip — duplicate guard in registerTool already throws, but hasTool above
      // guards against that. Any other unexpected error is non-fatal.
    }
  }
  return registered;
}

/**
 * Returns true if the given tool id is a registered connector-backed tool.
 * Drives fixture-backed mocking decisions.
 */
export function isConnectorTool(toolId: string): boolean {
  return getTool(toolId)?.isConnector === true;
}

/**
 * Returns true if the given namespace has at least one registered connector tool.
 */
export function isConnectorNamespace(namespace: string): boolean {
  for (const tool of registry.values()) {
    if (tool.namespace === namespace && tool.isConnector) {
      return true;
    }
  }
  return false;
}

/**
 * List all namespaces that contain at least one connector-backed tool.
 */
export function listConnectorNamespaces(): string[] {
  const namespaces = new Set<string>();
  for (const tool of registry.values()) {
    if (tool.isConnector) {
      namespaces.add(tool.namespace);
    }
  }
  return Array.from(namespaces).sort();
}

type JsonSchemaRecord = Record<string, unknown>;

function getOutputSchemaProperties(
  toolId: string,
): Record<string, unknown> | undefined {
  const outputSchema = getTool(toolId)?.outputSchema;
  if (
    !outputSchema ||
    typeof outputSchema !== "object" ||
    !("properties" in outputSchema) ||
    !outputSchema.properties ||
    typeof outputSchema.properties !== "object"
  ) {
    return undefined;
  }

  return outputSchema.properties as Record<string, unknown>;
}

function schemaHasType(schema: unknown, expected: string): boolean {
  if (!schema || typeof schema !== "object" || !("type" in schema)) {
    return false;
  }

  const type = (schema as JsonSchemaRecord).type;
  if (typeof type === "string") {
    return type === expected;
  }

  return Array.isArray(type) && type.includes(expected);
}

function getJsonAliasPropertyName(
  properties: Record<string, unknown>,
): string | undefined {
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (propertyName === "error") {
      continue;
    }

    if (
      schemaHasType(propertySchema, "array") ||
      schemaHasType(propertySchema, "object")
    ) {
      return propertyName;
    }
  }

  return undefined;
}

export function listToolOutputContextKeys(
  toolId: string,
  intoKey: string,
): string[] {
  const properties = getOutputSchemaProperties(toolId);
  if (!properties) {
    return [];
  }

  const keys: string[] = [];

  for (const [propertyName] of Object.entries(properties)) {
    // Expose all properties: runtime dot-nav renderer supports any type (arrays,
    // objects, scalars). Validation must match runtime behavior, not restrict to
    // scalar keys (causes false warnings on {{x.candles}}, {{x.data}}, etc.).
    keys.push(`${intoKey}.${propertyName}`);
  }

  if (getJsonAliasPropertyName(properties)) {
    keys.push(`${intoKey}.json`);
  }

  return keys;
}

export function seedToolOutputPreviewContext(
  toolId: string,
  intoKey: string,
  stepId: string,
  ctx: Record<string, string>,
): void {
  for (const key of listToolOutputContextKeys(toolId, intoKey)) {
    const suffix = key.slice(intoKey.length + 1);
    ctx[key] = `[dry-run:${stepId}.${suffix}]`;
  }
}

export function applyToolOutputContext(
  toolId: string,
  intoKey: string,
  result: string,
  ctx: Record<string, string>,
): void {
  const properties = getOutputSchemaProperties(toolId);
  if (!properties) {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const parsedResult = JSON.parse(result) as unknown;
    if (
      !parsedResult ||
      typeof parsedResult !== "object" ||
      Array.isArray(parsedResult)
    ) {
      return;
    }
    parsed = parsedResult as Record<string, unknown>;
  } catch {
    return;
  }

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    const propertyValue = parsed[propertyName];
    if (
      propertyValue !== undefined &&
      (schemaHasType(propertySchema, "string") ||
        schemaHasType(propertySchema, "number") ||
        schemaHasType(propertySchema, "boolean")) &&
      (typeof propertyValue === "string" ||
        typeof propertyValue === "number" ||
        typeof propertyValue === "boolean")
    ) {
      ctx[`${intoKey}.${propertyName}`] = String(propertyValue);
    }
  }

  const jsonAliasProperty = getJsonAliasPropertyName(properties);
  if (jsonAliasProperty && parsed[jsonAliasProperty] !== undefined) {
    ctx[`${intoKey}.json`] = JSON.stringify(parsed[jsonAliasProperty]);
  }
}

/**
 * Built-in parameter schemas for common patterns.
 */
export const CommonSchemas = {
  filePath: {
    type: "string",
    description: "File path (supports ~ for home directory)",
  },
  optional: {
    type: "boolean",
    description: "If true, failure returns empty string instead of throwing",
    default: false,
  },
  when: {
    type: "string",
    description: "Conditional expression evaluated before execution",
  },
  max: {
    type: "number",
    description: "Maximum number of results to return",
    default: 20,
  },
  since: {
    type: "string",
    description: "Time expression like '24h', '7d', '2026-01-01'",
    default: "24h",
  },
  into: {
    type: "string",
    description: "Variable name to capture output into context",
  },
} as const;

/**
 * Built-in output schemas for common patterns.
 */
export const CommonOutputSchemas = {
  fileContent: {
    type: "string",
    description: "File content as string",
  },
  fileWriteResult: {
    type: "object",
    properties: {
      path: { type: "string" },
      bytesWritten: { type: "number" },
    },
  },
  listResult: {
    type: "object",
    properties: {
      count: { type: "number" },
      items: { type: "array" },
    },
  },
  successResult: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      error: { type: "string" },
    },
  },
} as const;
