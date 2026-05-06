import { describe, expect, it } from "vitest";
import {
  changeCount,
  diffForStep,
  diffSnapshots,
  isTruncatedSnapshot,
  previewMockedReplay,
  type RegistryDiff,
  type StepWithSnapshot,
} from "@/lib/registryDiff";

// previewMockedReplay's happy-path is covered by registryDiff.smoke.test.ts;
// here we add the truncated-snapshot path and exhaustive coverage of the
// other exports.

describe("isTruncatedSnapshot", () => {
  it("matches the truncation envelope produced by captureForRunlog", () => {
    expect(
      isTruncatedSnapshot({
        "[truncated]": true,
        bytes: 16215,
        preview: "…",
      }),
    ).toBe(true);
  });

  it("requires `[truncated]` to be exactly the boolean true", () => {
    expect(isTruncatedSnapshot({ "[truncated]": "yes" })).toBe(false);
    expect(isTruncatedSnapshot({ "[truncated]": 1 })).toBe(false);
    expect(isTruncatedSnapshot({ "[truncated]": false })).toBe(false);
  });

  it("rejects null / non-objects", () => {
    expect(isTruncatedSnapshot(null)).toBe(false);
    expect(isTruncatedSnapshot(undefined)).toBe(false);
    expect(isTruncatedSnapshot("[truncated]")).toBe(false);
    expect(isTruncatedSnapshot(42)).toBe(false);
  });

  it("rejects plain objects without the marker key", () => {
    expect(isTruncatedSnapshot({ bytes: 100 })).toBe(false);
    expect(isTruncatedSnapshot({})).toBe(false);
  });
});

describe("previewMockedReplay — truncated path", () => {
  it("flags truncated outputs as unmocked with reason 'truncated'", () => {
    const out = previewMockedReplay([
      {
        id: "s1",
        status: "ok",
        tool: "github.listIssues",
        output: { "[truncated]": true, bytes: 16000, preview: "…" },
      },
    ]);
    expect(out.mocked).toEqual([]);
    expect(out.unmocked).toEqual([
      { id: "s1", tool: "github.listIssues", reason: "truncated" },
    ]);
  });

  it("omits tool field on unmocked entries when step has no tool", () => {
    // The implementation uses `...(s.tool !== undefined && {tool})` — keep
    // that behavior pinned: no `tool: undefined` leaks into the JSON.
    const out = previewMockedReplay([{ id: "s1", status: "ok" }]);
    expect(out.unmocked[0]).toEqual({ id: "s1", reason: "no-capture" });
    expect(out.unmocked[0]).not.toHaveProperty("tool");
  });

  it("classifies error steps the same way as ok steps", () => {
    // Error steps still need the mock pre-flight — only `skipped` is exempt.
    const out = previewMockedReplay([
      { id: "s1", status: "error", output: { e: "boom" } },
    ]);
    expect(out.mocked).toEqual(["s1"]);
  });
});

