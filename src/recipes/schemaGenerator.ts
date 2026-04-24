/**
 * Schema Generator — produces JSON Schema from tool registry.
 *
 * Generates composable schemas for editor autocomplete:
 *   - schemas/recipe.v1.json — top-level recipe schema
 *   - schemas/tools/<namespace>.json — per-namespace tool param schemas
 */

import { getNamespaces, listTools, type ToolMetadata } from "./toolRegistry.js";

export interface SchemaSet {
  /** Top-level recipe schema */
  recipe: unknown;
  /** Per-namespace tool schemas */
  namespaces: Record<string, unknown>;
  /** Dry-run plan JSON schema (machine-readable contract for `recipe run --dry-run` output) */
  dryRunPlan: unknown;
}

/**
 * Generate complete schema set from current registry state.
 */
export function generateSchemaSet(): SchemaSet {
  const namespaces: Record<string, unknown> = {};

  for (const ns of getNamespaces()) {
    namespaces[ns] = generateNamespaceSchema(ns);
  }

  return {
    recipe: generateRecipeSchema(namespaces),
    namespaces,
    dryRunPlan: generateDryRunPlanSchema(),
  };
}

/**
 * JSON Schema for RecipeDryRunPlan. Consumers (dashboard run timeline, external CI)
 * should pin on `schemaVersion` and validate against this.
 */
export function generateDryRunPlanSchema(): unknown {
  const riskEnum = { type: "string", enum: ["low", "medium", "high"] };
  const planStep = {
    type: "object",
    required: ["id", "type"],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["tool", "agent", "recipe"] },
      tool: { type: "string" },
      namespace: { type: "string" },
      into: { type: "string" },
      optional: { type: "boolean" },
      prompt: { type: "string" },
      params: { type: "object", additionalProperties: true },
      dependencies: { type: "array", items: { type: "string" } },
      condition: { type: "string" },
      risk: riskEnum,
      isWrite: { type: "boolean" },
      isConnector: { type: "boolean" },
      resolved: {
        type: "boolean",
        description:
          "True if the tool id is known to the registry at plan time",
      },
    },
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://patchworkos.com/schema/dry-run-plan.v1.json",
    title: "Patchwork Recipe Dry-Run Plan",
    description:
      "Stable machine-readable output of `patchwork recipe run --dry-run`. Pin consumers on schemaVersion.",
    type: "object",
    required: [
      "schemaVersion",
      "recipe",
      "mode",
      "triggerType",
      "generatedAt",
      "steps",
    ],
    properties: {
      schemaVersion: { type: "number", const: 1 },
      recipe: { type: "string" },
      mode: { type: "string", const: "dry-run" },
      triggerType: { type: "string" },
      generatedAt: {
        type: "string",
        description: "ISO-8601 timestamp when plan was generated",
      },
      stepSelection: {
        type: "object",
        properties: {
          query: { type: "string" },
          matchedBy: { type: "string" },
          matchedValue: { type: "string" },
        },
      },
      steps: { type: "array", items: planStep },
      parallelGroups: {
        type: "array",
        items: { type: "array", items: { type: "string" } },
      },
      maxDepth: { type: "number" },
      connectorNamespaces: { type: "array", items: { type: "string" } },
      hasWriteSteps: { type: "boolean" },
    },
  };
}

/**
 * Generate top-level recipe schema that composes namespace tool schemas.
 */
