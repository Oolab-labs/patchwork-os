import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTriggerInputDefaults } from "../recipes/triggerVars.js";
import { listInstalledRecipes } from "../recipesHttp.js";

/**
 * GET /recipes reports a recipe's declared inputs as `vars`. The runtime reads
 * declared inputs ONLY from `trigger.inputs[]` / `trigger.vars[]`
 * (`applyTriggerInputDefaults`); a root-level `vars:` key is ignored. The
 * listing must report what the runtime honours, or a run dialog built from it
 * offers no inputs for a correctly written recipe and offers dead ones for a
 * misplaced block.
 */

// Non-empty disabled list bypasses the per-dir cache.
const NO_CONFIG = { disabledRecipes: ["__none__"] };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pw-recipe-list-vars-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function varsOf(name: string) {
  const r = listInstalledRecipes(dir, NO_CONFIG).recipes.find(
    (x) => x.name === name,
  );
  expect(r, `recipe ${name} listed`).toBeDefined();
  return r?.vars;
}

describe("recipe listing reports trigger-declared inputs as vars", () => {
  it("top-level file: trigger.vars are reported", () => {
    writeFileSync(
      path.join(dir, "noisy-recipe.yaml"),
      `name: noisy-recipe
trigger:
  type: manual
  vars:
    - name: repo
      description: Target repository
      required: true
      default: acct-0001/example
    - name: limit
      default: 5
steps:
  - id: s1
    tool: getGitStatus
    params: {}
`,
    );
    expect(varsOf("noisy-recipe")).toEqual([
      {
        name: "repo",
        description: "Target repository",
        required: true,
        default: "acct-0001/example",
      },
      { name: "limit", default: "5" },
    ]);
  });

  it("install dir: trigger.inputs are reported, inputs win over vars by name", () => {
    mkdirSync(path.join(dir, "quiet-recipe"));
    writeFileSync(
      path.join(dir, "quiet-recipe", "main.yaml"),
      `name: quiet-recipe
trigger:
  type: manual
  inputs:
    - name: target
      default: true
    - description: no name, skipped
  vars:
    - name: target
      default: from-vars
    - name: extra
steps:
  - id: s1
    tool: getGitStatus
    params: {}
`,
    );
    expect(varsOf("quiet-recipe")).toEqual([
      { name: "target", default: "true" },
      { name: "extra" },
    ]);
  });

  it("root-level vars are NOT reported (the runtime ignores them)", () => {
    writeFileSync(
      path.join(dir, "misplaced-recipe.yaml"),
      `name: misplaced-recipe
trigger:
  type: manual
vars:
  - name: repo
    default: acct-0001/example
steps:
  - id: s1
    tool: getGitStatus
    params: {}
`,
    );
    expect(varsOf("misplaced-recipe")).toBeUndefined();
  });

  it("listing defaults agree with the defaults a run receives", () => {
    const file = path.join(dir, "noisy-recipe.yaml");
    writeFileSync(
      file,
      `name: noisy-recipe
trigger:
  type: manual
  inputs:
    - name: target
      description: from inputs
  vars:
    - name: target
      default: from-vars
    - name: count
      default: 3
vars:
  - name: ignored
    default: never-applied
steps:
  - id: s1
    tool: getGitStatus
    params: {}
`,
    );
    // An inputs entry with no default does not hide a vars default — the
    // runtime has always applied it, so the listing must show it too.
    expect(varsOf("noisy-recipe")).toEqual([
      { name: "target", description: "from inputs", default: "from-vars" },
      { name: "count", default: "3" },
    ]);
    expect(applyTriggerInputDefaults(file, { count: "9" })).toEqual({
      target: "from-vars",
      count: "9",
    });
  });
});
