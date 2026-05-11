import { describe, expect, it } from "vitest";
import { categoriseHaltReason, summariseHalts } from "../haltCategory.js";

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
});
