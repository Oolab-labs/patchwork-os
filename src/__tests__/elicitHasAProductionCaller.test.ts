/**
 * `McpTransport.elicit()` carries a doc comment that makes a claim about its own
 * call sites. That claim has been wrong before, and expensively.
 *
 * #1218 wrote "NO IN-REPO CALLER — deliberate, do not clean up", audited with a
 * `git grep`. #1223 added the first caller eight days later and did not update
 * the note. A roadmap survey on 2026-08-23 then read the stale note, concluded
 * the path was dead and that #1217 was scheduled work pointed at nothing, and
 * ranked the item on that basis — while #1217 had in fact been CLOSED by #1223
 * three weeks earlier.
 *
 * A comment that instructs the reader ("do not clean this up, it is unused") is
 * load-bearing, so its factual half gets a gate. This fails in BOTH directions:
 * if the caller is removed, or if the comment reverts to claiming there is none.
 *
 * It reads source because the claim IS about source. There is no runtime
 * behaviour that distinguishes "has a caller" from "documented as having one".
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("elicit() and the comment that describes its callers", () => {
  it("still has its production caller, on a live branch", () => {
    // `elicitMissingVars` is reached from recipeOrchestration when a manual run
    // would otherwise halt on a missing required var.
    expect(read("recipes/elicitMissingVars.ts")).toContain("elicit(");
    const orch = read("recipeOrchestration.ts");
    expect(orch).toContain("elicitMissingVars(");

    // Pin the GUARD EXPRESSION, not merely the identifier. An earlier draft of
    // this test asserted only that the string `server.elicitFn` appeared
    // somewhere in the file — which stayed true when the branch condition was
    // replaced with `false`, leaving the call present and permanently dead. A
    // test that survives its own subject being disabled is worse than none.
    expect(orch).toMatch(
      /if\s*\(\s*missingDeclarations\.length\s*>\s*0\s*&&\s*server\.elicitFn\s*\)/,
    );
  });

  it("the transport comment does not claim the path is unused", () => {
    // The exact wording that went stale. If it ever comes back, so has the bug.
    const t = read("transport.ts");
    expect(t).not.toContain("NO IN-REPO CALLER");
    expect(t).toContain("HAS A CALLER");
  });

  it("the bridge still wires elicitFn to the transport", () => {
    // The middle link. Without it the caller above is unreachable at runtime
    // and the comment would be true again by accident.
    expect(read("bridge.ts")).toContain("transport.elicit(");
  });
});
