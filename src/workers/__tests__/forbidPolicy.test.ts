/**
 * Forbidden-action policy (ADR-0017).
 *
 * The two properties that matter: an unconfigured workspace forbids nothing
 * (so this is entirely opt-in), and a malformed rule is never silently dropped
 * (because unlike the roster, a deny-list's silent failure is fail-OPEN).
 */
import { describe, expect, it } from "vitest";

import { classifyActionClass } from "../actionClass.js";
import {
  describeForbidRules,
  type ForbidRule,
  isForbidden,
  parseForbidRule,
  parseForbidRules,
} from "../forbidPolicy.js";

const push = classifyActionClass("gitPush");
const read = classifyActionClass("getDiagnostics");

describe("isForbidden", () => {
  it("forbids nothing when no rules are configured", () => {
    // Opt-in: a workspace that has configured no policy behaves exactly as it
    // did before this existed.
    expect(isForbidden(push, [])).toEqual({ forbidden: false });
    expect(isForbidden(read, [])).toEqual({ forbidden: false });
  });

  it("matches by domain", () => {
    const rules: ForbidRule[] = [
      { match: push.domain, reason: "we never push from a worker" },
    ];
    const v = isForbidden(push, rules);
    expect(v.forbidden).toBe(true);
    expect(v.reason).toBe("we never push from a worker");
    expect(v.matchedBy).toBe(push.domain);
  });

  it("matches by exact class key", () => {
    const rules: ForbidRule[] = [{ match: push.key, reason: "exactly this" }];
    expect(isForbidden(push, rules).forbidden).toBe(true);
  });

  it("matches by prefix", () => {
    // Mirrors ownsAction so operators learn one pattern language.
    const prefix = push.key.split(":")[0] as string;
    expect(
      isForbidden(push, [{ match: prefix, reason: "prefix" }]).forbidden,
    ).toBe(true);
  });

  it("does not match an unrelated action", () => {
    expect(
      isForbidden(read, [{ match: push.key, reason: "no" }]).forbidden,
    ).toBe(false);
  });

  it("does not match a partial segment", () => {
    // `vcs-rem` must not match `vcs-remote:...` — otherwise a typo silently
    // widens a deny rule to cover actions its author never named.
    const truncated = push.domain.slice(0, Math.max(1, push.domain.length - 2));
    const v = isForbidden(push, [{ match: truncated, reason: "typo" }]);
    expect(v.forbidden).toBe(false);
  });

  it("reports the FIRST matching rule, so the reason is the one written first", () => {
    const v = isForbidden(push, [
      { match: push.domain, reason: "first" },
      { match: push.key, reason: "second" },
    ]);
    expect(v.reason).toBe("first");
  });
});

describe("parseForbidRule", () => {
  it("requires both match and reason", () => {
    expect(parseForbidRule({ match: "vcs-remote", reason: "because" })).toEqual(
      {
        match: "vcs-remote",
        reason: "because",
      },
    );
    // A refusal with no reason is unusable in a receipt.
    expect(parseForbidRule({ match: "vcs-remote" })).toBeNull();
    expect(parseForbidRule({ reason: "because" })).toBeNull();
    expect(parseForbidRule({ match: "  ", reason: "because" })).toBeNull();
    expect(parseForbidRule({ match: "vcs-remote", reason: "   " })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseForbidRule(null)).toBeNull();
    expect(parseForbidRule("vcs-remote")).toBeNull();
  });

  it("trims both fields", () => {
    expect(parseForbidRule({ match: " a ", reason: " b " })).toEqual({
      match: "a",
      reason: "b",
    });
  });
});

describe("parseForbidRules — a deny list must never fail silently", () => {
  it("keeps valid rules and REPORTS the invalid ones by position", () => {
    // The asymmetry with the roster: dropping a malformed forbid rule quietly
    // fails OPEN — the banned action becomes merely gated, and a human can
    // then approve it.
    const parsed = parseForbidRules([
      { match: "vcs-remote", reason: "ok" },
      { match: "no-reason-given" },
      { match: "shell", reason: "ok too" },
    ]);
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.invalid).toEqual([1]);
  });

  it("treats a non-array as no rules at all", () => {
    expect(parseForbidRules(undefined)).toEqual({ rules: [], invalid: [] });
    expect(parseForbidRules({ match: "x", reason: "y" })).toEqual({
      rules: [],
      invalid: [],
    });
  });
});

describe("describeForbidRules", () => {
  it("says plainly when nothing is configured", () => {
    expect(describeForbidRules({ rules: [], invalid: [] })).toBe(
      "no forbidden-action rules configured",
    );
  });

  it("counts loaded rules", () => {
    expect(
      describeForbidRules({
        rules: [{ match: "a", reason: "b" }],
        invalid: [],
      }),
    ).toBe("1 forbidden-action rule loaded");
  });

  it("WARNS about unparsed rules and names their positions", () => {
    const out = describeForbidRules({
      rules: [{ match: "a", reason: "b" }],
      invalid: [2, 5],
    });
    expect(out).toContain("WARNING");
    expect(out).toContain("NOT in force");
    expect(out).toContain("2, 5");
  });
});
