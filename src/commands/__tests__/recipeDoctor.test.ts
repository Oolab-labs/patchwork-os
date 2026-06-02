/**
 * Tests for `recipe doctor` — runRecipeDoctor + formatRecipeDoctorReport.
 *
 * Doctor composes the static preflight check (lint + policy + plan) with a
 * recipe-scoped runtime halt summary (injected via `fetchHalts`, so the
 * bridge walk stays in the CLI layer). Verifies:
 *   - clean recipe + no halts → ok:true, both sections green
 *   - lint error → static.ok false → ok:false, report lists the issue
 *   - runtime halts present → ok:false, report lists category + fix hint
 *   - no bridge (fetchHalts → null) → runtime null + note, doesn't throw
 *   - fetchHalts omitted → runtime null with "not requested" note
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DoctorRuntimeHalts,
  formatRecipeDoctorReport,
  runRecipeDoctor,
} from "../recipe.js";

const tmpDir = join(os.tmpdir(), `patchwork-doctor-test-${process.pid}`);

const VALID_RECIPE = `name: healthy-recipe
description: A valid recipe
trigger:
  type: manual
steps:
  - tool: file.read
    path: ~/test.txt
    into: content
`;

const BROKEN_RECIPE = `description: Missing name
trigger:
  type: manual
steps: []
`;

function writeRecipe(name: string, body: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, body);
  return p;
}

beforeEach(() => {
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

describe("runRecipeDoctor", () => {
  it("reports healthy when static passes and no runtime halts", async () => {
    const p = writeRecipe("healthy.yaml", VALID_RECIPE);
    const result = await runRecipeDoctor(p, {
      fetchHalts: async () => ({ total: 0, byCategory: {}, recent: [] }),
    });
    expect(result.static.ok).toBe(true);
    expect(result.runtime?.total).toBe(0);
    expect(result.ok).toBe(true);

    const report = formatRecipeDoctorReport(result);
    expect(report).toContain("✓ healthy");
    expect(report).toContain("Static checks: ✓");
    expect(report).toContain("Runtime halts: ✓");
  });

  it("flags a lint error and surfaces it in the report", async () => {
    const p = writeRecipe("broken.yaml", BROKEN_RECIPE);
    const result = await runRecipeDoctor(p, {
      fetchHalts: async () => ({ total: 0, byCategory: {}, recent: [] }),
    });
    expect(result.static.ok).toBe(false);
    expect(result.ok).toBe(false);

    const report = formatRecipeDoctorReport(result);
    expect(report).toContain("✗ needs attention");
    expect(report).toMatch(/Static checks: \d+ error/);
  });

  it("flags runtime halts and maps each category to a fix hint", async () => {
    const p = writeRecipe("halting.yaml", VALID_RECIPE);
    const halts: DoctorRuntimeHalts = {
      total: 3,
      byCategory: { auth_failure: 2, rate_limited: 1 },
      recent: [
        {
          reason: "Tool slack.post threw: 401 unauthorized",
          category: "auth_failure",
          runSeq: 12,
        },
      ],
    };
    const result = await runRecipeDoctor(p, { fetchHalts: async () => halts });
    expect(result.static.ok).toBe(true);
    expect(result.ok).toBe(false); // runtime halts make it unhealthy

    const report = formatRecipeDoctorReport(result);
    expect(report).toContain("Runtime halts: 3");
    expect(report).toContain("auth failure: 2");
    expect(report).toContain("reconnect from /connections"); // the hint
    expect(report).toContain("rate limited: 1");
    expect(report).toContain("[run #12]");
  });

  it("degrades to static-only when no bridge is reachable", async () => {
    const p = writeRecipe("nobridge.yaml", VALID_RECIPE);
    const result = await runRecipeDoctor(p, { fetchHalts: async () => null });
    expect(result.runtime).toBeNull();
    expect(result.runtimeNote).toMatch(/no running bridge/);
    // static clean + runtime unknown → still ok (nothing proven unhealthy)
    expect(result.ok).toBe(true);

    const report = formatRecipeDoctorReport(result);
    expect(report).toContain("Runtime halts: —");
  });

  it("skips the runtime check when fetchHalts is omitted", async () => {
    const p = writeRecipe("local.yaml", VALID_RECIPE);
    const result = await runRecipeDoctor(p);
    expect(result.runtime).toBeNull();
    expect(result.runtimeNote).toMatch(/not requested/);
    expect(result.ok).toBe(true);
  });

  it("does not throw when fetchHalts rejects — records the error note", async () => {
    const p = writeRecipe("fetcherr.yaml", VALID_RECIPE);
    const result = await runRecipeDoctor(p, {
      fetchHalts: async () => {
        throw new Error("connection refused");
      },
    });
    expect(result.runtime).toBeNull();
    expect(result.runtimeNote).toMatch(/connection refused/);
  });
});
