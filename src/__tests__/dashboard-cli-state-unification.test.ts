/**
 * Tests for dashboard ↔ CLI disabled-state unification (Bug #2 from the
 * 2026-04-28 audit).
 *
 * Two systems coexisted:
 *   - **Legacy config**: `cfg.recipes.disabled` array — written by the
 *     dashboard "Disable" button (`setRecipeEnabledFn` in
 *     `recipeOrchestration.ts`), read by `listInstalledRecipes`.
 *   - **Per-install marker**: `.disabled` file inside each install dir —
 *     written by CLI `recipe enable/disable`, read by scheduler + (PR #49)
 *     webhook + manual-fire paths.
 *
 * Neither read the other. So clicking "Disable" in the dashboard for an
 * install-dir recipe wrote a name to the config that nothing checked.
 *
 * After the fix, the routing is:
 *   - `setRecipeEnabled(name)` finds the install dir if any and writes
 *     the marker; falls back to legacy config for top-level files.
 *   - `listInstalledRecipes` reports `enabled` from whichever system
 *     applies to that recipe (or AND for safety — disabled in either =
 *     disabled).
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
import { listInstalledRecipes, setRecipeEnabled } from "../recipesHttp.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "patchwork-state-unify-"));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function writeInstallDirRecipe(
  dirName: string,
  name: string,
  opts: { disabled?: boolean } = {},
) {
  const dir = path.join(tmp, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "main.yaml"),
    [
      `name: ${name}`,
      "trigger:",
      "  type: manual",
      "steps:",
      "  - id: main",
      "    agent: true",
      "    prompt: x",
    ].join("\n"),
  );
  if (opts.disabled) {
    writeFileSync(path.join(dir, ".disabled"), "");
  }
}

function writeTopLevelRecipe(filename: string, name: string) {
  writeFileSync(
    path.join(tmp, filename),
    JSON.stringify({
      name,
      version: "1",
      trigger: { type: "manual" },
      steps: [{ id: "main", agent: true, prompt: "x" }],
    }),
  );
}

describe("setRecipeEnabled — install-dir recipe writes marker", () => {
  it("disabling an install-dir recipe writes the .disabled marker", () => {
    writeInstallDirRecipe("morning-pkg", "morning-brief");

    const result = setRecipeEnabled("morning-brief", false, {
      recipesDir: tmp,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(tmp, "morning-pkg", ".disabled"))).toBe(true);
  });

  it("enabling an install-dir recipe removes the .disabled marker", () => {
    writeInstallDirRecipe("morning-pkg", "morning-brief", { disabled: true });

    const result = setRecipeEnabled("morning-brief", true, {
      recipesDir: tmp,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(tmp, "morning-pkg", ".disabled"))).toBe(false);
  });

  it("disabling an install-dir recipe is idempotent", () => {
    writeInstallDirRecipe("morning-pkg", "morning-brief", { disabled: true });

    const result = setRecipeEnabled("morning-brief", false, {
      recipesDir: tmp,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(tmp, "morning-pkg", ".disabled"))).toBe(true);
  });
});

describe("listInstalledRecipes — install-dir recipes report enabled state from marker", () => {
  it("reports enabled=true for an install-dir recipe with no marker", () => {
    writeInstallDirRecipe("morning-pkg", "morning-brief");
    const list = listInstalledRecipes(tmp);
    const entry = list.recipes.find((r) => r.name === "morning-brief");
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(true);
  });

  it("reports enabled=false for an install-dir recipe with .disabled marker", () => {
    writeInstallDirRecipe("morning-pkg", "morning-brief", { disabled: true });
    const list = listInstalledRecipes(tmp);
    const entry = list.recipes.find((r) => r.name === "morning-brief");
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
  });

  it("install-dir recipes still appear in the list (visibility regression check)", () => {
    writeInstallDirRecipe("standup-pkg", "standup-digest");
    const list = listInstalledRecipes(tmp);
    expect(list.recipes.some((r) => r.name === "standup-digest")).toBe(true);
  });

  it("top-level legacy recipes still report enabled=true by default", () => {
    writeTopLevelRecipe("legacy.json", "legacy-recipe");
    const list = listInstalledRecipes(tmp);
    const entry = list.recipes.find((r) => r.name === "legacy-recipe");
    expect(entry?.enabled).toBe(true);
  });
});
