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

import type { RunContext, StepDeps } from "./yamlRunner.js";

export interface ToolMetadata {
  /** Unique tool identifier: "namespace.action" */
  id: string;
  /** Namespace for grouping: "file", "git", "github", "jira", etc. */
  namespace: string;
  /** Human-readable description for hover docs */
  description: string;
  /** JSON Schema for input parameters */
  paramsSchema: unknown;
  /** JSON Schema for output (enables template linting) */
  outputSchema: unknown;
  /** Default risk tier for approval gate decisions */
  riskDefault: "low" | "medium" | "high";
  /** Whether this tool performs a write/mutation (affects mock behavior and approval) */
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

/**
 * Register a tool. Duplicate IDs throw.
 */
export function registerTool(tool: RegisteredTool): void {
  if (registry.has(tool.id)) {
    throw new Error(`Tool "${tool.id}" is already registered`);
  }
  registry.set(tool.id, tool);
}

/**
 * Get a tool by ID. Returns undefined if not found.
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
  const tools = Array.from(registry.values());
  if (!namespace) return tools;
  return tools.filter((t) => t.namespace === namespace);
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
 */
export async function executeTool(
  id: string,
  context: ToolContext,
): Promise<string | null> {
  const tool = getTool(id);
  if (!tool) {
    throw new Error(`Unknown tool: "${id}"`);
  }
  return tool.execute(context);
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

      registerTool({
        id: t.name,
        namespace,
        description:
          ((t.schema as Record<string, unknown> | null)?.description as
            | string
            | undefined) ?? `Plugin tool: ${t.name}`,
        paramsSchema:
          (t.schema as Record<string, unknown> | null)?.inputSchema ?? {},
        outputSchema: {},
        riskDefault: "low",
        isWrite: false,
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

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (
      schemaHasType(propertySchema, "string") ||
      schemaHasType(propertySchema, "number") ||
      schemaHasType(propertySchema, "boolean")
    ) {
      keys.push(`${intoKey}.${propertyName}`);
    }
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
