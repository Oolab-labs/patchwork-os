/**
 * Halt-category derivation.
 *
 * PR1c of the Val-inspired plan. PR1 attached a `haltReason` sentence to
 * every error-status StepResult; this module categorises those sentences
 * into a small bounded enum so the dashboard / metrics layer can count
 * them over time. Foundation for "is the haltReason work actually
 * surfacing useful signal, or is everything landing in `unknown`?"
 *
 * The mapping is intentionally pattern-based against the 5 phrases
 * emitted by yamlRunner.ts. Keep this file and those phrases in sync.
 * When a new error site is added, add a category here AND a test.
 */

export type HaltCategory =
  | "agent_silent_fail"
  | "agent_narration_only"
  | "agent_threw"
  | "tool_threw"
  | "tool_error"
  /** Write blocked by the global kill-switch (#422). Distinct from a real tool failure. */
  | "kill_switch"
  /** Effective policy refused the step before dispatch (governed profile: plugin allowlist, recipe tool allowlist, worker forbid). */
  | "policy_denied"
  /** No tool is registered under the step's id; the governed profile refuses rather than skips. */
  | "unresolved_tool"
  /** Recipe's `tokensMax` budget breached (PR2b). */
  | "budget_exceeded"
  /**
   * The composed prompt exceeded the agent prompt byte cap, so the step was
   * refused BEFORE dispatch. Its own category, not `budget_exceeded`: that one
   * means real tokens or dollars were spent up to a ceiling the author set,
   * while this one means nothing was spent and nothing was sent. Not
   * `agent_threw` either — no model was called, so a run trace shows no model
   * call to open.
   */
  | "prompt_too_large"
  /** Per-step `expect` assertion failed (slice 2). */
  | "expect_failed"
  /** Per-step wall-clock `timeout_ms` exceeded (sandbox-alternative slice). */
  | "step_timeout"
  /**
   * Opt-in judge→refine loop exhausted its `max_revisions` budget and the
   * judge still returned `request_changes` with `on_exhausted: "halt"`.
   */
  | "judge_revisions_exhausted"
  /**
   * Connector returned 401/403 — token expired or scopes insufficient.
   * Actionable: user should reconnect from /connections.
   */
  | "auth_failure"
  /**
   * External service returned 429 / rate limit. Actionable: retry later
   * or back off the cron cadence.
   */
  | "rate_limited"
  /**
   * Transport failed before the request reached the service
   * (ECONNREFUSED, ENOTFOUND, fetch failed). Distinct from a 4xx/5xx
   * from the service itself — usually a local network / DNS issue.
   */
  | "network_error"
  /**
   * Tool needed a connector that isn't configured for this workspace.
   * Actionable: install/connect from /connections.
   */
  | "missing_connector"
  /**
   * A human rejected the step at the flat-runner approval gate (M3). Distinct
   * from a tool failure — the run was deliberately stopped by an operator.
   */
  | "approval_rejected"
  /**
   * The approval TTL fired with nobody having answered. NOT a rejection: no
   * person looked at this step. Its own category because the remedies do not
   * overlap — a rejection is answered by discussing the step, an expiry by
   * noticing that an unattended run queued something nobody was awake to see.
   * The queue entry is already resolved, so "go and approve it" is advice that
   * cannot be followed.
   */
  | "approval_expired"
  /**
   * The run was cancelled while a step waited for approval. Nobody decided
   * anything about the step — the thing it belonged to went away.
   */
  | "approval_cancelled"
  /** Whole-recipe failure (e.g. circular dependencies) — has no step row. */
  | "run_level"
  /**
   * The run finished its steps but violated its RUN-LEVEL completion contract
   * (`recipe.expect` → `assertionFailures`). Distinct from `expect_failed`,
   * which is a per-STEP assertion and arrives as an error step row.
   *
   * Its own category because such a run finishes `done`, not `error`: the
   * operator-facing halt count could not see it at all, so "nothing halted"
   * and "the job did not do what it promised" were the same reading.
   */
  | "contract_failed"
  /**
   * The step uses a construct this runner does not implement (a compound
   * step — `parallel`, `each`, `recipe`, `chain`, `branch` — on a non-chained
   * recipe). An AUTHORING defect, not a runtime failure: nothing was attempted
   * and a retry cannot help. Its own category because the fix is specific and
   * knowable ("use fan_out, or make the recipe chained") — folding it into
   * `unknown` would send the author to a run trace that shows nothing.
   */
  | "unsupported_step"
  | "unknown";

/**
 * Human-readable label per category. Shared by the `halts` CLI, the
 * `recipe doctor` command, and (mirrored) the dashboard, so the wording
 * stays consistent across surfaces.
 */
