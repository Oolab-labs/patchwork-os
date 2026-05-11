import { describe, expect, it } from "vitest";
import {
  categoriseHaltReason,
  deriveHaltReasonFromError,
  haltSummaryToPrometheus,
  summariseHalts,
} from "../haltCategory.js";

describe("categoriseHaltReason", () => {
  it("maps each of the 5 yamlRunner phrases to its own category", () => {
    expect(
      categoriseHaltReason(
        'Agent step "x" returned no usable output (silent-fail: stub).',
      ),
    ).toBe("agent_silent_fail");
    expect(
      categoriseHaltReason(
        'Agent step "x" returned only narration or whitespace — no content.',
      ),
    ).toBe("agent_narration_only");
    expect(
      categoriseHaltReason('Agent step "x" threw before completing: boom'),
    ).toBe("agent_threw");
    expect(
      categoriseHaltReason(
        'Tool "git.x" in step "y" threw after 2 attempts: e',
      ),
    ).toBe("tool_threw");
    expect(
      categoriseHaltReason(
        'Tool "git.x" in step "y" reported an error: remote unreachable',
      ),
    ).toBe("tool_error");
  });

  it("recognises kill-switch-blocked writes before the generic tool_threw match", () => {
    const reason =
      'Tool "slack.postMessage" in step "post" threw: Write operation blocked by kill switch: slack.postMessage. Unset PATCHWORK_FLAG_KILL_SWITCH_WRITES or set kill-switch.writes=false to restore.';
    expect(categoriseHaltReason(reason)).toBe("kill_switch");
    expect(categoriseHaltReason("kill_switch_blocked")).toBe("kill_switch");
    expect(categoriseHaltReason("kill-switch active")).toBe("kill_switch");
  });

  it("returns 'unknown' for missing or unrecognised reasons", () => {
    expect(categoriseHaltReason(undefined)).toBe("unknown");
    expect(categoriseHaltReason("")).toBe("unknown");
    expect(categoriseHaltReason("some legacy error string")).toBe("unknown");
  });
});

describe("summariseHalts", () => {
  it("counts error-status step results by category and keeps 5 most recent", () => {
    const runs = [
      {
        seq: 3,
        stepResults: [
          {
            status: "error" as const,
            haltReason: 'Tool "a" in step "s" threw: x',
          },
          { status: "ok" as const },
        ],
      },
      {
        seq: 2,
        stepResults: [
          {
            status: "error" as const,
            haltReason:
              'Agent step "s" returned no usable output (silent-fail: r).',
          },
        ],
      },
      {
        seq: 1,
        stepResults: [
          { status: "skipped" as const },
          {
            status: "error" as const,
            haltReason: 'Tool "b" in step "t" reported an error: oops',
          },
        ],
      },
    ];
    const summary = summariseHalts(runs);
    expect(summary.total).toBe(3);
    expect(summary.byCategory).toEqual({
      tool_threw: 1,
      agent_silent_fail: 1,
      tool_error: 1,
    });
    expect(summary.recent).toHaveLength(3);
    expect(summary.recent[0]?.runSeq).toBe(3);
    expect(summary.recent[0]?.category).toBe("tool_threw");
  });

  it("ignores non-error rows and rows without haltReason", () => {
    const runs = [
      {
        seq: 1,
        stepResults: [
          { status: "error" as const }, // no haltReason
          { status: "ok" as const, haltReason: "should be ignored" },
          { status: "skipped" as const, haltReason: "ditto" },
        ],
      },
    ];
    const summary = summariseHalts(runs);
    expect(summary.total).toBe(0);
    expect(summary.byCategory).toEqual({});
    expect(summary.recent).toEqual([]);
  });

  it("counts run-level errorMessage as run_level when no per-step halts cover it", () => {
    const runs = [
      {
        seq: 4,
        status: "error" as const,
        errorMessage: "Recipe has circular dependencies",
        stepResults: [],
      },
      {
        seq: 3,
        status: "error" as const,
        errorMessage: "this should NOT be counted (step halt already covers)",
        stepResults: [
          {
            status: "error" as const,
            haltReason: 'Tool "a" in step "s" threw: x',
          },
        ],
      },
    ];
    const summary = summariseHalts(runs);
    expect(summary.total).toBe(2);
    expect(summary.byCategory).toEqual({
      tool_threw: 1,
      run_level: 1,
    });
    expect(summary.recent.find((r) => r.category === "run_level")?.runSeq).toBe(
      4,
    );
  });
});

describe("deriveHaltReasonFromError", () => {
  it("returns undefined for non-error or missing error", () => {
    expect(
      deriveHaltReasonFromError({ stepId: "s", status: "ok" }),
    ).toBeUndefined();
    expect(
      deriveHaltReasonFromError({ stepId: "s", status: "error" }),
    ).toBeUndefined();
  });

  it("derives silent-fail / narration / agent-threw / tool-error in that order", () => {
    expect(
      deriveHaltReasonFromError({
        stepId: "s",
        status: "error",
        error: "silent-fail detected: (...)",
      }),
    ).toMatch(/silent-fail/);
    expect(
      deriveHaltReasonFromError({
        stepId: "s",
        status: "error",
        error: "only narration here",
      }),
    ).toMatch(/narration/);
    expect(
      deriveHaltReasonFromError({
        stepId: "s",
        isAgent: true,
        status: "error",
        error: "kaboom",
      }),
    ).toMatch(/Agent step .* threw/);
    expect(
      deriveHaltReasonFromError({
        stepId: "s",
        toolName: "git.x",
        status: "error",
        error: "remote unreachable",
      }),
    ).toMatch(/Tool "git\.x" .* reported an error/);
  });

  it("output round-trips through categoriseHaltReason to the expected category", () => {
    const r = deriveHaltReasonFromError({
      stepId: "s",
      isAgent: true,
      status: "error",
      error: "kaboom",
    });
    expect(r).toBeDefined();
    expect(categoriseHaltReason(r)).toBe("agent_threw");
  });
});

describe("haltSummaryToPrometheus", () => {
  it("returns empty array for an empty summary (no orphan HELP/TYPE)", () => {
    expect(
      haltSummaryToPrometheus({ total: 0, byCategory: {}, recent: [] }),
    ).toEqual([]);
  });

  it("emits HELP + TYPE + one line per category", () => {
    const lines = haltSummaryToPrometheus({
      total: 5,
      byCategory: { tool_threw: 3, kill_switch: 1, agent_silent_fail: 1 },
      recent: [],
    });
    expect(lines).toContain(
      "# HELP bridge_recipe_halts Recipe halts in the in-memory run-log window, by category",
    );
    expect(lines).toContain("# TYPE bridge_recipe_halts gauge");
    expect(lines).toContain('bridge_recipe_halts{category="tool_threw"} 3');
    expect(lines).toContain('bridge_recipe_halts{category="kill_switch"} 1');
    expect(lines).toContain(
      'bridge_recipe_halts{category="agent_silent_fail"} 1',
    );
    // 2 meta lines + 3 sample lines
    expect(lines).toHaveLength(5);
  });

  it("produces lines that parse as well-formed Prometheus text-exposition", () => {
    const lines = haltSummaryToPrometheus({
      total: 1,
      byCategory: { unknown: 1 },
      recent: [],
    });
    const sampleLines = lines.filter((l) => !l.startsWith("#"));
    expect(sampleLines).toHaveLength(1);
    // Match `metric{labels} value` per Prometheus exposition format.
    expect(sampleLines[0]).toMatch(/^[a-z_][a-z0-9_]*\{[a-z_]+="[^"]+"\} \d+$/);
  });
});
