/**
 * Per-page "what's this?" hint registry.
 *
 * Each `HintCard` consumes one entry by `id`. Hints are 1–3 sentences
 * of plain-English explanation that surface the first time a user
 * lands on a page; once dismissed, the dashboard remembers (via
 * localStorage) and the card stays hidden. The card's `?` icon lets
 * the user re-open it at any time.
 *
 * Voice rules (locked here, not in the component):
 *   - Lead with what the page IS, not what it DOES.
 *   - One concrete keyboard / link tip per hint.
 *   - No marketing copy ("powerful", "intelligent", etc.).
 *   - Active voice, second person ("you can …").
 *   - Reference Patchwork's own vocabulary (recipe / run / halt /
 *     approval / decision / trace / connection), not synonyms.
 */

export interface Hint {
  /**
   * Stable identifier — used as the localStorage dismissal key
   * (`patchwork.hint.<id>.dismissed`). Don't change once shipped.
   */
  id: string;
  /** Page title — surfaces as the `<strong>` tag in the card. */
  title: string;
  /** 1–3 sentences. Plain text; no markdown. */
  body: string;
  /** Optional inline tip ("Press ⌘K to search.", "Use J/K to navigate."). */
  tip?: string;
}

export const HINTS: Record<string, Hint> = {
  approvals: {
    id: "approvals",
    title: "What's the Approval queue?",
    body:
      "Tool calls your agents want to run that need a human nod first. " +
      "Approve, reject, or save your reasoning so similar calls can run automatically next time.",
    tip: "J / K to navigate · E to approve · X to reject · ⌘K for search.",
  },
  activity: {
    id: "activity",
    title: "What's the Activity stream?",
    body:
      "Every event the Patchwork bridge emits in real time — recipe runs, tool calls, " +
      "approval decisions, halts, session connects.",
    tip:
      "Use the tab strip above to drill into Runs, Tasks, Sessions, or Traces. " +
      "The halt badge on the sidebar shows how many recipes failed in the last 24h.",
  },
  recipes: {
    id: "recipes",
    title: "What's a Recipe?",
    body:
      "A YAML automation your agents can run on a schedule, a webhook, or on demand. " +
      "Each row shows the trigger, recent runs, and any halts that need attention.",
    tip: "Click + New recipe in the sidebar, or browse Marketplace to install one.",
  },
  inbox: {
    id: "inbox",
    title: "What's the Inbox?",
    body:
      "Digests and reports your recipes have produced for you to read — " +
      "morning briefs, AI-generated summaries, recipe outputs.",
    tip: "Filter by source in the top-right; archive when done.",
  },
  decisions: {
    id: "decisions",
    title: "What's Knowledge?",
    body:
      "The reasoning your agents have written down about past decisions. " +
      "Each entry was saved with ctxSaveTrace — typically from an approval, " +
      "a fix, or a recipe that produced an interesting result.",
    tip: "Query by tag or recency. Future approvals will surface relevant Knowledge entries automatically.",
  },
  insights: {
    id: "insights",
    title: "What are Approval Insights?",
    body:
      "Per-tool approval and rejection patterns. " +
      "Tools you approve consistently show up as Trusted; tools with any rejections show up with a warning so you can tighten policy.",
    tip: "Use Replay to see how today's rules would have decided past calls.",
  },
  suggestions: {
    id: "suggestions",
    title: "What are Suggestions?",
    body:
      "Allow/deny rules Patchwork has detected from your past approvals. " +
      "Accept one to graduate a trusted tool out of the approval queue without writing config by hand.",
  },
  connections: {
    id: "connections",
    title: "What are Connections?",
    body:
      "Authorisations for the external services your recipes use — Gmail, Slack, GitHub, etc. " +
      "Each connection's token lives only on your machine; the dashboard refreshes it on 401 automatically.",
    tip: "Click Test to send a real request through the bridge.",
  },
  marketplace: {
    id: "marketplace",
    title: "What's the Marketplace?",
    body:
      "Recipes published by the Patchwork community. Each card shows install count, " +
      "required connections, and the YAML you'd land in your project.",
    tip: "Bundles install several related recipes at once.",
  },
  transactions: {
    id: "transactions",
    title: "What are Transactions?",
    body:
      "Multi-file edits an agent has staged but not yet committed. They're TTL-bound " +
      "and disappear if not approved or rolled back within the window.",
  },
  traces: {
    id: "traces",
    title: "What are Traces?",
    body:
      "Cross-session memory entries — saved approvals, enrichment links, recipe-run " +
      "decisions, and reasoning from ctxSaveTrace. Used to give future sessions context " +
      "without re-deriving everything from scratch.",
    tip: "Filter by trace type (approval / enrichment / recipe / decision) in the chip row above.",
  },
};

/** Look up a hint, returning undefined if the id isn't registered. */
export function findHint(id: string): Hint | undefined {
  return HINTS[id];
}
