/**
 * Tests for the unified `onCompaction` automation hook (v2.43.0+).
 *
 * Phase C of the roadmap consolidates 4 hook pairs into parameterized forms.
 * `onPreCompact` + `onPostCompact` is the first pair to land.
 *
 * Strategy: expansion happens at `loadPolicy` time — `onCompaction(phase: "pre")`
 * is rewritten into `onPreCompact` before any downstream code sees the policy,
 * so the new form is a drop-in replacement that shares all existing test coverage
 * of the underlying hook. These tests verify the expansion contract itself:
 * user-facing schema → internal shape.
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
  tmpDir = mkdtempSync(join(tmpdir(), "onCompaction-"));
  policyPath = join(tmpDir, "policy.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPolicy — onCompaction unified hook", () => {
  it("expands onCompaction with phase: 'pre' into onPreCompact", () => {
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "pre",
        prompt: "pre-compact snapshot",
        cooldownMs: 5_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onPreCompact?.enabled).toBe(true);
    expect(policy.onPreCompact?.prompt).toBe("pre-compact snapshot");
    expect(policy.onPreCompact?.cooldownMs).toBe(5_000);
    expect(policy.onPostCompact).toBeUndefined();
    // Phase field is stripped during expansion
    expect(
      (policy.onPreCompact as unknown as { phase?: unknown })?.phase,
    ).toBeUndefined();
    // onCompaction itself is cleared after expansion
    expect(policy.onCompaction).toBeUndefined();
  });

  it("expands onCompaction with phase: 'post' into onPostCompact", () => {
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "post",
        promptName: "project-status",
        cooldownMs: 30_000,
      },
    });

    const policy = loadPolicy(policyPath);

    expect(policy.onPostCompact?.enabled).toBe(true);
    expect(policy.onPostCompact?.promptName).toBe("project-status");
    expect(policy.onPostCompact?.cooldownMs).toBe(30_000);
    expect(policy.onPreCompact).toBeUndefined();
  });

  it("rejects invalid phase with a clear error", () => {
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "middle",
        prompt: "x",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(/phase.*must be.*pre.*post/i);
  });

  it("rejects setting both onCompaction(phase: 'pre') and legacy onPreCompact", () => {
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "pre",
        prompt: "new form",
        cooldownMs: 5_000,
      },
      onPreCompact: {
        enabled: true,
        prompt: "legacy form",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onCompaction.*onPreCompact/,
    );
  });

  it("rejects setting both onCompaction(phase: 'post') and legacy onPostCompact", () => {
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "post",
        prompt: "new",
        cooldownMs: 5_000,
      },
      onPostCompact: {
        enabled: true,
        prompt: "legacy",
        cooldownMs: 5_000,
      },
    });

    expect(() => loadPolicy(policyPath)).toThrow(
      /Cannot set both.*onCompaction.*onPostCompact/,
    );
  });

  it("allows onCompaction(phase: 'pre') alongside legacy onPostCompact (no overlap)", () => {
    // phase: "pre" only touches onPreCompact; onPostCompact is fair game to keep
    // as a separate (deprecated) entry during the migration window.
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "pre",
        prompt: "pre",
        cooldownMs: 5_000,
      },
      onPostCompact: {
        enabled: true,
        prompt: "post",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = loadPolicy(policyPath);
    warnSpy.mockRestore();

    expect(policy.onPreCompact?.prompt).toBe("pre");
    expect(policy.onPostCompact?.prompt).toBe("post");
  });
});

describe("loadPolicy — legacy compaction-hook deprecation warning", () => {
  it("emits a deprecation warning when onPreCompact is used directly", () => {
    writePolicy({
      onPreCompact: {
        enabled: true,
        prompt: "legacy pre",
        cooldownMs: 5_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(/onPreCompact.*deprecated.*onCompaction.*phase.*pre/);
    warnSpy.mockRestore();
  });

  it("emits a deprecation warning when onPostCompact is used directly", () => {
    writePolicy({
      onPostCompact: {
        enabled: true,
        promptName: "project-status",
        cooldownMs: 30_000,
      },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadPolicy(policyPath);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(/onPostCompact.*deprecated.*onCompaction.*phase.*post/);
    warnSpy.mockRestore();
  });

  it("does NOT emit a deprecation warning when onCompaction is used (canonical form)", () => {
    writePolicy({
      onCompaction: {
        enabled: true,
        phase: "pre",
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
