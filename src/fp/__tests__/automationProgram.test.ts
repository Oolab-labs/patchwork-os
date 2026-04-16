import { describe, expect, it } from "vitest";
import {
  hook,
  parallel,
  sequence,
  withCooldown,
  withDedup,
  withRateLimit,
  withRetry,
} from "../automationProgram.js";

const INLINE_SOURCE = { kind: "inline" as const, prompt: "do something" };
const NAMED_SOURCE = {
  kind: "named" as const,
  promptName: "project-status",
  promptArgs: { extra: "val" },
};

describe("hook smart constructor", () => {
  it("sets _tag = Hook", () => {
    const h = hook({
      hookType: "onFileSave",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    expect(h._tag).toBe("Hook");
  });

  it("preserves all fields", () => {
    const h = hook({
      hookType: "onGitCommit",
      enabled: false,
      condition: "!*.test.ts",
      when: { minDiagnosticCount: 1 },
      promptSource: NAMED_SOURCE,
      model: "claude-haiku",
      effort: "low",
      systemPrompt: "be brief",
      extras: { kind: "none" },
    });
    expect(h.hookType).toBe("onGitCommit");
    expect(h.enabled).toBe(false);
    expect(h.condition).toBe("!*.test.ts");
    expect(h.when?.minDiagnosticCount).toBe(1);
    expect(h.promptSource).toEqual(NAMED_SOURCE);
    expect(h.model).toBe("claude-haiku");
    expect(h.effort).toBe("low");
    expect(h.systemPrompt).toBe("be brief");
    expect(h.extras).toEqual({ kind: "none" });
  });

  it("round-trips for every HookType", () => {
    const hookTypes = [
      "onDiagnosticsError",
      "onDiagnosticsCleared",
      "onFileSave",
      "onFileChanged",
      "onCwdChanged",
      "onPreCompact",
      "onPostCompact",
      "onInstructionsLoaded",
      "onTestRun",
      "onTestPassAfterFailure",
      "onGitCommit",
      "onGitPush",
      "onGitPull",
      "onBranchCheckout",
      "onPullRequest",
      "onTaskCreated",
      "onPermissionDenied",
      "onTaskSuccess",
      "onDebugSessionStart",
      "onDebugSessionEnd",
    ] as const;
    for (const ht of hookTypes) {
      const h = hook({
        hookType: ht,
        enabled: true,
        promptSource: INLINE_SOURCE,
      });
      expect(h._tag).toBe("Hook");
      expect(h.hookType).toBe(ht);
    }
  });
});

describe("sequence smart constructor", () => {
  it("sets _tag = Sequence", () => {
    const h = hook({
      hookType: "onFileSave",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const s = sequence([h]);
    expect(s._tag).toBe("Sequence");
    expect(s.programs).toHaveLength(1);
  });

  it("empty sequence is valid", () => {
    const s = sequence([]);
    expect(s.programs).toHaveLength(0);
  });
});

describe("parallel smart constructor", () => {
  it("sets _tag = Parallel", () => {
    const h = hook({
      hookType: "onGitPush",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const p = parallel([h]);
    expect(p._tag).toBe("Parallel");
  });
});

describe("withCooldown smart constructor", () => {
  it("sets _tag = WithCooldown and all fields", () => {
    const h = hook({
      hookType: "onFileSave",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const wc = withCooldown("save:*", 30_000, h);
    expect(wc._tag).toBe("WithCooldown");
    expect(wc.key).toBe("save:*");
    expect(wc.cooldownMs).toBe(30_000);
    expect(wc.program).toBe(h);
  });
});

describe("withDedup smart constructor", () => {
  it("sets _tag = WithDedup", () => {
    const h = hook({
      hookType: "onDiagnosticsError",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const wd = withDedup("dedup:diagnostics:*", 900_000, h);
    expect(wd._tag).toBe("WithDedup");
    expect(wd.key).toBe("dedup:diagnostics:*");
    expect(wd.cooldownMs).toBe(900_000);
    expect(wd.program).toBe(h);
  });
});

describe("withRateLimit smart constructor", () => {
  it("sets _tag = WithRateLimit", () => {
    const h = hook({
      hookType: "onFileSave",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const wrl = withRateLimit(20, h);
    expect(wrl._tag).toBe("WithRateLimit");
    expect(wrl.maxPerHour).toBe(20);
    expect(wrl.program).toBe(h);
  });
});

describe("withRetry smart constructor", () => {
  it("sets _tag = WithRetry", () => {
    const h = hook({
      hookType: "onFileSave",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const wr = withRetry("save:*", 3, 30_000, h);
    expect(wr._tag).toBe("WithRetry");
    expect(wr.key).toBe("save:*");
    expect(wr.maxRetries).toBe(3);
    expect(wr.retryDelayMs).toBe(30_000);
    expect(wr.program).toBe(h);
  });
});

describe("nested construction", () => {
  it("WithDedup wrapping WithRetry wrapping HookNode", () => {
    const h = hook({
      hookType: "onDiagnosticsError",
      enabled: true,
      promptSource: INLINE_SOURCE,
    });
    const wc = withCooldown("diagnostics:*", 10_000, h);
    const wr = withRetry("diagnostics:*", 2, 30_000, wc);
    const wd = withDedup("dedup:diagnostics:*", 900_000, wr);

    expect(wd._tag).toBe("WithDedup");
    expect(wd.program._tag).toBe("WithRetry");
    const inner = wd.program;
    expect(inner._tag).toBe("WithRetry");
    if (inner._tag === "WithRetry") {
      expect(inner.program._tag).toBe("WithCooldown");
      const innerCooldown = inner.program;
      if (innerCooldown._tag === "WithCooldown") {
        expect(innerCooldown.program._tag).toBe("Hook");
      }
    }
  });
});
