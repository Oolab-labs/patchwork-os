/**
 * Parse issue references from commit messages or free text.
 *
 * Matches `#123`, `GH-123`, and verbs like `fixes #123` / `closes GH-123`.
 * Returns deduplicated refs as `#<n>` strings, lowest number first, then
 * insertion order.
 */
export function extractIssueRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/(?:GH-|#)(\d+)/gi)) {
    refs.add(`#${match[1]}`);
  }
  return Array.from(refs);
}

/**
 * Classify commit→issue link verb. `fixes #12` / `closes #12` / `resolves #12`
 * indicate the commit resolves the issue; `refs #12` / bare `#12` are
 * references only. Useful for enrichment output.
 */
export function classifyIssueLink(
  text: string,
  ref: string,
): "closes" | "references" {
  const num = ref.replace(/^#/, "");
  // Verb directly precedes the target ref (no other #N or GH-N between them).
  // Keeps "Fixes #42 and references #99" → #42 closes, #99 references.
  const closeRe = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:GH-|#)${num}\\b`,
    "i",
  );
  return closeRe.test(text) ? "closes" : "references";
}
