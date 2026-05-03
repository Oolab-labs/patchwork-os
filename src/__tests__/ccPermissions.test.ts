import { describe, expect, it } from "vitest";
import {
  evaluateRules,
  explainRules,
  loadCcPermissions,
} from "../ccPermissions.js";

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

  it("glob: mid-string wildcard matches", () => {
    const r = { allow: ["Bash(git push origin *)"], ask: [], deny: [] };
    expect(evaluateRules("Bash", "git push origin main", r)).toBe("allow");
    expect(evaluateRules("Bash", "git push origin feature/x", r)).toBe("allow");
    expect(evaluateRules("Bash", "git push upstream main", r)).toBe("none");
  });

  it("glob: URL prefix wildcard", () => {
    const r = {
      allow: ["WebFetch(https://api.example.com/*)"],
      ask: [],
      deny: [],
    };
    expect(
      evaluateRules("WebFetch", "https://api.example.com/v1/users", r),
    ).toBe("allow");
    expect(evaluateRules("WebFetch", "https://evil.com/", r)).toBe("none");
  });

  it("glob: question-mark matches single char", () => {
    const r = { allow: ["Bash(ls ?)"], ask: [], deny: [] };
    expect(evaluateRules("Bash", "ls .", r)).toBe("allow");
    expect(evaluateRules("Bash", "ls ..", r)).toBe("none");
  });

  it("glob: multi-star pattern", () => {
    const r = { allow: ["Bash(docker * --rm *)"], ask: [], deny: [] };
    expect(evaluateRules("Bash", "docker run --rm alpine", r)).toBe("allow");
    expect(evaluateRules("Bash", "docker build .", r)).toBe("none");
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

describe("loadCcPermissions — managed path", () => {
  it("managed deny wins over workspace allow", () => {
    const files: Record<string, string> = {
      "/managed/settings.json": JSON.stringify({
        permissions: { deny: ["gitPush"] },
      }),
      "/ws/.claude/settings.json": JSON.stringify({
        permissions: { allow: ["gitPush"] },
      }),
    };
    const rules = loadCcPermissions("/ws", {
      readFile: (p) => files[p] ?? "",
      exists: (p) => p in files,
      managedPath: "/managed/settings.json",
    });
    expect(rules.deny).toContain("gitPush");
    expect(rules.allow).toContain("gitPush");
    // evaluateRules must pick deny first
    expect(evaluateRules("gitPush", undefined, rules)).toBe("deny");
  });

  it("missing managed file is silently skipped", () => {
    const rules = loadCcPermissions("/ws", {
      readFile: () => {
        throw new Error("shouldn't read missing file");
      },
      exists: () => false,
      managedPath: "/does/not/exist.json",
    });
    expect(rules.deny).toEqual([]);
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

describe("explainRules", () => {
  const rules = {
    deny: [{ pattern: "Bash(rm *)", source: "project" as const }],
    ask: [{ pattern: "Bash(*)", source: "user" as const }],
    allow: [{ pattern: "Read", source: "project-local" as const }],
  };

  it("returns deny explanation when deny rule matches", () => {
    const result = explainRules("Bash", "rm /tmp/foo", rules);
    expect(result).toEqual({
      matchedRule: "Bash(rm *)",
      tier: "deny",
      source: "project",
    });
  });

  it("falls through to ask when deny doesn't match", () => {
    const result = explainRules("Bash", "ls", rules);
    expect(result).toEqual({
      matchedRule: "Bash(*)",
      tier: "ask",
      source: "user",
    });
  });

  it("returns allow explanation for plain tool match", () => {
    const result = explainRules("Read", undefined, rules);
    expect(result).toEqual({
      matchedRule: "Read",
      tier: "allow",
      source: "project-local",
    });
  });

  it("returns null when no rule matches", () => {
    const result = explainRules("Write", undefined, rules);
    expect(result).toBeNull();
  });
});
