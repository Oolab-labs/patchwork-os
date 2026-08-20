/**
 * #1487, second half — the automation trigger string must carry the RECIPE
 * name, not the hook type.
 *
 * `bridge.ts` emitted `automation:${opts.triggerSource}`, and `triggerSource`
 * is `program.hookType` (`automationInterpreter.ts`) — so the string was
 * `automation:onFileSave`. Every other kind carries the recipe:
 * `webhook:${match.name}`, `recipe:${name}`.
 *
 * While the run log refused to parse `automation:` at all this was harmless.
 * The moment it learned to — which is the other half of #1487 — it would have
 * filed eleven distinct recipes under a handful of names invented from hook
 * types, merging unrelated recipes into one row-family and cross-attributing
 * their trust. The run log is the autonomy gate's evidence, so that is worse
 * than recording nothing, AND it would have looked like a fix.
 *
 * WHY THIS TEST READS SOURCE. The call site is constructed inline inside
 * `Bridge`'s constructor, wired to a live `AutomationHooks` and
 * `RecipeOrchestration`; there is no seam to inject a fake through without
 * standing up a bridge. A hand-injected dependency would prove the logic and
 * not the path — and the path is the entire defect here. So this asserts the
 * wiring itself, which is crude but is the thing that actually regressed.
 * If a seam is added later, replace this with a behavioural test driving it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bridge.ts",
);

describe("#1487: automation trigger source names the recipe", () => {
  const src = readFileSync(BRIDGE, "utf8");

  it("has at least one automation trigger-source call site", () => {
    // Guards the assertion below against passing vacuously if the call sites
    // are renamed or moved — an absent pattern would otherwise "pass".
    const sites = src.match(/triggerSourceSuffix: `automation:/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
  });

  /**
   * Only the INTERPOLATED EXPRESSION, deliberately. Matching the whole line
   * catches the key `triggerSourceSuffix`, whose own name contains
   * "triggerSource" — the first version of this test failed on that and would
   * have been "fixed" by loosening the assertion into uselessness.
   */
  const interpolations = () =>
    [...src.matchAll(/triggerSourceSuffix: `automation:\$\{([^}]+)\}`/g)].map(
      (m) => m[1] ?? "",
    );

  it("uses the recipe name at every call site", () => {
    const exprs = interpolations();
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) {
      expect(e).toContain("recipeName");
    }
  });

  it("uses the hook type at none of them", () => {
    for (const e of interpolations()) {
      expect(e).not.toContain("triggerSource");
    }
  });
});
