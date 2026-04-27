/**
 * RecipeOrchestration — owns recipe-related server fn wiring and YAML recipe
 * dispatch. Extracted from bridge.ts to reduce god-object surface area.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { recordRecipeRun } from "./activationMetrics.js";
import type { ClaudeOrchestrator } from "./claudeOrchestrator.js";
import {
  loadConfig as loadPatchworkConfig,
  saveConfig as savePatchworkConfig,
} from "./patchworkConfig.js";
import type { RecipeOrchestrator } from "./recipes/RecipeOrchestrator.js";
import type {
  SchedulerEnqueue,
  SchedulerOptions,
} from "./recipes/scheduler.js";
import { RecipeScheduler } from "./recipes/scheduler.js";
import {
  deleteRecipeContent,
  findWebhookRecipe,
  findYamlRecipePath,
  lintRecipeContent,
  listInstalledRecipes,
  loadRecipeContent,
  loadRecipePrompt,
  renderWebhookPrompt,
  saveRecipe,
  saveRecipeContent,
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
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
      return listInstalledRecipes(recipesDir) as unknown as Record<
        string,
        unknown
      >;
    };

    server.loadRecipeContentFn = (name: string) => {
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
      return loadRecipeContent(recipesDir, name);
    };

    server.saveRecipeContentFn = (name: string, content: string) => {
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
      return saveRecipeContent(recipesDir, name, content);
    };

    server.deleteRecipeContentFn = (name: string) => {
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
      return deleteRecipeContent(recipesDir, name);
    };

    server.lintRecipeContentFn = (content: string) =>
      lintRecipeContent(content);

    // biome-ignore lint/suspicious/noExplicitAny: matches Server type
    server.saveRecipeFn = (draft: any) => {
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
      return saveRecipe(recipesDir, draft);
    };

    server.setRecipeEnabledFn = (name: string, enabled: boolean) => {
      try {
        const cfg = loadPatchworkConfig();
        const disabled = new Set<string>(
          (cfg as { recipes?: { disabled?: string[] } }).recipes?.disabled ??
            [],
        );
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        savePatchworkConfig({
          ...cfg,
          recipes: {
            ...(cfg as { recipes?: Record<string, unknown> }).recipes,
            disabled: [...disabled],
          },
        } as Parameters<typeof savePatchworkConfig>[0]);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
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
          status: q.status as "done" | "error" | "cancelled" | "interrupted",
        }),
        ...(q.recipe !== undefined && { recipe: q.recipe }),
        ...(q.after !== undefined && { after: q.after }),
      }) as unknown as Record<string, unknown>[];
    };

    server.runDetailFn = (seq: number) => {
      if (!this.deps.recipeRunLog) return null;
      return this.deps.recipeRunLog.getBySeq(seq) as unknown as Record<
        string,
        unknown
      > | null;
    };

    server.runPlanFn = async (recipeName: string) => {
      const { runRecipeDryPlan } = await import("./commands/recipe.js");
      return (await runRecipeDryPlan(recipeName)) as unknown as Record<
        string,
        unknown
      >;
    };

    server.webhookFn = async (hookPath: string, payload: unknown) => {
      if (!this.deps.getOrchestrator()) {
        return {
          ok: false,
          error: "orchestrator_unavailable",
        };
      }
      const orchestrator = this.deps.getOrchestrator()!;
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");
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
        path.basename(match.filePath, path.extname(match.filePath)),
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
      const orchestrator = this.deps.getOrchestrator()!;
      const recipesDir = path.join(os.homedir(), ".patchwork", "recipes");

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
    const orch = this.deps.getOrchestrator()!;
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
    const chainedOptions = {
      sourcePath: opts.filePath,
      runLogDir: this.deps.recipeRunLog
        ? path.join(os.homedir(), ".patchwork")
        : undefined,
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