export const HALT_CATEGORY_LABELS: Record<HaltCategory, string> = {
  agent_silent_fail: "agent silent-fail",
  agent_narration_only: "agent narration-only",
  agent_threw: "agent threw",
  tool_threw: "tool threw",
  tool_error: "tool error",
  kill_switch: "kill-switch blocked",
  policy_denied: "policy refused",
  unresolved_tool: "tool not registered",
  budget_exceeded: "budget exceeded",
  prompt_too_large: "prompt too large",
  expect_failed: "expect failed",
  step_timeout: "step timeout",
  judge_revisions_exhausted: "judge revisions exhausted",
  auth_failure: "auth failure",
  rate_limited: "rate limited",
  network_error: "network error",
  missing_connector: "missing connector",
  approval_rejected: "approval rejected",
  approval_expired: "approval expired",
  approval_cancelled: "approval cancelled",
  run_level: "run-level halt",
  contract_failed: "completion contract failed",
  unsupported_step: "unsupported step form",
  unknown: "uncategorised",
};

/**
 * Actionable one-liner per category — "what to do about it". Shared by
 * the `halts` CLI and `recipe doctor` so SSH / mobile users get the fix
 * hint without opening the dashboard.
 */
export const HALT_CATEGORY_HINTS: Record<HaltCategory, string> = {
  agent_silent_fail: "inspect prompt + check trace",
  agent_narration_only: "tighten prompt or add `into:` target",
  agent_threw: "open run trace",
  tool_threw: "check inner error in trace",
  tool_error: "check inner error in trace",
  kill_switch: "run `patchwork kill-switch release`",
  policy_denied:
    "run `patchwork policy explain <recipe> <tool>` to see which stage refused",
  unresolved_tool:
    "run `recipe doctor`; install or allowlist the plugin that provides the tool",
  budget_exceeded: "raise tokensMax / usdMax or shrink prompts",
  prompt_too_large:
    "shorten the step prompt, or the tool output it interpolates — nothing was sent",
  expect_failed: "inspect assertion vs actual output",
  step_timeout: "bump timeout_ms or speed up step",
  judge_revisions_exhausted:
    "raise max_revisions, refine the prompt, or set on_exhausted: proceed",
  auth_failure: "reconnect from /connections",
  rate_limited: "back off cron cadence or wait",
  network_error: "check connectivity to upstream",
  missing_connector: "install/connect from /connections",
  approval_rejected:
    "approve the step from the dashboard, or set requireApproval: false",
  // Deliberately does NOT say "approve it": the queue entry the TTL resolved
  // no longer exists, so that is advice nobody can act on. This is the whole
  // operator-facing cost of the conflation this category was split out of.
  approval_expired:
    "nobody answered before the approval timed out — an unattended run needs someone watching, `requireApproval: false`, or a longer approval timeout",
  approval_cancelled: "the run was cancelled while waiting — re-run it",
  run_level: "check recipe for circular deps / parse errors",
  contract_failed:
    "the run finished but broke its `expect` postcondition — compare the assertion with the run output",
  unsupported_step: "use `fan_out`, or set trigger.type: chained",
  unknown: "open run trace for raw error",
};

