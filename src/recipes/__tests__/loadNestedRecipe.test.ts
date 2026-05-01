/**
 * A-PR2 — `loadNestedRecipe` jail tests (dogfood F-04).
 *
 * `loadNestedRecipe` is closed over by `buildChainedDeps`. We construct a
 * minimal `RunnerDeps` set, grab the function back, then exercise it with
 * (a) parent-relative paths INSIDE the jail (must load),
 * (b) absolute paths OUTSIDE all three jail roots (must reject → null),
 * (c) the security-fixture outer/inner pair from /tmp/dogfood-G2 (must
 *     reject because /tmp/dogfood-G2 is not a parent dir or recipes dir).
 *
 * The test materialises real YAML files in a tmpdir so the existing
 * `existsSync` / `loadYamlRecipe` path is exercised — we do not mock the
 * filesystem.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildChainedDeps, type RunnerDeps } from "../yamlRunner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "dogfood",
  "recipe-dogfood-2026-05-01",
  "security-fixtures",
);

let parentRecipePath: string;
let outsideJailPath: string;

function baseDeps(): RunnerDeps {
  return {
    now: () => new Date("2026-04-25T12:00:00Z"),
    logDir: os.tmpdir(),
    readFile: () => {
      throw new Error("not found");
    },
    writeFile: () => {},
    appendFile: () => {},
    mkdir: () => {},
    gitLogSince: () => "",
    gitStaleBranches: () => "",
    getDiagnostics: () => "",
  };
}

beforeAll(() => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "load-nested-jail-"));
  // Parent recipe lives at <tmp>/parent.yaml; valid nested at <tmp>/sub.yaml.
  parentRecipePath = path.join(tmpRoot, "parent.yaml");
  const validNestedPath = path.join(tmpRoot, "sub.yaml");
  writeFileSync(
    parentRecipePath,
    "name: parent\ntrigger:\n  type: chained\nsteps:\n  - id: noop\n    tool: file.read\n    path: /tmp/x\n    optional: true\n",
    "utf-8",
  );
  writeFileSync(
    validNestedPath,
    "name: sub\ntrigger:\n  type: chained\nsteps:\n  - id: noop\n    tool: file.read\n    path: /tmp/x\n    optional: true\n",
    "utf-8",
  );

  // Out-of-jail YAML lives in a sibling tmpdir, not under parent dir or
  // ~/.patchwork/recipes or the bundled-templates dir.
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "load-nested-evil-"));
  outsideJailPath = path.join(outsideRoot, "evil.yaml");
  writeFileSync(
    outsideJailPath,
    "name: evil\ntrigger:\n  type: chained\nsteps:\n  - id: pwn\n    tool: file.write\n    path: /tmp/PWNED\n    content: pwned\n",
    "utf-8",
  );
});

describe("loadNestedRecipe — A-PR2 jail (dogfood F-04)", () => {
  it("loads a sibling recipe under the parent's directory", async () => {
    const { loadNestedRecipe } = buildChainedDeps(baseDeps());
    const result = await loadNestedRecipe("./sub.yaml", parentRecipePath);
    expect(result).not.toBeNull();
    expect(result?.recipe.name).toBe("sub");
  });

  it("rejects an absolute path outside all three jail roots → null", async () => {
    const { loadNestedRecipe } = buildChainedDeps(baseDeps());
    const result = await loadNestedRecipe(outsideJailPath, parentRecipePath);
    expect(result).toBeNull();
  });

  it("rejects a relative ../ traversal that escapes the parent dir → null", async () => {
    const { loadNestedRecipe } = buildChainedDeps(baseDeps());
    // ../../etc/passwd.yaml resolves above tmpRoot — outside parent dir,
    // user recipes dir, and bundled templates.
    const result = await loadNestedRecipe(
      "../../../etc/passwd.yaml",
      parentRecipePath,
    );
    expect(result).toBeNull();
  });

  it("rejects /etc/passwd.yaml absolute path → null (smoke)", async () => {
    const { loadNestedRecipe } = buildChainedDeps(baseDeps());
    const result = await loadNestedRecipe("/etc/passwd.yaml", parentRecipePath);
    expect(result).toBeNull();
  });

  it("rejects the outer-chained-traversal.yaml fixture's inner path", async () => {
    // The promoted security fixture refers to /tmp/dogfood-G2/inner-write.yaml,
    // which is OUTSIDE every jail root when the parent is the fixture file
    // itself living in the docs tree. The fixture is preserved verbatim so
    // future regressions can be replayed; we test the reference resolution
    // here by reading its `recipe:` field.
    const fixtureContent = readFileSync(
      path.join(FIXTURES_DIR, "outer-chained-traversal.yaml"),
      "utf-8",
    );
    const innerRef = fixtureContent.match(/recipe:\s*(\S+)/)?.[1];
    expect(innerRef).toBe("/tmp/dogfood-G2/inner-write.yaml");

    const { loadNestedRecipe } = buildChainedDeps(baseDeps());
    // Treat the fixture as if it were the parent. The inner path is absolute
    // and lives in /tmp/dogfood-G2, which is NOT the fixture's parent dir,
    // not the user recipes dir, not the bundled templates dir → reject.
    const result = await loadNestedRecipe(
      innerRef!,
      path.join(FIXTURES_DIR, "outer-chained-traversal.yaml"),
    );
    expect(result).toBeNull();
  });

  it("returns null when no parentSourcePath is supplied AND the name is path-shaped", async () => {
    // Without a parent, the path-shaped branch is skipped entirely; lookup
    // falls through to ~/.patchwork/recipes which won't have the file.
    const { loadNestedRecipe } = buildChainedDeps(baseDeps());
    const result = await loadNestedRecipe(outsideJailPath);
    expect(result).toBeNull();
  });
});
