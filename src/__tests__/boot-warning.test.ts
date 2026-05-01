import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { warnAboutLegacyPermissionsSidecars } from "../recipes/migrationWarnings.js";

/**
 * Regression guard for recipe-dogfood-2026-05-01 A-PR4 (R2 L-2): the
 * boot-time scan for legacy `<name>.permissions.json` sidecars must
 * fire exactly once per boot with a count + migration link, and must
 * skip in NODE_ENV=test unless an explicit warn callback is supplied.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "patchwork-boot-warn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("warnAboutLegacyPermissionsSidecars", () => {
  it("emits exactly one warn with the count when sidecars exist", () => {
    writeFileSync(path.join(dir, "foo.permissions.json"), "{}");
    writeFileSync(path.join(dir, "bar.permissions.json"), "{}");
    writeFileSync(path.join(dir, "baz.permissions.json"), "{}");
    // Real recipe files must not be counted.
    writeFileSync(path.join(dir, "foo.json"), "{}");
    writeFileSync(path.join(dir, "qux.yaml"), "name: qux\n");

    const warnings: string[] = [];
    const result = warnAboutLegacyPermissionsSidecars(dir, {
      warn: (msg) => warnings.push(msg),
    });

    expect(result.count).toBe(3);
    expect(result.warned).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/3 legacy/);
    expect(warnings[0]).toContain("permissions.json");
    expect(warnings[0]).toContain(dir);
    // Migration link present.
    expect(warnings[0]).toMatch(/https?:\/\//);
  });

  it("returns count=0 / warned=false when no sidecars present", () => {
    writeFileSync(path.join(dir, "foo.json"), "{}");
    writeFileSync(path.join(dir, "qux.yaml"), "name: qux\n");

    const warnings: string[] = [];
    const result = warnAboutLegacyPermissionsSidecars(dir, {
      warn: (msg) => warnings.push(msg),
    });

    expect(result).toEqual({ count: 0, warned: false });
    expect(warnings).toHaveLength(0);
  });

  it("returns count=0 / warned=false when recipesDir doesn't exist", () => {
    const missing = path.join(dir, "nonexistent");
    const warnings: string[] = [];
    const result = warnAboutLegacyPermissionsSidecars(missing, {
      warn: (msg) => warnings.push(msg),
    });

    expect(result).toEqual({ count: 0, warned: false });
    expect(warnings).toHaveLength(0);
  });

  it("skips emission under NODE_ENV=test (default console.warn path)", () => {
    writeFileSync(path.join(dir, "foo.permissions.json"), "{}");

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      // Default code path (no `warn` override) → must not call console.warn.
      const result = warnAboutLegacyPermissionsSidecars(dir);
      expect(result.count).toBe(1);
      expect(result.warned).toBe(false);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("uniqueness — single grammar form for count=1", () => {
    writeFileSync(path.join(dir, "foo.permissions.json"), "{}");

    const warnings: string[] = [];
    const result = warnAboutLegacyPermissionsSidecars(dir, {
      warn: (msg) => warnings.push(msg),
    });

    expect(result.count).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 legacy");
    expect(warnings[0]).toContain("file in"); // singular "file" not "files"
  });
});
