/**
 * Tests for universal `.disabled` marker enforcement across all recipe-trigger
 * surfaces (Bug #1 from the 2026-04-28 audit).
 *
 * PR #43 wired `.disabled` enforcement into the cron scheduler. Webhook,
 * manual-fire (`patchwork recipe run` / HTTP /recipes/run), and the
 * automation interpreter still ignored the marker — so a "disabled" recipe
 * could fire via webhook or be triggered by automation. This test file
 * locks in the fix.
 *
 * Two related issues fixed together:
 *   1. install-dir recipes (created by `runRecipeInstall` into a subdir)
 *      were invisible to `findWebhookRecipe` / `findYamlRecipePath` — those
 *      only scanned top-level files. Recipes installed via the marketplace
 *      flow couldn't be triggered at all by webhook/manual paths.
 *   2. `.disabled` marker wasn't checked on the result.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findWebhookRecipe,
  findYamlRecipePath,
  loadRecipePrompt,
} from "../recipesHttp.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-disabled-marker-"));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function writeInstalledRecipe(
  dirName: string,
  yamlBody: string,
  opts: { disabled?: boolean; manifestMain?: string } = {},
) {
  const dir = path.join(tmp, dirName);
  mkdirSync(dir, { recursive: true });
  const yamlFile = opts.manifestMain ?? "main.yaml";
  writeFileSync(path.join(dir, yamlFile), yamlBody);
  if (opts.manifestMain) {
    writeFileSync(
      path.join(dir, "recipe.json"),
      JSON.stringify(
        {
          name: dirName,
          version: "1.0.0",
          description: "x",
          recipes: { main: opts.manifestMain },
        },
        null,
        2,
      ),
    );
  }
  if (opts.disabled) {
    writeFileSync(path.join(dir, ".disabled"), "");
  }
  return dir;
}

describe("findWebhookRecipe — install-dir support + .disabled enforcement", () => {
  it("finds a webhook recipe inside an install dir", () => {
    writeInstalledRecipe(
      "deploy-pkg",
      [
        "name: deploy-trigger",
        "trigger:",
        "  type: webhook",
        "  path: /deploy",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: deploy",
      ].join("\n"),
    );

    const match = findWebhookRecipe(tmp, "/deploy");
    expect(match).not.toBeNull();
    expect(match?.name).toBe("deploy-trigger");
    expect(match?.path).toBe("/deploy");
  });

  it("does NOT find a webhook recipe whose install dir has the .disabled marker", () => {
    writeInstalledRecipe(
      "deploy-pkg",
      [
        "name: deploy-trigger",
        "trigger:",
        "  type: webhook",
        "  path: /deploy",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: deploy",
      ].join("\n"),
      { disabled: true },
    );

    const match = findWebhookRecipe(tmp, "/deploy");
    expect(match).toBeNull();
  });

  it("still finds top-level (legacy) webhook recipes", () => {
    writeFileSync(
      path.join(tmp, "topdeploy.json"),
      JSON.stringify({
        name: "top-trigger",
        version: "1",
        trigger: { type: "webhook", path: "/top" },
        steps: [{ id: "main", agent: true, prompt: "x" }],
      }),
    );
    const match = findWebhookRecipe(tmp, "/top");
    expect(match?.name).toBe("top-trigger");
  });

  it("respects manifest's recipes.main when finding the trigger", () => {
    writeInstalledRecipe(
      "weekly-pkg",
      [
        "name: weekly-trigger",
        "trigger:",
        "  type: webhook",
        "  path: /weekly",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: x",
      ].join("\n"),
      { manifestMain: "weekly.yaml" },
    );

    const match = findWebhookRecipe(tmp, "/weekly");
    expect(match?.name).toBe("weekly-trigger");
  });
});

describe("findYamlRecipePath — install-dir support + .disabled enforcement", () => {
  it("finds a YAML recipe whose name lives in an install dir", () => {
    writeInstalledRecipe(
      "morning-pkg",
      [
        "name: morning-brief",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: brief",
      ].join("\n"),
    );

    const found = findYamlRecipePath(tmp, "morning-brief");
    expect(found).not.toBeNull();
    expect(found).toContain("morning-pkg");
  });

  it("does NOT find a recipe whose install dir has .disabled marker", () => {
    writeInstalledRecipe(
      "morning-pkg",
      [
        "name: morning-brief",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: brief",
      ].join("\n"),
      { disabled: true },
    );

    const found = findYamlRecipePath(tmp, "morning-brief");
    expect(found).toBeNull();
  });

  it("still resolves top-level <name>.yaml (legacy)", () => {
    writeFileSync(
      path.join(tmp, "legacy.yaml"),
      [
        "name: legacy",
        "trigger:",
        "  type: manual",
        "steps:",
        "  - id: main",
        "    agent: true",
        "    prompt: x",
      ].join("\n"),
    );
    const found = findYamlRecipePath(tmp, "legacy");
    expect(found).toContain("legacy.yaml");
  });
});

describe("loadRecipePrompt — install-dir support + .disabled enforcement", () => {
  it("does NOT load a JSON recipe whose install dir has .disabled marker", () => {
    const dir = path.join(tmp, "json-pkg");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "json-recipe.json"),
      JSON.stringify({
        name: "json-recipe",
        version: "1",
        trigger: { type: "manual" },
        steps: [{ id: "main", agent: true, prompt: "hi" }],
      }),
    );
    writeFileSync(path.join(dir, ".disabled"), "");

    const result = loadRecipePrompt(tmp, "json-recipe");
    expect(result).toBeNull();
  });
});