describe("diffSnapshots", () => {
  it("treats every key in current as added when prev is undefined", () => {
    expect(diffSnapshots(undefined, { a: 1, b: 2 })).toEqual({
      added: { a: 1, b: 2 },
      modified: [],
      removed: [],
    });
  });

  it("returns the EMPTY shape when current is undefined", () => {
    // `current === undefined` is the only case where prev's keys aren't
    // reported as removed — pinned because callers depend on it.
    expect(diffSnapshots({ a: 1 }, undefined)).toEqual({
      added: {},
      modified: [],
      removed: [],
    });
  });

  it("classifies present-but-different keys as modified", () => {
    expect(diffSnapshots({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({
      added: {},
      modified: [{ key: "b", before: 2, after: 3 }],
      removed: [],
    });
  });

  it("classifies missing-from-current keys as removed", () => {
    expect(diffSnapshots({ a: 1, b: 2 }, { a: 1 })).toEqual({
      added: {},
      modified: [],
      removed: ["b"],
    });
  });

  it("classifies new keys as added", () => {
    expect(diffSnapshots({ a: 1 }, { a: 1, c: 3 })).toEqual({
      added: { c: 3 },
      modified: [],
      removed: [],
    });
  });

  it("handles all three buckets in the same diff", () => {
    expect(
      diffSnapshots(
        { keep: 1, change: 2, drop: 3 },
        { keep: 1, change: 99, add: 4 },
      ),
    ).toEqual({
      added: { add: 4 },
      modified: [{ key: "change", before: 2, after: 99 }],
      removed: ["drop"],
    });
  });

  it("uses deep equality for nested objects (no false-positive 'modified')", () => {
    const prev = { obj: { a: 1, b: [1, 2, 3] } };
    const cur = { obj: { a: 1, b: [1, 2, 3] } };
    expect(diffSnapshots(prev, cur).modified).toEqual([]);
  });

  it("detects a change inside a nested array", () => {
    const prev = { obj: { b: [1, 2, 3] } };
    const cur = { obj: { b: [1, 2, 4] } };
    expect(diffSnapshots(prev, cur).modified).toEqual([
      { key: "obj", before: { b: [1, 2, 3] }, after: { b: [1, 2, 4] } },
    ]);
  });

  it("treats null vs object as a real difference (not deep-equal)", () => {
    expect(diffSnapshots({ x: null }, { x: {} }).modified).toEqual([
      { key: "x", before: null, after: {} },
    ]);
  });
});

describe("diffForStep", () => {
  it("returns { kind: 'unavailable' } when the step has no snapshot", () => {
    const steps: StepWithSnapshot[] = [{ id: "a" }];
    expect(diffForStep(steps, 0)).toEqual({ kind: "unavailable" });
  });

  it("returns { kind: 'truncated' } when this step's snapshot is the truncation envelope", () => {
    const steps: StepWithSnapshot[] = [
      {
        id: "a",
        registrySnapshot: { "[truncated]": true, bytes: 16000 },
      },
    ];
    expect(diffForStep(steps, 0)).toEqual({ kind: "truncated" });
  });

  it("returns { kind: 'truncated' } when the prior snapshot is truncated", () => {
    const steps: StepWithSnapshot[] = [
      { id: "a", registrySnapshot: { "[truncated]": true, bytes: 16000 } },
      { id: "b", registrySnapshot: { x: 1 } },
    ];
    expect(diffForStep(steps, 1)).toEqual({ kind: "truncated" });
  });

  it("walks back past steps without a snapshot to find the previous one", () => {
    const steps: StepWithSnapshot[] = [
      { id: "a", registrySnapshot: { x: 1 } },
      { id: "b" }, // no snapshot — skipped/error
      { id: "c", registrySnapshot: { x: 1, y: 2 } },
    ];
    const got = diffForStep(steps, 2);
    expect(got).toEqual({
      kind: "diff",
      diff: { added: { y: 2 }, modified: [], removed: [] },
    });
  });

  it("treats step 0 as initial state (everything is added)", () => {
    const steps: StepWithSnapshot[] = [
      { id: "a", registrySnapshot: { x: 1, y: 2 } },
    ];
    expect(diffForStep(steps, 0)).toEqual({
      kind: "diff",
      diff: { added: { x: 1, y: 2 }, modified: [], removed: [] },
    });
  });

  it("handles out-of-range index by returning unavailable", () => {
    const steps: StepWithSnapshot[] = [
      { id: "a", registrySnapshot: { x: 1 } },
    ];
    expect(diffForStep(steps, 5)).toEqual({ kind: "unavailable" });
  });
});

describe("changeCount", () => {
  it("sums added keys + modified rows + removed keys", () => {
    const diff: RegistryDiff = {
      added: { a: 1, b: 2 },
      modified: [{ key: "c", before: 3, after: 4 }],
      removed: ["d", "e"],
    };
    expect(changeCount(diff)).toBe(5);
  });

  it("returns 0 for the EMPTY shape", () => {
    expect(changeCount({ added: {}, modified: [], removed: [] })).toBe(0);
  });
});