function generateRecipeSchema(
  namespaceSchemas: Record<string, unknown>,
): unknown {
  const chainedStepMetadataProperties = {
    id: {
      type: "string",
      description:
        "Unique chained step identifier used for outputs and dependencies",
    },
    awaits: {
      type: "array",
      description: "Step IDs that must complete before this step runs",
      items: {
        type: "string",
      },
    },
    when: {
      type: "string",
      description: "Template condition that controls whether this step runs",
    },
    optional: {
      type: "boolean",
      description: "Whether step failure should be tolerated",
    },
    risk: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Risk level for this step",
    },
    transform: {
      type: "string",
      description:
        "Template rendered after tool execution. Use $result to reference the tool output. Supports all template expressions.",
    },
  };
  const toolRefs = Object.keys(namespaceSchemas).map((ns) => ({
    allOf: [
      {
        $ref: `./tools/${ns}.json`,
      },
      {
        type: "object",
        properties: {
          ...chainedStepMetadataProperties,
        },
      },
    ],
  }));
  const knownToolIds = listTools()
    .map((tool) => tool.id)
    .sort();
  const chainedRecipeStep = {
    type: "object",
    anyOf: [{ required: ["recipe"] }, { required: ["chain"] }],
    properties: {
      ...chainedStepMetadataProperties,
      recipe: {
        type: "string",
        description: "Nested recipe name or path",
      },
      chain: {
        type: "string",
        description: "Alias for nested recipe name or path",
      },
      vars: {
        type: "object",
        description: "Template variables passed into a nested recipe step",
        additionalProperties: {
          type: "string",
        },
      },
      output: {
        type: "string",
        description: "Output key for the nested recipe result",
      },
    },
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://patchworkos.com/schema/recipe.v1.json",
    title: "Patchwork Recipe",
    description: "YAML recipe schema for Patchwork automation",
    // taplo formatter: auto-associates *.patchwork.yaml files
    "x-taplo": {
      "file-patterns": ["*.patchwork.yaml", "*.patchwork.yml"],
    },
    type: "object",
    required: ["name", "trigger", "steps"],
    properties: {
      name: {
        type: "string",
        description: "Recipe name (kebab-case recommended)",
        pattern: "^[a-z0-9-]+$",
      },
      description: {
        type: "string",
        description: "Human-readable description of what this recipe does",
      },
      maxConcurrency: {
        type: "number",
        description:
          "Maximum number of chained steps that may execute in parallel",
      },
      maxDepth: {
        type: "number",
        description: "Maximum nested recipe depth for chained recipes",
      },
      version: {
        type: "string",
        description: "Semantic version",
        default: "1.0.0",
      },
      apiVersion: {
        type: "string",
        description: "Patchwork API version",
        enum: ["patchwork.sh/v1"],
        default: "patchwork.sh/v1",
      },
      trigger: {
        type: "object",
        description: "When to run this recipe",
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: [
              "manual",
              "cron",
              "webhook",
              "file_watch",
              "git_hook",
              "on_file_save",
              "on_test_run",
              "chained",
            ],
            description: "Trigger type",
          },
          at: {
            type: "string",
            description: "Cron expression (for cron trigger)",
          },
          glob: {
            type: "string",
            description: "File glob pattern (for file_watch trigger)",
          },
          on: {
            type: "string",
            enum: ["post-commit", "pre-push", "post-merge"],
            description: "Git hook event (for git_hook trigger)",
          },
          filter: {
            type: "string",
            description: "File filter pattern (for file_watch trigger)",
          },
          eventSource: {
            type: "string",
            description:
              "Webhook/event source name after legacy trigger normalization",
          },
          eventFilter: {
            oneOf: [
              {
                type: "string",
              },
              {
                type: "object",
              },
            ],
            description:
              "Webhook/event filter after legacy trigger normalization",
          },
          eventLeadTimeHours: {
            type: "number",
            description:
              "Lead time in hours after legacy trigger normalization",
          },
          eventLeadTimeMinutes: {
            type: "number",
            description:
              "Lead time in minutes after legacy trigger normalization",
          },
          legacyType: {
            type: "string",
            enum: ["event"],
            description:
              "Original trigger type preserved during legacy normalization",
          },
        },
      },
      context: {
        type: "array",
        description: "Context blocks to load before running steps",
        items: {
          type: "object",
          required: ["type"],
          properties: {
            type: {
              type: "string",
              enum: ["file", "env"],
            },
            path: { type: "string" },
            keys: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      steps: {
        type: "array",
        description: "Sequence of steps to execute",
        items: {
          oneOf: [
            ...toolRefs,
            {
              type: "object",
              required: ["agent"],
              properties: {
                ...chainedStepMetadataProperties,
                agent: {
                  type: "object",
                  required: ["prompt"],
                  description: "Agent step configuration",
                  properties: {
                    prompt: {
                      type: "string",
                      description:
                        "Prompt to send to the AI (supports {{templates}})",
                    },
                    model: {
                      type: "string",
                      description: "Model to use for the agent step",
                    },
                    driver: {
                      type: "string",
                      enum: [
                        "claude",
                        "claude-code",
                        "api",
                        "openai",
                        "grok",
                        "gemini",
                        "anthropic",
                      ],
                      description: "Driver for agent execution",
                    },
                    into: {
                      type: "string",
                      description: "Variable name to store output in context",
                    },
                  },
                },
              },
            },
            {
              type: "object",
              required: ["tool"],
              properties: {
                ...chainedStepMetadataProperties,
                tool: {
                  type: "string",
                  not: {
                    enum: knownToolIds,
                  },
                },
                into: {
                  type: "string",
                },
              },
            },
            chainedRecipeStep,
          ],
        },
      },
      expect: {
        type: "object",
        description: "Optional assertions for mocked recipe tests",
        properties: {
          stepsRun: {
            type: "number",
            description: "Expected number of executed steps",
          },
          outputs: {
            type: "array",
            description: "Expected output paths or keys recorded by the run",
            items: { type: "string" },
          },
          errorMessage: {
            type: ["string", "null"],
            description:
              "Expected final error message, or null for a clean run",
          },
          context: {
            type: "object",
            description: "Expected context key/value pairs after the run",
            additionalProperties: { type: "string" },
          },
        },
      },
      output: {
        type: "object",
        description: "Output file configuration",
        properties: {
          path: {
            type: "string",
            description: "Path to write final output",
          },
        },
      },
      on_error: {
        type: "object",
        description: "Error handling policy",
        properties: {
          retry: {
            type: "number",
            description: "Number of retries",
            default: 0,
          },
          fallback: {
            type: "string",
            enum: ["log_only", "abort", "deliver_original"],
            description: "Fallback action on error",
          },
          notify: {
            type: "boolean",
            description: "Whether to notify on error",
            default: true,
          },
        },
      },
    },
  };
}

