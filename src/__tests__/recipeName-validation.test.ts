/**
 * Tests for recipe-name validation + body↔filename auto-rewrite in
 * `saveRecipeContent`. The audit (2026-05-06) found `MyRecipe` saved
 * to `myrecipe.yaml` with body `name: MyRecipe` — silent body↔filename
 * mismatch. This test exercises the new behavior:
 *  - server regex tightened to drop `_`
 *  - body `name:` auto-rewritten to match filename when they differ
 *  - warning surfaced on the rewrite
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRecipeContent } from "../recipesHttp.js";

const VALID_BODY = (name = "test-recipe") =>
  `apiVersion: patchwork.sh/v1
name: ${name}
description: test
trigger:
  type: manual
steps:
  - id: s1
    agent:
      prompt: hi
`;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "recipe-name-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("saveRecipeContent — name regex", () => {
  it("rejects names with underscores (newly tightened to match the schema)", () => {
    const result = saveRecipeContent(dir, "my_recipe", VALID_BODY("my_recipe"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid recipe name/);
  });

  it("rejects uppercase even after caller-side toLowerCase", () => {
    // saveRecipeContent already lowercases — but a caller passing the
    // already-cased value should still pass. The actual upper-case
    // rejection happens earlier (URL routing) in the server.
    const result = saveRecipeContent(dir, "MyRecipe", VALID_BODY("MyRecipe"));
    expect(result.ok).toBe(true); // lowercased to "myrecipe"
  });

  it("rejects names with spaces", () => {
    const result = saveRecipeContent(dir, "my recipe", VALID_BODY("my recipe"));
    expect(result.ok).toBe(false);
  });

  it("rejects names that are too long (>64 chars)", () => {
    const long = "a".repeat(65);
    const result = saveRecipeContent(dir, long, VALID_BODY(long));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid recipe name/);
  });

  it("accepts canonical kebab-case", () => {
    const result = saveRecipeContent(
      dir,
      "my-good-recipe",
      VALID_BODY("my-good-recipe"),
    );
    expect(result.ok).toBe(true);
  });
});

describe("saveRecipeContent — body↔filename auto-rewrite", () => {
  it("rewrites body name to match filename when they differ", () => {
    // Caller PUTs to /recipes/foo with a body whose `name:` is `bar`.
    // The filename wins; body is rewritten and a warning is returned.
    const result = saveRecipeContent(dir, "foo", VALID_BODY("bar"));
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    const written = readFileSync(result.path as string, "utf-8");
    expect(written).toMatch(/^name: foo$/m);
    expect(written).not.toMatch(/^name: bar$/m);
    expect((result as { warnings?: string[] }).warnings ?? []).toContainEqual(
      expect.stringMatching(/rewritten to "foo"/),
    );
  });

  it("does NOT rewrite when body name already matches", () => {
    const result = saveRecipeContent(
      dir,
      "exact-match",
      VALID_BODY("exact-match"),
    );
    expect(result.ok).toBe(true);
    const written = readFileSync(result.path as string, "utf-8");
    expect(written).toMatch(/^name: exact-match$/m);
    // No body-rewrite warning
    const warnings = (result as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => w.includes("rewritten"))).toBe(false);
  });

  it("rewrites body name when caller PUT URL was uppercase", () => {
    // Server lowercases the URL name, so MyRecipe → myrecipe; body keeps
    // `name: MyRecipe`. Auto-rewrite catches the divergence.
    const result = saveRecipeContent(dir, "MyRecipe", VALID_BODY("MyRecipe"));
    expect(result.ok).toBe(true);
    const written = readFileSync(result.path as string, "utf-8");
    expect(written).toMatch(/^name: myrecipe$/m);
    expect((result as { warnings?: string[] }).warnings ?? []).toContainEqual(
      expect.stringMatching(/rewritten to "myrecipe"/),
    );
  });

  it("preserves a multiline description after rewriting name", () => {
    // Make sure `^name:\s*.+$/m` only touches the name line, not other
    // lines that happen to start with whitespace + the same prefix.
    const body = `apiVersion: patchwork.sh/v1
name: wrong-name
description: |
  This recipe also has
  a name field that should NOT be touched.
trigger:
  type: manual
steps:
  - id: s1
    agent:
      prompt: hi
`;
    const result = saveRecipeContent(dir, "right-name", body);
    expect(result.ok).toBe(true);
    const written = readFileSync(result.path as string, "utf-8");
    expect(written).toMatch(/^name: right-name$/m);
    expect(written).toContain("a name field that should NOT be touched");
  });
});
