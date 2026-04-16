/**
 * Tests for the unified `onTestRun(filter)` automation hook (v2.43.0+).
 *
 * Phase C consolidation 3/4: replaces `onTestRun.onFailureOnly` + separate
 * `onTestPassAfterFailure` hook with a single `filter` field:
 *   - "any"             — fire after every test run
 *   - "failure"         — fire on failing runs (= legacy onFailureOnly:true)
 *   - "pass-after-fail" — route into the onTestPassAfterFailure slot
 *
 * Expansion happens at loadPolicy time. Legacy names still work with a
 * deprecation warning.
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
  tmpDir = mkdtempSync(join(tmpdir(), "onTestRun-"));
  policyPath = join(tmpDir, "policy.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPolicy — onTestRun.filter rewriting", () => {
  it("filter: 'failure' rewrites to onFailureOnly: true", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "failure",
        prompt: "fail fix",
        cooldownMs: 10_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onTestRun?.enabled).toBe(true);
    expect(policy.onTestRun?.onFailureOnly).toBe(true);
    // filter stripped after rewrite
    expect(
      (policy.onTestRun as unknown as { filter?: unknown })?.filter,
    ).toBeUndefined();
    expect(policy.onTestPassAfterFailure).toBeUndefined();
  });

  it("filter: 'any' rewrites to onFailureOnly: false", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "any",
        prompt: "any run",
        cooldownMs: 10_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onTestRun?.onFailureOnly).toBe(false);
    expect(
      (policy.onTestRun as unknown as { filter?: unknown })?.filter,
    ).toBeUndefined();
  });

  it("filter: 'pass-after-fail' routes to onTestPassAfterFailure slot", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "pass-after-fail",
        prompt: "green after red",
        cooldownMs: 10_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onTestRun).toBeUndefined();
    expect(policy.onTestPassAfterFailure?.enabled).toBe(true);
    expect(policy.onTestPassAfterFailure?.prompt).toBe("green after red");
    expect(policy.onTestPassAfterFailure?.cooldownMs).toBe(10_000);
    expect(
      (policy.onTestPassAfterFailure as unknown as { filter?: unknown })
        ?.filter,
    ).toBeUndefined();
  });

  it("rejects invalid filter values", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "sometimes",
        prompt: "x",
        cooldownMs: 10_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /filter.*must be one of.*any.*failure.*pass-after-fail/i,
    );
  });

  it("rejects setting both filter and legacy onFailureOnly", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "failure",
        onFailureOnly: true,
        prompt: "x",
        cooldownMs: 10_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*filter.*onFailureOnly/,
    );
  });

  it("rejects filter 'pass-after-fail' when legacy onTestPassAfterFailure also set", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "pass-after-fail",
        prompt: "new",
        cooldownMs: 10_000,
      },
      onTestPassAfterFailure: {
        enabled: true,
        prompt: "legacy",
        cooldownMs: 10_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onTestRun.*pass-after-fail.*onTestPassAfterFailure/,
    );
  });
});

describe("loadPolicy — onTestRun legacy deprecation", () => {
  it("warns when onFailureOnly is used directly (no filter)", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        onFailureOnly: true,
        prompt: "legacy",
        cooldownMs: 10_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(
      /onTestRun\.onFailureOnly.*deprecated.*filter/,
    );
    // behavior preserved — hook still works with onFailureOnly:true
    expect(policy.onTestRun?.onFailureOnly).toBe(true);
    warnSpy.mockRestore();
  });

  it("warns when separate onTestPassAfterFailure hook is set", () => {
    writePolicy({
      onTestPassAfterFailure: {
        enabled: true,
        prompt: "legacy",
        cooldownMs: 10_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(
      /onTestPassAfterFailure.*deprecated.*onTestRun.*filter.*pass-after-fail/,
    );
    // behavior preserved
    expect(policy.onTestPassAfterFailure?.enabled).toBe(true);
    warnSpy.mockRestore();
  });

  it("does NOT warn when onTestRun.filter is used (canonical form)", () => {
    writePolicy({
      onTestRun: {
        enabled: true,
        filter: "failure",
        prompt: "canonical",
        cooldownMs: 10_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
