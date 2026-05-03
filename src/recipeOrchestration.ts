/**
 * RecipeOrchestration — owns recipe-related server fn wiring and YAML recipe
 * dispatch. Extracted from bridge.ts to reduce god-object surface area.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { recordRecipeRun } from "./activationMetrics.js";
import type { ClaudeOrchestrator } from "./claudeOrchestrator.js";
import type { RecipeOrchestrator } from "./recipes/RecipeOrchestrator.js";
import type {
  SchedulerEnqueue,
  SchedulerOptions,
} from "./recipes/scheduler.js";
import { RecipeScheduler } from "./recipes/scheduler.js";
import {
  deleteRecipeContent,
  duplicateRecipe,
  findWebhookRecipe,
  findYamlRecipePath,
  lintRecipeContent,
  listInstalledRecipes,
  loadRecipeContent,
  loadRecipePrompt,
  promoteRecipeVariant,
  renderWebhookPrompt,
  saveRecipe,
  saveRecipeContent,
  setRecipeEnabled,
  setTrustLevel,
} from "./recipesHttp.js";
import type { RecipeRunLog } from "./runLog.js";
import type { Server } from "./server.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecipeOrchestrationDeps {
  server: Server;
  /** Getter — avoids stale reference after orchestrator is replaced. */
  getOrchestrator: () => ClaudeOrchestrator | null;
  recipeOrchestrator: RecipeOrchestrator;
  recipeRunLog: RecipeRunLog | null;
  /**
   * Bridge ActivityLog used to broadcast `recipe_step_start` /
   * `recipe_step_done` events for live-tail SSE consumers (dashboard
   * `/runs/[seq]` page). Optional — when absent, recipes still run, just
   * without live-tail.
   */
  activityLog?: import("./activityLog.js").ActivityLog;
  workdir: string;
  logger: { info?: (s: string) => void; warn?: (s: string) => void };
}

export interface BuildSchedulerDeps {
  recipesDir: string;
  runRecipeFn: (
    name: string,
  ) => Promise<{ ok: boolean; error?: string } | undefined>;
  enqueue: SchedulerEnqueue;
  logger: { info?: (s: string) => void; warn?: (s: string) => void };
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class RecipeOrchestration {
  constructor(private readonly deps: RecipeOrchestrationDeps) {}

  // -------------------------------------------------------------------------
  // Static factory for the cron scheduler
  // -------------------------------------------------------------------------

  static buildScheduler(deps: BuildSchedulerDeps): RecipeScheduler {
    return new RecipeScheduler({
      recipesDir: deps.recipesDir,
      enqueue: deps.enqueue,
      runYaml: async (name) => {
        const result = await deps.runRecipeFn(name);
        if (result && !result.ok) {
          throw new Error(result.error ?? "unknown error");
        }
      },
      logger: deps.logger as SchedulerOptions["logger"],
    });
  }

  // -------------------------------------------------------------------------
  // Server fn wiring
  // -------------------------------------------------------------------------

  wireServerFns(): void {
    const { server } = this.deps;

    server.recipesFn = () => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return listInstalledRecipes(recipesDir) as unknown as Record<
        string,
        unknown
      >;
    };

    server.loadRecipeContentFn = (name: string) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return loadRecipeContent(recipesDir, name);
    };

