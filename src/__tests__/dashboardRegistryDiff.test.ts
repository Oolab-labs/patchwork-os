// VD-3: registry-diff helper for the dashboard's per-step hover panel.
// Tests live at the repo root (no separate dashboard vitest setup) — the
// helper is pure TypeScript with no Next.js-specific imports, so the
// root vitest can exercise it via a relative import.

import { describe, expect, test } from "vitest";
import {
  changeCount,
  diffForStep,
  diffSnapshots,
} from "../../dashboard/src/lib/registryDiff.js";

describe("diffSnapshots", () => {
  test("undefined current → empty diff", () => {
    expect(diffSnapshots({ a: 1 }, undefined)).toEqual({
      added: {},
      modified: [],
      removed: [],
    });
  });

  test("undefined prev → all keys added", () => {
    expect(diffSnapshots(undefined, { a: 1, b: 2 })).toEqual({
      added: { a: 1, b: 2 },
      modified: [],
      removed: [],
    });
  });

  test("new key → added", () => {
    expect(diffSnapshots({ a: 1 }, { a: 1, b: 2 })).toEqual({
      added: { b: 2 },
      modified: [],
      removed: [],
    });
  });

  test("changed value → modified", () => {
    expect(diffSnapshots({ a: 1 }, { a: 2 })).toEqual({
      added: {},
      modified: [{ key: "a", before: 1, after: 2 }],
      removed: [],
    });
  });

  test("missing key → removed", () => {
    expect(diffSnapshots({ a: 1, b: 2 }, { a: 1 })).toEqual({
      added: {},
      modified: [],
      removed: ["b"],
    });
  });

  test("deep equal nested object → not modified", () => {
    expect(
      diffSnapshots(
        { step1: { status: "success", data: { x: 1, y: ["a", "b"] } } },
        { step1: { status: "success", data: { x: 1, y: ["a", "b"] } } },
      ),
    ).toEqual({ added: {}, modified: [], removed: [] });
  });

  test("deep nested change → modified", () => {
    expect(
      diffSnapshots(
        { step1: { status: "success", data: { x: 1 } } },
        { step1: { status: "success", data: { x: 2 } } },
      ),
    ).toEqual({
      added: {},
      modified: [
        {
          key: "step1",
          before: { status: "success", data: { x: 1 } },
          after: { status: "success", data: { x: 2 } },
        },
      ],
      removed: [],
    });
  });

  test("array length difference → modified", () => {
    expect(diffSnapshots({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual({
      added: {},
      modified: [{ key: "list", before: [1, 2], after: [1, 2, 3] }],
      removed: [],
    });
  });
});

describe("diffForStep", () => {
  test("first step → all of its snapshot is added", () => {
    const steps = [{ id: "s1", registrySnapshot: { s1: { data: 1 } } }];
    expect(diffForStep(steps, 0)).toEqual({
      kind: "diff",
      diff: {
        added: { s1: { data: 1 } },
        modified: [],
        removed: [],
      },
    });
  });

  test("second step → only its own key is added (typical case)", () => {
    const steps = [
      { id: "s1", registrySnapshot: { s1: { data: 1 } } },
      { id: "s2", registrySnapshot: { s1: { data: 1 }, s2: { data: 2 } } },
    ];
    const result = diffForStep(steps, 1);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.diff).toEqual({
        added: { s2: { data: 2 } },
        modified: [],
        removed: [],
      });
    }
  });

  test("walks back past steps without snapshots", () => {
    // Middle step had no snapshot (pre-VD-2 row, or skipped step). The
    // diff for s3 should compare against s1, not s2.
    const steps = [
      { id: "s1", registrySnapshot: { s1: { data: 1 } } },
      { id: "s2" }, // no snapshot
      { id: "s3", registrySnapshot: { s1: { data: 1 }, s3: { data: 3 } } },
    ];
    const result = diffForStep(steps, 2);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.diff).toEqual({
        added: { s3: { data: 3 } },
        modified: [],
        removed: [],
      });
    }
  });

  test("step without snapshot → 'unavailable'", () => {
    const steps = [{ id: "s1" }];
    expect(diffForStep(steps, 0)).toEqual({ kind: "unavailable" });
  });

  test("respects bounds — index out of range → 'unavailable'", () => {
    const steps = [{ id: "s1", registrySnapshot: { s1: 1 } }];
    expect(diffForStep(steps, 5)).toEqual({ kind: "unavailable" });
    expect(diffForStep(steps, -1)).toEqual({ kind: "unavailable" });
  });

  // BUG-2 (post-merge dogfood): when the registry as a whole exceeds 8 KB,
  // VD-2's `captureForRunlog` returns a truncation envelope
  // (`{[truncated]:true,bytes,preview}`) for `registrySnapshot`. Diffing
  // two envelopes produces meaningless modifications like
  // `bytes 15084 → 16215`. We short-circuit to "truncated" so the panel
  // can render a clean empty state instead.

  test("truncated current snapshot → kind:'truncated'", () => {
    const steps = [
      { id: "s1", registrySnapshot: { s1: { data: 1 } } },
      {
        id: "s2",
        registrySnapshot: {
          "[truncated]": true,
          bytes: 15000,
          preview: "...",
        } as Record<string, unknown>,
      },
    ];
    expect(diffForStep(steps, 1)).toEqual({ kind: "truncated" });
  });

  test("truncated previous snapshot → kind:'truncated'", () => {
    const steps = [
      {
        id: "s1",
        registrySnapshot: {
          "[truncated]": true,
          bytes: 15000,
          preview: "...",
        } as Record<string, unknown>,
      },
      { id: "s2", registrySnapshot: { s2: { data: 2 } } },
    ];
    expect(diffForStep(steps, 1)).toEqual({ kind: "truncated" });
  });

  test("truncated first step → kind:'truncated' (no prev to compare)", () => {
    const steps = [
      {
        id: "s1",
        registrySnapshot: {
          "[truncated]": true,
          bytes: 15000,
          preview: "...",
        } as Record<string, unknown>,
      },
    ];
    expect(diffForStep(steps, 0)).toEqual({ kind: "truncated" });
  });
});

describe("changeCount", () => {
  test("counts each section", () => {
    expect(
      changeCount({
        added: { a: 1, b: 2 },
        modified: [{ key: "c", before: 1, after: 2 }],
        removed: ["d"],
      }),
    ).toBe(4);
  });

  test("zero for empty diff", () => {
    expect(changeCount({ added: {}, modified: [], removed: [] })).toBe(0);
  });
});
