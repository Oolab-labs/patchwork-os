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

const BASE_POLICY = {
  onDebugSessionEnd: {
    enabled: true,
    prompt: "Debug session {{sessionName}} ({{sessionType}}) ended",
    cooldownMs: 5_000,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AutomationHooks.onDebugSessionEnd", () => {
  it("fires when hook is enabled and session ends", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionEnd({
      sessionName: "My Node App",
      sessionType: "node",
    });

    expect(orch.list().length).toBe(1);
  });

  it("returns early when hook is not enabled", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDebugSessionEnd: {
          enabled: false,
          prompt: "debug ended",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );

    await hooks.handleDebugSessionEnd({
      sessionName: "My App",
      sessionType: "node",
    });

    expect(orch.list().length).toBe(0);
  });

  it("returns early when hook is not configured", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks({}, orch, () => {});

    await hooks.handleDebugSessionEnd({
      sessionName: "My App",
      sessionType: "node",
    });

    expect(orch.list().length).toBe(0);
  });

  it("substitutes {{sessionName}} and {{sessionType}} placeholders", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleDebugSessionEnd({
      sessionName: "MyServer",
      sessionType: "python",
    });
    await hooks.flush();

    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("MyServer");
    expect(tasks[0]!.prompt).toContain("python");
  });

  it("respects cooldownMs — second trigger within window is suppressed", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleDebugSessionEnd({ sessionName: "App", sessionType: "node" });
    await hooks.flush();
    expect(orch.list().length).toBe(1);

    // Second trigger within cooldown
    hooks.handleDebugSessionEnd({ sessionName: "App", sessionType: "node" });
    await hooks.flush();
    expect(orch.list().length).toBe(1); // still 1 — cooldown blocked

    // Advance past cooldown
    vi.setSystemTime(Date.now() + 10_000);

    hooks.handleDebugSessionEnd({ sessionName: "App", sessionType: "node" });
    await hooks.flush();
    expect(orch.list().length).toBe(2);
  });

  // Loop guard (active-task suppression) replaced by cooldown in Phase 4.

  it("fires after cooldown expires following a successful trigger", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionEnd({
      sessionName: "App",
      sessionType: "node",
    });
    await hooks.flush();
    expect(orch.list().length).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);

    await hooks.handleDebugSessionEnd({
      sessionName: "App2",
      sessionType: "python",
    });
    await hooks.flush();
    expect(orch.list().length).toBe(2);
  });

  it("includes hook metadata prefix in prompt", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionEnd({
      sessionName: "TestApp",
      sessionType: "go",
    });

    const tasks = orch.list();
    expect(tasks[0]!.prompt).toContain("onDebugSessionEnd");
  });
});
