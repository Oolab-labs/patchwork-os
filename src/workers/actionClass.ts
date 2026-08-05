import { classifyTool, type RiskTier } from "../riskTier.js";

/**
 * Worker trust is scoped per (worker × action-class), never globally. An
 * action-class is the unit that accumulates evidence. It is intentionally
 * COARSE enough to graduate (a worker touches only a handful) yet keyed on
 * blast-tier so that a rarer, higher-blast action in the same domain is a
 * DISTINCT, less-trusted class — competence on routine `git status` can never
 * transfer to `git push --force`.
 *
 * That separation holds across TOOLS. It did not hold across INSTANCES of one
 * tool: every component of the key derived from the tool name, so a £5 charge
 * and a £5,000 charge were one class and evidence ground out on the former
 * authorised the latter. Value-bearing domains therefore also carry a coarse
 * magnitude band. (worker-ramp-v2)
 */

export type Reversibility = "reversible" | "compensable" | "irreversible";

/**
 * Coarse value bucket for a value-bearing action. Bands, never raw amounts:
 * an unbounded key space would mean every purchase is its own class and no
 * class ever accumulates enough evidence to graduate.
 */
export type MagnitudeBand = "band<=50" | "band<=500" | "band>500";

export interface ActionClass {
  /**
   * Stable identity: `${domain}:${reversibility}:${blastTier}`, plus a
   * `:${magnitudeBand}` suffix for value-bearing domains.
   */
  key: string;
  domain: string;
  reversibility: Reversibility;
  blastTier: RiskTier;
  /**
   * Present only for domains in `MAGNITUDE_BANDED_DOMAINS`. Undefined elsewhere
   * — most actions have no meaningful magnitude, and inventing one would split
   * their trust cells for no reason.
   */
  magnitudeBand?: MagnitudeBand;
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
  // payments / commerce — money movement. These connector methods exist
  // (src/connectors/paystack.ts, stripe.ts) but are NOT currently registered as
  // recipe tools; that unreachability is the only thing containing them today.
  // Mapped here so that if any of them IS registered later it classifies as
  // `payments` rather than silently falling to `other` — a default that is
  // conservative on reversibility but loses the magnitude band entirely.
  "paystack.charge_authorization": "payments",
  "paystack.initiate_transfer": "payments",
  "stripe.create_charge": "payments",
  "stripe.create_payment_intent": "payments",
  "stripe.create_refund": "payments",
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
  payments: "irreversible", // a settled charge/transfer has no generic inverse;
  // a refund is a NEW compensating action with residue (fees kept, two
  // statement lines), not an undo — see src/recipes/fileRollback.ts's note.
  other: "irreversible",
};

/**
 * Domains whose class key carries a magnitude band. Deliberately an explicit
 * allowlist rather than "any params with an amount": banding a domain that has
 * no meaningful value would fragment its trust cells and stall graduation.
 */
const MAGNITUDE_BANDED_DOMAINS = new Set(["payments"]);

/** Param keys that may carry a value, in precedence order. */
const AMOUNT_PARAM_KEYS = [
  "amount",
  "amountMinor",
  "amount_minor",
  "value",
  "total",
] as const;

/**
 * Best-effort magnitude for a value-bearing action, in MINOR units (cents), the
 * convention every payment API in the tree uses. Returns null when no amount is
 * readable — the caller treats that as the widest band, never the cheapest.
 */
function readAmountMinor(params?: Record<string, unknown>): number | null {
  if (!params) return null;
  for (const k of AMOUNT_PARAM_KEYS) {
    if (!Object.hasOwn(params, k)) continue;
    const raw = params[k];
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue;
    return n;
  }
  return null;
}

/**
 * Bucket an amount. A NULL amount bands as the WIDEST bucket, not the narrowest:
 * an unreadable value must never be treated as cheap, or an attacker-shaped or
 * merely malformed param becomes the way to reach the low-friction class.
 */
function magnitudeBandFor(amountMinor: number | null): MagnitudeBand {
  if (amountMinor === null) return "band>500";
  if (amountMinor <= 50_00) return "band<=50";
  if (amountMinor <= 500_00) return "band<=500";
  return "band>500";
}

/** Domains whose actions are externally visible — failure is reputational. */
const BRAND_EXPOSED_DOMAINS = new Set([
  "messaging",
  "vcs-remote",
  "vcs-push",
  "vcs-merge",
  "issue",
  "http",
  "payments", // a wrong charge is a customer-visible, reputational failure
]);

/**
 * The tool names this module can classify (MCP names + recipe-tool ids). Exposed
 * so the worker-agent sandbox can enumerate every risky tool to consider
 * blocking. NOT exhaustive of the whole MCP surface — any unknown tool classifies
 * as `other:irreversible` and is gated at the per-step gate regardless.
 */
export function knownActionTools(): string[] {
  return Object.keys(DOMAIN_BY_TOOL);
}

/**
 * The closed vocabulary of action-class domains a worker manifest's `owns`
 * field can name (bare domain form). Exposed so UI/validation code has one
 * source of truth instead of hand-maintaining a second copy of this list.
 */
export function knownActionDomains(): string[] {
  return Object.keys(REVERSIBILITY_BY_DOMAIN);
}

export function classifyActionClass(
  toolName: string,
  params?: Record<string, unknown>,
): ActionClass {
  const domain = DOMAIN_BY_TOOL[toolName] ?? "other";
  const reversibility = REVERSIBILITY_BY_DOMAIN[domain] ?? "irreversible";
  const blastTier = classifyTool(toolName);
  // Instance-derived facet. Without it the key is a pure function of the tool
  // NAME, so a trivial instance and a catastrophic one share a trust cell and
  // evidence ground out on the former silently authorises the latter.
  const magnitudeBand = MAGNITUDE_BANDED_DOMAINS.has(domain)
    ? magnitudeBandFor(readAmountMinor(params))
    : undefined;
  const key = magnitudeBand
    ? `${domain}:${reversibility}:${blastTier}:${magnitudeBand}`
    : `${domain}:${reversibility}:${blastTier}`;
  return {
    key,
    domain,
    reversibility,
    blastTier,
    magnitudeBand,
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
