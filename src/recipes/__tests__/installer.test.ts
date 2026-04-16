import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRecipeFromFile } from "../installer.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-inst-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRecipe(name: string, recipe: unknown): string {
  const p = path.join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(recipe));
  return p;
}

const SIMPLE = {
  name: "sentry-autofix",
  version: "1.0",
  trigger: { type: "file_watch", patterns: ["**/*.ts"] },
  steps: [
    {
      id: "fix",
      agent: true,
      prompt: "fix it",
      tools: ["Read", "Edit(/src/**)"],
      risk: "medium",
    },
  ],
};

describe("installRecipeFromFile", () => {
  it("creates recipe + permissions file in recipesDir", () => {
    const src = writeRecipe("source", SIMPLE);
    const recipesDir = path.join(dir, "recipes");
    const result = installRecipeFromFile(src, { recipesDir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("sentry-autofix.json")).toBe(true);
    const written = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(written.name).toBe("sentry-autofix");
    const perms = JSON.parse(
      readFileSync(`${result.installedPath}.permissions.json`, "utf-8"),
    );
    expect(perms.permissions.ask).toContain("Edit(/src/**)");
    // step-level risk "medium" sends all step tools to ask bucket
    expect(perms.permissions.ask).toContain("Read");
  });

  it("reports 'replaced' on second install", () => {
    const src = writeRecipe("source", SIMPLE);
    const recipesDir = path.join(dir, "recipes");
    installRecipeFromFile(src, { recipesDir });
    const second = installRecipeFromFile(src, { recipesDir });
    expect(second.action).toBe("replaced");
  });

  it("rejects non-JSON source file with helpful message", () => {
    const src = path.join(dir, "recipe.yaml");
    writeFileSync(src, "name: x\nversion: '1.0'");
    expect(() => installRecipeFromFile(src, { recipesDir: dir })).toThrow(
      /YAML support lands/,
    );
  });

  it("propagates parser errors", () => {
    const src = writeRecipe("bad", { name: "x" }); // missing required fields
    expect(() => installRecipeFromFile(src, { recipesDir: dir })).toThrow();
  });
});