export function categoriseHaltReason(reason: string | undefined): HaltCategory {
  if (!reason) return "unknown";
  // Order matters: more specific phrases (silent-fail, narration, kill
  // switch) must match before the general "Agent step ... threw" /
  // "Tool ... threw" patterns. The phrases below mirror
  // yamlRunner.ts:558-606,677-684,693-708 and
  // featureFlags.ts:assertWriteAllowed.
  if (/silent-fail/i.test(reason)) return "agent_silent_fail";
  if (/narration|whitespace|no content/i.test(reason))
    return "agent_narration_only";
  if (/kill[- _]?switch/i.test(reason)) return "kill_switch";
  if (/budget[_ ]?exceeded|exceeded its token budget/i.test(reason))
    return "budget_exceeded";
  // Before every generic matcher: the sentence contains "agent step failed",
  // which `agent_threw` would otherwise claim.
  if (/prompt_too_large/i.test(reason)) return "prompt_too_large";
  // Both must precede the rejection matcher: its `rejected by .*approval`
  // alternative is broad, and a mis-ordered expiry reading as a rejection is
  // exactly the failure this split exists to end.
  if (/approval[_ ]?expired|approval expired/i.test(reason))
    return "approval_expired";
  if (/approval[_ ]?cancelled|approval cancelled/i.test(reason))
    return "approval_cancelled";
  if (/approval[_ ]?rejected|rejected by .*approval/i.test(reason))
    return "approval_rejected";
  if (/^expect_failed/i.test(reason)) return "expect_failed";
  // Compound step on a non-chained recipe (yamlRunner's COMPOUND_STEP_KEYS
  // guard). Authoring defect — must precede every runtime-failure matcher.
  if (/is not supported in this recipe/i.test(reason))
    return "unsupported_step";
  // Opt-in judge→refine loop exhaustion (`judge "x" did not approve after N
  // revisions`). Must precede the generic `Agent step ... threw` matcher.
  if (/did not approve after \d+ revision/i.test(reason))
    return "judge_revisions_exhausted";
  // Must precede the `^Tool ... threw` matcher: timeouts surface wrapped
  // inside the tool-threw envelope (`Tool "x" in step "y" threw: step_timeout: ...`).
  if (/step_timeout/i.test(reason)) return "step_timeout";
  // Sub-categories that peek inside the wrapped `Tool "x" threw: <inner>` /
  // `Tool "x" reported an error: <inner>` envelope. Must precede the
  // generic `tool_threw` / `tool_error` matchers below. Patterns are
  // deliberately narrow — e.g. "unreachable" alone stays in `tool_error`
  // because too many tools use it as a generic phrase.
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?token|token[_ -]?expired|authentication[_ -]?failed/i.test(
      reason,
    )
  )
    return "auth_failure";
  if (/\b429\b|rate[_ -]?limit|too many requests/i.test(reason))
    return "rate_limited";
  if (
    /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network[_ -]?error|getaddrinfo/i.test(
      reason,
    )
  )
    return "network_error";
  if (
    /connector[_ -]?not[_ -]?configured|no[_ -]?(connector[_ -]?)?token|not[_ -]?connected|missing[_ -]?connector/i.test(
      reason,
    )
  )
    return "missing_connector";
  if (/^Agent step .* threw/i.test(reason)) return "agent_threw";
  if (/^Tool .* threw/i.test(reason)) return "tool_threw";
  if (/^Tool .* reported an error/i.test(reason)) return "tool_error";
  return "unknown";
}

/**
 * The halt sentence + category for a refused approval, in ONE place.
 *
 * Both runners emitted this sentence as their own string literal, and the
 * chained one recovers its category by matching the sentence with
 * `categoriseHaltReason` — so a sentence written twice is a category derived
 * from a phrase that only one of the two copies still matches. Same reason
 * `agentTextFromTask` exists.
 *
 * An ABSENT refusal keeps the pre-existing sentence verbatim. A gate that
 * returned a bare `false` said "not approved" and nothing more; rendering that
 * as an expiry or a cancellation would invent a fact, and rendering it as
 * anything but today's text would break every caller that already reads it.
 */
export function approvalHaltFor(
  refusal?: import("./approvalRequest.js").ApprovalRefusal,
): { reason: string; category: HaltCategory } {
  if (refusal === "expired") {
    return {
      reason:
        "Step approval expired before anyone answered — approval_expired.",
      category: "approval_expired",
    };
  }
  if (refusal === "cancelled") {
    return {
      reason: "Step approval cancelled with the run — approval_cancelled.",
      category: "approval_cancelled",
    };
  }
  return {
    reason: "Step rejected by approval gate — approval_rejected.",
    category: "approval_rejected",
  };
}

export interface HaltSummary {
  /** Total error-status step results scanned. */
  total: number;
  /** Per-category counts; categories with zero hits are omitted. */
  byCategory: Partial<Record<HaltCategory, number>>;
  /** Most recent 5 halt reasons (verbatim) for surfacing in the UI. */
  recent: Array<{ reason: string; category: HaltCategory; runSeq: number }>;
}

export interface HaltSummaryInputRun {
  seq: number;
  /** Top-level run status — `run_level` halts are runs with status === "error" but no error stepResults (e.g. circular-dep failure before any step ran). */
  status?: "running" | "done" | "error" | "cancelled" | "interrupted";
  /** Top-level errorMessage — surfaced as a `run_level` halt when no per-step halts cover it. */
  errorMessage?: string;
  /**
   * Run-level `recipe.expect` violations. Present on the run-log row already
   * — the runner persists them — so every caller passing a whole row gets
   * this for free and no call site changes.
   */
  assertionFailures?: Array<{ message?: string } | unknown>;
  stepResults?: Array<{
    status: "ok" | "skipped" | "error";
    haltReason?: string;
    /** Pre-tagged category from yamlRunner throw site — avoids regex re-derivation when present. */
    haltCategory?: HaltCategory;
  }>;
}

