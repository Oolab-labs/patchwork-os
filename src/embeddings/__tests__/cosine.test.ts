import { describe, expect, it } from "vitest";
import { cosineSimilarity, topK } from "../cosine.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([0.5, 0.5], [0.5, 0.5])).toBeCloseTo(1, 10);
  });

  it("returns 1 for parallel (scaled) vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it("returns 0 on length mismatch (no throw)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([1], [1, 2, 3, 4])).toBe(0);
  });

  it("returns 0 for a zero vector (no NaN)", () => {
    const r = cosineSimilarity([0, 0, 0], [1, 2, 3]);
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });

  it("returns 0 for two zero vectors (no NaN)", () => {
    const r = cosineSimilarity([0, 0], [0, 0]);
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });

  it("returns 0 for empty vectors (no NaN)", () => {
    const r = cosineSimilarity([], []);
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });
});

describe("topK", () => {
  const score = (n: number) => n;

  it("returns exactly k items in score-descending order", () => {
    expect(topK([3, 1, 4, 1, 5, 9, 2], score, 3)).toEqual([9, 5, 4]);
  });

  it("returns all items when k exceeds the list length", () => {
    expect(topK([3, 1, 2], score, 10)).toEqual([3, 2, 1]);
  });

  it("returns [] for k <= 0", () => {
    expect(topK([1, 2, 3], score, 0)).toEqual([]);
    expect(topK([1, 2, 3], score, -5)).toEqual([]);
  });

  it("returns [] for an empty list", () => {
    expect(topK([], score, 3)).toEqual([]);
  });

  it("is stable for ties — original order preserved among equal scores", () => {
    const items = [
      { id: "a", s: 5 },
      { id: "b", s: 5 },
      { id: "c", s: 9 },
      { id: "d", s: 5 },
    ];
    const result = topK(items, (i) => i.s, 4).map((i) => i.id);
    // c first (highest), then a, b, d in original relative order.
    expect(result).toEqual(["c", "a", "b", "d"]);
  });

  it("respects k while keeping tie stability", () => {
    const items = [
      { id: "a", s: 1 },
      { id: "b", s: 1 },
      { id: "c", s: 1 },
    ];
    expect(topK(items, (i) => i.s, 2).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
