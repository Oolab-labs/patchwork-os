/**
 * Schema Generator — produces JSON Schema from tool registry.
 *
 * Generates composable schemas for editor autocomplete:
 *   - schemas/recipe.v1.json — top-level recipe schema
 *   - schemas/tools/<namespace>.json — per-namespace tool param schemas
 */

import { RECIPE_NAME_RE } from "./names.js";
import { getNamespaces, listTools, type ToolMetadata } from "./toolRegistry.js";

/**
 * JSON-Schema `pattern` for a recipe `name`, derived from the canonical
 * RECIPE_NAME_RE (`src/recipes/names.ts`) so the generated schema can
 * never silently weaken the committed strict pattern on regen.
 *
 * RECIPE_NAME_RE is the bare kebab slug (`^[a-z0-9][a-z0-9-]{0,63}$`).
 * The schema additionally accepts an optional `@scope/` prefix because
 * marketplace registry recipes ship a scoped name (`@patchworkos/foo`)
 * which `stripRecipeScope` normalizes to the bare slug before the
 * RECIPE_NAME_RE check runs. We inject that prefix group right after the
 * leading `^` of RECIPE_NAME_RE.source.
 */
const RECIPE_NAME_SCHEMA_PATTERN = `^(@[a-z0-9-]+/)?${RECIPE_NAME_RE.source.replace(
  /^\^/,
  "",
)}`;

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
    $id: "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/dry-run-plan.v1.json",
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
 * JSON Schema for the What-If Preview `RecipeSimulationReport`
 * (`src/recipes/simulation/types.ts`), the output of
 * `GET /recipes/:name/simulate` and `patchwork recipe simulate`. A superset of
 * the dry-run plan; consumers pin on `schemaVersion`. Standalone (not part of
 * `generateSchemaSet`/`writeSchemas`) — served on demand to consumers that want
 * to validate the wire contract.
 */
