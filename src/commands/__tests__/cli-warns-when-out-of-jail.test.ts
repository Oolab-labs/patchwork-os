/**
 * G-security A-PR1 — CLI warn when `recipe run <path>` resolves a recipe
 * file outside the jail (F-10).
 *
 * The CLI happily LOADS the YAML — out-of-jail files are read-only at the
 * loader level — but it must emit a stderr notice so the operator knows
 * the recipe's runtime tool dispatches will hit the jail.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRecipeRefForCli } from "../recipe.js";

let warnSpy: ReturnType<typeof vi.spyOn>;
let tmpRoot: string;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cli-warn-jail-"));
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveRecipeRefForCli — out-of-jail warn (F-10)", () => {
  it("emits a stderr warn when the recipe file lives in /tmp (default jail OFF)", () => {
    const yamlPath = path.join(tmpRoot, "stray-recipe.yaml");
    writeFileSync(
      yamlPath,
      "name: stray\ntrigger:\n  type: manual\nsteps: []\n",
    );

    // Force tmp-jail OFF for this assertion — the test setup turns it on
    // for hermetic temp dirs, but the F-10 warn only fires when the
    // recipe file is *outside* the active jail.
    const prev = process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    delete process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    try {
      const resolved = resolveRecipeRefForCli(yamlPath);
      expect(resolved).toBe(yamlPath);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0]?.[0];
      expect(typeof msg).toBe("string");
      // We assert the substring "outside the recipe jail" rather than the
      // full message text — the wording may evolve but the operator-facing
      // signal must remain stable.
      expect(String(msg)).toContain("outside the recipe jail");
    } finally {
      if (prev !== undefined)
        process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL = prev;
    }
  });

  it("does NOT warn when the recipe file lives in /tmp and tmp-jail is opted in", () => {
    const yamlPath = path.join(tmpRoot, "ok-tmp-recipe.yaml");
    writeFileSync(
      yamlPath,
      "name: ok-tmp\ntrigger:\n  type: manual\nsteps: []\n",
    );

    const prev = process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL = "1";
    try {
      resolveRecipeRefForCli(yamlPath);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) {
        process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL = prev;
      } else {
        delete process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
      }
    }
  });
});
