/**
 * Unit tests for the approval identity: the digest that binds a human's
 * approval to the exact action that later runs.
 *
 * Added after a mutation run (Stryker, 2026-11-14) showed most of this module
 * could be broken without a test failing. Two of those were permissive: the
 * recipe name and correlation id could stop contributing to the identity, so
 * an approval granted for one run would also match another.
 */

import { describe, expect, it } from "vitest";
import {
  type ApprovedActionFacts,
  approvalIdentityDigestsMatch,
  approvalIdentityMatches,
  computeApprovedActionIdentity,
  isActionIdentityDigest,
} from "../approvalIdentity.js";

const base: ApprovedActionFacts = {
  toolName: "file.write",
  params: { path: "out.txt", content: "hello" },
  sessionId: "s-1",
  tier: "high",
  correlationId: "run-1",
  recipeName: "example-recipe",
};
const id = (f: Partial<ApprovedActionFacts> = {}) =>
  computeApprovedActionIdentity({ ...base, ...f });

describe("computeApprovedActionIdentity", () => {
  it("is a 64-character lowercase hex digest and is stable", () => {
    expect(id()).toMatch(/^[a-f0-9]{64}$/);
    expect(id()).toBe(id());
  });

  it("changes when any consequential fact changes", () => {
    const changed: Partial<ApprovedActionFacts>[] = [
      { toolName: "file.append" },
      { params: { path: "other.txt", content: "hello" } },
      { sessionId: "s-2" },
      { tier: "medium" },
      { correlationId: "run-2" },
      { recipeName: "other-recipe" },
    ];
    const ids = new Set([id(), ...changed.map((c) => id(c))]);
    expect(ids.size).toBe(changed.length + 1);
  });

  it("an approval for one run or recipe does not match another", () => {
    const granted = id();
    expect(
      approvalIdentityMatches(granted, { ...base, correlationId: "run-2" }),
    ).toBe(false);
    expect(
      approvalIdentityMatches(granted, { ...base, recipeName: "other-recipe" }),
    ).toBe(false);
    expect(approvalIdentityMatches(granted, base)).toBe(true);
  });

  it("treats an absent optional fact as empty, consistently", () => {
    const { sessionId: _s, correlationId: _c, recipeName: _r, ...rest } = base;
    const bare = computeApprovedActionIdentity(rest);
    expect(bare).toBe(
      computeApprovedActionIdentity({
        ...rest,
        sessionId: null,
        correlationId: "",
        recipeName: "",
      }),
    );
    expect(bare).not.toBe(id());
  });

  it("does not depend on the order params keys were written in", () => {
    expect(id({ params: { b: 2, a: { y: 1, x: [3, 4] } } })).toBe(
      id({ params: { a: { x: [3, 4], y: 1 }, b: 2 } }),
    );
  });

  it("distinguishes values that a careless serialiser would collide", () => {
    const pairs: Array<[unknown, unknown]> = [
      [["a"], { "0": "a" }], // array vs object with index keys
      [[1, 2], [12]], // element separator
      [{ a: "1", b: "2" }, { a: "1,b:2" }], // field separator
      [null, "null"],
      [undefined, null],
      [undefined, "undefined"],
      [1, "1"],
      [true, "true"],
      [[], {}],
      [
        [[1], 2],
        [1, [2]],
      ],
    ];
    for (const [x, y] of pairs) {
      expect(
        id({ params: { v: x } }),
        `${JSON.stringify(x)} vs ${JSON.stringify(y)}`,
      ).not.toBe(id({ params: { v: y } }));
    }
  });

  it("nested params count: a change deep inside still changes the identity", () => {
    expect(id({ params: { a: { b: { c: [1, { d: "x" }] } } } })).not.toBe(
      id({ params: { a: { b: { c: [1, { d: "y" }] } } } }),
    );
  });
});

describe("isActionIdentityDigest", () => {
  it("accepts exactly 64 lowercase hex characters and nothing else", () => {
    const good = "a".repeat(64);
    expect(isActionIdentityDigest(good)).toBe(true);
    for (const bad of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      `x${"a".repeat(64)}`,
      `${"a".repeat(64)}x`,
      `g${"a".repeat(63)}`,
      "",
      64,
      null,
      undefined,
      { length: 64 },
    ]) {
      expect(isActionIdentityDigest(bad), String(bad)).toBe(false);
    }
  });
});

describe("approvalIdentityDigestsMatch", () => {
  const d = id();
  it("matches only identical well-formed digests", () => {
    expect(approvalIdentityDigestsMatch(d, d)).toBe(true);
    expect(approvalIdentityDigestsMatch(d, id({ tier: "low" }))).toBe(false);
  });

  it("refuses — and does not throw — when either side is malformed", () => {
    for (const bad of ["", "zz", `${d}00`, `zz${d}`, d.toUpperCase()]) {
      expect(() => approvalIdentityDigestsMatch(bad, d)).not.toThrow();
      expect(approvalIdentityDigestsMatch(bad, d)).toBe(false);
      expect(approvalIdentityDigestsMatch(d, bad)).toBe(false);
    }
  });
});

describe("approvalIdentityMatches", () => {
  it("refuses — and does not throw — a malformed expected identity", () => {
    const d = id();
    for (const bad of ["", "zz", `${d}00`, `zz${d}`, `${d.slice(0, 62)}zz`]) {
      expect(() => approvalIdentityMatches(bad, base)).not.toThrow();
      expect(approvalIdentityMatches(bad, base)).toBe(false);
    }
  });
});
