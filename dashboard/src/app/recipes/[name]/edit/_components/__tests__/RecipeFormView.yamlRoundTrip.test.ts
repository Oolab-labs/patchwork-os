/**
 * Unit tests for the YAML round-trip logic in RecipeFormView.
 * Exercises the parseDocument → mutate → String(doc) path without
 * mounting any React components.
 */
import { describe, expect, it } from "vitest";
import { parseDocument, YAMLMap, YAMLSeq } from "yaml";

const EXAMPLE_YAML = `# yaml-language-server: $schema=https://example.com/recipe.json
version: 1.0.0
name: test-recipe
description: A test recipe
trigger:
  type: cron
  at: 30 4 * * *
steps:
  - id: fetch
    tool: inbox.fetch
    into: threads
  - id: summarize
    agent:
      prompt: |
        Summarize {{threads}} in 3 bullet points.
    into: digest
`;

function mutateAndStringify(yaml: string, mutate: (d: ReturnType<typeof parseDocument>) => void): string {
  const doc = parseDocument(yaml, { keepSourceTokens: true });
  mutate(doc);
  return String(doc);
}

describe("RecipeFormView YAML round-trip", () => {
  it("preserves the leading comment when mutating name", () => {
    const result = mutateAndStringify(EXAMPLE_YAML, (d) => d.setIn(["name"], "renamed-recipe"));
    expect(result).toContain("# yaml-language-server:");
    expect(result).toContain("name: renamed-recipe");
    expect(result).not.toContain("name: test-recipe");
  });

  it("preserves unmodified fields when mutating description", () => {
    const result = mutateAndStringify(EXAMPLE_YAML, (d) => d.setIn(["description"], "Updated description"));
    expect(result).toContain("description: Updated description");
    expect(result).toContain("name: test-recipe");
    expect(result).toContain("trigger:");
    expect(result).toContain("steps:");
  });

  it("mutates a tool step's tool field in-place", () => {
    const result = mutateAndStringify(EXAMPLE_YAML, (d) => {
      const steps = d.get("steps", true);
      if (!(steps instanceof YAMLSeq)) throw new Error("no steps");
      const step = steps.get(0, true);
      if (!(step instanceof YAMLMap)) throw new Error("no step 0");
      step.set("tool", "inbox.fetchV2");
    });
    expect(result).toContain("tool: inbox.fetchV2");
    expect(result).not.toContain("tool: inbox.fetch\n");
    // Second step untouched
    expect(result).toContain("id: summarize");
  });

  it("mutates an agent step's prompt in-place", () => {
    const result = mutateAndStringify(EXAMPLE_YAML, (d) => {
      const steps = d.get("steps", true);
      if (!(steps instanceof YAMLSeq)) throw new Error("no steps");
      const step = steps.get(1, true);
      if (!(step instanceof YAMLMap)) throw new Error("no step 1");
      const agent = step.get("agent", true);
      if (!(agent instanceof YAMLMap)) throw new Error("no agent");
      agent.set("prompt", "New prompt text.");
    });
    expect(result).toContain("New prompt text.");
    expect(result).not.toContain("Summarize {{threads}}");
    // First step untouched
    expect(result).toContain("id: fetch");
  });

  it("mutates the `into` field on a step", () => {
    const result = mutateAndStringify(EXAMPLE_YAML, (d) => {
      const steps = d.get("steps", true);
      if (!(steps instanceof YAMLSeq)) throw new Error("no steps");
      const step = steps.get(0, true);
      if (!(step instanceof YAMLMap)) throw new Error("no step 0");
      step.set("into", "rawThreads");
    });
    expect(result).toContain("into: rawThreads");
    // Second step's `into` untouched
    expect(result).toContain("into: digest");
  });

  it("round-trips without double-parsing errors", () => {
    const step1 = mutateAndStringify(EXAMPLE_YAML, (d) => d.setIn(["name"], "pass1"));
    const step2 = mutateAndStringify(step1, (d) => d.setIn(["description"], "pass2 desc"));
    const { errors } = parseDocument(step2);
    expect(errors).toHaveLength(0);
    expect(step2).toContain("name: pass1");
    expect(step2).toContain("description: pass2 desc");
  });

  it("handles a recipe with no agent block by creating it", () => {
    const noAgentYaml = `name: simple\nsteps:\n  - id: s1\n    tool: myTool\n    into: out\n`;
    const result = mutateAndStringify(noAgentYaml, (d) => {
      const steps = d.get("steps", true);
      if (!(steps instanceof YAMLSeq)) throw new Error("no steps");
      const step = steps.get(0, true);
      if (!(step instanceof YAMLMap)) throw new Error("no step");
      // Simulate what handleStepFieldChange does for path ["agent", "prompt"]
      step.set("agent", d.createNode({ prompt: "Hello world." }));
    });
    expect(result).toContain("agent:");
    expect(result).toContain("prompt: Hello world.");
    expect(result).toContain("tool: myTool");
  });
});
