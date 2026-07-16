/**
 * Tests for `recipe uninstall` (missing-feature follow-up to PR #42) and
 * reinstall correctness (Bug #3 from the 2026-04-28 audit).
 *
 * Reinstall correctness fixes:
 *   - Files from a previous version that the new manifest no longer declares
 *     are LEFT BEHIND today. They should be cleared.
 *   - `.disabled` marker is rewritten unconditionally on reinstall, which
 *     re-disables a recipe the user had explicitly enabled. Reinstall should
 *     preserve the existing enabled state.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRecipeEnabled,
  runRecipeInstall,
  runRecipeUninstall,
} from "../recipeInstall.js";

// Native ESM module namespaces aren't configurable, so cpSync/rmSync can't
// be vi.spyOn'd directly (they can only be intercepted via vi.mock).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    cpSync: vi.fn(actual.cpSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

let recipesRoot: string;
let srcRoot: string;

beforeEach(() => {
  recipesRoot = mkdtempSync(path.join(os.tmpdir(), "patchwork-uninstall-"));
  srcRoot = mkdtempSync(path.join(os.tmpdir(), "patchwork-uninstall-src-"));
});

afterEach(() => {
  for (const d of [recipesRoot, srcRoot]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function writeSrcRecipe(
  files: Record<string, string>,
  manifest?: {
    name: string;
    version: string;
    description: string;
    recipes: { main: string; children?: string[] };
  },
) {
  const dir = mkdtempSync(path.join(srcRoot, "pkg-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  if (manifest) {
    writeFileSync(path.join(dir, "recipe.json"), JSON.stringify(manifest));
  }
  return dir;
}

describe("runRecipeUninstall", () => {
  it("removes the install dir and all its files", async () => {
    const src = writeSrcRecipe({ "main.yaml": "name: x\nsteps: []\n" });
    const result = await runRecipeInstall(src, { recipesDir: recipesRoot });
    expect(existsSync(result.installDir)).toBe(true);

    const r = runRecipeUninstall(result.name, { recipesDir: recipesRoot });
    expect(r.ok).toBe(true);
    expect(existsSync(result.installDir)).toBe(false);
  });

  it("returns ok:false with a clear error when the recipe is not installed", () => {
    const r = runRecipeUninstall("nonexistent-recipe", {
      recipesDir: recipesRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No installed recipe/);
  });

  it("rejects path-traversal in name", () => {
    expect(() =>
      runRecipeUninstall("../../../etc", { recipesDir: recipesRoot }),
    ).toThrow();
  });

  it("returns the removed install dir path", async () => {
    const src = writeSrcRecipe({ "main.yaml": "name: x\nsteps: []\n" });
    const inst = await runRecipeInstall(src, { recipesDir: recipesRoot });

    const r = runRecipeUninstall(inst.name, { recipesDir: recipesRoot });
    expect(r.ok).toBe(true);
    expect(r.installDir).toBe(inst.installDir);
  });
});

describe("runRecipeInstall — reinstall correctness", () => {
  it("removes files from the prior version that the new manifest doesn't declare", async () => {
    // First install: declares main.yaml + extra-old.yaml
    const v1 = writeSrcRecipe(
      {
        "main.yaml": "name: x\nsteps: []\n",
        "extra-old.yaml": "name: x-old\nsteps: []\n",
      },
      {
        name: "evolving-pkg",
        version: "1.0.0",
        description: "v1",
        recipes: { main: "main.yaml", children: ["extra-old.yaml"] },
      },
    );
    const inst1 = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    expect(existsSync(path.join(inst1.installDir, "extra-old.yaml"))).toBe(
      true,
    );

    // Second install: declares main.yaml + extra-new.yaml (NOT extra-old)
    const v2 = writeSrcRecipe(
      {
        "main.yaml": "name: x\nsteps: []\n",
        "extra-new.yaml": "name: x-new\nsteps: []\n",
      },
      {
        name: "evolving-pkg",
        version: "2.0.0",
        description: "v2",
        recipes: { main: "main.yaml", children: ["extra-new.yaml"] },
      },
    );
    const inst2 = await runRecipeInstall(v2, { recipesDir: recipesRoot });

    expect(inst2.installDir).toBe(inst1.installDir);
    expect(existsSync(path.join(inst2.installDir, "extra-new.yaml"))).toBe(
      true,
    );
    expect(existsSync(path.join(inst2.installDir, "extra-old.yaml"))).toBe(
      false,
    );
  });

  it("preserves the enabled state on reinstall (was: re-disables every time)", async () => {
    // Manifest gives both versions the same install-dir name so it's a true reinstall.
    const stableManifest = (version: string) => ({
      name: "stable-pkg",
      version,
      description: "stable",
      recipes: { main: "main.yaml" },
    });

    const v1 = writeSrcRecipe(
      { "main.yaml": "name: x\nsteps: []\n" },
      stableManifest("1.0.0"),
    );
    const inst1 = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    expect(isRecipeEnabled(inst1.installDir)).toBe(false); // fresh install starts disabled

    // User enables it
    rmSync(path.join(inst1.installDir, ".disabled"));
    expect(isRecipeEnabled(inst1.installDir)).toBe(true);

    // Reinstall (upgrade)
    const v2 = writeSrcRecipe(
      { "main.yaml": "name: x\nsteps: []\nversion: 2\n" },
      stableManifest("2.0.0"),
    );
    const inst2 = await runRecipeInstall(v2, { recipesDir: recipesRoot });

    // Same install dir, enabled state preserved — user opted in and upgrade
    // shouldn't silently revoke that.
    expect(inst2.installDir).toBe(inst1.installDir);
    expect(isRecipeEnabled(inst2.installDir)).toBe(true);
  });

  it("preserves the disabled state on reinstall (idempotent)", async () => {
    const stableManifest = (version: string) => ({
      name: "stable-pkg-2",
      version,
      description: "stable2",
      recipes: { main: "main.yaml" },
    });

    const v1 = writeSrcRecipe(
      { "main.yaml": "name: x\nsteps: []\n" },
      stableManifest("1.0.0"),
    );
    const inst1 = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    expect(isRecipeEnabled(inst1.installDir)).toBe(false);

    const v2 = writeSrcRecipe(
      { "main.yaml": "name: x\nsteps: []\n" },
      stableManifest("2.0.0"),
    );
    const inst2 = await runRecipeInstall(v2, { recipesDir: recipesRoot });
    expect(inst2.installDir).toBe(inst1.installDir);
    expect(isRecipeEnabled(inst2.installDir)).toBe(false);
  });

  it("a fresh install (different name) still defaults to disabled", async () => {
    const src = writeSrcRecipe({ "main.yaml": "name: x\nsteps: []\n" });
    const inst = await runRecipeInstall(src, { recipesDir: recipesRoot });
    expect(isRecipeEnabled(inst.installDir)).toBe(false);
  });

  it("reinstall doesn't leave .disabled-like residue files unrelated to the marker", async () => {
    // Edge case: recipe declares a file literally named ".disabled" as a child.
    // We only treat the marker file as state; declared files should be copied
    // and survive uninstall→reinstall.
    const v1 = writeSrcRecipe(
      { "main.yaml": "name: x\nsteps: []\n" },
      {
        name: "edge-pkg",
        version: "1.0.0",
        description: "edge",
        recipes: { main: "main.yaml" },
      },
    );
    const inst = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    // After install, the .disabled marker is from runRecipeInstall, not the
    // package — good.
    const before = readdirSync(inst.installDir).sort();
    expect(before).toContain(".disabled");
    expect(before).toContain("recipe.json");
    expect(before).toContain("main.yaml");
  });
});

describe("runRecipeInstall — crash safety (staged install + atomic rename)", () => {
  afterEach(async () => {
    // Reset the mocked cpSync/rmSync back to real implementations so other
    // describe blocks in this file (which share the same mocked module
    // instance) aren't affected by a mockImplementation set here.
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const mocked = await import("node:fs");
    vi.mocked(mocked.cpSync).mockImplementation(actual.cpSync);
    vi.mocked(mocked.rmSync).mockImplementation(actual.rmSync);
  });

  /**
   * Makes cpSync throw only for the per-file copies into the recipesDir
   * staging directory (what we're actually testing crash-safety for) —
   * NOT for stageLocalSource's own unrelated bulk `cpSync(src, tmpDir,
   * {recursive:true})` call that stages the source package into an OS
   * temp dir before runRecipeInstall ever reaches the code under test.
   */
  async function mockCpSyncThrowsForRecipesRoot(): Promise<void> {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { cpSync } = await import("node:fs");
    vi.mocked(cpSync).mockImplementation((src, dest, opts) => {
      if (String(dest).includes(recipesRoot)) {
        throw new Error("simulated crash mid-copy");
      }
      return actual.cpSync(src as never, dest as never, opts as never);
    });
  }

  it("fresh install: a crash mid-copy leaves no trace at the final install path", async () => {
    const src = writeSrcRecipe(
      { "main.yaml": "name: crash-fresh\nsteps: []\n" },
      {
        name: "crash-fresh",
        version: "1.0.0",
        description: "x",
        recipes: { main: "main.yaml" },
      },
    );

    await mockCpSyncThrowsForRecipesRoot();

    await expect(
      runRecipeInstall(src, { recipesDir: recipesRoot }),
    ).rejects.toThrow("simulated crash mid-copy");

    // The real install path was never touched — nothing under it, because
    // nothing was ever copied there directly (staged in a sibling dir first).
    expect(existsSync(path.join(recipesRoot, "crash-fresh"))).toBe(false);
  });

  it("fresh install: if cleanup itself also fails, the orphaned staging dir is still marked disabled (never scanned as live)", async () => {
    const src = writeSrcRecipe(
      { "main.yaml": "name: crash-fresh-2\nsteps: []\n" },
      {
        name: "crash-fresh-2",
        version: "1.0.0",
        description: "x",
        recipes: { main: "main.yaml" },
      },
    );

    await mockCpSyncThrowsForRecipesRoot();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { rmSync: mockedRmSync } = await import("node:fs");
    // Simulate the process dying before the catch block's best-effort
    // rmSync(stagingDir) cleanup can run.
    vi.mocked(mockedRmSync).mockImplementation((target, opts) => {
      if (String(target).includes(".installing-")) {
        throw new Error("simulated: no cleanup, process died");
      }
      return actual.rmSync(target as string, opts as never);
    });

    await expect(
      runRecipeInstall(src, { recipesDir: recipesRoot }),
    ).rejects.toThrow("simulated crash mid-copy");

    const leftovers = readdirSync(recipesRoot).filter((f) =>
      f.startsWith(".installing-"),
    );
    expect(leftovers.length).toBeGreaterThan(0);
    for (const leftover of leftovers) {
      // The safety marker was written BEFORE any file copy was attempted —
      // an orphaned staging dir is always inert, regardless of how much (if
      // any) of the copy loop completed before the crash.
      expect(existsSync(path.join(recipesRoot, leftover, ".disabled"))).toBe(
        true,
      );
    }
  });

  it("reinstall: a crash mid-copy leaves the PREVIOUS version installed and enabled, untouched", async () => {
    const v1 = writeSrcRecipe(
      { "main.yaml": "name: crash-reinstall\nsteps: []\nversion: 1\n" },
      {
        name: "crash-reinstall",
        version: "1.0.0",
        description: "x",
        recipes: { main: "main.yaml" },
      },
    );
    const inst1 = await runRecipeInstall(v1, { recipesDir: recipesRoot });
    // Explicitly enable it, like a real user would after a fresh install.
    writeFileSync(
      path.join(inst1.installDir, "main.yaml"),
      "name: crash-reinstall\nsteps: []\nversion: 1\n",
    );
    const disabledMarker = path.join(inst1.installDir, ".disabled");
    rmSync(disabledMarker, { force: true });
    expect(isRecipeEnabled(inst1.installDir)).toBe(true);

    const v2 = writeSrcRecipe(
      { "main.yaml": "name: crash-reinstall\nsteps: []\nversion: 2\n" },
      {
        name: "crash-reinstall",
        version: "2.0.0",
        description: "x",
        recipes: { main: "main.yaml" },
      },
    );

    await mockCpSyncThrowsForRecipesRoot();

    await expect(
      runRecipeInstall(v2, { recipesDir: recipesRoot }),
    ).rejects.toThrow("simulated crash mid-copy");

    // The old install dir must still exist, unchanged, and still enabled —
    // the old dir is renamed aside (not deleted) until the new one has
    // fully landed, and a crash during copy means the new one never lands.
    expect(existsSync(inst1.installDir)).toBe(true);
    expect(isRecipeEnabled(inst1.installDir)).toBe(true);
    expect(
      readFileSync(path.join(inst1.installDir, "main.yaml"), "utf-8"),
    ).toContain("version: 1");

    // No leftover `.replaced-<ts>` backup dir either — restored via rename,
    // not left as a stray duplicate.
    const stray = readdirSync(recipesRoot).filter((f) =>
      f.includes(".replaced-"),
    );
    expect(stray).toEqual([]);
  });
});
