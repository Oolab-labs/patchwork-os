/**
 * Regression: the recipe-detail header status pill must distinguish
 * "list still loading" from "recipe genuinely not installed".
 *
 * Bug: statusPillFor(recipe) returned { label: "loading" } whenever
 * `!recipe`, which is true BOTH while the recipes list is in flight AND
 * when the recipe doesn't exist. So a missing recipe showed a permanent
 * "loading" pill in the header while the page body correctly rendered
 * "Recipe not found" — the header and body disagreed forever.
 *
 * Fix: pass whether the list has resolved so a loaded-but-absent recipe
 * reads "not found", not "loading".
 */

import { describe, expect, it } from "vitest";
import { statusPillFor } from "../recipeHeaderStatus";

const enabled = { name: "demo", enabled: true };
const disabled = { name: "demo", enabled: false };
const lintBad = {
  name: "demo",
  enabled: true,
  lint: { ok: false, errorCount: 1, warningCount: 0 },
};

describe("statusPillFor (recipe-detail header)", () => {
  it("reads 'loading' only while the recipes list is still in flight", () => {
    expect(statusPillFor(undefined, false)).toEqual({
      tone: "muted",
      label: "loading",
    });
  });

  it("reads 'not found' once the list resolved but the recipe is absent", () => {
    const res = statusPillFor(undefined, true);
    expect(res.label).toBe("not found");
    expect(res.label).not.toBe("loading");
  });

  it("reads 'enabled' for an enabled recipe", () => {
    expect(statusPillFor(enabled, true)).toEqual({ tone: "ok", label: "enabled" });
  });

  it("reads 'disabled' for a disabled recipe", () => {
    expect(statusPillFor(disabled, true)).toEqual({
      tone: "muted",
      label: "disabled",
    });
  });

  it("surfaces a lint error ahead of enabled/disabled state", () => {
    expect(statusPillFor(lintBad, true)).toEqual({
      tone: "err",
      label: "lint error",
    });
  });
});
