import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../logger.js";
import { loadConfig } from "../patchworkConfig.js";
import { findYamlRecipePath, loadRecipePrompt } from "../recipesHttp.js";

/**
 * RecipeScheduler — runs cron-triggered recipes on a simple interval or
 * standard 5-field cron expression.
 *
 * Supported schedule forms:
 *   @every Ns|Nm|Nh  — simple interval (setInterval-based)
 *   <5-field cron>   — standard cron expression (node-cron-based)
 *
 * Scheduler is a pure consumer of the recipes-on-disk contract and an
 * injected enqueue fn, so it's trivial to unit test without the orchestrator.
 */

export type SchedulerEnqueue = (opts: {
  prompt: string;
  triggerSource: string;
}) => string;

export type SchedulerRunYaml = (name: string) => Promise<void>;

export interface ScheduledRecipe {
  name: string;
  schedule: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval>;
  /** Present only for cron5-kind recipes. */
  cronJob?: cron.ScheduledTask;
}

export interface SchedulerOptions {
  recipesDir: string;
  enqueue: SchedulerEnqueue;
  /** Called for YAML recipes instead of enqueue. */
  runYaml?: SchedulerRunYaml;
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

    // Load disabled list from config
    let disabled: Set<string> = new Set();
    try {
      const cfg = loadConfig();
      if (cfg.recipes?.disabled) {
        disabled = new Set(cfg.recipes.disabled);
      }
    } catch {
      // non-fatal — proceed with empty disabled set
    }

    let entries: string[];
    try {
      entries = readdirSync(this.opts.recipesDir);
    } catch {
      return [];
    }

    for (const f of entries) {
      const isJson = f.endsWith(".json") && !f.endsWith(".permissions.json");
      const isYaml = f.endsWith(".yaml") || f.endsWith(".yml");
      if (!isJson && !isYaml) continue;

      const fullPath = path.join(this.opts.recipesDir, f);
      try {
        let name: string;
        let schedule: string | undefined;

        if (isJson) {
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
          schedule = parsed.trigger.schedule;
          name = parsed.name ?? path.basename(f, ".json");
        } else {
          // YAML
          const raw = readFileSync(fullPath, "utf-8");
          const parsed = parseYaml(raw) as {
            name?: string;
            trigger?: { type?: string; at?: string; schedule?: string };
          };
          if (parsed.trigger?.type !== "cron") continue;
          schedule = parsed.trigger.at ?? parsed.trigger.schedule;
          if (!schedule || typeof schedule !== "string") continue;
          name =
            parsed.name ?? path.basename(f, isYaml ? path.extname(f) : ".yaml");
        }

        // Apply disabled filter
        if (disabled.has(name)) {
          this.opts.logger?.info?.(
            `[scheduler] skipping disabled recipe "${name}"`,
          );
          continue;
        }

        const parsed2 = parseSchedule(schedule);
        if (parsed2 === null) {
          this.opts.logger?.warn?.(
            `[scheduler] ignoring recipe "${name}" — unsupported schedule "${schedule}" (use @every Ns|Nm|Nh or a 5-field cron expression)`,
          );
          continue;
        }

        if (parsed2.kind === "interval") {
          const intervalMs = parsed2.intervalMs;
          const timer = this.setIntervalFn(() => {
            this.fire(name);
          }, intervalMs);
          if (typeof timer === "object" && "unref" in timer) timer.unref();
          this.scheduled.push({
            name,
            schedule,
            intervalMs,
            timer,
          });
          this.opts.logger?.info?.(
            `[scheduler] "${name}" scheduled every ${intervalMs}ms (${schedule})`,
          );
        } else {
          // cron5
          const cronJob = cron.schedule(parsed2.expression, () => {
            this.fire(name);
          });
          // Store a sentinel timer so the ScheduledRecipe shape stays stable
          const dummyTimer = this.setIntervalFn(() => {}, 2_147_483_647);
          if (typeof dummyTimer === "object" && "unref" in dummyTimer)
            dummyTimer.unref();
          this.scheduled.push({
            name,
            schedule,
            intervalMs: 0,
            timer: dummyTimer,
            cronJob,
          });
          this.opts.logger?.info?.(
            `[scheduler] "${name}" scheduled with cron expression "${schedule}"`,
          );
        }
      } catch {
        // skip malformed recipe
      }
    }
    return this.scheduled;
  }

  stop(): void {
    for (const entry of this.scheduled) {
      if (entry.cronJob) {
        entry.cronJob.stop();
      } else {
        this.clearIntervalFn(entry.timer);
      }
    }
    this.scheduled = [];
  }

  restart(): void {
    this.stop();
    this.start();
  }

  list(): ReadonlyArray<Omit<ScheduledRecipe, "timer" | "cronJob">> {
    return this.scheduled.map(({ timer: _t, cronJob: _c, ...rest }) => rest);
  }

  /** Test hook: dispatch a recipe immediately without waiting for the interval. */
  fireForTest(name: string): void {
    this.fire(name);
  }

  private fire(name: string): void {
    // YAML recipe — delegate to runYaml if provided
    const yamlPath = findYamlRecipePath(this.opts.recipesDir, name);

    if (yamlPath) {
      if (!this.opts.runYaml) {
        this.opts.logger?.warn?.(
          `[scheduler] skipped "${name}" — YAML recipe requires runYaml callback (start bridge with --claude-driver)`,
        );
        return;
      }
      this.opts.runYaml(name).catch((err) => {
        this.opts.logger?.warn?.(
          `[scheduler] YAML recipe "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      this.opts.logger?.info?.(`[scheduler] fired YAML recipe "${name}"`);
      return;
    }

    // JSON recipe — legacy path
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

type ParsedSchedule =
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron5"; expression: string };

/** Parse @every forms into milliseconds, or detect a 5-field cron expression. Returns null for unsupported schedules. */
export function parseSchedule(schedule: string): ParsedSchedule | null {
  const trimmed = schedule.trim();

  // @every Ns|Nm|Nh
  const m = /^@every\s+(\d+)\s*(ms|s|m|h)$/i.exec(trimmed);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    const unit = m[2]?.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return null;
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1000
          : unit === "m"
            ? 60_000
            : 60 * 60_000;
    return { kind: "interval", intervalMs: n * multiplier };
  }

  // 5-field cron expression (e.g. "0 8 * * 1-5")
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(trimmed)) {
    if (cron.validate(trimmed)) {
      return { kind: "cron5", expression: trimmed };
    }
  }

  return null;
}
