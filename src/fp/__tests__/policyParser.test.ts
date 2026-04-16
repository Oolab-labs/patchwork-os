import { describe, expect, it } from "vitest";
import type { AutomationPolicy } from "../../automation.js";
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
    // Structure: WithDedup → Hook (no WithCooldown when dedupeByContent=true;
    // dedup provides its own cooldown window so per-file cooldown is skipped)
    expect(top._tag).toBe("WithDedup");
    if (top._tag === "WithDedup") {
      expect(top.cooldownMs).toBe(900_000);
      expect(top.program._tag).toBe("Hook");
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
    if (top._tag === "WithCooldown") {
      expect(top.key).toBe("save:**/*.ts");
    }
  });
});
