import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import { loadRecipePrompt } from "../recipesHttp.js";

/**
 * RecipeScheduler — runs cron-triggered recipes on a simple interval.
 *
 * Phase-0 scope supports the `@every Ns|Nm|Nh` schedule form, which is
 * enough to demonstrate "works while you're away" without pulling in a full
 * cron dependency. Standard 5-field expressions can be added later.
 *
 * Scheduler is a pure consumer of the recipes-on-disk contract and an
 * injected enqueue fn, so it's trivial to unit test without the orchestrator.
 */

export type SchedulerEnqueue = (opts: {
  prompt: string;
  triggerSource: string;
}) => string;

export interface ScheduledRecipe {
  name: string;
  schedule: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
}

export interface SchedulerOptions {
  recipesDir: string;
  enqueue: SchedulerEnqueue;
  logger?: Logger;
  /** Override for tests — defaults to setInterval. */
  setInterval?: typeof setInterval;
  /** Override for tests — defaults to clearInterval. */
  clearInterval?: typeof clearInterval;
}

export class RecipeScheduler {
  private scheduled: ScheduledRecipe[] = [];
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(private readonly opts: SchedulerOptions) {
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
  }

  start(): ScheduledRecipe[] {
    this.stop();
    let entries: string[];
    try {
      entries = readdirSync(this.opts.recipesDir);
    } catch {
      return [];
    }
    for (const f of entries) {
      if (!f.endsWith(".json") || f.endsWith(".permissions.json")) continue;
      const fullPath = path.join(this.opts.recipesDir, f);
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          name?: string;
          trigger?: { type?: string; schedule?: string };
        };
        if (parsed.trigger?.type !== "cron") continue;
        if (
          !parsed.trigger.schedule ||
          typeof parsed.trigger.schedule !== "string"
        )
          continue;
        const intervalMs = parseSchedule(parsed.trigger.schedule);
        if (intervalMs === null) {
          this.opts.logger?.warn?.(
            `[scheduler] ignoring recipe "${parsed.name ?? f}" — unsupported schedule "${parsed.trigger.schedule}" (use @every Ns|Nm|Nh)`,
          );
          continue;
        }
        const name = parsed.name ?? path.basename(f, ".json");
        const timer = this.setIntervalFn(() => {
          this.fire(name);
        }, intervalMs);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        this.scheduled.push({
          name,
          schedule: parsed.trigger.schedule,
          intervalMs,
          timer,
        });
        this.opts.logger?.info?.(
          `[scheduler] "${name}" scheduled every ${intervalMs}ms (${parsed.trigger.schedule})`,
        );
      } catch {
        // skip malformed recipe
      }
    }
    return this.scheduled;
  }

  stop(): void {
    for (const entry of this.scheduled) {
      this.clearIntervalFn(entry.timer);
    }
    this.scheduled = [];
  }

  list(): ReadonlyArray<Omit<ScheduledRecipe, "timer">> {
    return this.scheduled.map(({ timer: _t, ...rest }) => rest);
  }

  /** Test hook: dispatch a recipe immediately without waiting for the interval. */
  fireForTest(name: string): void {
    this.fire(name);
  }

  private fire(name: string): void {
    const loaded = loadRecipePrompt(this.opts.recipesDir, name);
    if (!loaded) {
      this.opts.logger?.warn?.(
        `[scheduler] skipped "${name}" — recipe file disappeared`,
      );
      return;
    }
    try {
      this.opts.enqueue({
        prompt: loaded.prompt,
        triggerSource: `cron:${name}`,
      });
      this.opts.logger?.info?.(`[scheduler] enqueued "${name}"`);
    } catch (err) {
      this.opts.logger?.warn?.(
        `[scheduler] failed to enqueue "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Parse @every forms into milliseconds. Returns null for unsupported schedules. */
export function parseSchedule(schedule: string): number | null {
  const trimmed = schedule.trim();
  const m = /^@every\s+(\d+)\s*(ms|s|m|h)$/i.exec(trimmed);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : 60 * 60_000;
  return n * multiplier;
}
