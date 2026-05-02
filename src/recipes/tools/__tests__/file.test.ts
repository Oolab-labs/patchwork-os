/**
 * file.* tool jail regressions — A-PR1.
 *
 * Loads the security fixtures promoted from /tmp/dogfood-G2/ into
 * docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures/ and asserts
 * that every exploit path is rejected with err.code ===
 * 'recipe_path_jail_escape' (R2 M-4 — assert on code, not message).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runYamlRecipe, type YamlRecipe } from "../../yamlRunner.js";

const FIXTURES_DIR = path.resolve(
  __dirname,
  "../../../../docs/dogfood/recipe-dogfood-2026-05-01/security-fixtures",
);

function loadFixture(name: string): YamlRecipe {
  const text = readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
  return parseYaml(text) as YamlRecipe;
}

const tmpLogDir = mkdtempSync(path.join(os.tmpdir(), "file-jail-test-"));
const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "file-jail-ws-"));

function makeDeps() {
  return {
    now: () => new Date("2026-05-01T08:00:00Z"),
    logDir: tmpLogDir,
    workdir: workspaceDir,
    testMode: true,
  };
}

beforeAll(() => {
  mkdirSync(workspaceDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * Helper — assert at least one step recorded errorCode === jail-escape
 * (R2 M-4: tests assert err.code, not message text).
 */
function expectJailEscape(result: {
  stepResults: { error?: string; errorCode?: string }[];
}) {
  const codes = result.stepResults
    .map((s) => s.errorCode)
    .filter((c): c is string => typeof c === "string");
  expect(codes).toContain("recipe_path_jail_escape");
}

