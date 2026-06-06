/**
 * WIN-CACHE-001: listInstalledRecipes + findWebhookRecipe should cache
 * results so repeated calls don't re-scan the filesystem on every request.
 *
 * Behavioral proof: add a file without invalidating → still get stale data
 * (cache hit). After invalidateRecipesCache → fresh data visible.
 *
 * These tests FAIL before the cache is wired and PASS after.
 */

import * as nodefs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findWebhookRecipe,
  invalidateRecipesCache,
  listInstalledRecipes,
} from "../recipesHttp.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpRecipesDir(): string {
  return nodefs.mkdtempSync(path.join(tmpdir(), "pw-cache-test-"));
}

function writeYaml(dir: string, name: string, content: string): void {
  nodefs.writeFileSync(path.join(dir, name), content, "utf-8");
}

const RECIPE_YAML = (name: string) =>
  `name: ${name}\ndescription: test\nsteps:\n  - id: s1\n    agent:\n      prompt: hi\n`;

const WEBHOOK_YAML = (name: string, triggerPath: string) =>
  `name: ${name}\ntrigger:\n  type: webhook\n  path: ${triggerPath}\nsteps:\n  - id: s1\n    agent:\n      prompt: hi\n`;

// ── listInstalledRecipes — in-memory cache ────────────────────────────────────

describe("listInstalledRecipes — in-memory cache (WIN-CACHE-001)", () => {
  let recipesDir: string;

  beforeEach(() => {
    recipesDir = makeTmpRecipesDir();
    writeYaml(recipesDir, "hello.yaml", RECIPE_YAML("hello"));
    invalidateRecipesCache(recipesDir);
  });

  afterEach(() => {
    nodefs.rmSync(recipesDir, { recursive: true, force: true });
  });

  it("second call returns identical result object (cache hit)", () => {
    const first = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
    const second = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
    // Same reference means the function returned the cached value, not a new scan
    expect(second).toBe(first);
  });

  it("stale file added after first call is NOT visible until invalidated", () => {
    const first = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
    expect(first.recipes).toHaveLength(1);

    // Add a recipe without invalidating
    writeYaml(recipesDir, "world.yaml", RECIPE_YAML("world"));

    // Without cache: would see 2. With cache: still 1.
    const stale = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
    expect(stale.recipes).toHaveLength(1);

    // Invalidate → rescan → 2
    invalidateRecipesCache(recipesDir);
    const fresh = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
    expect(fresh.recipes).toHaveLength(2);
  });

  it("invalidateRecipesCache(dir) only clears that dir, not others", () => {
    const otherDir = makeTmpRecipesDir();
    try {
      writeYaml(otherDir, "other.yaml", RECIPE_YAML("other"));
      invalidateRecipesCache(otherDir);

      const a = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
      const b = listInstalledRecipes(otherDir, { disabledRecipes: [] });

      invalidateRecipesCache(recipesDir); // only clears recipesDir

      // otherDir cache is still warm
      const bAgain = listInstalledRecipes(otherDir, { disabledRecipes: [] });
      expect(bAgain).toBe(b);

      // recipesDir is invalidated → new object
      const aAgain = listInstalledRecipes(recipesDir, { disabledRecipes: [] });
      expect(aAgain).not.toBe(a);
    } finally {
      nodefs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ── findWebhookRecipe — in-memory cache ──────────────────────────────────────

describe("findWebhookRecipe — in-memory cache (WIN-CACHE-001)", () => {
  let recipesDir: string;

  beforeEach(() => {
    recipesDir = makeTmpRecipesDir();
    writeYaml(recipesDir, "hook.yaml", WEBHOOK_YAML("hook", "/hook/ping"));
    invalidateRecipesCache(recipesDir);
  });

  afterEach(() => {
    nodefs.rmSync(recipesDir, { recursive: true, force: true });
  });

  it("second call with same path returns same result (cache hit)", () => {
    const first = findWebhookRecipe(recipesDir, "/hook/ping");
    const second = findWebhookRecipe(recipesDir, "/hook/ping");
    expect(second).toBe(first);
    expect(second?.name).toBe("hook");
  });

  it("miss result (null) is also cached", () => {
    const first = findWebhookRecipe(recipesDir, "/no/match");
    expect(first).toBeNull();
    // Add a matching recipe without invalidating
    writeYaml(recipesDir, "new.yaml", WEBHOOK_YAML("new", "/no/match"));
    const stale = findWebhookRecipe(recipesDir, "/no/match");
    // Cache hit → still null
    expect(stale).toBeNull();
    // After invalidation → finds the new recipe
    invalidateRecipesCache(recipesDir);
    const fresh = findWebhookRecipe(recipesDir, "/no/match");
    expect(fresh?.name).toBe("new");
  });

  it("different paths are cached independently", () => {
    const r1 = findWebhookRecipe(recipesDir, "/hook/ping");
    const r2 = findWebhookRecipe(recipesDir, "/hook/other");
    const r1again = findWebhookRecipe(recipesDir, "/hook/ping");
    expect(r1again).toBe(r1); // cache hit for /hook/ping
    expect(r2).toBeNull(); // /hook/other → miss
  });

  it("rescans after invalidateRecipesCache", () => {
    findWebhookRecipe(recipesDir, "/hook/ping");
    invalidateRecipesCache(recipesDir);
    writeYaml(recipesDir, "hook2.yaml", WEBHOOK_YAML("hook2", "/hook/v2"));
    const result = findWebhookRecipe(recipesDir, "/hook/v2");
    expect(result?.name).toBe("hook2");
  });
});
