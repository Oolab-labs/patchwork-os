import { describe, expect, it } from "vitest";
import { evaluateRules, loadCcPermissions } from "../ccPermissions.js";

describe("evaluateRules", () => {
  it("deny wins over ask and allow", () => {
    const r = {
      allow: ["gitPush"],
      ask: ["gitPush"],
      deny: ["gitPush"],
    };
    expect(evaluateRules("gitPush", undefined, r)).toBe("deny");
  });

  it("ask wins over allow when both match", () => {
    const r = { allow: ["Bash"], ask: ["Bash"], deny: [] };
    expect(evaluateRules("Bash", "ls", r)).toBe("ask");
  });

  it("allow matches plain tool name", () => {
    const r = { allow: ["Read"], ask: [], deny: [] };
    expect(evaluateRules("Read", undefined, r)).toBe("allow");
  });

  it("returns 'none' when no rule matches", () => {
    const r = { allow: [], ask: [], deny: [] };
    expect(evaluateRules("gitPush", undefined, r)).toBe("none");
  });

  it("matches Bash wildcard with space-before-star", () => {
    const r = { allow: ["Bash(npm run *)"], ask: [], deny: [] };
    expect(evaluateRules("Bash", "npm run build", r)).toBe("allow");
    expect(evaluateRules("Bash", "npm run test -- --watch", r)).toBe("allow");
  });

  it("does NOT match prefix only", () => {
    const r = { allow: ["Bash(npm run *)"], ask: [], deny: [] };
    expect(evaluateRules("Bash", "npm runaway", r)).toBe("none");
  });

  it("matches :* trailing wildcard equivalent", () => {
    const r = { allow: ["Bash(git:*)"], ask: [], deny: [] };
    expect(evaluateRules("Bash", "git status", r)).toBe("allow");
  });

  it("matches WebFetch(domain:...) literal spec", () => {
    const r = {
      allow: ["WebFetch(domain:github.com)"],
      ask: [],
      deny: [],
    };
    expect(evaluateRules("WebFetch", "domain:github.com", r)).toBe("allow");
    expect(evaluateRules("WebFetch", "domain:evil.com", r)).toBe("none");
  });
});

describe("loadCcPermissions", () => {
  it("merges allow/ask/deny across files in precedence order", () => {
    const files: Record<string, string> = {
      "/ws/.claude/settings.local.json": JSON.stringify({
        permissions: { allow: ["LocalTool"] },
      }),
      "/ws/.claude/settings.json": JSON.stringify({
        permissions: { deny: ["gitPush"], ask: ["gitCommit"] },
      }),
    };
    const rules = loadCcPermissions("/ws", {
      readFile: (p) => files[p] ?? "",
      exists: (p) => p in files,
    });
    expect(rules.allow).toContain("LocalTool");
    expect(rules.deny).toContain("gitPush");
    expect(rules.ask).toContain("gitCommit");
  });

  it("tolerates malformed settings.json without throwing", () => {
    const rules = loadCcPermissions("/ws", {
      readFile: () => "{not json",
      exists: () => true,
    });
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual([]);
  });

  it("skips missing files", () => {
    const rules = loadCcPermissions("/ws", {
      readFile: () => {
        throw new Error("shouldn't be called");
      },
      exists: () => false,
    });
    expect(rules.allow).toEqual([]);
  });
});
