/**
 * Regression: the /runs list rendered duplicate React keys
 * (`Encountered two children with the same key, yaml:...-10707`),
 * spamming ~72 console errors per page load and risking dropped /
 * duplicated rows + inflated stat counts.
 *
 * Root cause: the bridge /runs response can include the same logical run
 * twice (5s poll racing the SSE-triggered reload, or an upstream
 * duplicate). The row key is `${taskId}-${seq}`, so the collision is
 * fatal to React reconciliation. taskId embeds a timestamp and seq is a
 * monotonic counter, so an identical (taskId, seq) pair is the same run
 * — safe to collapse to the first occurrence.
 */

import { describe, expect, it } from "vitest";
import { dedupeRunsByKey } from "../dedupeRuns";

describe("dedupeRunsByKey", () => {
  it("collapses an exact (taskId, seq) duplicate, keeping the first", () => {
    const out = dedupeRunsByKey([
      { taskId: "yaml:x:1782122400171", seq: 10707, status: "done" },
      { taskId: "yaml:x:1782122400171", seq: 10707, status: "error" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("done");
  });

  it("keeps distinct seqs that share a taskId", () => {
    const out = dedupeRunsByKey([
      { taskId: "t", seq: 1 },
      { taskId: "t", seq: 2 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps distinct taskIds that share a seq", () => {
    const out = dedupeRunsByKey([
      { taskId: "a", seq: 5 },
      { taskId: "b", seq: 5 },
    ]);
    expect(out).toHaveLength(2);
  });

  it("preserves original order", () => {
    const out = dedupeRunsByKey([
      { taskId: "a", seq: 1 },
      { taskId: "b", seq: 1 },
      { taskId: "a", seq: 1 },
      { taskId: "c", seq: 1 },
    ]);
    expect(out.map((r) => r.taskId)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty list", () => {
    expect(dedupeRunsByKey([])).toEqual([]);
  });
});
