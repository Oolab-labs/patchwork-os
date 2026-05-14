/**
 * Patchwork-specific vocabulary, single source of truth.
 *
 * Every term that's domain-specific to Patchwork lives here with a
 * 1-sentence definition + a destination link. The <Glossary> component
 * wraps terms in prose with a dotted underline; hover/focus reveals the
 * definition, click navigates to the destination so the user can dig
 * deeper.
 *
 * Voice rules (locked here, not in the component):
 *   - One sentence max. No paragraphs in tooltips.
 *   - Lead with what it IS, not what it does.
 *   - Use other glossary terms freely (the reader can hover those too).
 *   - Never marketing copy.
 */

export interface GlossaryEntry {
  /** The term itself in canonical lowercase. */
  term: string;
  /** 1-sentence definition. */
  definition: string;
  /** Where to send the reader to see the term in action. */
  href: string;
}

const ENTRIES: GlossaryEntry[] = [
  {
    term: "recipe",
    definition:
      "A YAML automation that runs your agents on a trigger — cron, webhook, file change, or on demand.",
    href: "/recipes",
  },
  {
    term: "run",
    definition:
      "One execution of a recipe — has a seq number, a status, halts (if any), and a duration.",
    href: "/runs",
  },
  {
    term: "halt",
    definition:
      "A recipe run that stopped before completion. Categories include tool_threw, kill_switch, run_level, and a few others.",
    href: "/runs",
  },
  {
    term: "approval",
    definition:
      "A tool call your agent wants to run that's gated by your delegation policy and needs a human nod.",
    href: "/approvals",
  },
  {
    term: "decision",
    definition:
      "Saved reasoning your agents wrote down with ctxSaveTrace — the knowledge base future sessions read from.",
    href: "/decisions",
  },
  {
    term: "trace",
    definition:
      "A cross-session memory entry: approvals, enrichment links, recipe runs, or saved reasoning, indexed for recall.",
    href: "/traces",
  },
  {
    term: "task",
    definition:
      "A Claude subprocess invocation orchestrated by the bridge — distinct from a recipe run.",
    href: "/tasks",
  },
  {
    term: "session",
    definition:
      "An MCP client (Claude Code, Desktop, JetBrains, etc.) connected to the bridge.",
    href: "/sessions",
  },
  {
    term: "connection",
    definition:
      "An authorisation for an external service — Gmail, Slack, GitHub. The token lives on your machine; the bridge refreshes on 401.",
    href: "/connections",
  },
  {
    term: "transaction",
    definition:
      "Multi-file edits an agent has staged but not yet committed. TTL-bound — disappear if not approved or rolled back.",
    href: "/transactions",
  },
  {
    term: "suggestion",
    definition:
      "An allow/deny rule Patchwork has inferred from your past approvals. Accept to graduate a tool out of the queue.",
    href: "/suggestions",
  },
  {
    term: "bridge",
    definition:
      "The local Patchwork process the dashboard talks to. Lives on a port (default 3101); started via `patchwork start`.",
    href: "/settings",
  },
];

const BY_TERM = new Map<string, GlossaryEntry>(
  ENTRIES.map((e) => [e.term.toLowerCase(), e]),
);

/**
 * Look up a glossary entry. Lowercases the input so callers can pass
 * the cased form they're displaying (e.g. "Recipe") without losing the
 * lookup.
 */
export function findGlossary(term: string): GlossaryEntry | undefined {
  return BY_TERM.get(term.toLowerCase());
}

/** All registered terms, sorted alphabetically. */
export function allGlossaryTerms(): GlossaryEntry[] {
  return [...ENTRIES].sort((a, b) => a.term.localeCompare(b.term));
}
