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
