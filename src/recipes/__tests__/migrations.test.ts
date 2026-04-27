import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_API_VERSION,
  migrateRecipeToCurrent,
} from "../migrations/index.js";

describe("migrateRecipeToCurrent", () => {
  it("stamps apiVersion patchwork.sh/v1 on an unversioned recipe", () => {
    const warn = vi.fn();
    const result = migrateRecipeToCurrent(
      {
        name: "no-version",
        trigger: { type: "manual" },
        steps: [{ tool: "file.write", path: "/tmp/a", content: "x" }],
      },
      warn,
    );
    const r = result.recipe as Record<string, unknown>;
    expect(r.apiVersion).toBe(CURRENT_API_VERSION);
    expect(result.applied).toEqual(["(unversioned) -> patchwork.sh/v1"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("apiVersion"));
  });

  it("preserves all original fields when stamping apiVersion", () => {
    const input = {
      name: "preserve",
      description: "Preserve fields",
      trigger: { type: "manual" },
      steps: [{ tool: "file.read", path: "/tmp/b" }],
    };
    const { recipe } = migrateRecipeToCurrent(input);
    const r = recipe as Record<string, unknown>;
    expect(r.name).toBe("preserve");
    expect(r.description).toBe("Preserve fields");
    expect(r.trigger).toEqual({ type: "manual" });
    expect(r.steps).toEqual([{ tool: "file.read", path: "/tmp/b" }]);
  });

  it("is a no-op when apiVersion already matches the current version", () => {
    const warn = vi.fn();
    const input = {
      apiVersion: CURRENT_API_VERSION,
      name: "current",
      trigger: { type: "manual" },
      steps: [],
    };
    const result = migrateRecipeToCurrent(input, warn);
    expect(result.applied).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    const r = result.recipe as Record<string, unknown>;
    expect(r.apiVersion).toBe(CURRENT_API_VERSION);
  });

  it("passes unknown future apiVersion through unchanged for downstream lint", () => {
    const warn = vi.fn();
    const input = {
      apiVersion: "patchwork.sh/v999",
      name: "future",
      trigger: { type: "manual" },
      steps: [],
    };
    const result = migrateRecipeToCurrent(input, warn);
    expect(result.applied).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    const r = result.recipe as Record<string, unknown>;
    expect(r.apiVersion).toBe("patchwork.sh/v999");
  });

  it("returns non-record inputs untouched", () => {
    expect(migrateRecipeToCurrent(null)).toEqual({
      recipe: null,
      applied: [],
    });
    expect(migrateRecipeToCurrent("string")).toEqual({
      recipe: "string",
      applied: [],
    });
    expect(migrateRecipeToCurrent([1, 2, 3])).toEqual({
      recipe: [1, 2, 3],
      applied: [],
    });
  });

  it("does not mutate the input recipe", () => {
    const input: Record<string, unknown> = {
      name: "no-mutate",
      trigger: { type: "manual" },
      steps: [],
    };
    const before = JSON.stringify(input);
    migrateRecipeToCurrent(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.apiVersion).toBeUndefined();
  });
});
