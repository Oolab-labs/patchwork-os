/**
 * Which Claude Code permission rule bears on a pending tool call, for the
 * approval card's badge (audit M28).
 *
 * A bare rule (`Bash`) covers every call to the tool. A scoped rule
 * (`Bash(npm test:*)`) covers only calls whose arguments match its
 * specifier — which this page cannot evaluate faithfully, so it is reported
 * as `scoped` rather than as covering this call. The old matcher counted any
 * `Tool(...)` rule as a full match, so `allow: Bash(npm test:*)` rendered
 * "CC: allow" on `Bash(rm -rf …)`.
 *
 * Whole-tool rules outrank scoped ones; within each, deny > ask > allow.
 */
export type CcRuleKind = "deny" | "ask" | "allow";

export interface CcRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export function matchCcRule(
  toolName: string,
  rules: CcRules | null,
): { kind: CcRuleKind; scoped: boolean } | null {
  if (!rules) return null;
  const order: CcRuleKind[] = ["deny", "ask", "allow"];
  for (const kind of order) {
    if (rules[kind].some((r) => r === toolName)) return { kind, scoped: false };
  }
  for (const kind of order) {
    if (rules[kind].some((r) => r.startsWith(`${toolName}(`))) {
      return { kind, scoped: true };
    }
  }
  return null;
}
