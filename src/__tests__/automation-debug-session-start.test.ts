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

const BASE_RESULT = {
  sessionName: "My Node App",
  sessionType: "node",
  breakpointCount: 3,
  activeFile: "/workspace/src/server.ts",
};

const BASE_POLICY = {
  onDebugSessionStart: {
    enabled: true,
    prompt:
      "Debug session {{sessionName}} ({{sessionType}}) started — {{breakpointCount}} breakpoints set in {{activeFile}}",
    cooldownMs: 5_000,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AutomationHooks.onDebugSessionStart", () => {
  it("fires when hook is enabled and session starts", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionStart(BASE_RESULT);

    expect(orch.list().length).toBe(1);
  });

  it("returns early when hook is not enabled", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDebugSessionStart: {
          enabled: false,
          prompt: "debug started",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );

    await hooks.handleDebugSessionStart(BASE_RESULT);

    expect(orch.list().length).toBe(0);
  });

  it("returns early when hook is not configured", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks({}, orch, () => {});

    await hooks.handleDebugSessionStart(BASE_RESULT);

    expect(orch.list().length).toBe(0);
  });

  it("substitutes all placeholders: sessionName, sessionType, breakpointCount, activeFile", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionStart({
      sessionName: "MyServer",
      sessionType: "python",
      breakpointCount: 5,
      activeFile: "/workspace/app.py",
    });

    const tasks = orch.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toContain("MyServer");
    expect(tasks[0]!.prompt).toContain("python");
    expect(tasks[0]!.prompt).toContain("5");
    expect(tasks[0]!.prompt).toContain("/workspace/app.py");
  });

  it("respects cooldownMs — second trigger within window is suppressed", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    hooks.handleDebugSessionStart(BASE_RESULT);
    await hooks.flush();
    expect(orch.list().length).toBe(1);

    // Second trigger within cooldown
    hooks.handleDebugSessionStart(BASE_RESULT);
    await hooks.flush();
    expect(orch.list().length).toBe(1); // still 1 — cooldown blocked

    // Advance past cooldown
    vi.setSystemTime(Date.now() + 10_000);

    hooks.handleDebugSessionStart(BASE_RESULT);
    await hooks.flush();
    expect(orch.list().length).toBe(2);
  });

  // Loop guard (active-task suppression) replaced by cooldown in Phase 4.

  it("fires after cooldown expires following a successful trigger", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionStart(BASE_RESULT);
    expect(orch.list().length).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);

    await hooks.handleDebugSessionStart({
      ...BASE_RESULT,
      sessionName: "App2",
      sessionType: "python",
    });
    expect(orch.list().length).toBe(2);
  });

  it("includes hook metadata prefix in prompt", async () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(BASE_POLICY, orch, () => {});

    await hooks.handleDebugSessionStart(BASE_RESULT);

    const tasks = orch.list();
    expect(tasks[0]!.prompt).toContain("onDebugSessionStart");
  });

  it("clamps cooldownMs below minimum to 5000ms", () => {
    expect(() => {
      new AutomationHooks(
        {
          onDebugSessionStart: {
            enabled: true,
            prompt: "started",
            cooldownMs: 100, // below minimum — should be clamped
          },
        },
        makeInstantOrchestrator(),
        () => {},
      );
    }).not.toThrow();
  });
});
