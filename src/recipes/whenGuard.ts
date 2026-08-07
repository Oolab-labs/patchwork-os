/**
 * The ONE `when:` guard evaluator, shared by both runners.
 *
 * It is one module rather than two copies for the same reason
 * `resolveGateOutcome` is: the flat and chained runners held byte-similar
 * copies of this logic with a comment on each asking the next person to keep
 * them in lockstep, and "kept in lockstep by hand" is how the flat-vs-chained
 * fork produced #1256. A shared function makes parity structural.
 *
 * ## What changed, and why it mattered
 *
 * The guard used to render the template and truthy-test the result. That makes
 * `when: "{{title}} != DUPLICATE"` — which reads exactly like a duplicate
 * check — evaluate to `"DUPLICATE != DUPLICATE"`, a non-empty string, and the
 * guarded step runs. The recipe appears to have a check and does not have one.
 *
 * The failure direction is what makes it worth fixing properly: an unevaluated
 * comparison fails OPEN. Nothing errors, nothing is skipped, and the guarded
 * action happens every single time. Two of the twelve `when:` guards in
 * shipped recipes were written that way.
 *
 * So there are three outcomes now, by kind rather than one blanket rule:
 *
 *   1. `==` / `!=`  — evaluated as a string comparison.
 *   2. any other operator (`>`, `<`, `>=`, `<=`, `&&`, `||`) — an AUTHORING
 *      ERROR, reported loudly. The runner halts the step rather than guessing.
 *      Silently truthy-testing it is precisely how the original bug shipped.
 *   3. anything else — the existing truthy / last-token behaviour, unchanged,
 *      because ten of the twelve shipped guards are bare `{{var}}` checks.
 *
 * ## Why detection runs on the RAW template
 *
 * Operator detection reads the template as the author wrote it, not the
 * rendered output. An agent's free-text verdict routinely contains "<" or ">"
 * and would otherwise turn a working guard into an authoring error the moment
 * the model phrased something differently. What the author typed is a stable,
 * unambiguous signal; what a model returned is not.
 *
 * Operators INSIDE `{{ }}` are left alone — that is the template engine's
 * domain, and flagging them here would be this module overreaching.
 */

/** Falsy tokens, from the original guard. Kept verbatim. */
const FALSY = new Set(["", "0", "false", "null", "undefined"]);

/**
 * Operators an author might reach for that this guard cannot evaluate, each
 * paired with a LITERAL regex.
 *
 * Written out rather than built with `new RegExp(escape(op))`: an escape
 * helper that misses a character is a sink CodeQL is right to flag, and the
 * set is fixed and tiny, so there is nothing to be gained by generating it.
 * Two-character operators come first — `>=` must match before `>`.
 *
 * Each pattern requires whitespace or a boundary on both sides, so `->` and
 * `=>` inside a literal comparison value are not mistaken for operators.
 */
const UNSUPPORTED: ReadonlyArray<{ op: string; re: RegExp }> = [
  { op: ">=", re: /(^|\s)>=(\s|$)/ },
  { op: "<=", re: /(^|\s)<=(\s|$)/ },
  { op: "&&", re: /(^|\s)&&(\s|$)/ },
  { op: "||", re: /(^|\s)\|\|(\s|$)/ },
  { op: ">", re: /(^|\s)>(\s|$)/ },
  { op: "<", re: /(^|\s)<(\s|$)/ },
];

export type WhenResult =
  | { kind: "ok"; truthy: boolean }
  | { kind: "unsupported"; operator: string; reason: string };

/** Blank out every `{{ ... }}` span so operator scanning only sees the parts
 *  the author wrote as guard syntax. */
function outsideExpressions(template: string): string {
  return template.replace(/\{\{[\s\S]*?\}\}/g, (m) => " ".repeat(m.length));
}

/**
 * The first unsupported operator in the raw template, or null.
 *
 * Exported for the linter, so a recipe can be told at author time rather than
 * at 3am in the middle of a run.
 */
export function findUnsupportedOperator(template: string): string | null {
  const scan = outsideExpressions(template);
  for (const { op, re } of UNSUPPORTED) {
    if (re.test(scan)) return op;
  }
  return null;
}

/** Strip one layer of matching quotes from a comparison literal. */
function unquote(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  )
    return t.slice(1, -1);
  return t;
}

/**
 * Evaluate a `when:` guard.
 *
 * `render` is the caller's template renderer — the flat runner's `render(s,
 * ctx)` and the chained runner's `compileTemplate(s).evaluate(context)` differ
 * in plumbing but not in meaning, so it is injected rather than imported. Each
 * side of a comparison is rendered SEPARATELY, so a value containing the
 * operator cannot re-split the expression.
 */
export function evaluateWhen(
  template: string,
  render: (s: string) => string,
): WhenResult {
  const unsupported = findUnsupportedOperator(template);
  if (unsupported) {
    return {
      kind: "unsupported",
      operator: unsupported,
      reason:
        `\`when\` cannot evaluate \`${unsupported}\` — only \`==\` and \`!=\` are supported. ` +
        "Compute the comparison in the step that produces the value and gate on its result, " +
        "or restate the guard as an equality check.",
    };
  }

  // Find `==` / `!=` outside any `{{ }}`, so `{{a == b}}` stays the template
  // engine's business.
  const scan = outsideExpressions(template);
  const m = /(^|[^!=<>])(==|!=)([^=]|$)/.exec(scan);
  if (m && m.index !== undefined) {
    const opIdx = m.index + (m[1]?.length ?? 0);
    const op = m[2] as "==" | "!=";
    const left = template.slice(0, opIdx);
    const right = template.slice(opIdx + 2);
    const lv = unquote(render(left)).trim().toLowerCase();
    const rv = unquote(render(right)).trim().toLowerCase();
    const equal = lv === rv;
    return { kind: "ok", truthy: op === "==" ? equal : !equal };
  }

  // Truthy path — unchanged. Falsy if the WHOLE value is a falsy token OR its
  // LAST token is, so a guard fed an agent's free-text decision gates on the
  // verdict rather than on "non-empty ⇒ truthy" (#1070). Trailing
  // punctuation/backticks/quotes are stripped so `` `false`. `` still reads
  // false.
  const rendered = render(template).trim().toLowerCase();
  const lastToken = (rendered.split(/\s+/).pop() ?? "").replace(
    /[^a-z0-9]/g,
    "",
  );
  return {
    kind: "ok",
    truthy: !!rendered && !FALSY.has(rendered) && !FALSY.has(lastToken),
  };
}