/**
 * Generate schema for a namespace's tools.
 */
function generateNamespaceSchema(namespace: string): unknown {
  const tools = listTools(namespace);

  const definitions: Record<string, unknown> = {};
  const anyOf: unknown[] = [];

  for (const tool of tools) {
    const toolSchema = generateToolSchema(tool);
    definitions[tool.id.replace(".", "_")] = toolSchema;
    anyOf.push({ $ref: `#/definitions/${tool.id.replace(".", "_")}` });
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `https://patchworkos.com/schema/tools/${namespace}.json`,
    title: `${capitalize(namespace)} Tools`,
    description: `Tool parameters for ${namespace} namespace`,
    definitions,
    anyOf,
  };
}

/**
 * Extract properties from tool paramsSchema, merging with base tool property.
 */
function getToolProperties(tool: ToolMetadata): Record<string, unknown> {
  const base = {
    tool: {
      type: "string",
      const: tool.id,
      description: `Tool: ${tool.id}`,
    },
  };

  const schema = tool.paramsSchema as Record<string, unknown> | undefined;
  const extra =
    schema && typeof schema === "object" && "properties" in schema
      ? (schema.properties as Record<string, unknown>)
      : undefined;

  return extra ? { ...base, ...extra } : base;
}

/**
 * Generate schema for a single tool's parameters.
 */
function generateToolSchema(tool: ToolMetadata): unknown {
  const schema = tool.paramsSchema as Record<string, unknown> | undefined;
  const requiredFromParams =
    schema && typeof schema === "object" && Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [];

  return {
    type: "object",
    title: tool.id,
    description: tool.description,
    properties: getToolProperties(tool),
    required: ["tool", ...requiredFromParams],
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Write schema files to disk.
 */
export async function writeSchemas(
  outputDir: string,
  schemas: SchemaSet,
  writeFile: (path: string, content: string) => Promise<void> | void,
): Promise<void> {
  // Write main recipe schema
  await writeFile(
    `${outputDir}/recipe.v1.json`,
    JSON.stringify(schemas.recipe, null, 2),
  );

  // Write dry-run plan schema
  await writeFile(
    `${outputDir}/dry-run-plan.v1.json`,
    JSON.stringify(schemas.dryRunPlan, null, 2),
  );

  // Write per-namespace schemas
  for (const [ns, schema] of Object.entries(schemas.namespaces)) {
    await writeFile(
      `${outputDir}/tools/${ns}.json`,
      JSON.stringify(schema, null, 2),
    );
  }
}
