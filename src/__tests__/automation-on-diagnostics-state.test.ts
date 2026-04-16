/**
 * Tests for the unified `onDiagnosticsStateChange` automation hook (v2.43.0+).
 *
 * Phase C consolidation 2/4: replaces onDiagnosticsError + onDiagnosticsCleared
 * with a single schema entry discriminated by `state: "error"|"cleared"`.
 * Expansion happens at loadPolicy time — existing interpreter + handler code
 * is unchanged.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicy } from "../automation.js";

let tmpDir: string;
let policyPath: string;

function writePolicy(policy: Record<string, unknown>): void {
  writeFileSync(policyPath, JSON.stringify(policy), "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "onDiagState-"));
  policyPath = join(tmpDir, "policy.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPolicy — onDiagnosticsStateChange unified hook", () => {
  it("expands state: 'error' into onDiagnosticsError with extra fields preserved", () => {
    writePolicy({
      onDiagnosticsStateChange: {
        enabled: true,
        state: "error",
        minSeverity: "error",
        diagnosticTypes: ["ts", "eslint"],
        dedupeByContent: true,
        dedupeContentCooldownMs: 600_000,
        prompt: "fix it",
        cooldownMs: 20_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onDiagnosticsError?.enabled).toBe(true);
    expect(policy.onDiagnosticsError?.minSeverity).toBe("error");
    expect(policy.onDiagnosticsError?.diagnosticTypes).toEqual([
      "ts",
      "eslint",
    ]);
    expect(policy.onDiagnosticsError?.dedupeByContent).toBe(true);
    expect(policy.onDiagnosticsError?.dedupeContentCooldownMs).toBe(600_000);
    expect(policy.onDiagnosticsCleared).toBeUndefined();
    expect(
      (policy.onDiagnosticsError as unknown as { state?: unknown })?.state,
    ).toBeUndefined();
    expect(policy.onDiagnosticsStateChange).toBeUndefined();
  });

  it("expands state: 'cleared' into onDiagnosticsCleared", () => {
    writePolicy({
      onDiagnosticsStateChange: {
        enabled: true,
        state: "cleared",
        prompt: "all clear",
        cooldownMs: 5_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onDiagnosticsCleared?.enabled).toBe(true);
    expect(policy.onDiagnosticsCleared?.prompt).toBe("all clear");
    expect(policy.onDiagnosticsError).toBeUndefined();
  });

  it("rejects invalid state", () => {
    writePolicy({
      onDiagnosticsStateChange: {
        enabled: true,
        state: "warning",
        prompt: "x",
        cooldownMs: 5_000,
      } as unknown as Record<string, unknown>,
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /state.*must be.*error.*cleared/i,
    );
  });

  it("rejects setting both onDiagnosticsStateChange(error) and legacy onDiagnosticsError", () => {
    writePolicy({
      onDiagnosticsStateChange: {
        enabled: true,
        state: "error",
        minSeverity: "error",
        prompt: "new",
        cooldownMs: 5_000,
      },
      onDiagnosticsError: {
        enabled: true,
        minSeverity: "error",
        prompt: "legacy",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onDiagnosticsStateChange.*onDiagnosticsError/,
    );
  });

  it("rejects setting both onDiagnosticsStateChange(cleared) and legacy onDiagnosticsCleared", () => {
    writePolicy({
      onDiagnosticsStateChange: {
        enabled: true,
        state: "cleared",
        prompt: "new",
        cooldownMs: 5_000,
      },
      onDiagnosticsCleared: {
        enabled: true,
        prompt: "legacy",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onDiagnosticsStateChange.*onDiagnosticsCleared/,
    );
  });
});

describe("loadPolicy — legacy diagnostics-hook deprecation warnings", () => {
  it("emits a deprecation warning when onDiagnosticsError is used directly", () => {
    writePolicy({
      onDiagnosticsError: {
        enabled: true,
        minSeverity: "error",
        prompt: "legacy err",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(
      /onDiagnosticsError.*deprecated.*onDiagnosticsStateChange.*state.*error/,
    );
    warnSpy.mockRestore();
  });

  it("emits a deprecation warning when onDiagnosticsCleared is used directly", () => {
    writePolicy({
      onDiagnosticsCleared: {
        enabled: true,
        prompt: "legacy clear",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(
      /onDiagnosticsCleared.*deprecated.*onDiagnosticsStateChange.*state.*cleared/,
    );
    warnSpy.mockRestore();
  });

  it("does NOT warn when onDiagnosticsStateChange is used (canonical form)", () => {
    writePolicy({
      onDiagnosticsStateChange: {
        enabled: true,
        state: "error",
        minSeverity: "error",
        prompt: "canonical",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
