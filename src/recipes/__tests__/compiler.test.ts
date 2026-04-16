import { describe, expect, it } from "vitest";
import { compileRecipe, RecipeCompileError } from "../compiler.js";
import type { Recipe } from "../schema.js";

const BASE: Recipe = {
  name: "demo",
  version: "1.0",
  trigger: { type: "file_watch", patterns: ["src/**/*.ts"] },
  steps: [
    { id: "s1", agent: true, prompt: "do the thing" },
    { id: "s2", agent: false, tool: "send_message", params: { text: "done" } },
  ],
};

function unwrapToHook(program: ReturnType<typeof compileRecipe>): {
  hookType: string;
  prompt: string;
  patterns?: string[];
} {
  // Walk: WithRateLimit → WithCooldown → (WithRetry?) → Hook
  let p = program;
  while (p._tag !== "Hook") {
    if ("program" in p) p = p.program;
    else throw new Error("no Hook node found");
  }
  return {
    hookType: p.hookType,
    prompt: p.promptSource.kind === "inline" ? p.promptSource.prompt : "",
    patterns: p.patterns,
  };
}

describe("compileRecipe", () => {
  it("maps file_watch → onFileSave with patterns", () => {
    const program = compileRecipe(BASE);
    const inner = unwrapToHook(program);
    expect(inner.hookType).toBe("onFileSave");
    expect(inner.patterns).toEqual(["src/**/*.ts"]);
  });

  it("wraps program in rate-limit + cooldown", () => {
    const program = compileRecipe(BASE);
    expect(program._tag).toBe("WithRateLimit");
    if (program._tag === "WithRateLimit") {
      expect(program.program._tag).toBe("WithCooldown");
    }
  });

  it("adds WithRetry when on_error.retry > 0", () => {
    const r: Recipe = { ...BASE, on_error: { retry: 3 } };
    const program = compileRecipe(r);
    // WithRateLimit → WithCooldown → WithRetry → Hook
    let p = program;
    let found = false;
    while (p._tag !== "Hook") {
      if (p._tag === "WithRetry") {
        found = true;
        expect(p.maxRetries).toBe(3);
      }
      if ("program" in p) p = p.program;
      else break;
    }
    expect(found).toBe(true);
  });

  it("skips WithRetry when no retry policy", () => {
    const program = compileRecipe(BASE);
    let p = program;
    while (p._tag !== "Hook") {
      expect(p._tag).not.toBe("WithRetry");
      if ("program" in p) p = p.program;
      else break;
    }
  });

  it("serializes steps into prompt with agent + tool distinction", () => {
    const inner = unwrapToHook(compileRecipe(BASE));
    expect(inner.prompt).toContain("Step 1/2 — s1 (agent)");
    expect(inner.prompt).toContain("do the thing");
    expect(inner.prompt).toContain("Step 2/2 — s2 (tool: send_message)");
    expect(inner.prompt).toContain('"text": "done"');
  });

  it("maps git_hook events correctly", () => {
    const cases = [
      { event: "post-commit" as const, expect: "onGitCommit" },
      { event: "pre-push" as const, expect: "onGitPush" },
      { event: "post-merge" as const, expect: "onGitPull" },
    ];
    for (const c of cases) {
      const inner = unwrapToHook(
        compileRecipe({
          ...BASE,
          trigger: { type: "git_hook", event: c.event },
        }),
      );
      expect(inner.hookType).toBe(c.expect);
    }
  });

  it("rejects webhook trigger with clear message", () => {
    expect(() =>
      compileRecipe({
        ...BASE,
        trigger: { type: "webhook", path: "/hooks/x" },
      }),
    ).toThrow(RecipeCompileError);
  });

  it("rejects cron + manual triggers", () => {
    expect(() =>
      compileRecipe({
        ...BASE,
        trigger: { type: "cron", schedule: "0 9 * * *" },
      }),
    ).toThrow(/scheduler wiring/);
    expect(() =>
      compileRecipe({ ...BASE, trigger: { type: "manual" } }),
    ).toThrow(/patchwork run/);
  });
});
