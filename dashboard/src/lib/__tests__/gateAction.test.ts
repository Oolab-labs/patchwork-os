import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gateActionLabel } from "../gateAction";

/**
 * The bug this guards: `page.tsx` typed `action` as `"allow" | "gate"` and
 * rendered `isAllow ? "ALLOW" : "GATE"`, so a `forbid` row was presented to the
 * operator as a gate — with the explain line reading "vs required higher", i.e.
 * go and get more approval.
 *
 * ADR-0017: `forbid` is not a stronger gate. No approval unlocks it. Showing it
 * as one inverts the terminal state's whole purpose.
 */
describe("gateActionLabel", () => {
  it("does not present forbid as a gate", () => {
    const f = gateActionLabel("forbid");
    expect(f.verb).not.toBe("GATE");
    expect(f.verb).toBe("FORBID");
  });

  it("never tells the operator that more approval would unlock a forbid", () => {
    // The specific inversion. "higher" was the old text.
    const f = gateActionLabel("forbid");
    expect(f.requiredPhrase).not.toContain("higher");
    expect(f.requiredPhrase).toMatch(/no approval/i);
  });

  it("distinguishes the three in WORDS, not only in colour", () => {
    // ControlBoundary holds this property for the boundary screen; it must not
    // be lost here. Greyscale and colour-blind readers get the same distinction.
    const verbs = (["allow", "gate", "forbid"] as const).map(
      (a) => gateActionLabel(a).verb,
    );
    expect(new Set(verbs).size).toBe(3);
    const phrases = (["allow", "gate", "forbid"] as const).map(
      (a) => gateActionLabel(a).requiredPhrase,
    );
    expect(new Set(phrases).size).toBe(3);
  });

  it("says a gate needs a named person", () => {
    expect(gateActionLabel("gate").requiredPhrase).toMatch(/named person/i);
  });

  it("keeps allow visually distinct and marked as needing nothing", () => {
    const a = gateActionLabel("allow");
    expect(a.verb).toBe("ALLOW");
    expect(a.className).toContain("allow");
    expect(a.requiredPhrase).toContain("none");
  });

  it("treats an unrecognised action as not permitted, never as allowed", () => {
    // A future fourth terminal state must not default to looking permitted.
    const u = gateActionLabel("something_new");
    expect(u.requiredPhrase).not.toContain("allowed");
    expect(u.requiredPhrase).toMatch(/not permitted/i);
    expect(u.className).not.toContain("allow");
  });
});

/**
 * The module above is only worth having if the page actually uses it. `GateRow`
 * is not exported (page.tsx is one large client component), so there is no seam
 * to render it through without standing up the whole page — and a
 * hand-constructed render would prove the module, not the path.
 *
 * The path is the defect: the old code derived the verb inline from a boolean,
 * which is exactly what let a third action fall silently into the else-branch.
 */
describe("the page actually uses it", () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../app/page.tsx"),
    "utf8",
  );

  it("renders the verb through gateActionLabel", () => {
    expect(src).toContain("gateActionLabel(");
  });

  it("no longer derives the verb from a two-way boolean", () => {
    // `const isAllow = d.action === "allow"` then `isAllow ? "ALLOW" : "GATE"`.
    // Any third action lands in the else-branch and is mislabelled.
    expect(src).not.toMatch(/isAllow\s*\?\s*"ALLOW"\s*:\s*"GATE"/);
    expect(src).not.toContain('const isAllow =');
  });

  it("does not pin the action type to two values", () => {
    // The narrow type is what made the mislabelling invisible to tsc.
    expect(src).not.toMatch(/action:\s*"allow"\s*\|\s*"gate"\s*;/);
  });
});
