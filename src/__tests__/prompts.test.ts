import { describe, expect, it } from "vitest";
import { getPrompt, PROMPTS } from "../prompts.js";

describe("PROMPTS list", () => {
  it("is non-empty", () => {
    expect(PROMPTS.length).toBeGreaterThan(0);
  });

  it("every entry has name and description", () => {
    for (const p of PROMPTS) {
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe("string");
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it("all names are unique", () => {
    const names = PROMPTS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("getPrompt", () => {
  it("returns null for unknown name", () => {
    expect(getPrompt("nonexistent", {})).toBeNull();
  });

  it("returns null for missing required argument", () => {
    expect(getPrompt("review-file", {})).toBeNull();
    expect(getPrompt("explain-diagnostics", {})).toBeNull();
    expect(getPrompt("generate-tests", {})).toBeNull();
  });

  it("returns messages for review-file with file arg", () => {
    const result = getPrompt("review-file", { file: "/src/foo.ts" });
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBeGreaterThan(0);
    expect(result!.messages[0]!.role).toBe("user");
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("/src/foo.ts");
  });

  it("returns messages for explain-diagnostics with file arg", () => {
    const result = getPrompt("explain-diagnostics", { file: "/src/bar.ts" });
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content.text).toContain("/src/bar.ts");
  });

  it("returns messages for generate-tests with file arg", () => {
    const result = getPrompt("generate-tests", { file: "/src/baz.ts" });
    expect(result).not.toBeNull();
    expect(result!.messages[0]!.content.text).toContain("/src/baz.ts");
  });

  it("returns messages for debug-context with no args", () => {
    const result = getPrompt("debug-context", {});
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBeGreaterThan(0);
  });

  it("returns messages for git-review with no args (uses default base)", () => {
    const result = getPrompt("git-review", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("main");
  });

  it("returns messages for git-review with explicit base arg", () => {
    const result = getPrompt("git-review", { base: "develop" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("develop");
  });

  // ── Dispatch prompts ──────────────────────────────────────────────────────

  it("returns messages for project-status with no args", () => {
    const result = getPrompt("project-status", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getGitStatus");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("runTests");
  });

  it("returns messages for quick-tests with no args", () => {
    const result = getPrompt("quick-tests", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("runTests");
  });

  it("returns messages for quick-tests with filter arg", () => {
    const result = getPrompt("quick-tests", { filter: "auth" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("auth");
  });

  it("returns messages for quick-review with no args", () => {
    const result = getPrompt("quick-review", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getGitDiff");
    expect(text).toContain("getDiagnostics");
  });

  it("returns messages for build-check with no args", () => {
    const result = getPrompt("build-check", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getProjectInfo");
    expect(text).toContain("getDiagnostics");
  });

  it("returns messages for recent-activity with no args (default count)", () => {
    const result = getPrompt("recent-activity", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getGitLog");
    expect(text).toContain("10");
  });

  it("returns messages for recent-activity with custom count", () => {
    const result = getPrompt("recent-activity", { count: "5" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("5");
  });

  // ── Agent Teams & Scheduled Tasks prompts ────────────────────────────────

  it("returns messages for team-status with no args", () => {
    const result = getPrompt("team-status", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getGitStatus");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("getOpenEditors");
    expect(text).toContain("listClaudeTasks");
    expect(text).toContain("getActivityLog");
  });

  // ── Setup prompts ────────────────────────────────────────────────────────

  it("returns messages for orient-project with default style (standard)", () => {
    const result = getPrompt("orient-project", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getProjectInfo");
    expect(text).toContain("getFileTree");
    expect(text).toContain("getGitStatus");
    expect(text).toContain("findFiles");
    expect(text).toContain("getToolCapabilities");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("documents/architecture.md");
    expect(text).toContain("documents/styleguide.md");
    expect(text).toContain("documents/roadmap.md");
    expect(text).toContain("docs/adr/README.md");
    expect(text).toContain(".claude/rules/");
    expect(text).toContain("createFile");
  });

  it("orient-project with style=minimal omits docs and rules scaffolding", () => {
    const result = getPrompt("orient-project", { style: "minimal" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getProjectInfo");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("getToolCapabilities");
    expect(text).not.toContain("Phase 3");
    expect(text).not.toContain("documents/architecture.md");
    expect(text).not.toContain(".claude/rules/testing.md");
  });

  it("orient-project with style=full includes commands and agents", () => {
    const result = getPrompt("orient-project", { style: "full" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("documents/architecture.md");
    expect(text).toContain("documents/use-cases.md");
    expect(text).toContain(".claude/commands/orient.md");
    expect(text).toContain("project-builder");
    expect(text).toContain(".claude/rules/");
  });

  it("orient-project with invalid style defaults to standard", () => {
    const result = getPrompt("orient-project", { style: "bogus" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("documents/architecture.md");
    expect(text).toContain(".claude/rules/");
    expect(text).not.toContain("documents/use-cases.md");
    expect(text).not.toContain(".claude/commands/orient.md");
  });

  it("returns messages for health-check with no args", () => {
    const result = getPrompt("health-check", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getGitStatus");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("runTests");
    expect(text).toContain("getSecurityAdvisories");
    expect(text).toContain("auditDependencies");
    expect(text).toContain("HEALTHY");
  });

  // LSP composition prompts
  it("find-callers references call hierarchy and findReferences tools", () => {
    const result = getPrompt("find-callers", { symbol: "MyClass" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("MyClass");
    expect(text).toContain("getCallHierarchy");
    expect(text).toContain("findReferences");
  });

  it("find-callers requires symbol arg", () => {
    const result = getPrompt("find-callers", {});
    expect(result).toBeNull();
  });

  it("blast-radius references getChangeImpact tool", () => {
    const result = getPrompt("blast-radius", {
      file: "src/foo.ts",
      line: "10",
      column: "5",
    });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getChangeImpact");
    expect(text).toContain("src/foo.ts");
  });

  it("blast-radius requires file, line, column args", () => {
    expect(getPrompt("blast-radius", {})).toBeNull();
    expect(getPrompt("blast-radius", { file: "src/foo.ts" })).toBeNull();
  });

  it("why-error references getDiagnostics and explainSymbol tools", () => {
    const result = getPrompt("why-error", { file: "/src/foo.ts" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("explainSymbol");
    expect(text).toContain("/src/foo.ts");
  });

  it("why-error requires file arg", () => {
    const result = getPrompt("why-error", {});
    expect(result).toBeNull();
  });

  it("unused-in references detectUnusedCode and findReferences tools", () => {
    const result = getPrompt("unused-in", { file: "/src/foo.ts" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("detectUnusedCode");
    expect(text).toContain("findReferences");
  });

  it("unused-in requires file arg", () => {
    const result = getPrompt("unused-in", {});
    expect(result).toBeNull();
  });

  it("trace-to references getCallHierarchy and getImportedSignatures tools", () => {
    const result = getPrompt("trace-to", { symbol: "handleRequest" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getCallHierarchy");
    expect(text).toContain("getImportedSignatures");
    expect(text).toContain("handleRequest");
  });

  it("trace-to requires symbol arg", () => {
    const result = getPrompt("trace-to", {});
    expect(result).toBeNull();
  });

  it("imports-of references findReferences and searchWorkspaceSymbols tools", () => {
    const result = getPrompt("imports-of", { symbol: "MyType" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("findReferences");
    expect(text).toContain("searchWorkspaceSymbols");
    expect(text).toContain("MyType");
  });

  it("imports-of requires symbol arg", () => {
    const result = getPrompt("imports-of", {});
    expect(result).toBeNull();
  });

  it("circular-deps references getImportTree tool", () => {
    const result = getPrompt("circular-deps", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getImportTree");
  });

  it("refactor-preview references refactorAnalyze and refactorPreview tools", () => {
    const result = getPrompt("refactor-preview", {
      file: "src/foo.ts",
      line: "5",
      column: "3",
      newName: "betterName",
    });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("refactorAnalyze");
    expect(text).toContain("refactorPreview");
    expect(text).toContain("betterName");
  });

  it("refactor-preview requires file, line, column, and newName args", () => {
    expect(getPrompt("refactor-preview", {})).toBeNull();
    expect(
      getPrompt("refactor-preview", {
        file: "src/foo.ts",
        line: "5",
        column: "3",
      }),
    ).toBeNull();
    expect(getPrompt("refactor-preview", { newName: "betterName" })).toBeNull();
  });

  it("module-exports references getDocumentSymbols tool", () => {
    const result = getPrompt("module-exports", { file: "/src/foo.ts" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getDocumentSymbols");
  });

  it("module-exports requires file arg", () => {
    const result = getPrompt("module-exports", {});
    expect(result).toBeNull();
  });

  it("type-of references getHover tool", () => {
    const result = getPrompt("type-of", {
      file: "src/foo.ts",
      line: "3",
      column: "10",
    });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getHover");
    expect(text).toContain("src/foo.ts");
  });

  it("type-of requires file, line, column args", () => {
    expect(getPrompt("type-of", {})).toBeNull();
    expect(getPrompt("type-of", { file: "src/foo.ts" })).toBeNull();
  });

  it("deprecations references searchWorkspace and findReferences tools", () => {
    const result = getPrompt("deprecations", {});
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("searchWorkspace");
    expect(text).toContain("findReferences");
    expect(text).toContain("@deprecated");
  });

  it("coverage-gap references getCodeCoverage and getDocumentSymbols tools", () => {
    const result = getPrompt("coverage-gap", { file: "/src/foo.ts" });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("getCodeCoverage");
    expect(text).toContain("getDocumentSymbols");
  });

  it("coverage-gap requires file arg", () => {
    const result = getPrompt("coverage-gap", {});
    expect(result).toBeNull();
  });

  it("explore-type references findImplementations, goToTypeDefinition, and goToDeclaration tools", () => {
    const result = getPrompt("explore-type", {
      file: "src/foo.ts",
      line: "3",
      column: "10",
    });
    expect(result).not.toBeNull();
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("findImplementations");
    expect(text).toContain("goToTypeDefinition");
    expect(text).toContain("goToDeclaration");
    expect(text).toContain("src/foo.ts");
  });

  it("explore-type requires file, line, and column args", () => {
    expect(getPrompt("explore-type", {})).toBeNull();
    expect(getPrompt("explore-type", { file: "src/foo.ts" })).toBeNull();
    expect(
      getPrompt("explore-type", { file: "src/foo.ts", line: "3" }),
    ).toBeNull();
  });

  it("all returned messages have correct shape", () => {
    for (const prompt of PROMPTS) {
      const args: Record<string, string> = {};
      for (const arg of prompt.arguments ?? []) {
        if (arg.required) args[arg.name] = "/test/path.ts";
      }
      const result = getPrompt(prompt.name, args);
      expect(result).not.toBeNull();
      for (const msg of result!.messages) {
        expect(["user", "assistant"]).toContain(msg.role);
        expect(msg.content.type).toBe("text");
        expect(typeof msg.content.text).toBe("string");
        expect(msg.content.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("returns messages for review-changes with file arg", () => {
    const result = getPrompt("review-changes", { file: "src/tools/foo.ts" });
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBeGreaterThan(0);
    expect(result!.messages[0]!.role).toBe("user");
    const text = result!.messages[0]!.content.text;
    expect(text).toContain("src/tools/foo.ts");
    expect(text).toContain("getGitDiff");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("getGitHotspots");
  });

  it("review-changes returns null when file arg is missing", () => {
    expect(getPrompt("review-changes", {})).toBeNull();
  });

  it("review-changes description contains the file name", () => {
    const result = getPrompt("review-changes", { file: "src/auth.ts" });
    expect(result!.description).toContain("src/auth.ts");
  });
});