export function generateSimulationSchema(): unknown {
  const riskEnum = { type: "string", enum: ["low", "medium", "high"] };
  const sideEffectEnum = {
    type: "string",
    enum: [
      "local-read",
      "local-write",
      "connector-read",
      "connector-write",
      "external-http",
      "agent-llm",
      "nested-recipe",
      "unknown",
    ],
  };
  const simStep = {
    type: "object",
    required: [
      "id",
      "type",
      "resolved",
      "baseRisk",
      "effectiveRisk",
      "sideEffect",
      "isWrite",
      "isConnector",
    ],
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["tool", "agent", "recipe"] },
      tool: { type: "string" },
      namespace: { type: "string" },
      resolved: { type: "boolean" },
      optional: { type: "boolean" },
      dependencies: { type: "array", items: { type: "string" } },
      condition: { type: "string" },
      baseRisk: riskEnum,
      effectiveRisk: riskEnum,
      sideEffect: sideEffectEnum,
      isWrite: { type: "boolean" },
      isConnector: { type: "boolean" },
      mockedFrom: {
        type: "string",
        enum: ["history", "synthesized"],
        description:
          "Mocked fidelity only — whether this step's output came from real run history or a synthesized placeholder.",
      },
    },
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/simulation-report.v1.json",
    title: "Patchwork Recipe What-If Preview",
    description:
      "Stable machine-readable output of `patchwork recipe simulate` / GET /recipes/:name/simulate. Static counterfactual simulation — executes nothing. Pin consumers on schemaVersion. `gatedOnRecipeSteps` is false today: recipe steps are NOT gated by the approval queue.",
    type: "object",
    required: [
      "schemaVersion",
      "kind",
      "recipe",
      "triggerType",
      "generatedAt",
      "fidelity",
      "topology",
      "gatedOnRecipeSteps",
      "steps",
      "summary",
      "risk",
      "approvals",
      "cost",
      "branches",
      "lint",
      "notes",
    ],
    properties: {
      schemaVersion: { type: "number", const: 2 },
      kind: { type: "string", const: "what-if-preview" },
      recipe: { type: "string" },
      triggerType: { type: "string" },
      generatedAt: {
        type: "string",
        description: "ISO-8601 timestamp (reused from the dry-run plan)",
      },
      fidelity: { type: "string", enum: ["static", "mocked"] },
      sampleRuns: {
        type: "number",
        description:
          "Mocked fidelity only — number of prior runs sampled to seed the mocked sandbox.",
      },
      topology: { type: "string", enum: ["chained", "flat"] },
      gatedOnRecipeSteps: {
        type: "boolean",
        description:
          "False today — recipe-runner steps are NOT gated by the approval queue. The approval projection is the tier that WOULD apply if they were.",
      },
      steps: { type: "array", items: simStep },
      summary: {
        type: "object",
        required: [
          "totalSteps",
          "writeSteps",
          "connectorSteps",
          "agentSteps",
          "unresolvedSteps",
          "sideEffectCounts",
          "connectorNamespaces",
        ],
        properties: {
          totalSteps: { type: "number" },
          writeSteps: { type: "number" },
          connectorSteps: { type: "number" },
          agentSteps: { type: "number" },
          unresolvedSteps: { type: "number" },
          sideEffectCounts: {
            type: "object",
            additionalProperties: { type: "number" },
          },
          connectorNamespaces: { type: "array", items: { type: "string" } },
        },
      },
      risk: {
        type: "object",
        required: ["score", "tier", "components", "highestStepRisk"],
        properties: {
          score: { type: "number" },
          tier: riskEnum,
          highestStepRisk: riskEnum,
          components: {
            type: "object",
            required: [
              "highSteps",
              "mediumSteps",
              "writeSteps",
              "connectorWriteSteps",
              "externalHttpSteps",
              "unresolvedSteps",
            ],
            properties: {
              highSteps: { type: "number" },
              mediumSteps: { type: "number" },
              writeSteps: { type: "number" },
              connectorWriteSteps: { type: "number" },
              externalHttpSteps: { type: "number" },
              unresolvedSteps: { type: "number" },
            },
          },
        },
      },
      approvals: {
        type: "object",
        required: ["gatedOnRecipeSteps", "projected", "note"],
        properties: {
          gatedOnRecipeSteps: { type: "boolean" },
          note: { type: "string" },
          projected: {
            type: "array",
            items: {
              type: "object",
              required: ["stepId", "tier", "wouldRequireApproval", "reason"],
              properties: {
                stepId: { type: "string" },
                tool: { type: "string" },
                tier: riskEnum,
                wouldRequireApproval: { type: "boolean" },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      cost: {
        type: "object",
        required: [
          "basis",
          "agentSteps",
          "estimatedAgentSteps",
          "estPromptTokens",
          "usd",
          "note",
        ],
        properties: {
          basis: {
            type: "string",
            enum: ["history", "heuristic", "unavailable"],
          },
          confidence: { type: "string", enum: ["high", "low", "none"] },
          sampleRuns: { type: "number" },
          agentSteps: { type: "number" },
          estimatedAgentSteps: { type: "number" },
          estPromptTokens: { type: ["number", "null"] },
          estInputTokens: { type: ["number", "null"] },
          estOutputTokens: { type: ["number", "null"] },
          usd: { type: ["number", "null"] },
          minUsd: { type: ["number", "null"] },
          maxUsd: { type: ["number", "null"] },
          historyAgentSteps: { type: "number" },
          note: { type: "string" },
        },
      },
      branches: {
        type: "array",
        items: {
          type: "object",
          required: ["stepId", "condition", "outcome", "reason"],
          properties: {
            stepId: { type: "string" },
            condition: { type: "string" },
            outcome: {
              type: "string",
              enum: ["taken", "skipped", "undetermined"],
            },
            reason: { type: "string" },
          },
        },
      },
      lint: {
        type: "object",
        required: ["errors", "warnings"],
        properties: {
          errors: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
      notes: { type: "array", items: { type: "string" } },
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
    retry: {
      type: "number",
      description:
        "Number of times to retry this step on failure (overrides recipe-level on_error.retry)",
    },
    retryDelay: {
      type: "number",
      description: "Milliseconds to wait between retries (default 1000)",
    },
    timeout_ms: {
      type: "number",
      description:
        "Wall-clock timeout in milliseconds. If the step takes longer, the run halts with category step_timeout. Agent steps are not subject to this timeout.",
    },
    expect: {
      type: "object",
      description:
        "Per-step assertions evaluated against the step output. Multiple fields are AND-composed.",
      properties: {
        schema: {
          type: "object",
          description: "JSON Schema validated against the step output via AJV",
        },
        equals: {
          description:
            "Deep-equal comparison. Strings compared verbatim; objects/arrays compared via JSON canonical form.",
        },
        matches: {
          type: "string",
          description:
            "Regex (string source, no flags) matched against the stringified output. Max 500 chars.",
        },
        contains: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Substring(s) that must appear in the stringified output. Array → all must be present.",
        },
        on_fail: {
          type: "string",
          enum: ["halt", "warn"],
          description:
            "halt (default): step becomes error on assertion failure. warn: step passes but failure list is attached to stepResult.expectWarnings.",
        },
      },
    },
  };
  // Single source of truth for the `agent:` step config sub-schema. Used in
  // BOTH the leaf-step block and the nested/parallel-step block below. These
  // two blocks had drifted (the leaf block was missing the prompt/model/
  // driver/into descriptions); sharing one const reconciles that and means a
  // new agent field (e.g. the forthcoming cost-routing `downshift`) only has
  // to be added once instead of in two parallel places. Shared by reference,
  // matching the existing `chainedStepMetadataProperties` pattern (the schema
  // tree is never mutated in place after generation).
  const agentStepConfigSchema = {
    type: "object",
    required: ["prompt"],
    description: "Agent step configuration",
    properties: {
      prompt: {
        type: "string",
        description: "Prompt to send to the AI (supports {{templates}})",
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
      mcpAccess: {
        type: "boolean",
        description:
          "When true, grants the agent step access to MCP tools registered on the bridge. Defaults to false for subprocess driver steps.",
      },
      kind: {
        type: "string",
        enum: ["judge"],
        description:
          "When set to 'judge', the agent step emits a structured verdictReason and stores the verdict in the run log.",
      },
      reviews: {
        type: "string",
        description:
          "Step output key the judge reviews (its `into`, default 'agent_output'). Required for the judge→refine loop.",
      },
      max_revisions: {
        type: "integer",
        minimum: 0,
        description:
          "OPT-IN judge→refine loop. Max revise→re-judge cycles when the verdict is 'request_changes' (0/absent = augment-only, no loop). Requires kind:judge + reviews.",
      },
      on_exhausted: {
        type: "string",
        enum: ["halt", "proceed"],
        description:
          "When the revision budget is exhausted and the judge still requests changes: 'halt' (default) fails the run; 'proceed' continues with the last draft.",
      },
      downshift: {
        type: "array",
        description:
          "OPT-IN cost-aware routing (Phase 4). Ordered cheaper fallbacks tried when budget.usdMax is set and the remaining budget is too tight for the preferred driver/model. Each entry overrides driver and/or model. Absent → preferred model always used.",
        items: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
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
                "local",
              ],
            },
            model: { type: "string" },
          },
        },
      },
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

  // Leaf step variants reused inside parallel: items (one level, no recursion).
  const leafStepVariants = [
    ...toolRefs,
    {
      type: "object",
      required: ["agent"],
      properties: {
        ...chainedStepMetadataProperties,
        agent: agentStepConfigSchema,
      },
    },
    {
      type: "object",
      required: ["tool"],
      properties: {
        ...chainedStepMetadataProperties,
        tool: { type: "string", not: { enum: knownToolIds } },
        into: { type: "string" },
      },
    },
    chainedRecipeStep,
  ];

  const parallelStep = {
    type: "object",
    required: ["parallel"],
    properties: {
      id: {
        type: "string",
        description: "Optional group id — used as awaits target by later steps",
      },
      awaits: {
        type: "array",
        description: "Step IDs that must complete before this group starts",
        items: { type: "string" },
      },
      parallel: {
        description:
          "Run these steps concurrently. Array form: steps run in parallel. Object form: map-reduce — each item in `each` is bound to `as` and the steps array runs once per item.",
        oneOf: [
          {
            type: "array",
            description: "Run these steps concurrently.",
            items: { oneOf: leafStepVariants },
          },
          {
            type: "object",
            description:
              "Map-reduce form — iterate over a collection and run steps once per item.",
            required: ["each", "steps"],
            properties: {
              each: {
                type: "string",
                description:
                  "Template expression that resolves to an array of items to iterate over (e.g. '{{outputs.list}}').",
              },
              as: {
                type: "string",
                description:
                  "Variable name each item is bound to inside the steps (default: 'item').",
              },
              steps: {
                type: "array",
                description: "Steps to run for each item in the collection.",
                items: { oneOf: leafStepVariants },
              },
            },
          },
        ],
      },
    },
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json",
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
        description:
          "Recipe name (kebab-case, 1-64 chars). Scoped names like @scope/name are accepted for registry recipes.",
        pattern: RECIPE_NAME_SCHEMA_PATTERN,
      },
      description: {
        type: "string",
        description: "Human-readable description of what this recipe does",
      },
      maxConcurrency: {
        type: "integer",
        minimum: 1,
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
            description:
              "File filter pattern (for file_watch trigger). For on_test_run triggers, one of: any | failure | pass-after-fail.",
          },
          vars: {
            type: "array",
            description:
              "Declared input variables resolvable as {{name}} in steps. Place declared variables here (NOT at recipe root — top-level vars are ignored at runtime).",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: {
                  type: "string",
                  pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$",
                  description:
                    "Variable name (letter/underscore start; letters, digits, underscores; max 64 chars).",
                },
                required: {
                  type: "boolean",
                  description: "Whether the variable must be supplied.",
                },
                default: {
                  description: "Default value when not supplied.",
                },
                description: {
                  type: "string",
                  description: "Human-readable description of the variable.",
                },
              },
            },
          },
          inputs: {
            type: "array",
            description:
              "Alias for trigger.vars — declared input variables resolvable as {{name}} in steps.",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: {
                  type: "string",
                  pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$",
                  description:
                    "Variable name (letter/underscore start; letters, digits, underscores; max 64 chars).",
                },
                required: {
                  type: "boolean",
                  description: "Whether the variable must be supplied.",
                },
                default: {
                  description: "Default value when not supplied.",
                },
                description: {
                  type: "string",
                  description: "Human-readable description of the variable.",
                },
              },
            },
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
                agent: agentStepConfigSchema,
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
            parallelStep,
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
            description:
              "Number of retries per failing step (overridden by step.retry)",
            default: 0,
          },
          retryDelay: {
            type: "number",
            description:
              "Milliseconds between retries (overridden by step.retryDelay)",
            default: 1000,
          },
          fallback: {
            type: "string",
            enum: ["log_only", "abort", "deliver_original"],
            description:
              "log_only / deliver_original: treat step failure as non-fatal (like optional); fail-open. abort (default): propagate failure.",
          },
          notify: {
            type: "boolean",
            description:
              "When false, suppresses Slack notifications on step failure even when a Slack connector is connected.",
            default: true,
          },
        },
      },
      budget: {
        type: "object",
        description:
          "Per-recipe budget. Set tokensMax and/or usdMax; on breach the run halts with budget_exceeded (or warns). Enforced for API drivers that report token usage and (for usdMax) have a price-table entry; subscription drivers (Claude CLI) report no tokens and are skipped (fail-open with a one-time warning).",
        properties: {
          tokensMax: {
            type: "number",
            exclusiveMinimum: 0,
            description:
              "Cumulative input + output tokens allowed across the whole run",
          },
          usdMax: {
            type: "number",
            exclusiveMinimum: 0,
            description:
              "Cumulative USD allowed across the whole run, priced from token usage via the model price table. Unpriced models / subscription drivers fail open (never halt on them).",
          },
          estimateUnmeasured: {
            type: "boolean",
            description:
              "OPT-IN (default false). Estimate the notional list-price USD an unmeasured/subscription call would have cost and surface a ≈$ figure. Label only — never counted toward usdMax, never halts. Requires usdMax.",
          },
          onBreach: {
            type: "string",
            enum: ["halt", "warn"],
            description:
              "halt (default): stop run on next admission check. warn: continue but record the breach in the run log. Applies to both tokensMax and usdMax.",
            default: "halt",
          },
        },
      },
      servers: {
        type: "array",
        description:
          "Plugin package specifiers (npm package names or file paths) whose tools are loaded and available to steps in this recipe. Loaded once at run start.",
        items: { type: "string" },
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
    $id: `https://raw.githubusercontent.com/patchworkos/recipes/main/schema/tools/${namespace}.json`,
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
