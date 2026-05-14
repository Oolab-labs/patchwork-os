import type { ReactNode } from "react";
import { Glossary } from "@/components/patchwork/Glossary";

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
 *
 * Glossary integration: domain terms in body text are wrapped with
 * `<Glossary term="…">…</Glossary>` so hover/focus reveals a 1-line
 * definition + "Learn more →" link. The registry below uses JSX
 * because of this — the file is .tsx, not .ts.
 */

export interface Hint {
  /**
   * Stable identifier — used as the localStorage dismissal key
   * (`patchwork.hint.<id>.dismissed`). Don't change once shipped.
   */
  id: string;
  /** Page title — surfaces as the `<strong>` tag in the card. */
  title: string;
  /** 1–3 sentences. ReactNode so glossary terms can be highlighted inline. */
  body: ReactNode;
  /** Optional inline tip ("Press ⌘K to search.", "Use J/K to navigate."). */
  tip?: ReactNode;
}

export const HINTS: Record<string, Hint> = {
  approvals: {
    id: "approvals",
    title: "What's the Approval queue?",
    body: (
      <>
        Tool calls your agents want to run that need a human nod first.
        Approve, reject, or save your reasoning as a{" "}
        <Glossary term="decision">decision</Glossary> so similar calls can run
        automatically next time.
      </>
    ),
    tip: "J / K to navigate · E to approve · X to reject · ⌘K for search.",
  },
  activity: {
    id: "activity",
    title: "What's the Activity stream?",
    body: (
      <>
        Every event the Patchwork <Glossary term="bridge">bridge</Glossary>{" "}
        emits in real time — recipe <Glossary term="run">runs</Glossary>, tool
        calls, <Glossary term="approval">approval</Glossary> decisions,{" "}
        <Glossary term="halt">halts</Glossary>, session connects.
      </>
    ),
    tip: (
      <>
        Use the tab strip above to drill into{" "}
        <Glossary term="run">Runs</Glossary>,{" "}
        <Glossary term="task">Tasks</Glossary>,{" "}
        <Glossary term="session">Sessions</Glossary>, or{" "}
        <Glossary term="trace">Traces</Glossary>. The halt badge on the sidebar
        shows how many recipes failed in the last 24h.
      </>
    ),
  },
  recipes: {
    id: "recipes",
    title: "What's a Recipe?",
    body: (
      <>
        A YAML automation your agents can run on a schedule, a webhook, or on
        demand. Each row shows the trigger, recent{" "}
        <Glossary term="run">runs</Glossary>, and any{" "}
        <Glossary term="halt">halts</Glossary> that need attention.
      </>
    ),
    tip: "Click + New recipe in the sidebar, or browse Marketplace to install one.",
  },
  inbox: {
    id: "inbox",
    title: "What's the Inbox?",
    body: (
      <>
        Digests and reports your{" "}
        <Glossary term="recipe">recipes</Glossary> have produced for you to
        read — morning briefs, AI-generated summaries, recipe outputs.
      </>
    ),
    tip: "Filter by source in the top-right; archive when done.",
  },
  decisions: {
    id: "decisions",
    title: "What's Knowledge?",
    body: (
      <>
        The reasoning your agents have written down about past decisions. Each
        entry was saved with ctxSaveTrace — typically from an{" "}
        <Glossary term="approval">approval</Glossary>, a fix, or a{" "}
        <Glossary term="recipe">recipe</Glossary> that produced an interesting
        result.
      </>
    ),
    tip: (
      <>
        Query by tag or recency. Future{" "}
        <Glossary term="approval">approvals</Glossary> will surface relevant{" "}
        <Glossary term="trace">traces</Glossary> automatically.
      </>
    ),
  },
  insights: {
    id: "insights",
    title: "What are Approval Insights?",
    body: (
      <>
        Per-tool approval and rejection patterns. Tools you approve
        consistently show up as Trusted; tools with any rejections show up with
        a warning so you can tighten policy.
      </>
    ),
    tip: "Use Replay to see how today's rules would have decided past calls.",
  },
  suggestions: {
    id: "suggestions",
    title: "What are Suggestions?",
    body: (
      <>
        Allow/deny rules Patchwork has detected from your past{" "}
        <Glossary term="approval">approvals</Glossary>. Accept one to graduate a
        trusted tool out of the approval queue without writing config by hand.
      </>
    ),
  },
  connections: {
    id: "connections",
    title: "What are Connections?",
    body: (
      <>
        Authorisations for the external services your{" "}
        <Glossary term="recipe">recipes</Glossary> use — Gmail, Slack, GitHub,
        etc. Each connection&apos;s token lives only on your machine; the
        dashboard refreshes it on 401 automatically.
      </>
    ),
    tip: "Click Test to send a real request through the bridge.",
  },
  marketplace: {
    id: "marketplace",
    title: "What's the Marketplace?",
    body: (
      <>
        Curated <Glossary term="recipe">recipes</Glossary> from{" "}
        <code>github.com/patchworkos/recipes</code>. Each card shows the
        required <Glossary term="connection">connections</Glossary> and the
        YAML that lands in your local recipe folder when you install.
      </>
    ),
    tip: "Bundles install several related recipes at once. Propose new entries via GitHub PR.",
  },
  transactions: {
    id: "transactions",
    title: "What are Transactions?",
    body: (
      <>
        Multi-file edits an agent has staged but not yet committed.
        They&apos;re TTL-bound and disappear if not approved or rolled back
        within the window.
      </>
    ),
  },
  traces: {
    id: "traces",
    title: "What are Traces?",
    body: (
      <>
        Cross-session memory entries — saved{" "}
        <Glossary term="approval">approvals</Glossary>, enrichment links,{" "}
        <Glossary term="recipe">recipe-run</Glossary> decisions, and reasoning
        from ctxSaveTrace. Used to give future sessions context without
        re-deriving everything from scratch.
      </>
    ),
    tip: "Filter by trace type (approval / enrichment / recipe / decision) in the chip row above.",
  },
};

/** Look up a hint, returning undefined if the id isn't registered. */
export function findHint(id: string): Hint | undefined {
  return HINTS[id];
}
