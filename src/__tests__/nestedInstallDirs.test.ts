/**
 * Nested `owner/repo` installs must be reachable — and a failed lookup must
 * not write the wrong mechanism (#1403).
 *
 * `iterateInstallDirs` walked DIRECT children of the recipes dir. A
 * manifest-less GitHub install lives at `owner/repo/` with its entrypoint one
 * level deeper, so `findInstallDirByRecipeName` never saw it: `recipes/owner/`
 * holds no `.yaml`, and `recipes/owner/repo/` was never visited.
 *
 * The miss alone would be a lookup bug. What made it a correctness bug is that
 * `setRecipeEnabled` does not error when it cannot resolve an install dir — it
 * falls through to the legacy `cfg.recipes.disabled` array. For a nested
 * install that means the `.disabled` marker actually governing the recipe is
 * never written, a name is added to `config.json` that nothing checking THAT
 * recipe reads, and the call returns `{ ok: true }`.
 *
 * "I could not find this, so I wrote it somewhere else, and reported success"
 * is the same failure class as #1360, reached by a different route.
 *
 * The CLI is not affected: #1360 keeps a directory-resolved marker write ahead
 * of the delegation. The bridge route and the dashboard have no such guard, so
 * a nested install disabled from the dashboard is the live case.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setRecipeEnabled } from "../recipesHttp.js";

let recipesDir = "";

beforeEach(() => {
  recipesDir = mkdtempSync(path.join(os.tmpdir(), "nested-install-"));
});
afterEach(() => rmSync(recipesDir, { recursive: true, force: true }));

/** A manifest-less GitHub install: `recipes/<owner>/<repo>/<file>.yaml`. */
function nestedInstall(
  owner: string,
  repo: string,
  recipeName: string,
): string {
  const dir = path.join(recipesDir, owner, repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "recipe.yaml"),
    `name: ${recipeName}\ntrigger:\n  type: manual\nsteps: []\n`,
  );
  return dir;
}

/** A flat install: `recipes/<dir>/<file>.yaml`. The case that always worked. */
function flatInstall(dirName: string, recipeName: string): string {
  const dir = path.join(recipesDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "recipe.yaml"),
    `name: ${recipeName}\ntrigger:\n  type: manual\nsteps: []\n`,
  );
  return dir;
}

/** Config double, so a fallback write is observable rather than inferred. */
function configSpy() {
  const saved: unknown[] = [];
  return {
    saved,
    loadConfigFn: (() => ({ recipes: { disabled: [] } })) as never,
    saveConfigFn: (cfg: unknown) => {
      saved.push(cfg);
    },
  };
}

describe("nested owner/repo installs are reachable (#1403)", () => {
  it("disables a nested install via its marker, not the legacy config", () => {
    // THE REGRESSION TEST. Before the fix this resolved nothing, fell through,
    // wrote `config.json`, and returned ok:true — so it failed on `mechanism`
    // while every ok/changed assertion passed. That is why the mechanism is
    // asserted and not just the return code.
    const dir = nestedInstall("some-owner", "some-repo", "nested-recipe");
    const spy = configSpy();

    const res = setRecipeEnabled("nested-recipe", false, {
      recipesDir,
      ...spy,
    });

    expect(res.ok).toBe(true);
    expect(res.mechanism).toBe("marker");
    expect(res.installDir).toBe(dir);
    // The mechanism nothing reads must not have been touched.
    expect(spy.saved).toEqual([]);
  });

  it("re-enables a nested install", () => {
    nestedInstall("some-owner", "some-repo", "nested-recipe");
    const spy = configSpy();
    setRecipeEnabled("nested-recipe", false, { recipesDir, ...spy });

    const res = setRecipeEnabled("nested-recipe", true, { recipesDir, ...spy });
    expect(res.mechanism).toBe("marker");
    expect(res.changed).toBe(true);
    expect(spy.saved).toEqual([]);
  });

  it("still resolves flat installs (control)", () => {
    // Without this, the assertions above hold just as well for a change that
    // broke the direct-child walk while adding the nested one.
    const dir = flatInstall("flat-pkg", "flat-recipe");
    const spy = configSpy();
    const res = setRecipeEnabled("flat-recipe", false, { recipesDir, ...spy });
    expect(res.mechanism).toBe("marker");
    expect(res.installDir).toBe(dir);
  });

  it("still falls back to config for a genuinely unknown name (control)", () => {
    // The fallback is correct for legacy TOP-LEVEL recipes and must survive.
    // Without this the fix could have been "never fall back", which would
    // break the case the fallback exists for.
    const spy = configSpy();
    const res = setRecipeEnabled("no-such-recipe", false, {
      recipesDir,
      ...spy,
    });
    expect(res.mechanism).toBe("config");
    expect(spy.saved).toHaveLength(1);
  });

  it("descends ONE level only", () => {
    // `owner/repo` is the install layout, not arbitrary nesting. An unbounded
    // walk turns a mis-shaped recipes dir into a filesystem crawl, so a
    // three-deep recipe must stay invisible rather than be found by accident.
    const deep = path.join(recipesDir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      path.join(deep, "recipe.yaml"),
      "name: too-deep\ntrigger:\n  type: manual\nsteps: []\n",
    );
    const spy = configSpy();
    const res = setRecipeEnabled("too-deep", false, { recipesDir, ...spy });
    expect(res.mechanism).toBe("config");
  });

  it("a parent with its own entrypoint is not descended into", () => {
    // If `recipes/pkg/` is itself an install, its subdirectories are that
    // recipe's own files — data, fixtures, whatever. Treating them as separate
    // installs would surface recipes the operator never installed.
    const parent = flatInstall("pkg", "parent-recipe");
    const child = path.join(parent, "vendored");
    mkdirSync(child, { recursive: true });
    writeFileSync(
      path.join(child, "recipe.yaml"),
      "name: vendored-recipe\ntrigger:\n  type: manual\nsteps: []\n",
    );
    const spy = configSpy();
    const res = setRecipeEnabled("vendored-recipe", false, {
      recipesDir,
      ...spy,
    });
    expect(res.mechanism).toBe("config");
  });
});
