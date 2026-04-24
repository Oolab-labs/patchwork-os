import { describe, expect, it, vi } from "vitest";
import { normalizeRecipeForRuntime } from "../legacyRecipeCompat.js";

describe("normalizeRecipeForRuntime — deprecation warnings", () => {
  it("emits no warnings for a modern recipe", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "test",
        trigger: { type: "cron", at: "0 9 * * *" },
        steps: [{ tool: "shell.run", cmd: "echo hi" }],
      },
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on trigger.schedule → trigger.at rename", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "cron", schedule: "0 9 * * *" },
        steps: [],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("trigger.schedule"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("trigger.at"));
  });

  it("migrates trigger.schedule to trigger.at", () => {
    const result = normalizeRecipeForRuntime({
      name: "t",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      steps: [],
    }) as Record<string, unknown>;
    const trigger = result.trigger as Record<string, unknown>;
    expect(trigger.at).toBe("0 9 * * *");
    expect(trigger.schedule).toBeUndefined();
  });

  it("warns on agent: true boolean", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ agent: true, prompt: "do something" }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent: true"));
  });

  it("warns on step-level prompt moved to agent.prompt", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ agent: true, prompt: "do something" }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent.prompt"));
  });

  it("warns on step-level output moved to agent.into", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ agent: true, output: "result" }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent.into"));
  });

  it("warns on params inline promotion", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ tool: "shell.run", params: { cmd: "echo hi" } }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("params"));
  });

  it("warns on chain → recipe rename", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ chain: "other-recipe" }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("chain"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recipe"));
  });

  it("warns on step-level output → into rename (non-agent)", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ tool: "shell.run", cmd: "echo hi", output: "out" }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("into"));
  });

  it("warns on file.append line → content rename", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [{ tool: "file.append", line: "hello" }],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("line"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("content"));
  });

  it("does not warn when warn callback omitted", () => {
    // Should not throw even with legacy fields
    expect(() =>
      normalizeRecipeForRuntime({
        name: "t",
        trigger: { type: "cron", schedule: "0 9 * * *" },
        steps: [{ chain: "other" }],
      }),
    ).not.toThrow();
  });

  it("warns inside parallel steps", () => {
    const warn = vi.fn();
    normalizeRecipeForRuntime(
      {
        name: "t",
        trigger: { type: "manual" },
        steps: [
          {
            parallel: [{ tool: "file.append", line: "x" }],
          },
        ],
      },
      warn,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("line"));
  });
});
