import { Ajv } from "ajv";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSchemaSet } from "../schemaGenerator.js";
import { clearRegistry, registerTool } from "../toolRegistry.js";

/** Register a trivial tool so the namespace machinery has something to chew on. */
function registerEcho(): void {
  registerTool({
    id: "test.echo",
    namespace: "test",
    description: "Echo test",
    paramsSchema: { type: "object", properties: {} },
    outputSchema: { type: "string" },
    riskDefault: "low",
    isWrite: false,
    execute: async () => "ok",
  });
}

function recipeWithAgent(agent: Record<string, unknown>) {
  return {
    name: "sandbox-recipe",
    trigger: { type: "manual" },
    steps: [{ agent }],
  };
}

describe("schemaGenerator — agent step sandbox fields (P0-5)", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("exposes sandbox / tools / disallowedTools on the agent step config schema", () => {
    registerEcho();
    const schemas = generateSchemaSet();
    const recipeSchema = schemas.recipe as {
      properties?: {
        steps?: { items?: { oneOf?: Array<Record<string, unknown>> } };
      };
    };
    const agentStep = recipeSchema.properties?.steps?.items?.oneOf?.find(
      (entry) =>
        "properties" in entry &&
        "agent" in ((entry.properties as Record<string, unknown>) ?? {}),
    ) as
      | { properties?: { agent?: { properties?: Record<string, unknown> } } }
      | undefined;
    const agentProps = agentStep?.properties?.agent?.properties;
    expect(agentProps).toBeDefined();
    expect(agentProps?.sandbox).toMatchObject({ type: "boolean" });
    expect(agentProps?.tools).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(agentProps?.disallowedTools).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  it("validates a recipe that opts into the sandbox", () => {
    registerEcho();
    const schemas = generateSchemaSet();
    const ajv = new Ajv({ allErrors: true, strict: false });
    // The recipe schema $refs per-namespace tool schemas (./tools/<ns>.json).
    // Register them so AJV can resolve those refs at compile time.
    for (const nsSchema of Object.values(schemas.namespaces)) {
      ajv.addSchema(nsSchema as object);
    }
    const validate = ajv.compile(schemas.recipe as object);
    const ok = validate(
      recipeWithAgent({
        prompt: "do the thing",
        sandbox: true,
        tools: ["getDiagnostics", "getGitStatus"],
        disallowedTools: ["runCommand"],
      }),
    );
    expect(ok).toBe(true);
  });

  it("rejects a non-boolean sandbox value", () => {
    registerEcho();
    const schemas = generateSchemaSet();
    const ajv = new Ajv({ allErrors: true, strict: false });
    // The recipe schema $refs per-namespace tool schemas (./tools/<ns>.json).
    // Register them so AJV can resolve those refs at compile time.
    for (const nsSchema of Object.values(schemas.namespaces)) {
      ajv.addSchema(nsSchema as object);
    }
    const validate = ajv.compile(schemas.recipe as object);
    const ok = validate(
      recipeWithAgent({ prompt: "do the thing", sandbox: "yes" }),
    );
    expect(ok).toBe(false);
  });

  it("rejects a non-array tools value", () => {
    registerEcho();
    const schemas = generateSchemaSet();
    const ajv = new Ajv({ allErrors: true, strict: false });
    // The recipe schema $refs per-namespace tool schemas (./tools/<ns>.json).
    // Register them so AJV can resolve those refs at compile time.
    for (const nsSchema of Object.values(schemas.namespaces)) {
      ajv.addSchema(nsSchema as object);
    }
    const validate = ajv.compile(schemas.recipe as object);
    const ok = validate(
      recipeWithAgent({ prompt: "do the thing", tools: "getDiagnostics" }),
    );
    expect(ok).toBe(false);
  });
});