    server.saveRecipeContentFn = (name: string, content: string) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return saveRecipeContent(recipesDir, name, content);
    };

    server.deleteRecipeContentFn = (name: string) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return deleteRecipeContent(recipesDir, name);
    };

    server.duplicateRecipeFn = (name: string) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return duplicateRecipe(recipesDir, name);
    };

    server.promoteRecipeVariantFn = async (
      variantName: string,
      targetName: string,
      options?: { force?: boolean },
    ) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return promoteRecipeVariant(recipesDir, variantName, targetName, options);
    };

    server.lintRecipeContentFn = (content: string) =>
      lintRecipeContent(content);

    server.setRecipeTrustFn = (name: string, level: string) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return setTrustLevel(
        recipesDir,
        name,
        level as import("./recipesHttp.js").TrustLevel,
      );
    };

    // biome-ignore lint/suspicious/noExplicitAny: matches Server type
    server.saveRecipeFn = (draft: any) => {
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      return saveRecipe(recipesDir, draft);
    };

    server.setRecipeEnabledFn = (name: string, enabled: boolean) => {
      // Routes through `setRecipeEnabled` (recipesHttp.ts) which writes the
      // per-install `.disabled` marker for marketplace-installed recipes
      // and falls back to the legacy `cfg.recipes.disabled` config list
      // for top-level legacy files. Both surfaces (CLI + dashboard) now
      // converge on the same enable/disable semantics — fixes Bug #2 from
      // the 2026-04-28 audit where the dashboard "Disable" button silently
      // did nothing for install-dir recipes.
      return setRecipeEnabled(name, enabled);
    };

    server.runsFn = (q: {
      limit?: number;
      trigger?: string;
      status?: string;
      recipe?: string;
      after?: number;
    }) => {
      if (!this.deps.recipeRunLog) return [];
      return this.deps.recipeRunLog.query({
        ...(q.limit !== undefined && { limit: q.limit }),
        ...(q.trigger !== undefined && {
          trigger: q.trigger as "cron" | "webhook" | "recipe",
        }),
        ...(q.status !== undefined && {
          status: q.status as
            | "running"
            | "done"
            | "error"
            | "cancelled"
            | "interrupted",
        }),
        ...(q.recipe !== undefined && { recipe: q.recipe }),
        ...(q.after !== undefined && { after: q.after }),
      }) as unknown as Record<string, unknown>[];
    };

    server.runDetailFn = (seq: number) => {
      if (!this.deps.recipeRunLog) return null;
      const run = this.deps.recipeRunLog.getBySeq(seq);
      if (!run) return null;
      const childSeqs = this.deps.recipeRunLog.getChildSeqs(seq);
      return {
        ...(run as unknown as Record<string, unknown>),
        ...(childSeqs.length > 0 && { childSeqs }),
      };
    };

    server.runPlanFn = async (recipeName: string) => {
      const { runRecipeDryPlan } = await import("./commands/recipe.js");
      return (await runRecipeDryPlan(recipeName)) as unknown as Record<
        string,
        unknown
      >;
    };

    // VD-4 mocked replay: load the original run, re-parse its recipe
    // from disk (so a later edit replays against the new logic), and
    // re-fire through chainedRunner with `mockedOutputs` populated from
    // the captured per-step `output` (VD-2). No external IO; no side
    // effects.
    server.runReplayFn = async (seq: number) => {
      if (!this.deps.recipeRunLog) {
        return { ok: false, error: "run_log_unavailable" };
      }
      const original = this.deps.recipeRunLog.getBySeq(seq);
      if (!original) {
        return { ok: false, error: "run_not_found" };
      }
      // Strip ":agent" suffix that triggerSource may carry.
      const recipeName = original.recipeName.replace(/:agent$/, "");

      try {
        const { findYamlRecipePath } = await import("./recipesHttp.js");
        const recipesDir = join(homedir(), ".patchwork", "recipes");
        const recipePath = findYamlRecipePath(recipesDir, recipeName);
        if (!recipePath) {
          return { ok: false, error: "recipe_file_missing" };
        }
        const { readFileSync } = await import("node:fs");
        const { parse: parseYaml } = await import("yaml");
        const recipeYaml = parseYaml(readFileSync(recipePath, "utf-8"));
        // Only chained recipes have per-step capture today; flag others.
        const triggerType = (
          recipeYaml as { trigger?: { type?: string } } | undefined
        )?.trigger?.type;
        if (triggerType !== "chained") {
          return {
            ok: false,
            error: "replay_only_supported_for_chained_recipes",
          };
        }
        const { replayMockedRun } = await import("./recipes/replayRun.js");
        const { buildChainedDeps } = await import("./recipes/yamlRunner.js");
        // Reuse the orchestrator's claudeCodeFn for any step that falls
        // through to real execution (unmocked steps — caller is told).
        const orch = this.deps.getOrchestrator();
        const claudeCodeFn = async (prompt: string): Promise<string> => {
          if (!orch) return "";
          const task = await orch.runAndWait({
            prompt,
            triggerSource: `replay:${seq}:agent`,
            timeoutMs: 600_000,
          });
          return task.output ?? task.errorMessage ?? "";
        };
        const runnerDeps = { workdir: this.deps.workdir, claudeCodeFn };
        // buildChainedDeps just primes default tool/agent/recipe loaders.
        void buildChainedDeps;
        const result = await replayMockedRun({
          originalRun: original as unknown as import("./runLog.js").RecipeRun,
          recipe:
            recipeYaml as unknown as import("./recipes/chainedRunner.js").ChainedRecipe,
          ...(recipePath !== undefined && { sourcePath: recipePath }),
          deps: {
            runLog: this.deps.recipeRunLog,
            ...(this.deps.activityLog !== undefined && {
              activityLog: this.deps.activityLog,
            }),
            runnerDeps,
          },
        });
        return {
          ok: result.ok,
          ...(result.newSeq !== undefined && { newSeq: result.newSeq }),
          ...(result.unmockedSteps !== undefined && {
            unmockedSteps: result.unmockedSteps,
          }),
          ...(result.error !== undefined && { error: result.error }),
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    this.wireGenerateFn();

    server.webhookFn = async (hookPath: string, payload: unknown) => {
      if (!this.deps.getOrchestrator()) {
        return {
          ok: false,
          error: "orchestrator_unavailable",
        };
      }
      const orchestrator = this.deps.getOrchestrator();
      if (!orchestrator)
        return { ok: false, error: "orchestrator_unavailable" };
      const recipesDir = join(homedir(), ".patchwork", "recipes");
      const match = findWebhookRecipe(recipesDir, hookPath);
      if (!match) {
        return { ok: false, error: "not_found" };
      }
      if (match.format === "yaml") {
        let payloadText: string | undefined;
        if (payload !== undefined) {
          try {
            payloadText = JSON.stringify(payload);
          } catch {
            payloadText = String(payload);
          }
          if (payloadText.length > 8_000) {
            payloadText = `${payloadText.slice(0, 8_000)}\n…[truncated]`;
          }
        }
        const seedContext: Record<string, string> = {
          hook_path: hookPath,
          webhook_path: hookPath,
          ...(payloadText !== undefined
            ? { payload: payloadText, webhook_payload: payloadText }
            : {}),
        };
        return this.fireYamlRecipe({
          filePath: match.filePath,
          name: match.name,
          taskIdPrefix: `yaml-webhook-${match.name}`,
          triggerSourceSuffix: `webhook:${match.name}`,
          logLabel: `webhook "${match.name}"`,
          seedContext,
        });
      }
      const loaded = loadRecipePrompt(
        recipesDir,
        basename(match.filePath, extname(match.filePath)),
      );
      if (!loaded) {
        return { ok: false, error: "recipe_file_missing" };
      }
      try {
        const taskId = orchestrator.enqueue({
          prompt: renderWebhookPrompt(loaded.prompt, payload),
          triggerSource: `webhook:${match.name}`,
        });
        return { ok: true, taskId, name: match.name };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    server.runRecipeFn = async (
      name: string,
      vars?: Record<string, string>,
    ) => {
      if (!this.deps.getOrchestrator()) {
        return {
          ok: false,
          error:
            "Orchestrator unavailable — start bridge with --claude-driver subprocess",
        };
      }
      const orchestrator = this.deps.getOrchestrator();
      if (!orchestrator)
        return { ok: false, error: "orchestrator_unavailable" };
      const recipesDir = join(homedir(), ".patchwork", "recipes");

      // Try JSON recipe first (legacy path: enqueue prompt as a task).
      const loaded = loadRecipePrompt(recipesDir, name);
      if (loaded) {
        try {
          let prompt = loaded.prompt;
          if (vars && Object.keys(vars).length > 0) {
            const varLines = Object.entries(vars)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n");
            prompt = `Variables:\n${varLines}\n\n${prompt}`;
          }
          const taskId = orchestrator.enqueue({
            prompt,
            triggerSource: `recipe:${name}`,
          });
          return { ok: true, taskId };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // Fall through to YAML runner for .yaml/.yml recipes.
      const ymlPath = findYamlRecipePath(recipesDir, name);
      if (!ymlPath) {
        return {
          ok: false,
          error: `Recipe "${name}" not found in ${recipesDir}`,
        };
      }
      // Merge declared trigger.inputs[].default values with caller-provided vars.
      // Caller-provided vars always win. This lets dashboard "Run" buttons that
      // POST with no body still receive the recipe's declared input defaults
      // (e.g. team=Engineering) instead of empty strings.
      const mergedVars = applyTriggerInputDefaults(ymlPath, vars);

      return this.fireYamlRecipe({
        filePath: ymlPath,
        name,
        taskIdPrefix: `yaml-recipe-${name}`,
        triggerSourceSuffix: `recipe:${name}`,
        logLabel: `"${name}"`,
        seedContext: mergedVars,
      });
    };
  }

  // -------------------------------------------------------------------------
  // AI recipe generation
  // -------------------------------------------------------------------------

  private wireGenerateFn(): void {
    const { server } = this.deps;

    server.generateRecipeFn = async (userPrompt: string) => {
      const orch = this.deps.getOrchestrator();
      if (!orch) {
        return { ok: false, error: "driver_unavailable", unavailable: true };
      }

      let task: Awaited<ReturnType<typeof orch.runAndWait>>;
      try {
        task = await orch.runAndWait({
          prompt: `${RECIPE_GENERATION_SYSTEM_PROMPT}\n\nUser request: ${userPrompt}`,
          triggerSource: "recipe_generate",
          timeoutMs: 60_000,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (task.status !== "done" || !task.output) {
        return {
          ok: false,
          error: task.errorMessage ?? `Task ended with status: ${task.status}`,
        };
      }

      const rawYaml = extractYamlBlock(task.output);
      if (!rawYaml) {
        return { ok: false, error: "no_yaml_in_output" };
      }

      const lint = lintRecipeContent(rawYaml);
      if (!lint.ok) {
        return {
          ok: false,
          yaml: rawYaml,
          warnings: [...lint.errors, ...lint.warnings],
          error: "invalid_yaml_generated",
        };
      }

      return { ok: true, yaml: rawYaml, warnings: lint.warnings };
    };
  }

  // -------------------------------------------------------------------------
  // YAML recipe dispatch
  // -------------------------------------------------------------------------

  async fireYamlRecipe(opts: {
    filePath: string;
    name: string;
    taskIdPrefix: string;
    triggerSourceSuffix: string;
    logLabel: string;
    seedContext?: Record<string, string>;
  }): Promise<{ ok: boolean; taskId?: string; name?: string; error?: string }> {
    if (!this.deps.recipeOrchestrator) {
      return { ok: false, error: "recipe orchestrator unavailable" };
    }
    const orch = this.deps.getOrchestrator();
    if (!orch) {
      return { ok: false, error: "orchestrator_unavailable" };
    }
    const { buildChainedDeps, dispatchRecipe } = await import(
      "./recipes/yamlRunner.js"
    );
    const claudeCodeFn = async (prompt: string): Promise<string> => {
      const task = await orch.runAndWait({
        prompt,
        triggerSource: `${opts.triggerSourceSuffix}:agent`,
        timeoutMs: 600_000,
      });
      return task.output ?? task.errorMessage ?? "";
    };
    const runnerDeps = { workdir: this.deps.workdir, claudeCodeFn };
    // Pass the bridge's long-lived RecipeRunLog so chainedRunner can flip the
    // run from `running` → terminal in-place via startRun/completeRun. The
    // dashboard reads the same instance, so /runs surfaces the live entry
    // immediately. CLI invocations don't go through here — they fall back to
    // `runLogDir` + `appendDirect` (pre-VD-1 behavior, no live-tail).
    //
    // The `activityLog` enables VD-1B live-tail: when set, chainedRunner
    // broadcasts `recipe_step_start` / `recipe_step_done` events tagged with
    // `runSeq` so the dashboard's `/runs/[seq]` SSE subscription receives
    // them in real time.
    const chainedOptions = {
      sourcePath: opts.filePath,
      runLog: this.deps.recipeRunLog ?? undefined,
      activityLog: this.deps.activityLog,
    };
    const fireResult = await this.deps.recipeOrchestrator
      .fire({
        filePath: opts.filePath,
        name: opts.name,
        triggerSource: opts.triggerSourceSuffix,
        seedContext: opts.seedContext,
        dispatchFn: async (recipe, _deps, seedContext) => {
          const result = await dispatchRecipe(
            recipe,
            {
              ...runnerDeps,
              chainedDeps: buildChainedDeps(runnerDeps, claudeCodeFn),
              chainedOptions,
            },
            seedContext,
          );
          const steps =
            "stepsRun" in result
              ? result.stepsRun
              : (result.summary?.total ?? "?");
          const succeeded =
            "stepsRun" in result ? !result.errorMessage : result.success;
          if (succeeded) recordRecipeRun();
          this.deps.logger.info?.(
            `[recipe] ${opts.logLabel} finished: ${steps} steps`,
          );
          return result;
        },
      })
      .catch((err: unknown) => {
        this.deps.logger.warn?.(
          `[recipe] ${opts.logLabel} error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      });
    return fireResult;
  }
}

const RECIPE_GENERATION_SYSTEM_PROMPT = `You are a Patchwork recipe generator. Your ONLY output must be a valid Patchwork recipe in YAML format, fenced in a \`\`\`yaml block. Output nothing else — no explanation, no preamble, no trailing text.

SCHEMA:
  apiVersion: patchwork.sh/v1
  name: <slug: lowercase, hyphens, max 64 chars>
  description: <one-line description>   # optional
  trigger:
    type: manual | cron | webhook
    at: "<cron expression>"             # only when type=cron
    path: "/hooks/<slug>"               # only when type=webhook
  vars:                                 # optional
    - name: VAR_NAME
      description: hint for caller
      required: true | false
      default: "value"
  steps:
    - id: step-1
      agent:
        prompt: |
          <what Claude should do in this step>
        into: step_1_output

RULES:
1. Trigger inference: "every morning/daily/weekly/at Nhm" → cron; "webhook" → webhook; otherwise → manual.
2. Steps: decompose into 1–4 agent steps. Each prompt should be self-contained; reference prior step outputs as {{step_id_output}}.
3. Name: derive a slug from the description (e.g. "daily github digest" → "daily-github-digest").
4. Vars: declare caller-supplied values (email, repo, channel) as vars with required: true.
5. Step prompts are plain natural-language — do NOT invent tool names.

EXAMPLES:
User: every morning, summarize my GitHub notifications and email me a digest
\`\`\`yaml
apiVersion: patchwork.sh/v1
name: morning-github-digest
description: Daily summary of GitHub notifications delivered by email
trigger:
  type: cron
  at: "0 8 * * 1-5"
vars:
  - name: EMAIL
    description: Email address to send the digest to
    required: true
steps:
  - id: fetch-notifications
    agent:
      prompt: |
        Fetch my unread GitHub notifications from the last 24 hours.
        Summarize them grouped by repository: PR reviews, issues, mentions.
        One line per item.
      into: notifications_summary
  - id: send-digest
    agent:
      prompt: |
        Send an email to {{EMAIL}} with subject "Morning GitHub Digest".
        Body: {{notifications_summary}}
      into: send_result
\`\`\`

User: when a new Sentry issue arrives, create a Linear ticket and post to Slack
\`\`\`yaml
apiVersion: patchwork.sh/v1
name: sentry-to-linear-slack
description: Triage new Sentry issues to Linear and Slack
trigger:
  type: webhook
  path: "/hooks/sentry-issues"
vars:
  - name: SLACK_CHANNEL
    description: Slack channel to notify
    required: false
    default: "#incidents"
steps:
  - id: create-linear-ticket
    agent:
      prompt: |
        A new Sentry issue arrived. Payload: {{payload}}
        Create a Linear ticket in the Bug triage team with priority High.
        Title: the Sentry issue title. Include the Sentry URL in the description.
      into: linear_ticket
  - id: notify-slack
    agent:
      prompt: |
        Post to {{SLACK_CHANNEL}}: "New Sentry issue triaged → {{linear_ticket}}"
      into: slack_result
\`\`\``;

function extractYamlBlock(text: string): string | null {
  const fenced = /```(?:yaml)?\n([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const trimmed = text.trim();
  if (/^(?:apiVersion:|name:|#\s*yaml-language-server)/.test(trimmed))
    return trimmed;
  return null;
}

/**
 * Read a YAML recipe's trigger.inputs[] declarations and merge any declared
 * defaults underneath caller-provided vars. Caller vars always win. Tolerates
 * missing files / malformed YAML / non-array inputs by returning the original
 * vars untouched.
 */
function applyTriggerInputDefaults(
  ymlPath: string,
  vars?: Record<string, string>,
): Record<string, string> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(ymlPath, "utf-8"));
  } catch {
    return vars;
  }
  const trigger = (parsed as { trigger?: unknown } | null)?.trigger;
  const inputs = (trigger as { inputs?: unknown } | null)?.inputs;
  if (!Array.isArray(inputs)) return vars;

  const defaults: Record<string, string> = {};
  for (const item of inputs) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    const dflt = (item as { default?: unknown }).default;
    if (typeof name !== "string" || name.length === 0) continue;
    if (dflt === undefined || dflt === null) continue;
    defaults[name] = String(dflt);
  }

  if (Object.keys(defaults).length === 0) return vars;
  return { ...defaults, ...(vars ?? {}) };
}
