/**
 * Unit tests for the YAML round-trip logic in RecipeFormView.
 * Exercises the parseDocument → mutate → String(doc) path without
 * mounting any React components.
 */
import { describe, expect, it } from "vitest";
import { parseDocument, YAMLMap, YAMLSeq, Document as YamlDocument } from "yaml";

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

function mutateAndStringify(yaml: string, mutate: (d: YamlDocument) => void): string {
  const doc = parseDocument(yaml, { keepSourceTokens: true });
  mutate(doc);
  return String(doc);
}

// Helpers mirroring the component's add/remove/move logic
function addStep(yaml: string, kind: "agent" | "tool"): string {
  return mutateAndStringify(yaml, (d) => {
    let stepsNode = d.get("steps", true);
    if (!(stepsNode instanceof YAMLSeq)) {
      stepsNode = d.createNode([]) as YAMLSeq;
      d.set("steps", stepsNode);
    }
    const seq = stepsNode as YAMLSeq;
    const idx = seq.items.length;
    const newStep =
      kind === "agent"
        ? d.createNode({ id: `step_${idx + 1}`, agent: { prompt: "" }, into: `out_${idx + 1}` })
        : d.createNode({ id: `step_${idx + 1}`, tool: "", into: `out_${idx + 1}` });
    seq.add(newStep);
  });
}

function removeStep(yaml: string, stepIndex: number): string {
  return mutateAndStringify(yaml, (d) => {
    const stepsNode = d.get("steps", true);
    if (!(stepsNode instanceof YAMLSeq)) return;
    stepsNode.items.splice(stepIndex, 1);
  });
}

function moveStep(yaml: string, stepIndex: number, direction: "up" | "down"): string {
  return mutateAndStringify(yaml, (d) => {
    const stepsNode = d.get("steps", true);
    if (!(stepsNode instanceof YAMLSeq)) return;
    const items = stepsNode.items;
    const targetIndex = direction === "up" ? stepIndex - 1 : stepIndex + 1;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const tmp = items[stepIndex]!;
    items[stepIndex] = items[targetIndex]!;
    items[targetIndex] = tmp;
  });
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

describe("RecipeFormView step add/remove/move", () => {
  it("adds an agent step appended after existing steps", () => {
    const result = addStep(EXAMPLE_YAML, "agent");
    const parsed = parseDocument(result);
    expect(parsed.errors).toHaveLength(0);
    const doc = parsed.toJS() as { steps: unknown[] };
    expect(doc.steps).toHaveLength(3);
    expect((doc.steps[2] as { id: string }).id).toBe("step_3");
    // Original steps untouched
    expect(result).toContain("id: fetch");
    expect(result).toContain("id: summarize");
  });

  it("adds a tool step with an empty tool field", () => {
    const result = addStep(EXAMPLE_YAML, "tool");
    const doc = parseDocument(result).toJS() as { steps: Array<{ tool?: string }> };
    expect(doc.steps).toHaveLength(3);
    expect(Object.prototype.hasOwnProperty.call(doc.steps[2], "tool")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(doc.steps[2], "agent")).toBe(false);
  });

  it("removes a step by index without touching others", () => {
    const result = removeStep(EXAMPLE_YAML, 0);
    const parsed = parseDocument(result);
    expect(parsed.errors).toHaveLength(0);
    const doc = parsed.toJS() as { steps: Array<{ id: string }> };
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0]!.id).toBe("summarize");
  });

  it("moves a step up", () => {
    const result = moveStep(EXAMPLE_YAML, 1, "up");
    const doc = parseDocument(result).toJS() as { steps: Array<{ id: string }> };
    expect(doc.steps[0]!.id).toBe("summarize");
    expect(doc.steps[1]!.id).toBe("fetch");
  });

  it("moves a step down", () => {
    const result = moveStep(EXAMPLE_YAML, 0, "down");
    const doc = parseDocument(result).toJS() as { steps: Array<{ id: string }> };
    expect(doc.steps[0]!.id).toBe("summarize");
    expect(doc.steps[1]!.id).toBe("fetch");
  });

  it("no-ops when moving first step up", () => {
    const result = moveStep(EXAMPLE_YAML, 0, "up");
    const doc = parseDocument(result).toJS() as { steps: Array<{ id: string }> };
    expect(doc.steps[0]!.id).toBe("fetch");
    expect(doc.steps[1]!.id).toBe("summarize");
  });

  it("no-ops when moving last step down", () => {
    const result = moveStep(EXAMPLE_YAML, 1, "down");
    const doc = parseDocument(result).toJS() as { steps: Array<{ id: string }> };
    expect(doc.steps[0]!.id).toBe("fetch");
    expect(doc.steps[1]!.id).toBe("summarize");
  });

  it("add then remove returns to original step count", () => {
    const afterAdd = addStep(EXAMPLE_YAML, "agent");
    const afterRemove = removeStep(afterAdd, 2);
    const doc = parseDocument(afterRemove).toJS() as { steps: unknown[] };
    expect(doc.steps).toHaveLength(2);
  });
});
