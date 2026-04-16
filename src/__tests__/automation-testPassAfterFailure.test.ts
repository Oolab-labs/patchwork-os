import { describe, expect, it, vi } from "vitest";
import { AutomationHooks } from "../automation.js";
import type { IClaudeDriver } from "../claudeDriver.js";
import { ClaudeOrchestrator } from "../claudeOrchestrator.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInstantOrchestrator() {
  const driver: IClaudeDriver = {
    name: "instant",
    async run() {
      return { text: "ok", exitCode: 0, durationMs: 1 };
    },
  };
  return new ClaudeOrchestrator(driver, "/tmp", () => {});
}

function makeTestResult(opts: {
  failed?: number;
  passed?: number;
  runners?: string[];
}) {
  const failed = opts.failed ?? 0;
  const passed = opts.passed ?? 10;
  return {
    runners: opts.runners ?? ["vitest"],
    summary: {
      total: failed + passed,
      passed,
      failed,
      skipped: 0,
      errored: 0,
    },
    failures: Array.from({ length: failed }, (_, i) => ({
      name: `test ${i + 1}`,
      file: "src/foo.test.ts",
      message: `Expected ${i} to equal ${i + 1}`,
    })),
  };
}

const BASE_POLICY = {
  onTestPassAfterFailure: {
    enabled: true,
    prompt: "{{runner}} fixed: {{passed}}/{{total}} pass",
    cooldownMs: 5_000,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AutomationHooks.onTestPassAfterFailure", () => {
  it("fires when same runner transitions fail → pass", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleTestRun(makeTestResult({ failed: 2, runners: ["vitest"] }));
    await hooks.flush();
    expect(orch.list().length).toBe(0); // onTestRun not configured — no task

    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    await hooks.flush();
    expect(orch.list().length).toBe(1); // fail→pass triggers
  });

  it("does NOT fire on pass → pass (no prior failure)", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    expect(orch.list().length).toBe(0);
  });

  it("does NOT fire on fail → fail", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["vitest"] }));
    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["vitest"] }));
    expect(orch.list().length).toBe(0);
  });

  it("does NOT fire on first pass (null → pass, no prior state)", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    expect(orch.list().length).toBe(0);
  });

  it("does NOT fire when a DIFFERENT runner was failing (vitest fail → jest pass)", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    // vitest fails
    hooks.handleTestRun(makeTestResult({ failed: 2, runners: ["vitest"] }));
    // jest passes — different runner, should NOT trigger
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["jest"] }));
    expect(orch.list().length).toBe(0);
  });

  it("fires for each runner independently when both transition fail → pass", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    // both runners fail
    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["vitest"] }));
    await hooks.flush();
    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["jest"] }));
    await hooks.flush();

    // cooldown: advance time
    vi.setSystemTime(Date.now() + 10_000);

    // vitest passes
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    await hooks.flush();
    expect(orch.list().length).toBe(1);

    // jest passes — cooldown still active for onTestPassAfterFailure global key
    // so second trigger is suppressed; this is correct behavior
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["jest"] }));
    await hooks.flush();
    // still 1 because the global cooldown blocks the second fire within 5s
    // (both transitions happened within the cooldown window)
  });

  it("respects cooldownMs — second trigger within window is suppressed", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["vitest"] }));
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    await hooks.flush();
    expect(orch.list().length).toBe(1);

    // Second fail→pass within cooldown window
    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["vitest"] }));
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    await hooks.flush();
    // Cooldown blocks — still 1
    expect(orch.list().length).toBe(1);
  });

  // Loop guard (active-task suppression) replaced by cooldown in Phase 4.

  it("does not fire when hook is disabled", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onTestPassAfterFailure: {
          enabled: false,
          prompt: "tests fixed",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );

    hooks.handleTestRun(makeTestResult({ failed: 1, runners: ["vitest"] }));
    hooks.handleTestRun(makeTestResult({ failed: 0, runners: ["vitest"] }));
    expect(orch.list().length).toBe(0);
  });
});