/**
 * Aggregate halt categories across a set of runs. Runs are expected to be
 * sorted newest-first so `recent` reflects the most recent halts.
 *
 * A run contributes:
 * - one entry per error-status stepResult that has a `haltReason`
 * - plus one `run_level` entry if `status === "error"` and there were no
 *   per-step halts that already explained it (avoids double-counting).
 * - plus ONE `contract_failed` entry if the run violated its run-level
 *   `recipe.expect`, regardless of the two above.
 *
 * The contract entry is deliberately NOT guarded on the step count, unlike
 * `run_level`. That guard exists because a run's `errorMessage` usually
 * restates a step failure already counted — the same fact twice. A violated
 * postcondition is a DIFFERENT fact: every step can succeed and the run still
 * fail to deliver what it promised, and a step can fail for a reason
 * unrelated to the assertion that also failed.
 *
 * ONE entry per run, not one per failure. A run with three assertion failures
 * broke one contract in three ways; counting three would inflate the halt
 * count against "incomplete jobs", which is the reading this count is for.
 */
export function summariseHalts(runs: HaltSummaryInputRun[]): HaltSummary {
  const byCategory: Partial<Record<HaltCategory, number>> = {};
  const recent: HaltSummary["recent"] = [];
  let total = 0;
  for (const run of runs) {
    let stepHaltsForRun = 0;
    for (const step of run.stepResults ?? []) {
      if (step.status !== "error" || !step.haltReason) continue;
      stepHaltsForRun++;
      total++;
      const cat = step.haltCategory ?? categoriseHaltReason(step.haltReason);
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      if (recent.length < 5) {
        recent.push({
          reason: step.haltReason,
          category: cat,
          runSeq: run.seq,
        });
      }
    }
    const assertionCount = run.assertionFailures?.length ?? 0;
    if (assertionCount > 0) {
      total++;
      byCategory.contract_failed = (byCategory.contract_failed ?? 0) + 1;
      if (recent.length < 5) {
        recent.push({
          // Names the count rather than quoting an assertion: the assertion
          // text can carry run output, and `recent` is rendered in the CLI,
          // the dashboard and a Prometheus-adjacent surface.
          reason: `run-level expect failed (${assertionCount} assertion${
            assertionCount === 1 ? "" : "s"
          })`,
          category: "contract_failed",
          runSeq: run.seq,
        });
      }
    }
    if (stepHaltsForRun === 0 && run.status === "error" && run.errorMessage) {
      total++;
      byCategory.run_level = (byCategory.run_level ?? 0) + 1;
      if (recent.length < 5) {
        recent.push({
          reason: run.errorMessage,
          category: "run_level",
          runSeq: run.seq,
        });
      }
    }
  }
  return { total, byCategory, recent };
}

/**
 * Format a `HaltSummary` as Prometheus text-exposition lines for the
 * `bridge_recipe_halts{category="..."} N` gauge. Returns an empty array
 * when the summary is empty (no HELP/TYPE block emitted in that case so
 * Prom scrapers don't see an orphan declaration).
 *
 * Surfaced via `/metrics` so users with their own observability stack
 * can dashboard halts without using Patchwork's UI.
 */
export function haltSummaryToPrometheus(summary: HaltSummary): string[] {
  if (summary.total === 0) return [];
  const lines: string[] = [
    "# HELP bridge_recipe_halts Recipe halts in the in-memory run-log window, by category",
    "# TYPE bridge_recipe_halts gauge",
  ];
  for (const [category, count] of Object.entries(summary.byCategory)) {
    lines.push(`bridge_recipe_halts{category="${category}"} ${count}`);
  }
  return lines;
}

/**
 * Derive a one-sentence haltReason from a step's error-status + raw error
 * string. Used by `chainedRunner` to mirror the convention emitted by
 * `yamlRunner`. Returns `undefined` for non-error rows or missing error.
 *
 * Pattern-matches the same phrases `categoriseHaltReason` knows about,
 * so chained-run haltReasons categorise into the same buckets.
 */
export function deriveHaltReasonFromError(opts: {
  stepId: string;
  toolName?: string;
  isAgent?: boolean;
  status: "ok" | "skipped" | "error";
  error?: string;
}): string | undefined {
  if (opts.status !== "error" || !opts.error) return undefined;
  if (/silent-fail/i.test(opts.error)) {
    return `Step "${opts.stepId}" returned no usable output (silent-fail).`;
  }
  if (/narration|whitespace|no content/i.test(opts.error)) {
    return `Step "${opts.stepId}" returned only narration or whitespace — no content.`;
  }
  if (opts.isAgent) {
    return `Agent step "${opts.stepId}" threw before completing: ${opts.error}`;
  }
  return `Tool "${opts.toolName ?? "?"}" in step "${opts.stepId}" reported an error: ${opts.error}`;
}
