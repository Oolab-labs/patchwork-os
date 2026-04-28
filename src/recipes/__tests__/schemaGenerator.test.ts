import { Ajv } from "ajv";
import { beforeEach, describe, expect, it } from "vitest";
import {
  generateDryRunPlanSchema,
  generateSchemaSet,
} from "../schemaGenerator.js";
import { clearRegistry, registerTool } from "../toolRegistry.js";

describe("schemaGenerator", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("generates recipe schema with correct structure", () => {
    // Register a test tool
    registerTool({
      id: "test.echo",
      namespace: "test",
      description: "Echo test",
      paramsSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: async () => "echo",
    });

    const schemas = generateSchemaSet();

    // Check recipe schema
    expect(schemas.recipe).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/recipe.v1.json",
      title: "Patchwork Recipe",
      type: "object",
    });

    const recipeSchema = schemas.recipe as {
      properties?: Record<string, unknown>;
    };
    expect(recipeSchema.properties?.expect).toBeDefined();

    const steps = recipeSchema.properties?.steps as
      | { items?: { oneOf?: Array<Record<string, unknown>> } }
      | undefined;
    const agentStep = steps?.items?.oneOf?.find(
      (entry) =>
        "properties" in entry &&
        "agent" in ((entry.properties as Record<string, unknown>) ?? {}),
    );
    expect(agentStep).toBeDefined();
    expect(agentStep).toMatchObject({
      required: ["agent"],
      properties: {
        agent: {
          type: "object",
          required: ["prompt"],
        },
      },
    });

    // Check namespace schema exists
    expect(schemas.namespaces.test).toBeDefined();
    expect((schemas.namespaces.test as Record<string, unknown>).title).toBe(
      "Test Tools",
    );
  });

  it("generates tool schema with merged properties", () => {
    registerTool({
      id: "file.write",
      namespace: "file",
      description: "Write to file",
      paramsSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      outputSchema: { type: "object" },
      riskDefault: "medium",
      isWrite: true,
      execute: async () => "done",
    });

    const schemas = generateSchemaSet();
    const fileSchema = schemas.namespaces.file as Record<string, unknown>;
    const definitions = fileSchema.definitions as Record<
      string,
      { required?: string[] }
    >;

    expect(fileSchema.definitions).toBeDefined();
    expect(fileSchema.anyOf).toBeDefined();
    expect(definitions.file_write?.required).toEqual([
      "tool",
      "path",
      "content",
    ]);
  });

  it("handles tools without paramsSchema", () => {
    registerTool({
      id: "git.status",
      namespace: "git",
      description: "Git status",
      paramsSchema: {},
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: async () => "status",
    });

    const schemas = generateSchemaSet();
    expect(schemas.namespaces.git).toBeDefined();
  });

  it("includes normalized legacy event trigger fields in the recipe schema", () => {
    const schemas = generateSchemaSet();
    const recipeSchema = schemas.recipe as {
      properties?: {
        trigger?: {
          properties?: Record<string, unknown>;
        };
      };
    };

    expect(recipeSchema.properties?.trigger?.properties).toMatchObject({
      eventSource: {
        type: "string",
      },
      eventFilter: {
        oneOf: [{ type: "string" }, { type: "object" }],
      },
      eventLeadTimeHours: {
        type: "number",
      },
      eventLeadTimeMinutes: {
        type: "number",
      },
      legacyType: {
        type: "string",
        enum: ["event"],
      },
    });
  });

  it("includes chained recipe trigger and nested recipe step support", () => {
    const schemas = generateSchemaSet();
    const recipeSchema = schemas.recipe as {
      properties?: {
        trigger?: {
          properties?: {
            type?: {
              enum?: string[];
            };
          };
        };
        maxConcurrency?: Record<string, unknown>;
        maxDepth?: Record<string, unknown>;
        steps?: {
          items?: {
            oneOf?: Array<Record<string, unknown>>;
          };
        };
      };
    };

    expect(recipeSchema.properties?.trigger?.properties?.type?.enum).toContain(
      "chained",
    );
    expect(recipeSchema.properties?.maxConcurrency).toMatchObject({
      type: "number",
    });
    expect(recipeSchema.properties?.maxDepth).toMatchObject({ type: "number" });

    const nestedRecipeStep = recipeSchema.properties?.steps?.items?.oneOf?.find(
      (entry) => Array.isArray(entry.anyOf),
    );
    expect(nestedRecipeStep).toMatchObject({
      anyOf: [{ required: ["recipe"] }, { required: ["chain"] }],
      properties: {
        recipe: { type: "string" },
        chain: { type: "string" },
        vars: { type: "object" },
        output: { type: "string" },
      },
    });

    const parallelStep = recipeSchema.properties?.steps?.items?.oneOf?.find(
      (entry) =>
        Array.isArray(entry.required) && entry.required.includes("parallel"),
    );
    expect(parallelStep).toMatchObject({
      required: ["parallel"],
      properties: {
        parallel: {
          type: "array",
          items: { oneOf: expect.any(Array) },
        },
        id: { type: "string" },
        awaits: { type: "array" },
      },
    });
  });

  it("includes shared chained step metadata across step variants", () => {
    registerTool({
      id: "test.echo",
      namespace: "test",
      description: "Echo test",
      paramsSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
      },
      outputSchema: { type: "string" },
      riskDefault: "low",
      isWrite: false,
      execute: async () => "echo",
    });

    const schemas = generateSchemaSet();
    const recipeSchema = schemas.recipe as {
      properties?: {
        steps?: {
          items?: {
            oneOf?: Array<Record<string, unknown>>;
          };
        };
      };
    };

    const variants = recipeSchema.properties?.steps?.items?.oneOf ?? [];
    const toolStep = variants.find((entry) => Array.isArray(entry.allOf));
    const toolMetadata = (
      toolStep?.allOf as Array<Record<string, unknown>> | undefined
    )?.[1] as { properties?: Record<string, unknown> } | undefined;
    const agentStep = variants.find(
      (entry) =>
        "properties" in entry &&
        "agent" in ((entry.properties as Record<string, unknown>) ?? {}),
    ) as { properties?: Record<string, unknown> } | undefined;
    const unknownToolStep = variants.find(
      (entry) =>
        "properties" in entry &&
        "tool" in ((entry.properties as Record<string, unknown>) ?? {}) &&
        !("agent" in ((entry.properties as Record<string, unknown>) ?? {})),
    ) as { properties?: Record<string, unknown> } | undefined;
    const nestedRecipeStep = variants.find(
      (entry) =>
        "properties" in entry &&
        "recipe" in ((entry.properties as Record<string, unknown>) ?? {}),
    ) as { properties?: Record<string, unknown> } | undefined;

    expect(toolMetadata?.properties).toMatchObject({
      id: { type: "string" },
      awaits: { type: "array" },
      when: { type: "string" },
      optional: { type: "boolean" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
    });
    expect(agentStep?.properties).toMatchObject({
      id: { type: "string" },
      awaits: { type: "array" },
      when: { type: "string" },
      optional: { type: "boolean" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
    });
    expect(unknownToolStep?.properties).toMatchObject({
      id: { type: "string" },
      awaits: { type: "array" },
      when: { type: "string" },
      optional: { type: "boolean" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
    });
    expect(nestedRecipeStep?.properties).toMatchObject({
      id: { type: "string" },
      awaits: { type: "array" },
      when: { type: "string" },
      optional: { type: "boolean" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
    });
  });

  describe("dry-run plan schema", () => {
    it("exposes dryRunPlan on the schema set with stable id + schemaVersion const", () => {
      const schemas = generateSchemaSet();
      const schema = schemas.dryRunPlan as Record<string, unknown>;

      expect(schema.$id).toBe(
        "https://raw.githubusercontent.com/patchworkos/recipes/main/schema/dry-run-plan.v1.json",
      );
      const properties = schema.properties as Record<string, unknown>;
      expect(properties.schemaVersion).toMatchObject({ const: 1 });
      expect(properties.mode).toMatchObject({ const: "dry-run" });
      expect(schema.required).toEqual(
        expect.arrayContaining([
          "schemaVersion",
          "recipe",
          "mode",
          "triggerType",
          "generatedAt",
          "steps",
        ]),
      );
    });

    it("validates a realistic plan payload via Ajv", () => {
      const ajv = new Ajv({ strict: false });
      const validate = ajv.compile(generateDryRunPlanSchema() as object);

      const plan = {
        schemaVersion: 1,
        recipe: "example",
        mode: "dry-run",
        triggerType: "manual",
        generatedAt: new Date().toISOString(),
        steps: [
          {
            id: "post",
            type: "tool",
            tool: "slack.post_message",
            namespace: "slack",
            params: { channel: "alerts", text: "hi" },
            risk: "medium",
            isWrite: true,
            isConnector: true,
            resolved: true,
          },
          {
            id: "mystery",
            type: "tool",
            tool: "jira.fetch_issue",
            namespace: "jira",
            resolved: false,
          },
        ],
        connectorNamespaces: ["slack"],
        hasWriteSteps: true,
      };

      const ok = validate(plan);
      if (!ok) {
        throw new Error(
          `schema errors: ${JSON.stringify(validate.errors, null, 2)}`,
        );
      }
      expect(ok).toBe(true);
    });

    it("rejects a plan payload missing required fields", () => {
      const ajv = new Ajv({ strict: false });
      const validate = ajv.compile(generateDryRunPlanSchema() as object);

      const invalid = {
        recipe: "example",
        mode: "dry-run",
        triggerType: "manual",
        steps: [],
      };

      expect(validate(invalid)).toBe(false);
    });
  });
});
