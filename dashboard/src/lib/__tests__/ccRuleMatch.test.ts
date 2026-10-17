/**
 * The approval card's Claude Code rule badge (audit M28). Any `Tool(...)`
 * rule used to count as a match for EVERY call to that tool, so
 * `allow: Bash(npm test:*)` rendered "CC: allow" on `Bash(rm -rf …)`.
 */
import { describe, expect, it } from "vitest";
import { matchCcRule } from "@/lib/ccRuleMatch";

const rules = (r: Partial<{ allow: string[]; ask: string[]; deny: string[] }>) => ({
  allow: r.allow ?? [],
  ask: r.ask ?? [],
  deny: r.deny ?? [],
});

describe("matchCcRule", () => {
  it("a bare tool rule covers every call", () => {
    expect(matchCcRule("Bash", rules({ allow: ["Bash"] }))).toEqual({ kind: "allow", scoped: false });
  });
  it("a scoped rule is reported as scoped, never as covering this call", () => {
    expect(matchCcRule("Bash", rules({ allow: ["Bash(npm test:*)"] }))).toEqual({ kind: "allow", scoped: true });
  });
  it("a whole-tool rule outranks a scoped one", () => {
    expect(matchCcRule("Bash", rules({ allow: ["Bash"], deny: ["Bash(rm:*)"] }))).toEqual({ kind: "allow", scoped: false });
  });
  it("among whole-tool rules deny > ask > allow", () => {
    expect(matchCcRule("Bash", rules({ allow: ["Bash"], deny: ["Bash"] }))).toEqual({ kind: "deny", scoped: false });
  });
  it("no rule ⇒ null; null rules ⇒ null", () => {
    expect(matchCcRule("Bash", rules({ allow: ["Read"] }))).toBeNull();
    expect(matchCcRule("Bash", null)).toBeNull();
  });
});
