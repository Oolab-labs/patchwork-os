/**
 * Orchestrator for YAML/chained recipe execution.
 * Owns in-flight dedup — prevents the same recipe firing concurrently across
 * all entry paths (HTTP webhook, CLI, scheduler, automation hooks).
 */

import type { Logger } from "../logger.js";
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
  /**
   * Safety-net TTL (ms) for the in-flight dedup entry. If a dispatch promise
   * never settles (a tool step hangs with no timeout_ms), the entry would
   * otherwise be stuck forever, permanently rejecting every future fire() for
   * that recipe with `already_in_flight` (audit 2026-06-09 orch-hang-1). When
   * the timer fires, the slot is freed so the recipe can run again. Default
   * 30 min. Set to 0 to disable.
   */
  dispatchTimeoutMs?: number;
  logger?: Logger;
}

type ResolvedFireDeps = Required<Omit<FireDeps, "logger">> &
  Pick<FireDeps, "logger">;

// M21: safety-net must exceed the per-step task timeout (1_800_000ms) so
// that clearing the in-flight slot never races a still-running first dispatch.
// Set to 4× the step timeout (2 hours) to give long recipes headroom.
export const DEFAULT_DISPATCH_TIMEOUT_MS = 4 * 1_800_000;

export class RecipeOrchestrator {
  private readonly inFlight = new Set<string>();
  private readonly inFlightTimers = new Map<string, NodeJS.Timeout>();
  private readonly fireDeps: ResolvedFireDeps;
  private readonly dispatchTimeoutMs: number;

  constructor(
    private readonly deps: RunnerDeps,
    fireDeps: FireDeps = {},
  ) {
    this.fireDeps = {
      loadYamlRecipe: fireDeps.loadYamlRecipe ?? defaultLoadYamlRecipe,
      dispatchFn: fireDeps.dispatchFn ?? dispatchRecipe,
      dispatchTimeoutMs:
        fireDeps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      logger: fireDeps.logger,
    };
    this.dispatchTimeoutMs = this.fireDeps.dispatchTimeoutMs;
  }

  /** Free the in-flight slot for `name` and clear any pending safety timer. */
  private clearInFlight(name: string): void {
    this.inFlight.delete(name);
    const timer = this.inFlightTimers.get(name);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.inFlightTimers.delete(name);
    }
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

    // Safety net: if the dispatch promise never settles (a hung tool step),
    // free the slot after the TTL so future fires aren't permanently rejected.
    if (this.dispatchTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (this.inFlight.has(name)) {
          this.fireDeps.logger?.warn?.(
            `[orchestrator] recipe "${name}" dispatch exceeded ${this.dispatchTimeoutMs}ms — clearing in-flight slot (run may still be running)`,
          );
          this.clearInFlight(name);
        }
      }, this.dispatchTimeoutMs);
      // Don't keep the process alive just for the safety timer.
      timer.unref?.();
      this.inFlightTimers.set(name, timer);
    }

    dispatch(recipe, this.deps, seedContext)
      .finally(() => {
        this.clearInFlight(name);
      })
      .catch((err: unknown) => {
        this.fireDeps.logger?.warn?.(
          `[orchestrator] recipe "${name}" dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
