import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "../automation.js";
import { AutomationHooks, loadPolicy } from "../automation.js";
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
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        input.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(
            Object.assign(new Error("AbortError"), { name: "AbortError" }),
          );
        });
      });
      return { text: "ok", exitCode: 0, durationMs: 0 };
    },
  };
  return new ClaudeOrchestrator(driver, "/tmp", () => {});
}

const errorDiag: Diagnostic[] = [{ message: "Type error", severity: "error" }];
const warningDiag: Diagnostic[] = [
  { message: "Unused var", severity: "warning" },
];

// ── loadPolicy tests ──────────────────────────────────────────────────────────

describe("loadPolicy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-policy-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid policy", () => {
    const p = path.join(tmpDir, "policy.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Review {{file}}",
          cooldownMs: 10_000,
        },
      }),
    );
    const policy = loadPolicy(p);
    expect(policy.onFileSave?.enabled).toBe(true);
  });

  it("throws on invalid JSON", () => {
    const p = path.join(tmpDir, "bad.json");
    fs.writeFileSync(p, "not json {{{");
    expect(() => loadPolicy(p)).toThrow(/parse/i);
  });

  it("throws on missing file", () => {
    expect(() => loadPolicy("/nonexistent/path/policy.json")).toThrow();
  });

  it("enforces cooldownMs >= 5000", () => {
    const p = path.join(tmpDir, "policy.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Review {{file}}",
          cooldownMs: 100, // too low
        },
      }),
    );
    const policy = loadPolicy(p);
    expect(policy.onFileSave?.cooldownMs).toBe(5_000);
  });

  it("parses a valid onFileChanged policy", () => {
    const p = path.join(tmpDir, "policy.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Changed: {{file}}",
          cooldownMs: 10_000,
        },
      }),
    );
    const policy = loadPolicy(p);
    expect(policy.onFileChanged?.enabled).toBe(true);
    expect(policy.onFileChanged?.patterns).toEqual(["**/*.ts"]);
  });

  it("enforces onFileChanged cooldownMs >= 5000", () => {
    const p = path.join(tmpDir, "policy.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Changed: {{file}}",
          cooldownMs: 100,
        },
      }),
    );
    const policy = loadPolicy(p);
    expect(policy.onFileChanged?.cooldownMs).toBe(5_000);
  });

  it("throws on invalid minSeverity", () => {
    const p = path.join(tmpDir, "policy.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        onDiagnosticsError: {
          enabled: true,
          minSeverity: "critical",
          prompt: "Fix {{diagnostics}}",
          cooldownMs: 10_000,
        },
      }),
    );
    expect(() => loadPolicy(p)).toThrow(/minSeverity/i);
  });
});

// ── handleDiagnosticsChanged tests ───────────────────────────────────────────

describe("AutomationHooks.handleDiagnosticsChanged", () => {
  it("triggers task on first call", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDiagnosticsError: {
          enabled: true,
          minSeverity: "error",
          prompt: "Fix: {{diagnostics}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    expect(orch.list().length).toBe(1);
  });

  it("second call within cooldown is skipped", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDiagnosticsError: {
          enabled: true,
          minSeverity: "error",
          prompt: "Fix: {{diagnostics}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    expect(orch.list().length).toBe(1); // only one task
  });

  it("loop guard — no new task while prior one is pending/running", () => {
    const orch = makeSlowOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDiagnosticsError: {
          enabled: true,
          minSeverity: "error",
          prompt: "Fix: {{diagnostics}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    expect(orch.list().length).toBe(1);
    const firstTask = orch.list()[0];
    expect(
      firstTask?.status === "pending" || firstTask?.status === "running",
    ).toBe(true);

    // Force cooldown to pass by backdating
    (hooks as any).lastTrigger.set("diagnostics:/src/foo.ts", 0);
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    expect(orch.list().length).toBe(1); // loop guard prevents second task
  });

  it("skips diagnostics below minSeverity", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDiagnosticsError: {
          enabled: true,
          minSeverity: "error",
          prompt: "Fix: {{diagnostics}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleDiagnosticsChanged("/src/foo.ts", warningDiag);
    expect(orch.list().length).toBe(0);
  });

  it("does nothing when disabled", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onDiagnosticsError: {
          enabled: false,
          minSeverity: "error",
          prompt: "Fix",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    expect(orch.list().length).toBe(0);
  });
});

// ── handleFileSaved tests ─────────────────────────────────────────────────────

describe("AutomationHooks.handleFileSaved", () => {
  it("matching pattern triggers task", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Review {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileSaved("id1", "save", "/src/foo.ts");
    expect(orch.list().length).toBe(1);
  });

  it("non-matching pattern — no task", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Review {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileSaved("id1", "save", "/src/foo.py");
    expect(orch.list().length).toBe(0);
  });

  it("type !== save — no task", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Review {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileSaved("id1", "change", "/src/foo.ts");
    expect(orch.list().length).toBe(0);
  });

  it("cooldown prevents duplicate tasks", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Review {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileSaved("id1", "save", "/src/foo.ts");
    hooks.handleFileSaved("id2", "save", "/src/foo.ts");
    expect(orch.list().length).toBe(1);
  });
});

// ── handleFileChanged ─────────────────────────────────────────────────────────

describe("AutomationHooks.handleFileChanged", () => {
  it("enqueues task for matching change event", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "File changed: {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileChanged("id1", "change", "/src/foo.ts");
    expect(orch.list().length).toBe(1);
  });

  it("ignores save events (those are for onFileSave)", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "File changed: {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileChanged("id1", "save", "/src/foo.ts");
    expect(orch.list().length).toBe(0);
  });

  it("ignores non-matching patterns", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "File changed: {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileChanged("id1", "change", "/src/foo.js");
    expect(orch.list().length).toBe(0);
  });

  it("cooldown prevents duplicate tasks", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "File changed: {{file}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileChanged("id1", "change", "/src/foo.ts");
    hooks.handleFileChanged("id2", "change", "/src/foo.ts");
    expect(orch.list().length).toBe(1);
  });

  it("does not suppress diagnostics trigger for same file", () => {
    const orch = makeInstantOrchestrator();
    const hooks = new AutomationHooks(
      {
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts"],
          prompt: "Changed: {{file}}",
          cooldownMs: 5_000,
        },
        onDiagnosticsError: {
          enabled: true,
          minSeverity: "error",
          prompt: "Fix: {{file}} {{diagnostics}}",
          cooldownMs: 5_000,
        },
      },
      orch,
      () => {},
    );
    hooks.handleFileChanged("id1", "change", "/src/foo.ts");
    hooks.handleDiagnosticsChanged("/src/foo.ts", errorDiag);
    expect(orch.list().length).toBe(2);
  });

  it("getStatus includes onFileChanged", () => {
    const hooks = new AutomationHooks(
      {
        onFileChanged: {
          enabled: true,
          patterns: ["**/*.ts", "**/*.tsx"],
          prompt: "Changed: {{file}}",
          cooldownMs: 5_000,
        },
      },
      makeInstantOrchestrator(),
      () => {},
    );
    const status = hooks.getStatus();
    expect(status.onFileChanged).toEqual({ enabled: true, patternCount: 2 });
  });
});
