/**
 * `fan_out` must say it is alive, and a declared budget must not look enforced
 * when it is not.
 *
 * Both come from the same real run: a local-model pass over 20 documents.
 * Measured at ~11s per item, so 300 documents is an hour — during which
 * `fan_out` printed nothing at all. An hour of silence is indistinguishable
 * from a hang, and that is not a hypothetical: the run was misdiagnosed as
 * hung while it was working.
 *
 * The budget half is quieter and worse. The recipe declared `usdMax: 2.00`.
 * `RunBudget` correctly worked out that a local driver incurs no metered cost
 * and raised a notice saying the cap was not being enforced — and the CLI
 * never printed it. The report looked clean, so the cap looked real. A cap you
 * believe in and do not have is worse than no cap, because it is the one you
 * stop checking.
 */

import { describe, expect, it, vi } from "vitest";
import { formatRunReport } from "../../commands/recipe.js";
import { executeTool } from "../tools/index.js";

describe("fan_out progress", () => {
  /** Minimal deps: an agent executor that always succeeds, plus a collector. */
  function run(items: string[], agentOk = true) {
    const seen: Array<{ index: number; total: number; ok: boolean }> = [];
    const deps = {
      runNestedAgent: vi
        .fn()
        .mockResolvedValue(
          agentOk
            ? { text: "done", ok: true }
            : { text: "", ok: false, error: "model unavailable" },
        ),
      onIterationProgress: (p: { index: number; total: number; ok: boolean }) =>
        seen.push(p),
    };
    return executeTool("fan_out", {
      params: {
        items: JSON.stringify(items),
        as: "doc",
        do: { agent: { prompt: "summarise {{doc}}" } },
        on_iter_error: "continue",
      },
      step: {},
      ctx: {},
      deps: deps as never,
    }).then((out) => ({ out, seen, deps }));
  }

  it("reports after every iteration, not just at the end", async () => {
    const { seen } = await run(["a", "b", "c"]);
    expect(seen).toEqual([
      { index: 0, total: 3, ok: true },
      { index: 1, total: 3, ok: true },
      { index: 2, total: 3, ok: true },
    ]);
  });

  it("reports FAILED iterations too", async () => {
    // Reporting only successes would be worse than reporting nothing: the run
    // would appear to stall at the first failure while still working.
    const { seen } = await run(["a", "b"], false);
    expect(seen.map((s) => s.ok)).toEqual([false, false]);
    expect(seen).toHaveLength(2);
  });

  it("is a no-op when no reporter is injected", async () => {
    // Absent means silent — byte-identical to the old behaviour for any
    // caller that does not opt in.
    const out = await executeTool("fan_out", {
      params: {
        items: JSON.stringify(["a"]),
        as: "doc",
        do: { agent: { prompt: "x {{doc}}" } },
      },
      step: {},
      ctx: {},
      deps: {
        runNestedAgent: vi.fn().mockResolvedValue({ text: "t", ok: true }),
      } as never,
    });
    expect(out).toBeTruthy();
  });
});

describe("budget warnings reach the operator", () => {
  it("prints a cap that is not being enforced", () => {
    const report = formatRunReport(
      {
        stepsRun: 1,
        outputs: [],
        budgetWarnings: [
          'Driver "local" does not incur metered API cost — usdMax is not enforced for its calls.',
        ],
      } as never,
      "private-document-digest",
    );
    // Before the fix the notice existed on the result and was never printed.
    expect(report).toContain("usdMax is not enforced");
  });

  it("says nothing extra when there are no warnings", () => {
    const report = formatRunReport(
      { stepsRun: 1, outputs: [] } as never,
      "clean-recipe",
    );
    expect(report).not.toContain("⚠");
  });
});
