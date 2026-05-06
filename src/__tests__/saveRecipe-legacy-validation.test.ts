/**
 * Regression test for the legacy `saveRecipe` (POST /recipes) JSON path.
 *
 * Audit verification (2026-05-06) found this path was filtering
 * `validateRecipeDefinition` issues to ONLY "Unknown template
 * reference" errors — silently bypassing cron validation, var-name
 * regex, and reserved-name shadowing that the dashboard's YAML PUT
 * path already enforced. Anyone scripting against the bridge's JSON
 * API was getting much weaker validation than the form.
 *
 * Fix surfaces the FIRST `error`-level issue from
 * `validateRecipeDefinition` instead of cherry-picking template
 * reference errors only.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRecipe } from "../recipesHttp.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "save-recipe-legacy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const validDraftBase = {
  name: "test-recipe",
  description: "test",
  steps: [
    {
      id: "s1",
      agent: true as const,
      prompt: "hi",
    },
  ],
};

describe("saveRecipe — legacy JSON path validation parity", () => {
  it("rejects bogus cron expression (was silently accepted)", () => {
    const result = saveRecipe(dir, {
      ...validDraftBase,
      name: "cron-bogus",
      trigger: {
        type: "cron",
        cron: "bogus",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cron|schedule|trigger\.at/i);
  });

  it("rejects out-of-range cron field (was silently accepted)", () => {
    const result = saveRecipe(dir, {
      ...validDraftBase,
      name: "cron-bad-hour",
      trigger: {
        type: "cron",
        cron: "0 25 * * *",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cron|trigger\.at/i);
  });

  it("rejects reserved built-in var name (was silently accepted)", () => {
    const result = saveRecipe(dir, {
      ...validDraftBase,
      name: "reserved-var",
      trigger: { type: "manual" },
      vars: [{ name: "payload", description: "", required: true, default: "" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reserved|shadow/i);
  });

  it("rejects malformed var name (was silently accepted)", () => {
    const result = saveRecipe(dir, {
      ...validDraftBase,
      name: "malformed-var",
      trigger: { type: "manual" },
      vars: [{ name: "MY VAR", description: "", required: true, default: "" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/var|invalid/i);
  });

  it("still surfaces unknown template reference errors", () => {
    // Regression guard — the previous filter only caught these. Make
    // sure the broader filter still includes them.
    const result = saveRecipe(dir, {
      ...validDraftBase,
      name: "bad-ref",
      trigger: { type: "manual" },
      steps: [{ id: "s1", agent: true, prompt: "Hello {{NEVER_DECLARED}}" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown template reference|NEVER_DECLARED/);
  });

  it("accepts a valid recipe", () => {
    const result = saveRecipe(dir, {
      ...validDraftBase,
      name: "ok-cron",
      trigger: {
        type: "cron",
        cron: "0 9 * * 1-5",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    // File should land on disk
    const files = readdirSync(dir);
    expect(files).toContain("ok-cron.json");
  });
});
