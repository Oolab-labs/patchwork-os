import { describe, expect, it } from "vitest";
import {
  judgeSummaryToPrometheus,
  summariseJudgments,
} from "../judgeSummary.js";
import type { JudgeVerdict } from "../judgeVerdict.js";

function v(
  kind: JudgeVerdict["verdict"],
  reasons: string[] = [],
): JudgeVerdict {
  return { verdict: kind, reasons };
}

describe("summariseJudgments", () => {
  it("returns an empty summary for no runs", () => {
    expect(summariseJudgments([])).toEqual({
      total: 0,
      byVerdict: {},
      recent: [],
    });
  });

  it("ignores steps with no judgeVerdict", () => {
    const summary = summariseJudgments([
      {
        seq: 1,
        stepResults: [{ id: "build" }, { id: "test" }],
      },
    ]);
    expect(summary.total).toBe(0);
  });

  it("counts verdicts across runs and bucketises by kind", () => {
    const summary = summariseJudgments([
      {
        seq: 3,
        stepResults: [{ id: "review", judgeVerdict: v("approve", ["lgtm"]) }],
      },
      {
        seq: 2,
        stepResults: [
          {
            id: "review",
            judgeVerdict: v("request_changes", ["missing tests"]),
          },
          { id: "second_pass", judgeVerdict: v("approve") },
        ],
      },
      {
        seq: 1,
        stepResults: [{ id: "review", judgeVerdict: v("unparseable") }],
      },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.byVerdict).toEqual({
      approve: 2,
      request_changes: 1,
      unparseable: 1,
    });
  });

  it("caps recent at 5 with newest first (caller-provided order)", () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      seq: 10 - i,
      stepResults: [
        { id: "review", judgeVerdict: v("approve", [`reason ${10 - i}`]) },
      ],
    }));
    const summary = summariseJudgments(runs);
    expect(summary.recent).toHaveLength(5);
    expect(summary.recent[0]?.runSeq).toBe(10);
    expect(summary.recent[0]?.firstReason).toBe("reason 10");
    expect(summary.recent[0]?.stepId).toBe("review");
  });

  it("omits firstReason when reasons is empty", () => {
    const summary = summariseJudgments([
      {
        seq: 1,
        stepResults: [{ id: "r", judgeVerdict: v("approve", []) }],
      },
    ]);
    expect(summary.recent[0]?.firstReason).toBeUndefined();
  });
});

describe("judgeSummaryToPrometheus", () => {
  it("emits no lines on empty summary (no orphan HELP/TYPE)", () => {
    expect(
      judgeSummaryToPrometheus({ total: 0, byVerdict: {}, recent: [] }),
    ).toEqual([]);
  });

  it("emits HELP, TYPE, and one line per verdict", () => {
    const lines = judgeSummaryToPrometheus({
      total: 3,
      byVerdict: { approve: 2, request_changes: 1 },
      recent: [],
    });
    expect(lines[0]).toContain("# HELP bridge_recipe_judgments");
    expect(lines[1]).toBe("# TYPE bridge_recipe_judgments gauge");
    expect(lines).toContain('bridge_recipe_judgments{verdict="approve"} 2');
    expect(lines).toContain(
      'bridge_recipe_judgments{verdict="request_changes"} 1',
    );
  });
});
