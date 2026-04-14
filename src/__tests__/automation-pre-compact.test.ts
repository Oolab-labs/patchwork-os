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

function makeSlowOrchestrator() {
  const driver: IClaudeDriver = {
    name: "slow",
    async run(input) {
      await new Promise<void>((_, reject) => {
        input.signal.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("AbortError"), { name: "AbortError" }),
          ),
        );
      });
      return { text: "ok", exitCode: 0, durationMs: 0 };
    },
  };
  return new ClaudeOrchestrator(driver, "/tmp", () => {});
}

const BASE_POLICY = {
  onPreCompact: {
    enabled: true,
    prompt:
      "Context compaction is about to happen — snapshot important state now",
    cooldownMs: 5_000,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AutomationHooks.onPreCompact", () => {
  it("fires when hook is enabled", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handlePreCompact();

    expect(orch.list().length).toBe(1);
  });

  it("returns early when hook is not enabled", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onPreCompact: {
          enabled: false,
          prompt: "compact incoming",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );

    await hooks.handlePreCompact();

    expect(orch.list().length).toBe(0);
  });

  it("returns early when hook is not configured", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks({}, orch, () => {});

    await hooks.handlePreCompact();

    expect(orch.list().length).toBe(0);
  });

  it("respects cooldownMs — second trigger within window is suppressed", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1);

    // Second trigger within cooldown
    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1); // still 1 — cooldown blocked

    // Advance past cooldown
    vi.setSystemTime(Date.now() + 10_000);

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(2);
  });

  it("loop guard skips if previous task still running", async () => {
    const orch = makeSlowOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1);

    // Advance past cooldown
    vi.setSystemTime(Date.now() + 10_000);

    // Second trigger while first task still running — guard should suppress
    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1); // still 1 — loop guard blocked
  });

  it("fires after cooldown expires following a successful trigger", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(2);
  });

  it("includes hook metadata prefix in prompt", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handlePreCompact();

    const tasks = orch.list();
    expect(tasks[0]!.prompt).toContain("onPreCompact");
  });

  it("does not fire when cooldownMs is very large and time has not advanced", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onPreCompact: {
          enabled: true,
          prompt: "compact soon",
          cooldownMs: 3_600_000, // 1 hour
        },
      },
      orch,
      () => {},
    );

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1);

    // Advance only 1 second — cooldown (1h) still blocks
    vi.setSystemTime(Date.now() + 1_000);

    await hooks.handlePreCompact();
    expect(orch.list().length).toBe(1); // blocked by large cooldown
  });
});
