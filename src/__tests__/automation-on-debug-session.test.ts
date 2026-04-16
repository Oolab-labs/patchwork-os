/**
 * Tests for the unified `onDebugSession` automation hook (v2.43.0+).
 *
 * Phase C consolidation 4/4: replaces onDebugSessionStart + onDebugSessionEnd
 * with a single schema entry discriminated by `phase: "start"|"end"`.
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
  tmpDir = mkdtempSync(join(tmpdir(), "onDebugSession-"));
  policyPath = join(tmpDir, "policy.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPolicy — onDebugSession unified hook", () => {
  it("expands phase: 'start' into onDebugSessionStart", () => {
    writePolicy({
      onDebugSession: {
        enabled: true,
        phase: "start",
        prompt: "debug started",
        cooldownMs: 5_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onDebugSessionStart?.enabled).toBe(true);
    expect(policy.onDebugSessionStart?.prompt).toBe("debug started");
    expect(policy.onDebugSessionEnd).toBeUndefined();
    expect(policy.onDebugSession).toBeUndefined();
  });

  it("expands phase: 'end' into onDebugSessionEnd", () => {
    writePolicy({
      onDebugSession: {
        enabled: true,
        phase: "end",
        prompt: "debug done",
        cooldownMs: 5_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onDebugSessionEnd?.enabled).toBe(true);
    expect(policy.onDebugSessionStart).toBeUndefined();
  });

  it("rejects invalid phase", () => {
    writePolicy({
      onDebugSession: {
        enabled: true,
        phase: "middle",
        prompt: "x",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(/phase.*must be.*start.*end/i);
  });

  it("rejects both onDebugSession(start) and legacy onDebugSessionStart", () => {
    writePolicy({
      onDebugSession: {
        enabled: true,
        phase: "start",
        prompt: "new",
        cooldownMs: 5_000,
      },
      onDebugSessionStart: {
        enabled: true,
        prompt: "legacy",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onDebugSession.*onDebugSessionStart/,
    );
  });

  it("rejects both onDebugSession(end) and legacy onDebugSessionEnd", () => {
    writePolicy({
      onDebugSession: {
        enabled: true,
        phase: "end",
        prompt: "new",
        cooldownMs: 5_000,
      },
      onDebugSessionEnd: {
        enabled: true,
        prompt: "legacy",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onDebugSession.*onDebugSessionEnd/,
    );
  });
});

describe("loadPolicy — legacy debug-session-hook deprecation warnings", () => {
  it("warns when onDebugSessionStart is used directly", () => {
    writePolicy({
      onDebugSessionStart: {
        enabled: true,
        prompt: "legacy start",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(
      /onDebugSessionStart.*deprecated.*onDebugSession.*phase.*start/,
    );
    warnSpy.mockRestore();
  });

  it("warns when onDebugSessionEnd is used directly", () => {
    writePolicy({
      onDebugSessionEnd: {
        enabled: true,
        prompt: "legacy end",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(
      /onDebugSessionEnd.*deprecated.*onDebugSession.*phase.*end/,
    );
    warnSpy.mockRestore();
  });

  it("does NOT warn when onDebugSession is used (canonical form)", () => {
    writePolicy({
      onDebugSession: {
        enabled: true,
        phase: "start",
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
