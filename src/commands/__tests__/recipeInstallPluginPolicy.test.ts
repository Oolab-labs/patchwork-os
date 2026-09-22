/**
 * `patchwork recipe install <local-dir>` refuses a recipe whose `servers:`
 * names a spec outside `config.plugins.allow` under the governed profile,
 * before anything reaches the recipes directory. Compat is unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetActiveProfileForTesting,
  GOVERNED_PROFILE,
  setActiveProfile,
} from "../../governance/profile.js";
import { clearConfigCache, defaultConfigPath } from "../../patchworkConfig.js";
import { runRecipeInstall } from "../recipeInstall.js";

const YAML = [
  "name: cli-plugin-policy-fixture",
  "version: 1.0.0",
  "servers:",
  "  - ./nope-cli-plugin",
  "trigger:",
  "  type: manual",
  "steps:",
  "  - id: s1",
  "    tool: file.write",
  `    params: { path: ${path.join(os.tmpdir(), "x")}, content: y }`,
  "",
].join("\n");

let srcDir: string;
let recipesDir: string;

function writeConfig(cfg: Record<string, unknown>): void {
  const p = defaultConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg));
  clearConfigCache();
}

beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-pp-src-"));
  recipesDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-pp-dst-"));
  fs.writeFileSync(path.join(srcDir, "recipe.yaml"), YAML);
});

afterEach(() => {
  _resetActiveProfileForTesting();
  try {
    fs.unlinkSync(defaultConfigPath());
  } catch {
    /* absent */
  }
  clearConfigCache();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(recipesDir, { recursive: true, force: true });
});

describe("recipe install — plugin policy", () => {
  it("governed + not allowlisted ⇒ throws plugin_not_allowlisted, recipes dir untouched", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    writeConfig({ profile: "governed", plugins: { allow: [] } });
    await expect(
      runRecipeInstall(srcDir, { recipesDir }),
    ).rejects.toMatchObject({
      code: "plugin_not_allowlisted",
      specs: ["./nope-cli-plugin"],
    });
    expect(
      fs.readdirSync(recipesDir).filter((f) => !f.startsWith(".")),
    ).toEqual([]);
  });

  it("governed + allowlisted ⇒ installs", async () => {
    setActiveProfile(GOVERNED_PROFILE);
    writeConfig({
      profile: "governed",
      plugins: { allow: [{ spec: "./nope-cli-plugin" }] },
    });
    const result = await runRecipeInstall(srcDir, { recipesDir });
    expect(result.name).toBeTruthy();
    expect(fs.existsSync(path.join(recipesDir, result.name))).toBe(true);
  });

  it("compat ⇒ installs regardless of allowlist", async () => {
    const result = await runRecipeInstall(srcDir, { recipesDir });
    expect(fs.existsSync(path.join(recipesDir, result.name))).toBe(true);
  });
});
