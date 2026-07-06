/**
 * outcomes.classify_issues — deterministic disposition classification for
 * the outcome-ingester recipe, replacing an earlier LLM-judge agent step.
 *
 * The agent step read raw issue JSON and freehanded a disposition +
 * checkedAt epoch per-issue. In production cron runs it flipped the SAME
 * closed/COMPLETED issues between "confirmed" and "unknown" on alternating
 * fires, and hallucinated checkedAt values spanning 2023–2027. Trust-replay
 * reads this log to decide good:true/false, so non-deterministic
 * classification directly corrupts the trust signal.
 *
 * This tool has no LLM in the loop: classifyIssueDisposition() is a pure
 * function of state/labels, and checkedAt is the real clock.
 */

import { assertWriteAllowed } from "../../featureFlags.js";
import {
  classifyIssueDisposition,
  OutcomeStore,
  resolveOutcomeLogDir,
} from "../../workers/outcomeStore.js";
import { registerTool } from "../toolRegistry.js";

interface IngestedIssue {
  url?: string;
  html_url?: string;
  state?: string;
  stateReason?: string | null;
  labels?: Array<string | { name?: string }>;
}

registerTool({
  id: "outcomes.classify_issues",
  namespace: "outcomes",
  description:
    "Deterministically classify a batch of GitHub issues (from github.list_issues / github.search_issues output) as confirmed/junk/unknown and persist to the outcome-log for trust-replay. No LLM judgment — pure function of state/stateReason/labels.",
  paramsSchema: {
    type: "object",
    properties: {
      issues: {
        type: "string",
        description:
          "JSON array of issue objects (each with url/state/stateReason/labels), typically piped in as {{issues}} from a prior list_issues/search_issues step.",
      },
      recipeName: {
        type: "string",
        description: "Optional recipe name to stamp on each outcome record.",
      },
      workerClass: {
        type: "string",
        description: "Optional worker action-class to stamp on each record.",
      },
    },
    required: ["issues"],
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "number" },
      confirmed: { type: "number" },
      junk: { type: "number" },
      unknown: { type: "number" },
      error: { type: "string" },
    },
  },
  // "high", not "medium": this tool mutates the worker trust ledger from a
  // caller-supplied `issues` blob with no re-fetch/verification against real
  // GitHub state. POST /outcomes explicitly forbids self-confirmation for
  // the same reason (see recipeRoutes.ts) — this tool must be gated at least
  // as strictly, not run fully autonomously under the default approval
  // posture (security delta sweep 2026-07-06).
  riskDefault: "high",
  isWrite: true,
  execute: async ({ params }) => {
    assertWriteAllowed("outcomes.classify_issues");
    let issues: IngestedIssue[];
    try {
      const raw = params.issues ? String(params.issues) : "[]";
      const parsed = JSON.parse(raw);
      issues = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return JSON.stringify({
        count: 0,
        confirmed: 0,
        junk: 0,
        unknown: 0,
        error: `outcomes.classify_issues: invalid issues JSON — ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const store = new OutcomeStore(resolveOutcomeLogDir());
    const recipeName = params.recipeName
      ? String(params.recipeName)
      : undefined;
    const workerClass = params.workerClass
      ? String(params.workerClass)
      : undefined;

    let confirmed = 0;
    let junk = 0;
    let unknown = 0;
    const checkedAt = Date.now();
    for (const issue of issues) {
      const issueUrl = issue.url ?? issue.html_url;
      if (!issueUrl) continue;
      const disposition = classifyIssueDisposition({
        state: issue.state,
        state_reason: issue.stateReason,
        labels: issue.labels,
      });
      if (disposition === "confirmed") confirmed++;
      else if (disposition === "junk") junk++;
      else unknown++;
      store.upsert({
        issueUrl,
        disposition,
        checkedAt,
        ...(recipeName && { recipeName }),
        ...(workerClass && { workerClass }),
      });
    }

    return JSON.stringify({
      count: confirmed + junk + unknown,
      confirmed,
      junk,
      unknown,
    });
  },
});
