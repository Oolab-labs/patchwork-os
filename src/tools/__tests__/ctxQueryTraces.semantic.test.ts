import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionTraceLog } from "../../decisionTraceLog.js";
import {
  type CtxQueryTracesDeps,
  createCtxQueryTracesTool,
} from "../ctxQueryTraces.js";

let dir: string;
let decisionTraceLog: DecisionTraceLog;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "ctx-query-semantic-"));
  now = 1_000_000;
  decisionTraceLog = new DecisionTraceLog({ dir, now: () => now });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0]?.text ?? "{}");
}

/**
 * Deterministic, no-network embedder. Maps text → a 2-D vector by keyword so
 * cosine ordering is predictable without an ML model:
 *   - query + "rocket"-flavored traces → near [1, 0]  (highest similarity)
 *   - "banana"/"fruit" → [0.7, 0.7]  (moderate; above the 0.25 floor)
 *   - "widget"/"unrelated" → [0.05, 1]  (near-orthogonal; below the floor)
 *   - anything else → a small off-axis vector
 *
 * Query vec ≈ [1, 0.05]:
 *   rocket  → cosine ≈ 1.00   (ranked first)
 *   banana  → cosine ≈ 0.74   (above floor, ranked below rocket)
 *   widget  → cosine ≈ 0.08   (below floor → dropped)
 */
function vectorFor(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes("rocket") || t.includes("propuls") || t.includes("thrust")) {
    return [1, 0.05];
  }
  if (t.includes("widget") || t.includes("unrelated")) {
    return [0.05, 1];
  }
  if (t.includes("banana") || t.includes("fruit")) {
    return [0.7, 0.7];
  }
  return [0.2, 0.9];
}

function fakeEmbedFn(texts: string[]): Promise<number[][] | null> {
  return Promise.resolve(texts.map(vectorFor));
}

function seedTwoDecisions() {
  // Older trace: semantically related to the "spacecraft" query but
  // lexically different (no shared substring with the query).
  now = 1_000_000;
  decisionTraceLog.record({
    ref: "ROCKET-1",
    problem: "thrust loss during launch",
    solution: "rebalanced propulsion mixture",
    workspace: "/ws",
    tags: ["rocket"],
  });
  // Newer trace: lexically unrelated (banana) — must NOT outrank the
  // related-but-older one under semantic ranking.
  now = 2_000_000;
  decisionTraceLog.record({
    ref: "FRUIT-9",
    problem: "banana ripeness tracking",
    solution: "added fruit shelf-life chart",
    workspace: "/ws",
    tags: ["banana"],
  });
}

describe("ctxQueryTraces semantic ranking", () => {
  it("ranks semantically-related-but-lexically-different above recency-newer unrelated", async () => {
    seedTwoDecisions();
    const embedFn = vi.fn(fakeEmbedFn);
    const deps: CtxQueryTracesDeps = { decisionTraceLog, embedFn };
    const tool = createCtxQueryTracesTool(deps);

    // q has no substring overlap with the rocket trace fields.
    const res = parse(
      await tool.handler({ q: "rocket spacecraft", semantic: true }),
    );

    expect(res.count).toBe(2);
    // Rocket trace ranks first by cosine score despite being OLDER.
    expect(res.traces[0].ref ?? res.traces[0].body.ref).toBe("ROCKET-1");
    expect(res.traces[1].body.ref).toBe("FRUIT-9");
    // embedFn called (query once + traces once, or batched).
    expect(embedFn).toHaveBeenCalled();
  });

  it("falls back to substring path when embedFn returns null (unconfigured)", async () => {
    seedTwoDecisions();
    const nullEmbedFn = vi.fn(
      (_texts: string[]): Promise<number[][] | null> => Promise.resolve(null),
    );

    const semanticDeps: CtxQueryTracesDeps = {
      decisionTraceLog,
      embedFn: nullEmbedFn,
    };
    const substringDeps: CtxQueryTracesDeps = { decisionTraceLog };

    // Query that DOES substring-match the banana trace so the fallback
    // path produces a deterministic, non-empty result.
    const semantic = parse(
      await createCtxQueryTracesTool(semanticDeps).handler({
        q: "banana",
        semantic: true,
      }),
    );
    const substring = parse(
      await createCtxQueryTracesTool(substringDeps).handler({ q: "banana" }),
    );

    expect(nullEmbedFn).toHaveBeenCalled();
    expect(semantic.count).toBe(substring.count);
    expect(semantic.traces.map((t: { key: string }) => t.key)).toEqual(
      substring.traces.map((t: { key: string }) => t.key),
    );
  });

  it("does NOT call embedFn when semantic is false / omitted", async () => {
    seedTwoDecisions();
    const embedFn = vi.fn(fakeEmbedFn);
    const tool = createCtxQueryTracesTool({ decisionTraceLog, embedFn });

    const omitted = parse(await tool.handler({ q: "banana" }));
    const explicitFalse = parse(
      await tool.handler({ q: "banana", semantic: false }),
    );

    expect(embedFn).not.toHaveBeenCalled();
    // Substring path: only the banana trace matches "banana".
    expect(omitted.count).toBe(1);
    expect(explicitFalse.count).toBe(1);
    expect(omitted.traces[0].body.ref).toBe("FRUIT-9");
  });

  it("does NOT semantic-rank when semantic:true but q is absent", async () => {
    seedTwoDecisions();
    const embedFn = vi.fn(fakeEmbedFn);
    const tool = createCtxQueryTracesTool({ decisionTraceLog, embedFn });

    const res = parse(await tool.handler({ semantic: true }));

    // No q → no semantic ranking. embedFn never called; recency order.
    expect(embedFn).not.toHaveBeenCalled();
    expect(res.count).toBe(2);
    // Default recency sort: newest (banana) first.
    expect(res.traces[0].body.ref).toBe("FRUIT-9");
    expect(res.traces[1].body.ref).toBe("ROCKET-1");
  });

  it("filters out below-floor semantic scores", async () => {
    // One related trace, one wholly-unrelated trace whose vector is
    // near-orthogonal to the query (score below SEMANTIC_FLOOR).
    now = 1_000_000;
    decisionTraceLog.record({
      ref: "ROCKET-1",
      problem: "thrust loss during launch",
      solution: "rebalanced propulsion mixture",
      workspace: "/ws",
      tags: ["rocket"],
    });
    now = 2_000_000;
    decisionTraceLog.record({
      ref: "WIDGET-9",
      problem: "widget alignment unrelated drift",
      solution: "unrelated knob recalibration",
      workspace: "/ws",
      tags: ["widget"],
    });

    const embedFn = vi.fn(fakeEmbedFn);
    const tool = createCtxQueryTracesTool({ decisionTraceLog, embedFn });

    // Query vector ≈ [1, 0.05]; widget ≈ [0.05, 1] → cosine ≈ 0.08 < floor.
    const res = parse(
      await tool.handler({ q: "rocket spacecraft", semantic: true }),
    );

    expect(res.count).toBe(1);
    expect(res.traces[0].body.ref).toBe("ROCKET-1");
  });
});
