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

/**
 * The step "tool" name for an agent (reasoning) step.
 *
 * Defined once and imported by every site that special-cases it, because the
 * two that mattered — the gate's carve-out in `workerGate.ts` and the trust
 * fold in `shadowObserver.ts` — each hardcoded the literal independently and
 * then DRIFTED: the gate excluded agent steps as "not a gated action-class"
 * while the fold happily counted them as earned trust. A shared constant does
 * not by itself keep the two policies in agreement, but it makes the set of
 * places that must agree greppable from one symbol.
 */
export const AGENT_STEP_TOOL = "agent";

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
  // camelCase aliases inherit their canonical tool's class (#1311). These are
  // registered as `registerTool({ ...canonical, id: "..." })` — the SAME
  // action under a second name, so classifying one and not the other governs
  // half the callers.
  "linear.listIssues": "issue-read",
  "slack.postMessage": "messaging",

  // ── outbound messaging (#1311 batch 2) ──────────────────────────────────
  // Reversibility is UNCHANGED: these already classified irreversible via the
  // catch-all, and `messaging` is irreversible too. Blast tier is derived from
  // the tool name (classifyTool), not the domain, so it does not move either.
  // The only effect is that a sent message stops sharing a trust bucket with
  // every other unclassified write — which is what makes the bucket mean
  // something. Nothing is loosened by this block.
  "discord.send_message": "messaging",
  "telegram.send_message": "messaging",
  "twilio.send_sms": "messaging",
  "sendgrid.send_email": "messaging",
  "resend.send_email": "messaging",
  "resend.cancel_email": "messaging",

  // ── arbitrary SQL (#1311 batch 2) ───────────────────────────────────────
  // Also unchanged in reversibility. Separated from `messaging` because
  // "this worker may run SQL" and "this worker may send mail" are different
  // authorities, and a single `other` bucket could not tell them apart.
  "postgres.query": "db-write",
  "snowflake.execute_query": "db-write",

  // ── tracker / docs / support writes (#1311 batch 3) ─────────────────────
  // The per-tool review batch 1 deferred and batch 2 began. Every id below is
  // a declared WRITE, so each carries a stated inverse rather than a guess
  // from its name — the question asked of each was "what is the concrete act
  // that undoes this, and what residue does it leave?".
  //
  // Two different things happen in this block, and they are kept apart on
  // purpose:
  //   * DEBUCKETING (no reversibility change) — the tool stays irreversible
  //     and only stops sharing one bucket with every other unclassified write.
  //   * LOOSENING (irreversible → compensable) — the tool has a real inverse.
  //     This is the dangerous direction, so it is claimed only where the
  //     inverse is an ordinary, supported operation of the product itself.
  //
  // Issue trackers. Inverse: delete or close the issue, revert the field, or
  // delete the comment — all first-class operations in Jira and Linear. The
  // residue (a watcher may have seen it, a notification already went out) is
  // exactly what `compensable` means as distinct from `reversible`.
  "jira.create_issue": "issue",
  "jira.add_comment": "issue",
  "jira.update_status": "issue",
  "linear.createIssue": "issue",
  "linear.updateIssue": "issue",
  "linear.addComment": "issue",
  "meetingNotes.createLinearIssues": "issue",

  // Work trackers. Same inverse (delete the item / the comment); separate
  // domain because "may file engineering issues" and "may act on the task
  // board" are different authorities, and `tasks` already exists and is
  // already compensable for the same stated reason (#1268).
  "asana.add_task_comment": "tasks",
  "monday.create_item": "tasks",

  // Knowledge bases. Inverse: delete the page, or restore the previous
  // version — both products keep page history, which is what makes this a
  // real inverse rather than a hopeful one.
  //
  // `obsidian.write_note` is deliberately NOT here despite looking like a
  // sibling: it overwrites a vault file with no version history and is not
  // covered by the WriteEffectLedger that makes `fs-write` reversible, so
  // its prior content is simply gone. It stays on the ratchet.
  "notion.createPage": "docs-write",
  "notion.appendBlock": "docs-write",
  "confluence.createPage": "docs-write",
  "confluence.appendToPage": "docs-write",

  // Customer-facing support. Split by what the act actually IS, not by which
  // product it belongs to:
  //   * replying/commenting DELIVERS text to a customer (usually by email).
  //     That is a sent message and cannot be unsent — DEBUCKETING only, it
  //     stays irreversible, and `messaging` is where sent things live.
  //   * flipping ticket state is reopenable in both products — a genuine
  //     inverse, so `support` is compensable. Kept out of `issue` because
  //     "may close a customer's ticket" is a different authority from "may
  //     close an engineering issue", and it is brand-exposed in a way an
  //     internal tracker is not.
  "intercom.replyToConversation": "messaging",
  "zendesk.addComment": "messaging",
  "intercom.closeConversation": "support",
  "zendesk.updateStatus": "support",

  // ── connector reads (#1311 batch 1) ─────────────────────────────────────
  // Derived from the registry's own `isWrite: false`, never guessed from the
  // name. Writes are deliberately NOT swept: each needs a real reversibility
  // judgement, and loosening is the dangerous direction.
  "airtable.get_record": "connector-read",
  "airtable.list_bases": "connector-read",
  "airtable.list_records": "connector-read",
  "asana.get_current_user": "connector-read",
  "asana.list_projects": "connector-read",
  "asana.list_workspaces": "connector-read",
  "caldiy.get_booking": "connector-read",
  "caldiy.list_bookings": "connector-read",
  "caldiy.list_event_types": "connector-read",
  "calendar.list_events": "connector-read",
  "circleci.get_job": "connector-read",
  "circleci.get_workflow": "connector-read",
  "circleci.list_pipelines": "connector-read",
  "cloudflare.get_zone_analytics": "connector-read",
  "cloudflare.list_dns_records": "connector-read",
  "cloudflare.list_zones": "connector-read",
  "confluence.getPage": "connector-read",
  "confluence.listSpaces": "connector-read",
  "confluence.search": "connector-read",
  "datadog.getMonitor": "connector-read",
  "datadog.listActiveAlerts": "connector-read",
  "datadog.listIncidents": "connector-read",
  "datadog.listMonitors": "connector-read",
  "datadog.queryMetrics": "connector-read",
  "discord.get_current_user": "connector-read",
  "discord.list_channels": "connector-read",
  "discord.list_guilds": "connector-read",
  "discord.list_messages": "connector-read",
  "docs.get_document": "connector-read",
  "docs.get_document_text": "connector-read",
  "drive.fetchDoc": "connector-read",
  "drive.findLatestDoc": "connector-read",
  "elasticsearch.cluster_health": "connector-read",
  "elasticsearch.count": "connector-read",
  "elasticsearch.list_indices": "connector-read",
  "elasticsearch.search": "connector-read",
  "figma.get_file": "connector-read",
  "figma.get_file_comments": "connector-read",
  "figma.get_image_urls": "connector-read",
  "figma.list_project_files": "connector-read",
  "github.search_issues": "connector-read",
  "gitlab.get_current_user": "connector-read",
  "gitlab.get_issue": "connector-read",
  "gitlab.list_issues": "connector-read",
  "gitlab.list_merge_requests": "connector-read",
  "gitlab.list_projects": "connector-read",
  "gmail.fetch_thread": "connector-read",
  "gmail.fetch_unread": "connector-read",
  "gmail.getMessage": "connector-read",
  "gmail.resolveMeetingNotes": "connector-read",
  "gmail.search": "connector-read",
  "grafana.list_alert_rules": "connector-read",
  "grafana.list_dashboards": "connector-read",
  "grafana.query_datasource": "connector-read",
  "hubspot.getContact": "connector-read",
  "hubspot.getDeal": "connector-read",
  "hubspot.listContacts": "connector-read",
  "hubspot.listDeals": "connector-read",
  "hubspot.searchContacts": "connector-read",
  "intercom.getConversation": "connector-read",
  "intercom.listContacts": "connector-read",
  "intercom.listConversations": "connector-read",
  "jira.get_issue": "connector-read",
  "jira.list_issues": "connector-read",
  "jira.list_projects": "connector-read",
  "meetingNotes.flatten": "connector-read",
  "meetingNotes.parse": "connector-read",
  "monday.get_item": "connector-read",
  "monday.list_boards": "connector-read",
  "monday.list_items": "connector-read",
  "mongodb.aggregate": "connector-read",
  "mongodb.describe_collection": "connector-read",
  "mongodb.find": "connector-read",
  "mongodb.list_collections": "connector-read",
  "mongodb.list_databases": "connector-read",
  "notion.getPage": "connector-read",
  "notion.queryDatabase": "connector-read",
  "notion.search": "connector-read",
  "obsidian.list_vault": "connector-read",
  "obsidian.read_note": "connector-read",
  "obsidian.search_vault": "connector-read",
  "pagerduty.get_incident": "connector-read",
  "pagerduty.list_incidents": "connector-read",
  "pagerduty.list_on_calls": "connector-read",
  "pagerduty.list_services": "connector-read",
  "paystack.get_transaction": "connector-read",
  "paystack.list_customers": "connector-read",
  "paystack.list_transactions": "connector-read",
  "paystack.verify_transaction": "connector-read",
  "pipedrive.list_deals": "connector-read",
  "pipedrive.list_persons": "connector-read",
  "pipedrive.list_pipelines": "connector-read",
  "postgres.describe_table": "connector-read",
  "postgres.explain": "connector-read",
  "postgres.list_tables": "connector-read",
  "posthog.list_events": "connector-read",
  "posthog.list_insights": "connector-read",
  "posthog.query_insight": "connector-read",
  "redis.get": "connector-read",
  "redis.hgetall": "connector-read",
  "redis.info": "connector-read",
  "redis.keys": "connector-read",
  "resend.get_email": "connector-read",
  "resend.list_emails": "connector-read",
  "salesforce.get_object": "connector-read",
  "salesforce.query": "connector-read",
  "salesforce.search": "connector-read",
  "sendgrid.get_stats": "connector-read",
  "sendgrid.list_templates": "connector-read",
  "shopify.get_order": "connector-read",
  "shopify.list_customers": "connector-read",
  "shopify.list_orders": "connector-read",
  "shopify.list_products": "connector-read",
  "snowflake.describe_table": "connector-read",
  "snowflake.list_databases": "connector-read",
  "snowflake.list_tables": "connector-read",
  "stripe.getCharge": "connector-read",
  "stripe.getCustomer": "connector-read",
  "stripe.listCharges": "connector-read",
  "stripe.listCustomers": "connector-read",
  "stripe.listInvoices": "connector-read",
  "stripe.listSubscriptions": "connector-read",
  "supabase.get_schema": "connector-read",
  "supabase.list_files": "connector-read",
  "telegram.get_chat": "connector-read",
  "telegram.get_updates": "connector-read",
  "twilio.get_message": "connector-read",
  "twilio.list_messages": "connector-read",
  "vercel.get_deployment": "connector-read",
  "vercel.list_deployments": "connector-read",
  "vercel.list_projects": "connector-read",
  "webflow.list_collection_items": "connector-read",
  "webflow.list_collections": "connector-read",
  "webflow.list_form_submissions": "connector-read",
  "webflow.list_sites": "connector-read",
  "woocommerce.get_order": "connector-read",
  "woocommerce.list_customers": "connector-read",
  "woocommerce.list_orders": "connector-read",
  "woocommerce.list_products": "connector-read",
  "zendesk.getTicket": "connector-read",
  "zendesk.listTickets": "connector-read",
  "zendesk.listUsers": "connector-read",
  "sentry.get_issue": "issue-read", // read-only; reversible
  "diagnostics.get": "fs-read",
  // personal task management. Separate from `issue` (engineering trackers):
  // a personal to-do list has different blast radius and a different audience,
  // and trust on one should not unlock the other.
  "todoist.list_tasks": "tasks-read",
  "todoist.list_projects": "tasks-read",
  "asana.list_tasks": "tasks-read",
  "asana.get_task": "tasks-read",
  "todoist.create_task": "tasks", // compensable — todoist.delete_task exists
  "todoist.close_task": "tasks", // compensable — todoist.reopen_task exists
  "todoist.reopen_task": "tasks",
  "todoist.delete_task": "tasks",
  "asana.create_task": "tasks",
  "asana.update_task": "tasks",
  "asana.complete_task": "tasks",
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
  // Arbitrary SQL against a live database (#1311 batch 2). Irreversible for
  // the same reason `shell` is: the statement may be DDL or an unbounded
  // DELETE, and nothing here can know. Same reversibility the catch-all
  // already gave these tools — this only stops them sharing one bucket with
  // every other unclassified action.
  "db-write": "irreversible",
  http: "irreversible", // a POST may not be undoable
  issue: "compensable", // close / delete the created issue
  "issue-read": "reversible", // read-only issue queries
  ci: "reversible", // re-runnable, no durable side effect
  "deps-read": "reversible",
  "tasks-read": "reversible",
  // Connector reads (#1311 batch 1). Reversible by definition, and not a
  // judgement call: every tool mapped to this domain declares `isWrite: false`
  // in the registry — the same field that already drives the write kill-switch.
  // Before this they fell through to `other:irreversible`, which required L4
  // and so queued a plain list operation for human approval.
  "connector-read": "reversible",
  // Compensable rather than reversible: every write here has a registered
  // inverse (#1268), but running it is a NEW action with residue — a shared
  // list showed the task, a collaborator may have seen it. "Undoable" and
  // "as if it never happened" are not the same claim.
  tasks: "compensable",
  // Knowledge-base page writes (#1311 batch 3). Compensable, not reversible:
  // both Notion and Confluence keep page history, so "delete the page" and
  // "restore the previous version" are ordinary supported operations — but a
  // reader may already have seen it and a watch notification already fired.
  "docs-write": "compensable",
  // Customer-facing ticket STATE (#1311 batch 3) — not ticket text, which is
  // classified `messaging` and stays irreversible. Reopening a ticket is a
  // first-class operation in both Zendesk and Intercom, so the inverse is
  // real; the residue is that the customer was told it was closed.
  support: "compensable",
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
  // A customer watched their ticket close. Internal knowledge-base pages
  // (`docs-write`) are deliberately NOT here — the failure is embarrassing
  // internally, not customer-visible.
  "support",
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

