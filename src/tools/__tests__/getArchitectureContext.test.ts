import { describe, expect, it } from "vitest";
import { createGetArchitectureContextTool } from "../getArchitectureContext.js";

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

const WORKSPACE = "/workspace/my-project";

describe("createGetArchitectureContextTool", () => {
  it("returns required output fields", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.workspace).toBe(WORKSPACE);
    expect(Array.isArray(result.aspects)).toBe(true);
    expect(Array.isArray(result.queries)).toBe(true);
    expect(typeof result.hint).toBe("string");
    expect(result.hint.length).toBeGreaterThan(0);
  });

  it("defaults to all aspects when no args given", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.aspects).toContain("architecture");
    expect(result.aspects).toContain("adrs");
    expect(result.aspects).toContain("hotspots");
    expect(result.aspects).toContain("god-objects");
  });

  it("returns all 4 query types for aspects: ['all']", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({ aspects: ["all"] }));
    const aspectNames = result.queries.map(
      (q: Record<string, string>) => q.aspect,
    );
    expect(aspectNames).toContain("architecture");
    expect(aspectNames).toContain("adrs");
    expect(aspectNames).toContain("hotspots");
    expect(aspectNames).toContain("god-objects");
  });

  it("filters to only adrs when aspects: ['adrs']", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({ aspects: ["adrs"] }));
    expect(result.queries.length).toBe(1);
    expect(result.queries[0].aspect).toBe("adrs");
    expect(result.queries[0].tool).toBe("mcp__codebase-memory__manage_adr");
  });

  it("each query has required fields: aspect, tool, params, description", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    for (const q of result.queries) {
      expect(typeof q.aspect).toBe("string");
      expect(typeof q.tool).toBe("string");
      expect(typeof q.params).toBe("object");
      expect(typeof q.description).toBe("string");
    }
  });

  it("query params include project id derived from workspace path", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    for (const q of result.queries) {
      expect(typeof q.params.project).toBe("string");
      expect(q.params.project.length).toBeGreaterThan(0);
    }
  });

  it("maxNodes is reflected in god-objects graph query LIMIT", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({ maxNodes: 5 }));
    const godObjects = result.queries.find(
      (q: Record<string, string>) => q.aspect === "god-objects",
    );
    expect(godObjects).toBeDefined();
    expect(godObjects.params.query).toContain("LIMIT 5");
  });

  it("maxNodes is clamped to 100 max", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({ maxNodes: 999 }));
    const godObjects = result.queries.find(
      (q: Record<string, string>) => q.aspect === "god-objects",
    );
    expect(godObjects.params.query).toContain("LIMIT 100");
  });

  it("hotspots query uses FILE_CHANGES_WITH relationship", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({ aspects: ["hotspots"] }));
    expect(result.queries[0].params.query).toContain("FILE_CHANGES_WITH");
  });

  it("architecture query includes get_architecture tool", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({ aspects: ["modules"] }));
    const arch = result.queries.find(
      (q: Record<string, string>) => q.aspect === "architecture",
    );
    expect(arch).toBeDefined();
    expect(arch.tool).toBe("mcp__codebase-memory__get_architecture");
  });

  it("hint mentions codebase-memory index step", async () => {
    const tool = createGetArchitectureContextTool(WORKSPACE);
    const result = parse(await tool.handler({}));
    expect(result.hint).toContain("mcp__codebase-memory__index_repository");
  });
});
