/**
 * A category list that cannot be read must not quietly become "no
 * categories" (audit M13, 2026-10-15).
 *
 * Both sides used `Array.isArray(x) ? x.filter(isString) : undefined`. A
 * destination's `forbiddenCategories: "health"` (a string, not a list) was
 * therefore ignored, and a step carrying `health` was ALLOWED to the very
 * destination the operator meant to keep it from. A step's own malformed
 * `categories` was dropped the same way. And matching was case-sensitive:
 * `Health` slipped past a `health` forbid.
 *
 * Once a boundary is opted into, it fails CLOSED (ADR-0021): an unreadable
 * destination is reported invalid and not used; an unreadable step policy is
 * refused.
 */

import { describe, expect, it } from "vitest";
import {
  type DataPolicy,
  type Destination,
  decideBoundary,
  parseDataPolicy,
} from "../dataPolicy.js";
import { parseRegistry } from "../destinationRegistry.js";

const dest = (forbidden: string[]): Destination => ({
  id: "remote-model",
  type: "remote",
  classifications: ["public", "internal"],
  forbiddenCategories: forbidden,
});

describe("step data_policy categories", () => {
  it.each([
    ["a bare string", "health"],
    ["a list with a non-string", ["health", 3]],
    ["an object", { health: true }],
  ])("refuses %s rather than dropping it", (_why, categories) => {
    expect(
      parseDataPolicy({ classification: "internal", categories }),
    ).toBeNull();
  });

  it("still accepts a well-formed list and an absent one", () => {
    expect(
      parseDataPolicy({ classification: "internal", categories: ["health"] }),
    ).toEqual({ classification: "internal", categories: ["health"] });
    expect(parseDataPolicy({ classification: "internal" })).toEqual({
      classification: "internal",
    });
  });
});

describe("destination forbiddenCategories", () => {
  it.each([
    ["a bare string", "health"],
    ["a list with a non-string", ["health", 3]],
  ])("reports %s as an invalid destination instead of ignoring the forbid", (_why, forbiddenCategories) => {
    const reg = parseRegistry({
      destinations: {
        "remote-model": {
          type: "remote",
          classifications: ["internal"],
          forbiddenCategories,
        },
      },
    } as never);
    expect(reg.destinations.map((d) => d.id)).not.toContain("remote-model");
    expect(reg.invalid.map((i) => i.id)).toContain("remote-model");
  });
});

describe("category matching ignores case and surrounding space", () => {
  it.each([
    [["Health"], ["health"]],
    [["health"], ["HEALTH "]],
  ])("a step carrying %j does not reach a destination forbidding %j", (carried, forbidden) => {
    const policy: DataPolicy = {
      classification: "internal",
      categories: carried,
    };
    expect(decideBoundary(policy, dest(forbidden)).decision).not.toBe("ALLOW");
  });
});
