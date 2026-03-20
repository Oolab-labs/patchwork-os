import { describe, expect, it } from "vitest";
import { PROMPTS, getPrompt } from "../prompts.js";

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
});