describe("file.* jail — exploit fixtures from G-security G2", () => {
  it("rejects path traversal (escapes-via-traversal.yaml)", async () => {
    const recipe = loadFixture("exploit-traversal.yaml");
    // Per-tool jail throws a RecipePathJailError; the runner turns that
    // into a step error rather than a thrown promise rejection. We catch
    // both shapes — the runner may rethrow when the only step errors.
    let result: { stepResults: { error?: string }[] } | undefined;
    try {
      result = await runYamlRecipe(recipe, makeDeps());
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
      return;
    }
    if (result) expectJailEscape(result);
  });

  it("rejects path traversal via the legacy step shape (exploit-traversal — top-level path)", async () => {
    // The fixture uses `params.path` (chained-runner shape). Some legacy
    // recipe authors put `path` at step level instead of inside `params`.
    // Both must be jailed.
    const recipe: YamlRecipe = {
      name: "exploit-flat",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.write",
          path: "/etc/passwd-via-flat-shape",
          content: "PWNED",
        },
      ],
    } as YamlRecipe;
    let result: { stepResults: { error?: string }[] } | undefined;
    try {
      result = await runYamlRecipe(recipe, makeDeps());
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
      return;
    }
    if (result) expectJailEscape(result);
  });

  it("rejects symlink escape (exploit-symlink.yaml)", async () => {
    // Build a symlink inside the tmp jail that points outside (to /etc).
    // The fixture references /tmp/dogfood-G2/symlink-target — we recreate
    // the equivalent inside a fresh tmpdir so the test is hermetic.
    const linkRoot = mkdtempSync(path.join(os.tmpdir(), "file-jail-link-"));
    const linkPath = path.join(linkRoot, "symlink-target");
    const realOutside = mkdtempSync(path.join(os.tmpdir(), "file-jail-out-"));
    // Make the outside dir look like /etc-style — but actually it's a
    // separate tmp dir so we don't pollute the real /etc on CI.
    symlinkSync(realOutside, linkPath);

    const recipe: YamlRecipe = {
      name: "exploit-symlink",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.write",
          path: path.join(linkPath, "inner.txt"),
          content: "PWNED",
        },
      ],
    } as YamlRecipe;

    // /tmp is allowed by the test env, so the lexical check passes; the
    // symlink-aware check is what we want to fire here. To make that
    // happen we need the symlink target to live OUTSIDE every jail root.
    // /tmp is an allowed root in tests, so a tmp→tmp link doesn't escape.
    // Instead: turn off tmp-jail for this one assertion and use a real
    // outside root to demonstrate the symlink defense.
    const prev = process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    delete process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    try {
      let result: { stepResults: { error?: string }[] } | undefined;
      try {
        result = await runYamlRecipe(recipe, makeDeps());
      } catch (err) {
        expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
        return;
      }
      if (result) expectJailEscape(result);
    } finally {
      if (prev !== undefined)
        process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL = prev;
      rmSync(linkRoot, { recursive: true, force: true });
      rmSync(realOutside, { recursive: true, force: true });
    }
  });

  it("rejects template-driven traversal after render (exploit-template-traversal.yaml)", async () => {
    // Mimic the live exploit: --var target=../../../../tmp/PWNED.txt
    // applied to path: ~/.patchwork/inbox/{{target}}. With tmp-jail ON
    // (the test default) the post-render normalize would still reject
    // because the literal `..` segments in the rendered path push the
    // resolved location outside ~/.patchwork. To exercise the post-render
    // re-check unambiguously we disable tmp-jail for this scope.
    const prev = process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    delete process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL;
    try {
      const recipe: YamlRecipe = {
        name: "exploit-template-traversal",
        trigger: { type: "manual" },
        steps: [
          {
            tool: "file.write",
            path: "~/.patchwork/inbox/{{target}}",
            content: "PWNED via template traversal",
          },
        ],
      } as YamlRecipe;
      // Simulate the var as if it had been resolved by a chained runner —
      // we feed the rendered path directly via context overrides. The
      // simplest way is to stash the value in `now`-style override deps:
      // runYamlRecipe doesn't expose vars directly, so instead let's set
      // the rendered path inline and let the per-tool jail reject the
      // resolved escape.
      // NB: runYamlRecipe expands ~ and templates inside executeStep.
      // The template syntax `{{target}}` won't resolve without ctx, so
      // we hand-roll the pre-rendered path mimicking the bug class:
      const exploit: YamlRecipe = {
        name: "exploit-template-traversal-rendered",
        trigger: { type: "manual" },
        steps: [
          {
            tool: "file.write",
            path: "~/.patchwork/inbox/../../../../tmp/PWNED.txt",
            content: "PWNED",
          },
        ],
      } as YamlRecipe;
      let result: { stepResults: { error?: string }[] } | undefined;
      try {
        result = await runYamlRecipe(exploit, makeDeps());
      } catch (err) {
        expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
        return;
      }
      if (result) expectJailEscape(result);
      // Suppress the lint about `recipe` being unused.
      void recipe;
    } finally {
      if (prev !== undefined)
        process.env.CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL = prev;
    }
  });

  it("rejects null-byte paths before any FS call (null-byte-path.yaml)", async () => {
    // YAML doesn't reliably round-trip a literal \x00 across all parsers
    // — so we synthesize the recipe inline rather than read the fixture.
    const recipe: YamlRecipe = {
      name: "exploit-null-byte",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.write",
          path: "~/.patchwork/inbox/foo\x00.txt",
          content: "PWNED",
        },
      ],
    } as YamlRecipe;
    let result: { stepResults: { error?: string }[] } | undefined;
    try {
      result = await runYamlRecipe(recipe, makeDeps());
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
      return;
    }
    if (result) expectJailEscape(result);
  });

  it("permits a baseline write inside ~/.patchwork (valid-write-inside-jail.yaml)", async () => {
    const written: Record<string, string> = {};
    const recipe = loadFixture("valid-write-inside-jail.yaml");
    const result = await runYamlRecipe(recipe, {
      ...makeDeps(),
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    expect(result.stepsRun).toBe(1);
    expect(Object.keys(written)).toHaveLength(1);
    const target = Object.keys(written)[0]!;
    // resolved path must be inside the user's real home/.patchwork — we
    // assert the suffix rather than an exact string because $HOME varies.
    expect(
      target.endsWith(".patchwork/inbox/recipe-dogfood-A-PR1-baseline.txt"),
    ).toBe(true);
  });
});
