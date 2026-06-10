/**
 * Audit 2026-06-10 cluster C7 regression tests for src/automation.ts.
 *
 * fp-automation-2 — destroy() cancels in-flight WithRetry timers so a retry
 *   can't fire post-shutdown and enqueue a task / mutate the dead instance.
 * fp-automation-3 — array-form unified hooks reject duplicate discriminators
 *   instead of silently overwriting the first entry.
 * fp-automation-4 — inline prompt length is validated by UTF-8 byte length
 *   (matching truncatePrompt) rather than UTF-16 .length.
 * fp-automation-5 — getStats().lastFiredAt is populated after a hook fires.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationHooks, loadPolicy } from "../automation.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";
import type { IClaudeDriver } from "../drivers/types.js";

// ── loadPolicy validation (fp-automation-3, fp-automation-4) ───────────────────

describe("loadPolicy — C7 validation fixes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c7-policy-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePolicy(obj: unknown): string {
    const p = path.join(tmpDir, "policy.json");
    fs.writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  // fp-automation-3
  it("rejects array-form onDiagnosticsStateChange with duplicate discriminator", () => {
    const p = writePolicy({
      onDiagnosticsStateChange: [
        { state: "error", enabled: true, prompt: "first", cooldownMs: 5000 },
        { state: "error", enabled: true, prompt: "second", cooldownMs: 5000 },
      ],
    });
    expect(() => loadPolicy(p)).toThrow(/duplicate/i);
  });

  it("still accepts array-form onDiagnosticsStateChange with distinct discriminators", () => {
    const p = writePolicy({
      onDiagnosticsStateChange: [
        {
          state: "error",
          enabled: true,
          prompt: "on error",
          cooldownMs: 5000,
          minSeverity: "error",
        },
        {
          state: "cleared",
          enabled: true,
          prompt: "cleared",
          cooldownMs: 5000,
        },
      ],
    });
    const policy = loadPolicy(p);
    expect(policy.onDiagnosticsError?.prompt).toBe("on error");
    expect(policy.onDiagnosticsCleared?.prompt).toBe("cleared");
  });

  it("rejects array-form onCompaction with duplicate phase", () => {
    const p = writePolicy({
      onCompaction: [
        { phase: "pre", enabled: true, prompt: "A", cooldownMs: 5000 },
        { phase: "pre", enabled: true, prompt: "B", cooldownMs: 5000 },
      ],
    });
    expect(() => loadPolicy(p)).toThrow(/duplicate/i);
  });

  // fp-automation-4
  it("rejects a multibyte prompt that exceeds 32768 UTF-8 bytes even though .length is ≤ 32768", () => {
    // 20000 CJK chars: .length = 20000 (passes a UTF-16 check) but 60000
    // UTF-8 bytes (fails the byte check that matches truncatePrompt).
    const cjk = "字".repeat(20000);
    expect(cjk.length).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(32768);
    const p = writePolicy({
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        prompt: cjk,
        cooldownMs: 5000,
      },
    });
    expect(() => loadPolicy(p)).toThrow(/bytes|≤/i);
  });

  it("accepts a multibyte prompt within the 32768-byte budget", () => {
    const cjk = "字".repeat(1000); // 3000 UTF-8 bytes
    const p = writePolicy({
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        prompt: cjk,
        cooldownMs: 5000,
      },
    });
    expect(() => loadPolicy(p)).not.toThrow();
  });
});

// ── Runtime behavior (fp-automation-2, fp-automation-5) ────────────────────────

function makeInstantOrchestrator(): ClaudeOrchestrator {
  const driver: IClaudeDriver = {
    name: "instant",
    async run() {
      return { text: "ok", exitCode: 0, durationMs: 1 };
    },
  };
  return new ClaudeOrchestrator(driver, os.tmpdir(), () => {});
}

describe("AutomationHooks runtime — C7 fixes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // fp-automation-5
  it("getStats().lastFiredAt is set after a hook fires a task", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onGitCommit: {
          enabled: true,
          prompt: "commit {{hash}}",
          cooldownMs: 0,
        },
      } as unknown as ConstructorParameters<typeof AutomationHooks>[0],
      orch,
      () => {},
    );

    expect(hooks.getStats().lastFiredAt).toBeNull();

    hooks.handleGitCommit({
      hash: "abc1234",
      branch: "main",
      message: "feat: x",
      count: 1,
      files: ["a.ts"],
    });
    await hooks.flush();

    const fired = hooks.getStats().lastFiredAt;
    expect(fired).not.toBeNull();
    expect(() => new Date(fired as string).toISOString()).not.toThrow();
  });

  // fp-automation-2
  it("destroy() cancels a scheduled retry so it never fires post-shutdown", async () => {
    vi.useFakeTimers();
    try {
      const orch = makeInstantOrchestrator();
      let enqueueCount = 0;
      // Force the Hook error path so WithRetry schedules a retry.
      vi.spyOn(orch, "enqueue").mockImplementation((): string => {
        enqueueCount++;
        throw new Error("synthetic enqueue failure");
      });

      const hooks = new AutomationHooks(
        {
          onGitCommit: {
            enabled: true,
            prompt: "commit {{hash}}",
            cooldownMs: 0,
            retryCount: 1,
            retryDelayMs: 5000,
          },
        } as unknown as ConstructorParameters<typeof AutomationHooks>[0],
        orch,
        () => {},
      );

      hooks.handleGitCommit({
        hash: "abc1234",
        branch: "main",
        message: "feat: x",
        count: 1,
        files: ["a.ts"],
      });
      await hooks.flush();

      // Initial attempt threw → exactly one enqueue, retry timer scheduled.
      expect(enqueueCount).toBe(1);

      // Tear down before the retry delay elapses.
      hooks.destroy();

      // Advance well past retryDelayMs — the cancelled timer must not fire.
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(enqueueCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
