import { describe, expect, it, vi } from "vitest";
import {
  buildToolCatalog,
  firstSentence,
  groupByCategory,
  runToolsCommand,
  searchCatalog,
  type ToolEntry,
} from "../commands/tools.js";
import { TOOL_CATEGORIES } from "../tools/index.js";

// Sample mini-catalog for isolated unit tests
const SAMPLE: ToolEntry[] = [
  {
    name: "getGitStatus",
    description: "Show working tree status. More detail here.",
    categories: ["git"],
  },
  {
    name: "gitCommit",
    description: "Create a git commit with a message.",
    categories: ["git"],
  },
  {
    name: "getDiagnostics",
    description: "Return TypeScript errors and warnings for a file.",
    categories: ["lsp", "analysis"],
  },
  {
    name: "renameSymbol",
    description: "Safely rename a symbol across the workspace.",
    categories: ["lsp"],
  },
  {
    name: "runClaudeTask",
    description: "Enqueue a Claude Code subprocess task.",
    categories: ["automation"],
  },
];

describe("searchCatalog", () => {
  it("returns all entries when query is empty", () => {
    expect(searchCatalog(SAMPLE, "")).toHaveLength(SAMPLE.length);
  });

  it("matches by tool name substring (case-insensitive)", () => {
    const results = searchCatalog(SAMPLE, "git");
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining(["getGitStatus", "gitCommit"]),
    );
    // Should not include non-git tools
    expect(results.find((r) => r.name === "getDiagnostics")).toBeUndefined();
  });

  it("matches by category", () => {
    const results = searchCatalog(SAMPLE, "automation");
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("runClaudeTask");
  });

  it("matches by description keyword", () => {
    const results = searchCatalog(SAMPLE, "rename");
    expect(results.map((r) => r.name)).toContain("renameSymbol");
  });

  it("is case-insensitive", () => {
    expect(searchCatalog(SAMPLE, "LSP")).toHaveLength(
      searchCatalog(SAMPLE, "lsp").length,
    );
  });

  it("returns empty array when nothing matches", () => {
    expect(searchCatalog(SAMPLE, "xyznonexistent")).toHaveLength(0);
  });

  it("matches refactor by partial name", () => {
    const results = searchCatalog(SAMPLE, "refactor");
    // Nothing in sample has refactor — confirm no false positives
    expect(results).toHaveLength(0);
  });
});

describe("groupByCategory", () => {
  it("groups tools by first category", () => {
    const grouped = groupByCategory(SAMPLE);
    expect(grouped.has("git")).toBe(true);
    expect(grouped.has("lsp")).toBe(true);
    expect(grouped.has("automation")).toBe(true);

    const gitTools = grouped.get("git")!;
    expect(gitTools.map((t) => t.name)).toContain("getGitStatus");
    expect(gitTools.map((t) => t.name)).toContain("gitCommit");
  });

  it("puts tools with no category into other", () => {
    const noCat: ToolEntry[] = [
      { name: "myTool", description: "x", categories: [] },
    ];
    const grouped = groupByCategory(noCat);
    expect(grouped.has("other")).toBe(true);
  });
});

describe("firstSentence", () => {
  it("returns text up to and including first period", () => {
    expect(firstSentence("Show working tree status. More detail here.")).toBe(
      "Show working tree status.",
    );
  });

  it("returns full string when no period present", () => {
    expect(firstSentence("No period here")).toBe("No period here");
  });

  it("handles empty string", () => {
    expect(firstSentence("")).toBe("");
  });
});

describe("buildToolCatalog", () => {
  it("returns a non-empty sorted array", () => {
    const catalog = buildToolCatalog();
    expect(catalog.length).toBeGreaterThan(50);

    // Verify sorting
    const names = catalog.map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("every entry has a name", () => {
    const catalog = buildToolCatalog();
    for (const t of catalog) {
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it("includes known git tools with git category", () => {
    const catalog = buildToolCatalog();
    const gitCommit = catalog.find((t) => t.name === "gitCommit");
    expect(gitCommit).toBeDefined();
    expect(gitCommit?.categories).toContain("git");
  });

  it("includes lsp tools with description", () => {
    const catalog = buildToolCatalog();
    const diag = catalog.find((t) => t.name === "getDiagnostics");
    expect(diag?.description.length).toBeGreaterThan(0);
    expect(diag?.categories).toContain("lsp");
  });

  it("search for git returns git tools", () => {
    const catalog = buildToolCatalog();
    const results = searchCatalog(catalog, "git");
    expect(results.length).toBeGreaterThan(5);
    for (const r of results) {
      const haystack = [r.name, r.description, ...r.categories]
        .join(" ")
        .toLowerCase();
      expect(haystack).toContain("git");
    }
  });

  it("search for refactor returns refactor tools", () => {
    const catalog = buildToolCatalog();
    const results = searchCatalog(catalog, "refactor");
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "refactorAnalyze",
        "refactorPreview",
        "refactorExtractFunction",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Bug 3: --json flag before subcommand
// ---------------------------------------------------------------------------

describe("runToolsCommand --json flag positioning (Bug 3)", () => {
  it("runToolsCommand(['--json', 'list']) works like ['list', '--json']", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        written.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });

    try {
      await runToolsCommand(["--json", "list"]);
      const output = written.join("");
      const parsed = JSON.parse(output);
      // Should be an object keyed by category
      expect(typeof parsed).toBe("object");
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("runToolsCommand(['--json', 'search', 'git']) works like ['search', 'git', '--json']", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        written.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });

    try {
      await runToolsCommand(["--json", "search", "git"]);
      const output = written.join("");
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      // All results must relate to git
      for (const t of parsed as ToolEntry[]) {
        const haystack = [t.name, t.description, ...t.categories]
          .join(" ")
          .toLowerCase();
        expect(haystack).toContain("git");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: buildToolCatalog against real TOOL_CATEGORIES import
// ---------------------------------------------------------------------------

describe("buildToolCatalog integration (real TOOL_CATEGORIES)", () => {
  it("returns a non-empty array where every entry has a name and at least one entry has a category", () => {
    // Verify TOOL_CATEGORIES itself is populated (catches broken import chains)
    expect(Object.keys(TOOL_CATEGORIES).length).toBeGreaterThan(0);

    const catalog = buildToolCatalog();

    // Non-empty array
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);

    // Every entry has a name string
    for (const entry of catalog) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
    }

    // At least one entry has a category set
    const withCategory = catalog.filter((e) => e.categories.length > 0);
    expect(withCategory.length).toBeGreaterThan(0);
  });
});
