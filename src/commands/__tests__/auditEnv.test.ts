import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAuditEnv } from "../auditEnv.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecipe(extraYaml = ""): string {
  return `
name: test-recipe
trigger:
  schedule: "0 * * * *"
steps:
  - id: step1
    agent:
      prompt: "Call {{env.API_KEY}} and {{env.MISSING_VAR}} endpoint"
${extraYaml}
`.trim();
}

describe("runAuditEnv", () => {
  let tmpDir: string;
  let recipeFile: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "audit-env-test-"));
    recipeFile = path.join(tmpDir, "test-recipe.yaml");
    writeFileSync(recipeFile, makeRecipe());

    // Set API_KEY, ensure MISSING_VAR is absent
    process.env.API_KEY = "test-value";
    delete process.env.MISSING_VAR;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  // ── Basic present / missing split ─────────────────────────────────────────

  it("reports missing and present env vars from process.env", async () => {
    const result = await runAuditEnv(recipeFile);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["MISSING_VAR"]);
    expect(result.present).toEqual(["API_KEY"]);
    expect(result.warnings).toEqual([]);
  });

  it("ok=true when all refs are present", async () => {
    process.env.MISSING_VAR = "resolved";
    const result = await runAuditEnv(recipeFile);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toContain("API_KEY");
    expect(result.present).toContain("MISSING_VAR");
  });

  it("ok=true and empty arrays when recipe has no env refs", async () => {
    writeFileSync(
      recipeFile,
      `
name: no-env-recipe
trigger:
  schedule: "0 * * * *"
steps:
  - id: step1
    agent:
      prompt: "no env refs here"
`.trim(),
    );
    const result = await runAuditEnv(recipeFile);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toEqual([]);
  });

  // ── recipe name in result ─────────────────────────────────────────────────

  it("uses recipe.name field for display", async () => {
    const result = await runAuditEnv(recipeFile);
    expect(result.recipe).toBe("test-recipe");
  });

  // ── envFile support ───────────────────────────────────────────────────────

  it("uses envFile to resolve previously missing vars", async () => {
    const envFile = path.join(tmpDir, ".env");
    writeFileSync(envFile, "MISSING_VAR=from-dotenv\n");

    const result = await runAuditEnv(recipeFile, {
      envFile: ".env",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.present).toContain("MISSING_VAR");
    expect(result.present).toContain("API_KEY");
  });

  it("envFile can override process.env values", async () => {
    // API_KEY in process.env; .env also provides MISSING_VAR
    const envFile = path.join(tmpDir, ".env.test");
    writeFileSync(envFile, "MISSING_VAR=override\nAPI_KEY=from-file\n");

    const result = await runAuditEnv(recipeFile, {
      envFile: ".env.test",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("handles quoted values in envFile", async () => {
    const envFile = path.join(tmpDir, ".env");
    writeFileSync(envFile, `MISSING_VAR="some secret"\n`);

    const result = await runAuditEnv(recipeFile, {
      envFile: ".env",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.present).toContain("MISSING_VAR");
  });

  // ── envFile path traversal guard ─────────────────────────────────────────

  it("rejects envFile that escapes workspace (path traversal)", async () => {
    const outsideEnvFile = path.join(os.tmpdir(), "evil.env");
    writeFileSync(outsideEnvFile, "MISSING_VAR=leaked\n");

    const result = await runAuditEnv(recipeFile, {
      // Attempt to reference a file outside the workspace using ../
      envFile: "../../evil.env",
      workspace: tmpDir,
    });

    // Should NOT have resolved MISSING_VAR — path rejected
    expect(result.ok).toBe(false);
    expect(
      result.warnings.some((w) =>
        /envFile path rejected|escapes workspace/i.test(w),
      ),
    ).toBe(true);

    // Clean up
    rmSync(outsideEnvFile, { force: true });
  });

  it("returns error result when envFile is absolute path outside workspace", async () => {
    const result = await runAuditEnv(recipeFile, {
      envFile: "/etc/passwd",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    expect(
      result.warnings.some((w) =>
        /envFile path rejected|escapes workspace/i.test(w),
      ),
    ).toBe(true);
  });

  it("returns error result when workspace is missing but envFile provided", async () => {
    const result = await runAuditEnv(recipeFile, {
      envFile: ".env",
      // workspace intentionally omitted
    });

    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/workspace is required/);
  });

  // ── Invalid recipe path ───────────────────────────────────────────────────

  it("returns error result for non-existent recipe path", async () => {
    const result = await runAuditEnv("/does/not/exist.yaml");

    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/not found/i);
  });

  // ── Case-insensitive env ref matching (lowercase) ─────────────────────────

  it("detects lowercase {{env.foo}} refs", async () => {
    writeFileSync(
      recipeFile,
      `
name: lower-recipe
trigger:
  schedule: "0 * * * *"
steps:
  - id: step1
    agent:
      prompt: "use {{env.lowercase_key}} here"
`.trim(),
    );

    process.env.lowercase_key = "yes";
    const result = await runAuditEnv(recipeFile);

    expect(result.present).toContain("lowercase_key");
    expect(result.missing).not.toContain("lowercase_key");

    delete process.env.lowercase_key;
  });

  // ── Placeholder warning ────────────────────────────────────────────────────

  it("warns when present env var value looks like a placeholder", async () => {
    process.env.MISSING_VAR = "changeme";
    const result = await runAuditEnv(recipeFile);

    expect(result.present).toContain("MISSING_VAR");
    expect(
      result.warnings.some(
        (w) => w.includes("MISSING_VAR") && w.includes("placeholder"),
      ),
    ).toBe(true);

    delete process.env.MISSING_VAR;
  });

  // ── env refs in nested YAML structures ────────────────────────────────────

  it("finds refs nested deep in YAML", async () => {
    writeFileSync(
      recipeFile,
      `
name: nested-recipe
trigger:
  schedule: "0 * * * *"
vars:
  token: "{{env.DEEP_TOKEN}}"
steps:
  - id: step1
    agent:
      prompt: "noop"
`.trim(),
    );

    delete process.env.DEEP_TOKEN;
    const result = await runAuditEnv(recipeFile);

    expect(result.missing).toContain("DEEP_TOKEN");

    process.env.DEEP_TOKEN = "set";
    const result2 = await runAuditEnv(recipeFile);
    expect(result2.present).toContain("DEEP_TOKEN");

    delete process.env.DEEP_TOKEN;
  });

  // ── Workspace subdirectory for envFile ───────────────────────────────────

  it("accepts envFile inside a subdirectory of workspace", async () => {
    const subDir = path.join(tmpDir, "config");
    mkdirSync(subDir);
    const envFile = path.join(subDir, ".env");
    writeFileSync(envFile, "MISSING_VAR=subdir-value\n");

    const result = await runAuditEnv(recipeFile, {
      envFile: "config/.env",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(true);
    expect(result.present).toContain("MISSING_VAR");
  });
});
