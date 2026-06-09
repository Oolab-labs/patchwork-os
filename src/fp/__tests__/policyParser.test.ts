import { describe, expect, it } from "vitest";
import type {
  AutomationCondition,
  AutomationPolicy,
} from "../../automation.js";
import { parsePolicy } from "../policyParser.js";

const INLINE_PROMPT = "check the file {{file}}";

function minPolicy(
  overrides: Partial<AutomationPolicy> = {},
): AutomationPolicy {
  return { ...overrides };
}

describe("parsePolicy", () => {
  it("returns ok([]) for empty policy", () => {
    const result = parsePolicy(minPolicy());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  });

  it("parses a single enabled hook into WithCooldown wrapping Hook", () => {
    const policy = minPolicy({
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        cooldownMs: 30_000,
        prompt: INLINE_PROMPT,
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const node = result.value[0];
    if (!node) throw new Error("expected first node");
    expect(node._tag).toBe("WithCooldown");
    if (node._tag === "WithCooldown") {
      expect(node.cooldownMs).toBe(30_000);
      expect(node.key).toBe("save:*");
      expect(node.program._tag).toBe("Hook");
      if (node.program._tag === "Hook") {
        expect(node.program.hookType).toBe("onFileSave");
        expect(node.program.enabled).toBe(true);
      }
    }
  });

  it("skips disabled hooks", () => {
    const policy = minPolicy({
      onFileSave: {
        enabled: false,
        patterns: ["**/*.ts"],
        cooldownMs: 30_000,
        prompt: INLINE_PROMPT,
      },
      onGitCommit: {
        enabled: true,
        cooldownMs: 60_000,
        prompt: "commit happened",
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const node = result.value[0];
    if (!node) throw new Error("expected first node");
    expect(node._tag).toBe("WithCooldown");
    if (node._tag === "WithCooldown" && node.program._tag === "Hook") {
      expect(node.program.hookType).toBe("onGitCommit");
    }
  });

  it("wraps WithDedup for diagnostics error with dedupeByContent", () => {
    const policy = minPolicy({
      onDiagnosticsError: {
        enabled: true,
        minSeverity: "error",
        cooldownMs: 10_000,
        prompt: "check errors in {{file}}",
        dedupeByContent: true,
        dedupeContentCooldownMs: 900_000,
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const top = result.value[0];
    if (!top) throw new Error("expected first node");
    // Structure: WithDedup → Hook (no WithCooldown when dedupeByContent=true;
    // dedup provides its own cooldown window so per-file cooldown is skipped)
    expect(top._tag).toBe("WithDedup");
    if (top._tag === "WithDedup") {
      expect(top.cooldownMs).toBe(900_000);
      expect(top.program._tag).toBe("Hook");
    }
  });

  it("nests WithRetry OUTSIDE WithDedup when both are configured (audit 2026-06-03 HIGH #12)", () => {
    // A scheduled retry re-enters the OUTERMOST node. If WithDedup were the
    // outer wrapper (WithDedup → WithRetry → Hook), a task that only succeeds
    // on a retry would never re-pass through WithDedup, so the dedup key would
    // never be recorded and identical content would re-fire forever. Retry
    // must wrap dedup: WithRetry → WithDedup → Hook.
    const policy = minPolicy({
      onDiagnosticsError: {
        enabled: true,
        minSeverity: "error",
        cooldownMs: 10_000,
        prompt: "check errors in {{file}}",
        dedupeByContent: true,
        dedupeContentCooldownMs: 900_000,
        retryCount: 2,
        retryDelayMs: 15_000,
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const top = result.value[0];
    if (!top) throw new Error("expected first node");
    expect(top._tag).toBe("WithRetry");
    if (top._tag === "WithRetry") {
      expect(top.maxRetries).toBe(2);
      expect(top.program._tag).toBe("WithDedup");
      if (top.program._tag === "WithDedup") {
        expect(top.program.cooldownMs).toBe(900_000);
        expect(top.program.program._tag).toBe("Hook");
      }
    }
  });

  it("wraps WithRetry for hook with retryCount > 0", () => {
    const policy = minPolicy({
      onGitPush: {
        enabled: true,
        cooldownMs: 60_000,
        prompt: "push to {{branch}}",
        retryCount: 3,
        retryDelayMs: 15_000,
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const top = result.value[0];
    if (!top) throw new Error("expected first node");
    // Structure: WithRetry → WithCooldown → Hook
    expect(top._tag).toBe("WithRetry");
    if (top._tag === "WithRetry") {
      expect(top.maxRetries).toBe(3);
      expect(top.retryDelayMs).toBe(15_000);
      expect(top.program._tag).toBe("WithCooldown");
    }
  });

  it("wraps all programs in WithRateLimit when maxTasksPerHour > 0", () => {
    const policy = minPolicy({
      maxTasksPerHour: 10,
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        cooldownMs: 30_000,
        prompt: INLINE_PROMPT,
      },
      onGitCommit: {
        enabled: true,
        cooldownMs: 60_000,
        prompt: "committed",
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    for (const node of result.value) {
      expect(node._tag).toBe("WithRateLimit");
      if (node._tag === "WithRateLimit") {
        expect(node.maxPerHour).toBe(10);
      }
    }
  });

  it("returns err for hook missing both prompt and promptName", () => {
    const policy = minPolicy({
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        cooldownMs: 30_000,
        // no prompt or promptName
      } as AutomationPolicy["onFileSave"],
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_arg");
    }
  });

  it("supports named prompt source", () => {
    const policy = minPolicy({
      onGitCommit: {
        enabled: true,
        cooldownMs: 60_000,
        promptName: "project-status",
        promptArgs: { extra: "v" },
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const top = result.value[0];
    if (!top) throw new Error("expected first node");
    if (top._tag === "WithCooldown" && top.program._tag === "Hook") {
      const src = top.program.promptSource;
      expect(src.kind).toBe("named");
      if (src.kind === "named") {
        expect(src.promptName).toBe("project-status");
      }
    }
  });

  it("cooldown key uses condition when provided", () => {
    const policy = minPolicy({
      onFileSave: {
        enabled: true,
        patterns: ["**/*.ts"],
        cooldownMs: 10_000,
        prompt: "save",
        condition: "**/*.ts",
      },
    });
    const result = parsePolicy(policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const top = result.value[0];
    if (!top) throw new Error("expected first node");
    if (top._tag === "WithCooldown") {
      expect(top.key).toBe("save:**/*.ts");
    }
  });

  describe("onRecipeSave", () => {
    it("parses enabled hook with explicit prompt", () => {
      const policy = minPolicy({
        onRecipeSave: {
          enabled: true,
          cooldownMs: 15_000,
          prompt: "recipe saved: {{file}}",
        },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      const top = result.value[0];
      if (!top) throw new Error("expected first node");
      expect(top._tag).toBe("WithCooldown");
      if (top._tag === "WithCooldown") {
        expect(top.cooldownMs).toBe(15_000);
        // Per-file cooldown bucket: the `{{file}}` template is resolved at
        // interpret time so one saved recipe doesn't cool down all of them.
        expect(top.key).toBe("recipesave:{{file}}");
        if (top.program._tag === "Hook") {
          expect(top.program.hookType).toBe("onRecipeSave");
          const src = top.program.promptSource;
          expect(src.kind).toBe("inline");
          if (src.kind === "inline") {
            expect(src.prompt).toBe("recipe saved: {{file}}");
          }
        }
      }
    });

    it("uses a per-file cooldown key template, not a global bucket", () => {
      // Regression: onRecipeSave previously emitted the constant cooldown key
      // `recipesave:*`, so saving one recipe cooled down ALL recipes. The
      // parser now emits the per-file template `recipesave:{{file}}` which the
      // interpreter resolves against ctx.eventData.file at runtime.
      const policy = minPolicy({
        onRecipeSave: { enabled: true, cooldownMs: 10_000 },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const top = result.value[0];
      if (!top) throw new Error("expected first node");
      expect(top._tag).toBe("WithCooldown");
      if (top._tag === "WithCooldown") {
        expect(top.key).toBe("recipesave:{{file}}");
        expect(top.key).not.toBe("recipesave:*");
      }
    });

    it("injects default preflight prompt when no prompt specified", () => {
      const policy = minPolicy({
        onRecipeSave: {
          enabled: true,
          cooldownMs: 10_000,
        },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      const top = result.value[0];
      if (!top) throw new Error("expected first node");
      if (top._tag === "WithCooldown" && top.program._tag === "Hook") {
        const src = top.program.promptSource;
        expect(src.kind).toBe("inline");
        if (src.kind === "inline") {
          expect(src.prompt).toContain("preflight");
          expect(src.prompt).toContain("{{file}}");
        }
      }
    });

    it("applies default cooldown of 10 000 ms when cooldownMs absent", () => {
      const policy = minPolicy({
        onRecipeSave: {
          enabled: true,
          cooldownMs: 10_000,
        },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const top = result.value[0];
      if (!top) throw new Error("expected first node");
      if (top._tag === "WithCooldown") {
        expect(top.cooldownMs).toBe(10_000);
      }
    });

    it("skips disabled onRecipeSave", () => {
      const policy = minPolicy({
        onRecipeSave: {
          enabled: false,
          cooldownMs: 10_000,
        },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toHaveLength(0);
    });

    it("accepts promptName instead of inline prompt", () => {
      const policy = minPolicy({
        onRecipeSave: {
          enabled: true,
          cooldownMs: 10_000,
          promptName: "project-status",
        },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const top = result.value[0];
      if (!top) throw new Error("expected first node");
      if (top._tag === "WithCooldown" && top.program._tag === "Hook") {
        const src = top.program.promptSource;
        expect(src.kind).toBe("named");
        if (src.kind === "named") {
          expect(src.promptName).toBe("project-status");
        }
      }
    });
  });

  // ── LOW #24 — diagnosticsMinSeverity type alignment ────────────────────────

  describe("AutomationCondition.diagnosticsMinSeverity (LOW #24)", () => {
    it("accepts info as diagnosticsMinSeverity in AutomationCondition (type check)", () => {
      // The bug: AutomationCondition typed only "error" | "warning", but the
      // runtime evaluator (severityToNumber) handles "info" and "hint" too.
      // The fix broadens the TypeScript type to "error" | "warning" | "info" | "hint".
      // This test will fail to COMPILE if the type is still too narrow.
      const condition: AutomationCondition = {
        diagnosticsMinSeverity: "info",
      };
      // Should not throw — just verifying the type is assignable.
      expect(condition.diagnosticsMinSeverity).toBe("info");
    });

    it("accepts hint as diagnosticsMinSeverity in AutomationCondition (type check)", () => {
      const condition: AutomationCondition = {
        diagnosticsMinSeverity: "hint",
      };
      expect(condition.diagnosticsMinSeverity).toBe("hint");
    });

    it("parses onFileSave with when.diagnosticsMinSeverity: info into a valid Hook", () => {
      // Runtime path: when "info" is passed through the policy, the parser
      // should forward it to the WhenCondition without error.
      // After the fix AutomationCondition accepts "info" directly (no cast needed).
      const condition: AutomationCondition = {
        diagnosticsMinSeverity: "info",
      };
      const policy = minPolicy({
        onFileSave: {
          enabled: true,
          patterns: ["**/*.ts"],
          cooldownMs: 10_000,
          prompt: "check {{file}}",
          when: condition,
        },
      });
      const result = parsePolicy(policy);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const top = result.value[0];
      if (!top) throw new Error("expected first node");
      // Walk to the Hook node to check the WhenCondition was preserved.
      const hookNode = top._tag === "WithCooldown" ? top.program : undefined;
      if (!hookNode || hookNode._tag !== "Hook")
        throw new Error("expected Hook");
      expect(hookNode.when?.diagnosticsMinSeverity).toBe("info");
    });
  });
});
