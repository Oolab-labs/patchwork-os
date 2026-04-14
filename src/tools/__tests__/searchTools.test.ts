import { describe, expect, it } from "vitest";
import { createSearchToolsTool } from "../searchTools.js";

function makeTransport(
  tools: Array<{ name: string; description: string; categories?: string[] }>,
) {
  return {
    getToolSchemas: () => tools,
  } as any;
}

const FIXTURES = [
  { name: "getGitStatus", description: "Show git status", categories: ["git"] },
  {
    name: "gitCommit",
    description: "Commit staged changes",
    categories: ["git"],
  },
  {
    name: "getDiagnostics",
    description: "Get LSP diagnostics",
    categories: ["lsp", "analysis"],
  },
  { name: "runTests", description: "Run test suite", categories: ["analysis"] },
  {
    name: "getBridgeStatus",
    description: "Bridge health and connection info",
    categories: ["bridge"],
  },
  {
    name: "runInTerminal",
    description: "Execute shell command in terminal",
    categories: ["terminal"],
  },
];

describe("searchTools", () => {
  it("returns all tools when no query or category given", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({})) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.totalMatched).toBe(FIXTURES.length);
    expect(data.tools.length).toBeLessThanOrEqual(10);
  });

  it("filters by keyword in tool name", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ query: "git" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.tools.map((t: any) => t.name)).toContain("getGitStatus");
    expect(data.tools.map((t: any) => t.name)).toContain("gitCommit");
    expect(data.tools.map((t: any) => t.name)).not.toContain("runTests");
  });

  it("filters by keyword in description", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ query: "shell" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.tools[0].name).toBe("runInTerminal");
    expect(data.totalMatched).toBe(1);
  });

  it("filters by category", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ categories: ["git"] })) as any;
    const data = JSON.parse(result.content[0].text);
    const names = data.tools.map((t: any) => t.name);
    expect(names).toContain("getGitStatus");
    expect(names).toContain("gitCommit");
    expect(names).not.toContain("runTests");
    expect(names).not.toContain("getDiagnostics");
  });

  it("combines query and category filter (AND logic)", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    // query "diagnostics" + category "lsp" should match getDiagnostics
    const result = (await tool.handler({
      query: "diagnostics",
      categories: ["lsp"],
    })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.tools[0].name).toBe("getDiagnostics");
    expect(data.totalMatched).toBe(1);
  });

  it("respects limit param", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ limit: 2 })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.tools.length).toBe(2);
    expect(data.totalMatched).toBe(FIXTURES.length);
  });

  it("returns empty tools when nothing matches", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ query: "zzznomatch" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.tools).toHaveLength(0);
    expect(data.totalMatched).toBe(0);
  });

  it("returns empty tools for unknown category", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ categories: ["zzz_unknown"] })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.tools).toHaveLength(0);
  });

  it("is case-insensitive for query", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ query: "GIT" })) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.totalMatched).toBeGreaterThan(0);
  });

  it("includes categories in response when matched tool has them", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    const result = (await tool.handler({ query: "git status" })) as any;
    const data = JSON.parse(result.content[0].text);
    const match = data.tools.find((t: any) => t.name === "getGitStatus");
    expect(match).toBeDefined();
    expect(match.categories).toContain("git");
  });

  it("multi-category tool matches any of the given category filters", async () => {
    const tool = createSearchToolsTool(makeTransport(FIXTURES));
    // getDiagnostics has ["lsp", "analysis"] — should match category filter ["analysis"]
    const result = (await tool.handler({ categories: ["analysis"] })) as any;
    const data = JSON.parse(result.content[0].text);
    const names = data.tools.map((t: any) => t.name);
    expect(names).toContain("getDiagnostics");
    expect(names).toContain("runTests");
  });
});
