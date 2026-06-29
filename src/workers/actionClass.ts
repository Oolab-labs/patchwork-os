import { classifyTool, type RiskTier } from "../riskTier.js";

/**
 * Worker trust is scoped per (worker × action-class), never globally. An
 * action-class is the unit that accumulates evidence. It is intentionally
 * COARSE enough to graduate (a worker touches only a handful) yet keyed on
 * blast-tier so that a rarer, higher-blast action in the same domain is a
 * DISTINCT, less-trusted class — competence on routine `git status` can never
 * transfer to `git push --force`. (worker-ramp-v0)
 */

export type Reversibility = "reversible" | "compensable" | "irreversible";

export interface ActionClass {
  /** Stable identity: `${domain}:${reversibility}:${blastTier}`. */
  key: string;
  domain: string;
  reversibility: Reversibility;
  blastTier: RiskTier;
  /**
   * Brand/reputational exposure — a DISTINCT gating dimension from safety blast
   * radius (cf. Arts & Media: low safety risk, high reputational risk). An
   * externally-visible action (outbound message, public PR/push, issue) whose
   * failure damages reputation rather than (or as well as) systems. Folds into
   * the failure weight so reputational mistakes demote trust harder.
   */
  brandExposed: boolean;
}

/**
 * Tool → capability domain. Coarse on purpose. Unknown tools fall to "other"
 * (treated as irreversible — conservative: an unrecognised side effect is
 * assumed unrecoverable until proven otherwise).
 */
const DOMAIN_BY_TOOL: Record<string, string> = {
  // version control — read
  getGitStatus: "vcs-read",
  getGitDiff: "vcs-read",
  getGitLog: "vcs-read",
  gitBlame: "vcs-read",
  gitListBranches: "vcs-read",
  // version control — local mutations (reversible: reset/reflog/restore)
  gitAdd: "vcs-local",
  gitCommit: "vcs-local",
  gitCheckout: "vcs-local",
  gitStash: "vcs-local",
  // version control — remote / shared history.
  // Each operation has its OWN domain so trust earned on one never unlocks
  // another (trust-transfer prevention: a worker grinding PR creation must
  // separately earn evidence on push, and separately on merge).
  gitPush: "vcs-push", // can be force-reverted; compensable
  githubCreatePR: "vcs-remote", // PR is a proposal; closeable
  githubMergePR: "vcs-merge", // lands commits in main; hard to undo cleanly
  // filesystem
  editText: "fs-write",
  searchAndReplace: "fs-write",
  createFile: "fs-write",
  formatDocument: "fs-write",
  getBufferContent: "fs-read",
  findFiles: "fs-read",
  // shell
  runCommand: "shell",
  runInTerminal: "shell",
  sendTerminalCommand: "shell",
  // outbound messaging
  slackPostMessage: "messaging",
  // generic network
  sendHttpRequest: "http",
  WebFetch: "http",
  // issue trackers
  githubCreateIssue: "issue",
  createLinearIssue: "issue",
  addLinearComment: "issue",
  updateLinearIssue: "issue",
  // CI / tests
  runTests: "ci",
  githubActions: "ci",
  // dependency intel (read-only)
  auditDependencies: "deps-read",
  getSecurityAdvisories: "deps-read",
  // recipe-tool ids — RecipeRunLog records THESE (not the MCP names), so the
  // shadow dial attributes recipe-run steps by them. git.*/github.list_* are
  // reads; file.* writes; slack/http are outbound. (worker-ramp-v0 dogfood)
  "git.log_since": "vcs-read",
  "git.stale_branches": "vcs-read",
  "github.list_commits": "vcs-read",
  "github.list_prs": "vcs-read",
  "github.list_issues": "vcs-read",
  "github.create_issue": "issue", // write — compensable (closeable) + brand-exposed
  "file.read": "fs-read",
  "file.write": "fs-write",
  "file.append": "fs-write",
  "slack.post_message": "messaging",
  "http.post": "http",
  "linear.list_issues": "issue-read", // read-only; reversible
  "sentry.get_issue": "issue-read", // read-only; reversible
  "diagnostics.get": "fs-read",
};

/** Domain → reversibility. The middle ramp rungs (L2/L3) only exist for a class
 * whose reversibility is not "irreversible", so this is load-bearing. */
const REVERSIBILITY_BY_DOMAIN: Record<string, Reversibility> = {
  "vcs-read": "reversible",
  "vcs-local": "reversible", // reset / reflog / restore
  "vcs-remote": "compensable", // close PR — lossy but possible
  "vcs-push": "compensable", // force-revert / reflog — lossy but possible
  "vcs-merge": "compensable", // git revert on main — painful but recoverable
  "fs-write": "reversible", // transactions + WriteEffectLedger
  "fs-read": "reversible",
  shell: "irreversible", // arbitrary side effects — assume unrecoverable
  messaging: "irreversible", // a sent message can't be unsent reliably
  http: "irreversible", // a POST may not be undoable
  issue: "compensable", // close / delete the created issue
  "issue-read": "reversible", // read-only issue queries
  ci: "reversible", // re-runnable, no durable side effect
  "deps-read": "reversible",
  other: "irreversible",
};

/** Domains whose actions are externally visible — failure is reputational. */
const BRAND_EXPOSED_DOMAINS = new Set([
  "messaging",
  "vcs-remote",
  "vcs-push",
  "vcs-merge",
  "issue",
  "http",
]);

export function classifyActionClass(
  toolName: string,
  _params?: Record<string, unknown>,
): ActionClass {
  const domain = DOMAIN_BY_TOOL[toolName] ?? "other";
  const reversibility = REVERSIBILITY_BY_DOMAIN[domain] ?? "irreversible";
  const blastTier = classifyTool(toolName);
  return {
    key: `${domain}:${reversibility}:${blastTier}`,
    domain,
    reversibility,
    blastTier,
    brandExposed: BRAND_EXPOSED_DOMAINS.has(domain),
  };
}

const BLAST_MULTIPLIER: Record<RiskTier, number> = {
  low: 2,
  medium: 5,
  high: 12,
};
const REVERSIBILITY_MULTIPLIER: Record<Reversibility, number> = {
  reversible: 1,
  compensable: 1.5,
  irreversible: 3,
};

/**
 * Evidence weight for one outcome. A routine success is low-information
 * (weight 1 → the posterior climbs slowly). A failure is weighted by
 * blast-tier × reversibility, so a high-blast irreversible failure is high
 * information and craters the posterior (instant demote). This is the entire
 * anti-trust-transfer-grinding defence: count alone never graduates a risky
 * class, and one catastrophic outcome dominates a thousand trivial ones.
 */
const BRAND_MULTIPLIER = 1.5;

export function outcomeWeight(actionClass: ActionClass, good: boolean): number {
  if (good) return 1;
  const brand = actionClass.brandExposed ? BRAND_MULTIPLIER : 1;
  return (
    BLAST_MULTIPLIER[actionClass.blastTier] *
    REVERSIBILITY_MULTIPLIER[actionClass.reversibility] *
    brand
  );
}

/** Which ramp rungs are reachable for a class. Irreversible classes skip the
 * safety-net rungs L2/L3 (no compensating action exists), so they must clear a
 * higher bar to reach L4. */
export function reachableLevels(actionClass: ActionClass): number[] {
  return actionClass.reversibility === "irreversible"
    ? [0, 1, 4]
    : [0, 1, 2, 3, 4];
}
