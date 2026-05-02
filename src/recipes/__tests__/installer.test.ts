import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  it("creates recipe in recipesDir; returns suggested permissions JSON without writing sidecar", () => {
    const src = writeRecipe("source", SIMPLE);
    const recipesDir = path.join(dir, "recipes");
    const result = installRecipeFromFile(src, { recipesDir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("sentry-autofix.json")).toBe(true);
    const written = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(written.name).toBe("sentry-autofix");
    // alpha.36+ — sidecar `<name>.permissions.json` is no longer written.
    expect(existsSync(`${result.installedPath}.permissions.json`)).toBe(false);
    // permissionsJson is still returned for callers who want to render it
    // (e.g. CLI install confirmation).
    const perms = JSON.parse(result.permissionsJson);
    expect(perms.permissions.ask).toContain("Edit(/src/**)");
    expect(perms.permissions.ask).toContain("Read");
  });

  it("reports 'replaced' on second install", () => {
    const src = writeRecipe("source", SIMPLE);
    const recipesDir = path.join(dir, "recipes");
    installRecipeFromFile(src, { recipesDir });
    const second = installRecipeFromFile(src, { recipesDir });
    expect(second.action).toBe("replaced");
  });

  it("accepts YAML recipe files", () => {
    const src = path.join(dir, "recipe.yaml");
    writeFileSync(
      src,
      `name: yaml-recipe
version: "1.0"
description: from YAML
trigger:
  type: file_watch
  patterns:
    - "**/*.md"
steps:
  - id: summarize
    agent: true
    prompt: summarize the change
    tools:
      - Read
    risk: low
`,
    );
    const recipesDir = path.join(dir, "recipes");
    const result = installRecipeFromFile(src, { recipesDir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("yaml-recipe.json")).toBe(true);
    const written = JSON.parse(readFileSync(result.installedPath, "utf-8"));
    expect(written.trigger.type).toBe("file_watch");
    expect(written.steps[0].tools).toEqual(["Read"]);
  });

  it("accepts .yml extension", () => {
    const src = path.join(dir, "recipe.yml");
    writeFileSync(
      src,
      `name: short-ext
version: "1.0"
trigger: { type: manual }
steps:
  - id: x
    agent: false
    tool: send_message
    params: { text: hi }
`,
    );
    // Manual triggers bypass compile by design — install succeeds; asserts .yml is accepted
    const result = installRecipeFromFile(src, { recipesDir: dir });
    expect(result.action).toBe("created");
    expect(result.installedPath.endsWith("short-ext.json")).toBe(true);
  });

  it("rejects unknown extensions", () => {
    const src = path.join(dir, "recipe.toml");
    writeFileSync(src, "name = 'x'");
    expect(() => installRecipeFromFile(src, { recipesDir: dir })).toThrow(
      /Expected \.json, \.yaml, or \.yml/,
    );
  });

  it("propagates parser errors", () => {
    const src = writeRecipe("bad", { name: "x" }); // missing required fields
    expect(() => installRecipeFromFile(src, { recipesDir: dir })).toThrow();
  });
});
