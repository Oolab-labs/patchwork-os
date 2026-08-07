/**
 * `when:` guard evaluation — shared by both runners.
 *
 * WHY THIS EXISTS: `when: "{{title}} != DUPLICATE"` in
 * templates/recipes/butler-errand.yaml never fired. The guard was rendered to
 * a string and truthy-tested, so `"DUPLICATE != DUPLICATE"` is a non-empty
 * string ending in the token "duplicate" — truthy — and the guarded step ran
 * anyway. The recipe read as if it had a duplicate check and did not have one.
 *
 * The failure direction is what makes this worth fixing properly rather than
 * rewording one recipe: an unevaluated comparison fails OPEN. The author sees
 * a guard, the runner sees a non-empty string, and the guarded action happens
 * every time. Two of the twelve `when:` guards in shipped recipes were written
 * this way.
 *
 * So: `==` and `!=` are evaluated, anything else that looks like an expression
 * is an AUTHORING ERROR reported loudly, and bare truthy guards behave exactly
 * as before.
 */

import { describe, expect, it } from "vitest";
import { evaluateWhen, findUnsupportedOperator } from "../whenGuard.js";

/**
 * A stand-in for a real renderer: substitutes `{{...}}` and passes literal
 * text through untouched.
 *
 * The first version of this helper returned the value for ANY input, which
 * made both sides of a comparison render to the same string and reported
 * `title != DUPLICATE` as false for every title. That was the test lying, not
 * the code — worth keeping in mind, because `evaluateWhen` renders each side
 * separately and a fake that ignores its argument cannot exercise that.
 */
const renderer =
  (value: string) =>
  (s: string): string =>
    s.replace(/\{\{[^}]*\}\}/g, value);

describe("the bug: a comparison guard was truthy-tested", () => {
  it("DUPLICATE != DUPLICATE is FALSE, not truthy", () => {
    // Before the fix this returned `{ truthy: true }` — the whole defect in
    // one assertion.
    expect(
      evaluateWhen("{{title}} != DUPLICATE", renderer("DUPLICATE")),
    ).toEqual({
      kind: "ok",
      truthy: false,
    });
  });

  it("a real title != DUPLICATE is true", () => {
    expect(
      evaluateWhen(
        "{{title}} != DUPLICATE",
        renderer("Book the car in for a service"),
      ),
    ).toEqual({ kind: "ok", truthy: true });
  });
});

describe("== and != are evaluated", () => {
  const render = renderer("yes");

  it("== is true on a match", () => {
    expect(evaluateWhen("{{v}} == yes", render)).toEqual({
      kind: "ok",
      truthy: true,
    });
  });

  it("== is false on a mismatch", () => {
    expect(evaluateWhen("{{v}} == no", render)).toEqual({
      kind: "ok",
      truthy: false,
    });
  });

  it("compares case-insensitively and ignores surrounding whitespace", () => {
    // The old truthy path already lowercased, and an agent writing "Duplicate"
    // rather than "DUPLICATE" must not silently change the outcome.
    expect(evaluateWhen("  {{v}}   ==   YES  ", render)).toEqual({
      kind: "ok",
      truthy: true,
    });
  });

  it("compares an empty rendered value rather than treating it as falsy", () => {
    // `{{missing}} == ""` is a legitimate "did this come back empty" check.
    expect(evaluateWhen('{{v}} == ""', renderer(""))).toEqual({
      kind: "ok",
      truthy: true,
    });
    expect(evaluateWhen("{{v}} != ", renderer(""))).toEqual({
      kind: "ok",
      truthy: false,
    });
  });

  it("strips quotes around the literal side", () => {
    expect(evaluateWhen('{{v}} == "yes"', render)).toEqual({
      kind: "ok",
      truthy: true,
    });
    expect(evaluateWhen("{{v}} == 'yes'", render)).toEqual({
      kind: "ok",
      truthy: true,
    });
  });
});

describe("unsupported operators fail loudly, never silently", () => {
  // The whole point: an author who writes something the runner cannot evaluate
  // must be told. Quietly truthy-testing it is how the original bug shipped.
  for (const op of [">", "<", ">=", "<=", "&&", "||"]) {
    it(`reports \`${op}\` as an authoring error`, () => {
      const r = evaluateWhen(`{{a}} ${op} {{b}}`, renderer("x"));
      expect(r.kind).toBe("unsupported");
      if (r.kind === "unsupported") {
        expect(r.operator).toBe(op);
        // The message has to say what to write instead, or it just moves the
        // confusion.
        expect(r.reason).toMatch(/==|!=/);
      }
    });
  }

  it("does not mistake prose in a RENDERED value for an expression", () => {
    // This is why detection runs on the raw template, not the rendered output.
    // An agent's free-text verdict routinely contains "<" or ">" and must not
    // turn a working guard into an authoring error.
    const r = evaluateWhen("{{verdict}}", renderer("score 4 > 3 so yes: true"));
    expect(r).toEqual({ kind: "ok", truthy: true });
  });

  it("does not flag an operator inside a template expression", () => {
    // What is inside `{{ }}` belongs to the template engine, not to this
    // guard. Flagging it here would be this module overreaching.
    expect(findUnsupportedOperator("{{items.length > 0}}")).toBeNull();
  });

  it("does not flag a bare > in a literal comparison value", () => {
    expect(findUnsupportedOperator("{{arrow}} == ->")).toBeNull();
  });
});

describe("bare truthy guards are unchanged", () => {
  const cases: Array<[string, string, boolean]> = [
    ["{{phone}}", "+15551234", true],
    ["{{phone}}", "", false],
    ["{{n}}", "0", false],
    ["{{flag}}", "false", false],
    ["{{flag}}", "null", false],
    ["{{flag}}", "undefined", false],
    ["{{repo}}", "owner/name", true],
    // The last-token rule that makes an agent's free-text verdict gate on the
    // verdict rather than on "non-empty ⇒ truthy" (#1070).
    ["{{decision}}", "lots of reasoning, so: false", false],
    ["{{decision}}", "lots of reasoning, so: `true`.", true],
  ];

  for (const [tpl, rendered, expected] of cases) {
    it(`${tpl} rendering ${JSON.stringify(rendered)} is ${expected}`, () => {
      expect(evaluateWhen(tpl, renderer(rendered))).toEqual({
        kind: "ok",
        truthy: expected,
      });
    });
  }
});

describe("shipped recipes", () => {
  it("butler-errand's guard now actually gates on DUPLICATE", () => {
    const guard = "{{title}} != DUPLICATE";
    expect(evaluateWhen(guard, renderer("DUPLICATE"))).toEqual({
      kind: "ok",
      truthy: false,
    });
    expect(evaluateWhen(guard, renderer("Book the car in"))).toEqual({
      kind: "ok",
      truthy: true,
    });
  });
});