/**
 * Operator-supplied classification for tools the bridge does not ship.
 *
 * Returns the domain (and optionally an explicit reversibility) for a tool
 * name, or `undefined` to leave it alone. Mirrors `registerTierResolver` in
 * riskTier.ts, which solves the same problem for blast tier.
 */
export type ActionDomainResolver = (
  toolName: string,
) => { domain: string; reversibility?: Reversibility } | undefined;

let actionDomainResolver: ActionDomainResolver | null = null;

/**
 * Register (or clear, with `null`) the resolver for unknown tools.
 *
 * OPERATOR-asserted, deliberately — never declared by the tool itself. A
 * reversible action bypasses the gate unconditionally, so anything that could
 * declare its own reversibility could declare itself out of governance. The
 * thing being classified must not control its classification.
 */
export function registerActionDomainResolver(
  fn: ActionDomainResolver | null,
): void {
  actionDomainResolver = fn;
}

/**
 * Resolve a domain for a tool the built-in map does not cover.
 *
 * Consulted ONLY on a miss, which is the safety property: the resolver can
 * never re-map, soften, or shadow a shipped mapping (no declaring `gitPush`
 * reversible). A throw degrades to the conservative default rather than
 * propagating — a crashing gate is an outage, and outages are the pressure
 * that gets gates switched off.
 */
