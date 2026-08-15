/**
 * #1360 (write half) — `recipe enable` / `disable` must reach the same
 * recipes the CLI can now LIST.
 *
 * The read half (#1360, merged) made `recipe list` prefer the bridge's view,
 * which enumerates BOTH flat top-level recipe files and install directories.
 * The write half was withheld: `runRecipeEnable`/`runRecipeDisable` resolved
 * only via install directories and THREW for every top-level recipe — so the
 * CLI listed recipes it then refused to act on.
 *
 * Both verbs now delegate to the shared `setRecipeEnabled`, the same function
 * the bridge route and dashboard already use. That is the point: a second
 * routing implementation is what #1360 is about, and two of them disagreeing
 * is how a write lands on a mechanism nothing reads.
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
  runRecipeDisable,
  runRecipeEnable,
} from "../commands/recipeInstall.js";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cli-enable-"));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function writeInstallDir(dirName: string, name: string) {
  const dir = path.join(tmp, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "main.yaml"),
    `name: ${name}\ntrigger:\n  type: manual\nsteps: []\n`,
  );
  return dir;
}

/** A flat top-level recipe file — the shape the CLI used to refuse. */
function writeFlatRecipe(name: string) {
  writeFileSync(
    path.join(tmp, `${name}.yaml`),
    `name: ${name}\ntrigger:\n  type: manual\nsteps: []\n`,
  );
}

describe("CLI recipe enable/disable — install-dir recipes", () => {
  it("disables via the .disabled marker and reports the mechanism", () => {
    const dir = writeInstallDir("pkg", "install-dir-recipe");
    const r = runRecipeDisable("install-dir-recipe", { recipesDir: tmp });
    expect(r.alreadyDisabled).toBe(false);
    expect(r.mechanism).toBe("marker");
    expect(existsSync(path.join(dir, ".disabled"))).toBe(true);
  });

  it("is idempotent and says so", () => {
    writeInstallDir("pkg", "install-dir-recipe");
    runRecipeDisable("install-dir-recipe", { recipesDir: tmp });
    const again = runRecipeDisable("install-dir-recipe", { recipesDir: tmp });
    expect(again.alreadyDisabled).toBe(true);
  });

  it("re-enables by removing the marker", () => {
    const dir = writeInstallDir("pkg", "install-dir-recipe");
    runRecipeDisable("install-dir-recipe", { recipesDir: tmp });
    const r = runRecipeEnable("install-dir-recipe", { recipesDir: tmp });
    expect(r.alreadyEnabled).toBe(false);
    expect(existsSync(path.join(dir, ".disabled"))).toBe(false);
  });
});

describe("CLI recipe enable/disable — flat top-level recipes (#1360)", () => {
  it("DISABLES a top-level recipe instead of throwing", () => {
    // Before delegation this threw `No installed recipe named "…"` for every
    // flat recipe — the CLI listed them and then could not act on them.
    writeFlatRecipe("flat-recipe");
    const saved: unknown[] = [];
    // Drives `runRecipeDisable` — the function the CLI calls — NOT the shared
    // helper underneath it. Calling `setRecipeEnabled` here would prove the
    // helper works and say nothing about whether the CLI reaches it.
    const r = runRecipeDisable("flat-recipe", {
      recipesDir: tmp,
      loadConfigFn: () => ({}) as never,
      saveConfigFn: (cfg) => saved.push(cfg),
    });
    expect(r.mechanism).toBe("config");
    expect(r.alreadyDisabled).toBe(false);
    expect(saved).toHaveLength(1);
    expect(
      (saved[0] as { recipes: { disabled: string[] } }).recipes.disabled,
    ).toContain("flat-recipe");
  });

  it("does NOT rewrite config.json when nothing changes", () => {
    // #1380 fixed a clobber in this file days ago. A no-op enable rewriting
    // the operator's whole config is avoidable risk for no benefit, so the
    // write is skipped when the desired state already holds.
    writeFlatRecipe("flat-recipe");
    const saved: unknown[] = [];
    const r = runRecipeEnable("flat-recipe", {
      recipesDir: tmp,
      loadConfigFn: () => ({}) as never,
      saveConfigFn: (cfg) => saved.push(cfg),
    });
    expect(r.alreadyEnabled).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("an install-dir recipe never touches config.json", () => {
    // The routing guarantee: marker recipes must not also accrue a config
    // entry, or the two mechanisms drift back apart.
    writeInstallDir("pkg", "install-dir-recipe");
    const saved: unknown[] = [];
    runRecipeDisable("install-dir-recipe", {
      recipesDir: tmp,
      loadConfigFn: () => ({}) as never,
      saveConfigFn: (cfg) => saved.push(cfg),
    });
    expect(saved).toHaveLength(0);
  });
});
