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
  | "manual";

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

export type Trigger =
  | WebhookTrigger
  | CronTrigger
  | FileWatchTrigger
  | GitHookTrigger
  | ManualTrigger;

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

export interface Recipe {
  name: string;
  version: string;
  description?: string;
  trigger: Trigger;
  context?: ContextBlock[];
  steps: Step[];
  on_error?: ErrorPolicy;
}
