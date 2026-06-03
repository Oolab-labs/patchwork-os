/**
 * Patchwork Recipe schema — the user-authored workflow description.
 *
 * Phase 2 plan: YAML files at ~/.patchwork/recipes/*.yaml parse into this
 * shape, then compile into the bridge's AutomationProgram DSL.
 *
 * Phase-1 scaffold: JSON-only parsing (no YAML lib dep yet). YAML frontmatter
 * loader lands when a recipe requires it.
 */

export type TriggerType =
  | "webhook"
  | "cron"
  | "file_watch"
  | "git_hook"
  | "manual"
  | "chained"
  | "on_file_save"
  | "on_test_run";

export interface WebhookTrigger {
  type: "webhook";
  path: string;
}
export interface CronTrigger {
  type: "cron";
  schedule: string;
}
export interface FileWatchTrigger {
  type: "file_watch";
  patterns: string[];
}
export interface GitHookTrigger {
  type: "git_hook";
  event: "post-commit" | "pre-push" | "post-merge";
}
export interface ManualTrigger {
  type: "manual";
}

/**
 * `chained` recipes route to the ChainedRecipeRunner (dispatchRecipe in
 * yamlRunner.ts). They carry no required trigger fields of their own —
 * step-level `awaits`/`parallel`/`vars` drive execution. Modeled here so
 * the install path (parseRecipe) accepts them with parity to the JSON
 * schema and validateRecipeDefinition. Extra trigger fields (vars/inputs)
 * survive the JSON round-trip on install.
 */
export interface ChainedTrigger {
  type: "chained";
}

/**
 * `on_file_save` / `on_test_run` are the runtime-facing names for the
 * file-save and test-run triggers (yamlRunner injects `{{file}}` /
 * `{{runner}}`+`{{failed}}`+… context respectively). `glob`/`filter` are
 * optional; the bridge wires these via its own automation hooks rather
 * than the recipe compiler.
 */
export interface OnFileSaveTrigger {
  type: "on_file_save";
  glob?: string;
  filter?: string;
}
export interface OnTestRunTrigger {
  type: "on_test_run";
  filter?: string;
}

export type Trigger =
  | WebhookTrigger
  | CronTrigger
  | FileWatchTrigger
  | GitHookTrigger
  | ManualTrigger
  | ChainedTrigger
  | OnFileSaveTrigger
  | OnTestRunTrigger;

export interface FileContext {
  type: "file";
  path: string;
}
export interface EnvContext {
  type: "env";
  keys: string[];
}
export type ContextBlock = FileContext | EnvContext;

export type RiskTier = "low" | "medium" | "high";

export interface AgentStep {
  id: string;
  agent: true;
  prompt: string;
  tools?: string[];
  risk?: RiskTier;
  output?: string;
}

export interface ToolStep {
  id: string;
  agent: false;
  tool: string;
  params: Record<string, unknown>;
  risk?: RiskTier;
  output?: string;
}

export type Step = AgentStep | ToolStep;

/**
 * Recipe-level error policy. Single source of truth shared across
 * chainedRunner, yamlRunner, and generated JSON schema.
 *
 * Currently-honored fields at runtime:
 *   - retry        — integer; overridden per-step via step.retry
 *   - retryDelay   — ms between retries (default 1000); overridden per-step
 *   - fallback     — "log_only" and "deliver_original" both treat step
 *                    failure as non-fatal (like optional: true) — fail-open.
 *                    "abort" is the default (propagate).
 *   - notify       — reserved; yamlRunner currently posts Slack notifications
 *                    on any step failure when slack is connected. Gating on
 *                    this flag is not yet wired.
 */
export interface ErrorPolicy {
  retry?: number;
  retryDelay?: number;
  fallback?: "log_only" | "abort" | "deliver_original";
  notify?: boolean;
}

/**
 * PR2b — per-recipe token budget. When `tokensMax` is set, the runner
 * tracks cumulative input + output tokens from API drivers across the
 * run; on breach the run halts with a `budget_exceeded` haltReason
 * (composes with the existing halt-summary / dashboard / CLI / Prom
 * surfaces from #441/#444/#451/#452/#453).
 *
 * Subscription drivers (Claude CLI, provider subprocess CLIs) don't
 * report token counts — the runner emits a one-time warning per driver
 * per run and skips enforcement for those calls (fail-open). API
 * drivers (Anthropic API, OpenAI/Gemini/Grok subprocess that surfaces
 * usage, local LLM adapters) get full enforcement.
 *
 * Nested object (not flat `tokensMax`) so siblings — `usdMax` (added in
 * cost-routing Phase 3), and future `wallClockMs` / `stepsMax` — don't churn
 * the schema again.
 */
export interface BudgetPolicy {
  /** Cumulative input + output tokens allowed across the whole run. */
  tokensMax?: number;
  /**
   * Cumulative USD allowed across the whole run, priced from token usage via
   * the model price table (`src/recipes/pricing`). Enforced for measured +
   * priced (API) drivers; a subscription driver that reports no tokens, or a
   * model with no price-table entry, FAILS OPEN with a one-time warning and
   * never halts on it. Same `onBreach` semantics as `tokensMax`. A USD cap on
   * a subscription driver would be notional, not real money out — so it is
   * deliberately not enforced there.
   */
  usdMax?: number;
  /**
   * What to do when a budget is breached. `halt` (default) stops the
   * run on the next admission check with a `budget_exceeded` halt
   * reason. `warn` continues the run but emits a warning + records the
   * breach in the run log; useful for tuning budgets without breaking
   * production cron recipes. Applies to both `tokensMax` and `usdMax`.
   */
  onBreach?: "halt" | "warn";
  /**
   * OPT-IN, default **false**. When true, the runner ESTIMATES the notional USD
   * a subscription/unmeasured driver call would have cost at list prices (from
   * the prompt + output length) and surfaces a `≈$X` figure. This is a label
   * ONLY — estimated spend is tracked separately from `usdMax` and can NEVER
   * halt a run (subscription spend is flat-rate, not real money out; halting on
   * a ~4-chars/token guess would be wrong). Requires `usdMax` to be set (it
   * reuses the price table). Default false preserves the fail-open invariant.
   */
  estimateUnmeasured?: boolean;
}

export interface Recipe {
  name: string;
  version: string;
  description?: string;
  trigger: Trigger;
  context?: ContextBlock[];
  steps: Step[];
  /**
   * Acknowledge write-tool steps so preflight does not flag them. Each entry
   * is a tool id (e.g. "file.write") or a namespace (e.g. "slack"). Merged
   * with any --allow-write CLI flags at preflight time.
   */
  allowWrites?: string[];
  on_error?: ErrorPolicy;
  /** PR2b — see `BudgetPolicy` above. Absent = no enforcement. */
  budget?: BudgetPolicy;
}
