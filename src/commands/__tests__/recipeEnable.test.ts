/**
 * Tests for the recipe enable/disable flow.
 *
 * The wave2 plan (`docs/recipe-authoring-wave2-plan.md:242`) requires
 * recipes installed from third parties to start *disabled* — scheduled
 * triggers (cron/file-watch) only fire after the user explicitly opts
 * in via `patchwork recipe enable <name>`.
 *
 * The state lives as a `.disabled` marker file inside the install dir.
 * Absence = enabled (so legacy installs predating this PR keep working).
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
  isRecipeEnabled,
  listInstalledRecipes,
  runRecipeDisable,
  runRecipeEnable,
  runRecipeInstall,
} from "../recipeInstall.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "patchwork-enable-test-"));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function makeInstalledRecipe(name: string, withDisabledMarker: boolean) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "main.yaml"), "name: test\nsteps: []\n");
  if (withDisabledMarker) {
    writeFileSync(path.join(dir, ".disabled"), "");
  }
  return dir;
}

describe("isRecipeEnabled", () => {
  it("returns true when the install dir has no disabled marker", () => {
    const dir = makeInstalledRecipe("legacy", false);
    expect(isRecipeEnabled(dir)).toBe(true);
  });

  it("returns false when the disabled marker is present", () => {
    const dir = makeInstalledRecipe("fresh", true);
    expect(isRecipeEnabled(dir)).toBe(false);
  });
});

describe("runRecipeEnable", () => {
  it("removes the disabled marker on a freshly-installed recipe", () => {
    makeInstalledRecipe("morning-brief", true);

    const result = runRecipeEnable("morning-brief", { recipesDir: tmpRoot });

    expect(result.alreadyEnabled).toBe(false);
    expect(existsSync(path.join(tmpRoot, "morning-brief", ".disabled"))).toBe(
      false,
    );
  });

  it("is idempotent on an already-enabled recipe", () => {
    makeInstalledRecipe("legacy", false);

    const result = runRecipeEnable("legacy", { recipesDir: tmpRoot });

    expect(result.alreadyEnabled).toBe(true);
    expect(existsSync(path.join(tmpRoot, "legacy", ".disabled"))).toBe(false);
  });

  it("throws a clear error when the recipe is not installed", () => {
    expect(() =>
      runRecipeEnable("nonexistent", { recipesDir: tmpRoot }),
    ).toThrow(/No installed recipe named "nonexistent"/);
  });
});

describe("runRecipeDisable", () => {
  it("writes the disabled marker on an enabled recipe", () => {
    makeInstalledRecipe("legacy", false);

    const result = runRecipeDisable("legacy", { recipesDir: tmpRoot });

    expect(result.alreadyDisabled).toBe(false);
    expect(existsSync(path.join(tmpRoot, "legacy", ".disabled"))).toBe(true);
  });

  it("is idempotent on an already-disabled recipe", () => {
    makeInstalledRecipe("fresh", true);

    const result = runRecipeDisable("fresh", { recipesDir: tmpRoot });

    expect(result.alreadyDisabled).toBe(true);
    expect(existsSync(path.join(tmpRoot, "fresh", ".disabled"))).toBe(true);
  });

  it("throws a clear error when the recipe is not installed", () => {
    expect(() =>
      runRecipeDisable("nonexistent", { recipesDir: tmpRoot }),
    ).toThrow(/No installed recipe named "nonexistent"/);
  });
});

describe("runRecipeInstall — disabled-by-default", () => {
  it("writes a .disabled marker on a fresh local install", async () => {
    // Stage a local "source" dir to install from
    const srcDir = mkdtempSync(path.join(os.tmpdir(), "patchwork-src-"));
    writeFileSync(path.join(srcDir, "main.yaml"), "name: t\nsteps: []\n");

    try {
      const result = await runRecipeInstall(srcDir, { recipesDir: tmpRoot });
      expect(existsSync(path.join(result.installDir, ".disabled"))).toBe(true);
      expect(isRecipeEnabled(result.installDir)).toBe(false);
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});

describe("listInstalledRecipes — enabled state in entries", () => {
  it("reports enabled: true for a recipe without the marker", () => {
    makeInstalledRecipe("legacy", false);
    const entries = listInstalledRecipes({ recipesDir: tmpRoot });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enabled).toBe(true);
  });

  it("reports enabled: false for a recipe with the marker", () => {
    makeInstalledRecipe("fresh", true);
    const entries = listInstalledRecipes({ recipesDir: tmpRoot });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enabled).toBe(false);
  });

  it("reports the correct state per-recipe across a mix", () => {
    makeInstalledRecipe("morning-brief", true);
    makeInstalledRecipe("standup-digest", false);
    const entries = listInstalledRecipes({ recipesDir: tmpRoot });
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.enabled]));
    expect(byName["morning-brief"]).toBe(false);
    expect(byName["standup-digest"]).toBe(true);
  });
});
