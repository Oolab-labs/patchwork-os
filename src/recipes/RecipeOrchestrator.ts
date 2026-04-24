/**
 * Orchestrator for YAML/chained recipe execution.
 * Owns in-flight dedup — prevents the same recipe firing concurrently across
 * all entry paths (HTTP webhook, CLI, scheduler, automation hooks).
 */

import type { ChainedRunResult } from "./chainedRunner.js";
import {
  loadYamlRecipe as defaultLoadYamlRecipe,
  dispatchRecipe,
  type RunnerDeps,
  type RunResult,
  type YamlRecipe,
} from "./yamlRunner.js";

export type { RunnerDeps };

export type FireDedupPolicy = "reject" | "allow";

export interface FireRequest {
  filePath: string;
  name: string;
  triggerSource: string;
  seedContext?: Record<string, string>;
  dedupPolicy?: FireDedupPolicy;
  /** Per-call override for dispatch — use when dispatch logic captures call-specific state (e.g. triggerSource for claudeCodeFn). Falls back to constructor FireDeps.dispatchFn. */
  dispatchFn?: FireDeps["dispatchFn"];
}

export type FireResult =
  | { ok: true; taskId: string; name: string }
  | { ok: false; error: string };

export interface FireDeps {
  loadYamlRecipe?: (filePath: string) => YamlRecipe;
  dispatchFn?: (
    recipe: YamlRecipe,
    deps: RunnerDeps,
    seedContext?: Record<string, string>,
  ) => Promise<RunResult | ChainedRunResult>;
}

export class RecipeOrchestrator {
  private readonly inFlight = new Set<string>();
  private readonly fireDeps: Required<FireDeps>;

  constructor(
    private readonly deps: RunnerDeps,
    fireDeps: FireDeps = {},
  ) {
    this.fireDeps = {
      loadYamlRecipe: fireDeps.loadYamlRecipe ?? defaultLoadYamlRecipe,
      dispatchFn: fireDeps.dispatchFn ?? dispatchRecipe,
    };
  }

  run(
    recipe: Parameters<typeof dispatchRecipe>[0],
  ): Promise<RunResult | ChainedRunResult> {
    return dispatchRecipe(recipe, this.deps);
  }

  async fire(req: FireRequest): Promise<FireResult> {
    const { filePath, name, seedContext, dedupPolicy = "reject" } = req;
    const dispatch = req.dispatchFn ?? this.fireDeps.dispatchFn;

    if (dedupPolicy === "reject" && this.inFlight.has(name)) {
      return { ok: false, error: "already_in_flight" };
    }

    let recipe: YamlRecipe;
    try {
      recipe = this.fireDeps.loadYamlRecipe(filePath);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const taskId = `${name}-${Date.now()}`;
    this.inFlight.add(name);

    dispatch(recipe, this.deps, seedContext).finally(() => {
      this.inFlight.delete(name);
    });

    return { ok: true, taskId, name };
  }

  isInFlight(name: string): boolean {
    return this.inFlight.has(name);
  }

  listInFlight(): string[] {
    return [...this.inFlight];
  }
}
