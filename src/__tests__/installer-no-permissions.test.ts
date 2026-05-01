import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRecipeFromFile } from "../recipes/installer.js";

/**
 * Regression guard for recipe-dogfood-2026-05-01 A-PR4: the decorative
 * `<name>.permissions.json` sidecar must not be written to disk.
 *
 * Pre-alpha.36, installRecipeFromFile wrote two files: the recipe + a
 * permissions sidecar that toolRegistry never read. The sidecar is gone;
 * canonical permission location is ~/.claude/settings.json.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-no-perms-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RECIPE = {
  name: "no-perms-test",
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

describe("installRecipeFromFile — no permissions sidecar (A-PR4)", () => {
  it("does not write <name>.permissions.json on install", () => {
    const src = path.join(dir, "source.json");
    writeFileSync(src, JSON.stringify(RECIPE));
    const recipesDir = path.join(dir, "recipes");

    const result = installRecipeFromFile(src, { recipesDir });

    expect(result.installedPath).toMatch(/no-perms-test\.json$/);
    // Recipe file itself was written.
    expect(existsSync(result.installedPath)).toBe(true);
    // Sidecar was NOT written.
    expect(existsSync(`${result.installedPath}.permissions.json`)).toBe(false);
    // No leftover .permissions.json files anywhere in recipesDir.
    const sidecars = readdirSync(recipesDir).filter((f) =>
      f.endsWith(".permissions.json"),
    );
    expect(sidecars).toEqual([]);
  });

  it("does not write a sidecar on replace either", () => {
    const src = path.join(dir, "source.json");
    writeFileSync(src, JSON.stringify(RECIPE));
    const recipesDir = path.join(dir, "recipes");

    installRecipeFromFile(src, { recipesDir });
    const second = installRecipeFromFile(src, { recipesDir });

    expect(second.action).toBe("replaced");
    expect(existsSync(`${second.installedPath}.permissions.json`)).toBe(false);
  });
});