function resolveUnknownDomain(
  toolName: string,
): { domain: string; reversibility?: Reversibility } | undefined {
  if (!actionDomainResolver) return undefined;
  // The agent step is carved out of gating and withheld from the outcome fold
  // by name (AGENT_STEP_TOOL), and it is absent from DOMAIN_BY_TOOL — so
  // without this it would be resolver-reachable and could be re-declared
  // reversible, softening a carve-out two other subsystems depend on.
  if (toolName === AGENT_STEP_TOOL) return undefined;
  try {
    const resolved = actionDomainResolver(toolName);
    if (!resolved || typeof resolved.domain !== "string" || !resolved.domain) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

export function classifyActionClass(
  toolName: string,
  params?: Record<string, unknown>,
): ActionClass {
  const builtIn = DOMAIN_BY_TOOL[toolName];
  const resolved =
    builtIn === undefined ? resolveUnknownDomain(toolName) : undefined;
  const domain = builtIn ?? resolved?.domain ?? "other";
  // A resolver-supplied reversibility applies only to a domain the bridge does
  // not already define. An unrecognised domain stays "irreversible" — the same
  // fail-closed default an unmapped tool gets, so a typo in operator config
  // narrows autonomy rather than widening it.
  const reversibility =
    REVERSIBILITY_BY_DOMAIN[domain] ??
    (builtIn === undefined ? resolved?.reversibility : undefined) ??
    "irreversible";
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
