import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
// `ScheduledTask` is a NAMED type export in node-cron 4.x. It was reachable
// as `cron.ScheduledTask` only because 4.2.1 also emitted a namespace; 4.6.0
// — the version production has been running — does not, so the repo would
// not compile against the library it deploys. See
// `__tests__/schedulerDependencyPin.test.ts` for why the caret allowed that.
import cron, { type ScheduledTask } from "node-cron";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../logger.js";
import { loadConfig } from "../patchworkConfig.js";
import { findYamlRecipePath, loadRecipePrompt } from "../recipesHttp.js";
import {
  type ClaimOptions,
  claimCronSlot,
  sweepCronClaims,
} from "./cronClaim.js";
import {
  getConfigDisabledNames,
  isInstallDirDisabled,
} from "./disabledMarkers.js";

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
  cronJob?: ScheduledTask;
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
  /**
   * Override the disabled-recipe set. Defaults to reading from
   * `loadConfig()` (the operator's ~/.patchwork/config.json). Tests inject
   * an empty array so a stale disabled entry on the dev machine doesn't
   * silently make the scheduler skip a freshly-fixtured recipe.
   */
  disabledRecipes?: ReadonlyArray<string>;
  /**
   * IANA timezone for cron expressions, e.g. "America/New_York". Defaults to
   * `loadConfig().recipes?.timezone ?? "UTC"` at start time. Tests can inject
   * this to avoid depending on the dev machine's config.
   */
  timezone?: string;
  /**
   * Cron-claim store override (#1458). Tests point it at a temp root; the two
   * real bridges share the default under PATCHWORK_HOME, which is exactly the
   * scope of the shared recipe store that causes the double-fire.
   */
  claim?: ClaimOptions;
}

/**
 * The instant the cron matcher matched, as a second-aligned epoch value.
 *
 * node-cron hands the task callback a context whose `date` is the matched
 * instant with milliseconds already zeroed, derived from the matcher rather
 * than from the moment the callback happens to run. Two processes evaluating
 * the same expression in the same timezone therefore produce the byte-identical
 * value — which is the only reason a filesystem claim can dedupe them.
 *
 * `triggeredAt` on the same context is `new Date()` and must NEVER be used: it
 * differs per process by exactly the amount that breaks the key.
 *
 * Returns `undefined` when there is no usable context, so an older or newer
 * node-cron that does not pass one degrades to today's behaviour — no slot, no
 * claim, both bridges fire — rather than throwing inside a timer callback.
 *
 * Exported for tests. The alternative is asserting it through a live cron tick,
 * which means a real timer and a real second boundary in CI — and this repo has
 * spent enough of its life on timing flakes.
 */
export function matchedSlotMs(ctx?: { date?: Date }): number | undefined {
  const t = ctx?.date?.getTime?.();
  if (typeof t !== "number" || !Number.isFinite(t)) return undefined;
  return Math.floor(t / 1000) * 1000;
}

export class RecipeScheduler {
  private scheduled: ScheduledRecipe[] = [];
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  /**
   * Per-recipe inflight guard. Holds names whose YAML run is currently
   * in flight from this scheduler. Prevents a cron tick from firing
   * recipe X while a previous tick (or a slow CLI `patchwork recipe
   * run X` joining in the same window) is still running it.
   *
   * Why not rely on WriteEffectLedger dedup? The ledger keys on
   * `(recipeName, manualRunId)` and `manualRunId` is per-attempt — two
   * concurrent invocations from cron + CLI generate different ids and
   * dedup-collide on neither side. The ledger only stops *same-attempt*
   * replay; this guard stops cross-attempt double-fire.
   *
   * Manual CLI runs do NOT go through this Set — they take their own
   * path. The guard is scheduler-scoped (ONE PROCESS), and that is NOT
   * enough: it used to say "which is enough because that's the only
   * place a cron tick can originate", and #1458 disproved it live. The
   * recipe store is global, so every running bridge schedules every
   * enabled cron recipe and an in-process Set cannot see a sibling.
   * N bridges fired N times.
   *
   * This Set still does its original job — a slow run overlapping the
   * next tick WITHIN this process. The cross-process half is
   * `claimCronSlot` (./cronClaim.ts), taken immediately before dispatch.
   */
  private readonly inflight = new Set<string>();

  constructor(private readonly opts: SchedulerOptions) {
    this.setIntervalFn = opts.setInterval ?? setInterval;
    this.clearIntervalFn = opts.clearInterval ?? clearInterval;
  }

  start(): ScheduledRecipe[] {
    this.stop();

    // Bound the claim store's growth (#1458). Best-effort and never throws — a
    // scheduler that refused to start because it could not tidy up would be a
    // far worse bug than the disk it saves. Logged only when it did something,
    // so the line means "work happened" rather than becoming noise every start.
    try {
      const swept = sweepCronClaims(Date.now(), this.opts.claim ?? {});
      if (swept > 0) {
        this.opts.logger?.info?.(
          `[scheduler] swept ${swept} expired cron-claim day-director${swept === 1 ? "y" : "ies"}`,
        );
      }
    } catch {
      /* housekeeping only */
    }

    // Load disabled list — tests can inject `opts.disabledRecipes` to bypass
    // reading the operator's real ~/.patchwork/config.json (which would
    // otherwise silently skip a recipe whose name happens to be in the dev
    // machine's disabled set).
    let disabled: Set<string> = new Set();
    if (this.opts.disabledRecipes !== undefined) {
      disabled = new Set(this.opts.disabledRecipes);
    } else {
      try {
        disabled = getConfigDisabledNames(loadConfig());
      } catch {
        // non-fatal — proceed with empty disabled set
      }
    }

    let entries: string[];
    try {
      entries = readdirSync(this.opts.recipesDir);
    } catch {
      return [];
    }

    // Build the list of (path, isInstalledDir) pairs to consider:
    //   - top-level *.json / *.yaml files (legacy, recipes-as-files)
    //   - subdirectories from `patchwork recipe install` (each with a
    //     `.disabled` marker that gates this scheduler — see PR #42)
    type Candidate = {
      filePath: string;
      kind: "json" | "yaml";
      installDir: string | null;
    };
    const candidates: Candidate[] = [];

    for (const f of entries) {
      const fullPath = path.join(this.opts.recipesDir, f);
      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        // Honor the per-recipe `.disabled` marker written by recipeInstall.
        if (isInstallDirDisabled(fullPath)) {
          this.opts.logger?.info?.(
            `[scheduler] skipping recipe in "${f}" — .disabled marker present`,
          );
          continue;
        }
        // Locate the recipe entrypoint inside the install dir.
        // Prefer recipe.json's `recipes.main`, then fall back to first YAML.
        const manifestPath = path.join(fullPath, "recipe.json");
        let entrypoint: string | null = null;
        if (existsSync(manifestPath)) {
          try {
            const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
              recipes?: { main?: string };
            };
            if (m.recipes?.main) {
              const candidate = path.join(fullPath, m.recipes.main);
              if (existsSync(candidate)) entrypoint = candidate;
            }
          } catch (err) {
            // Malformed manifest — fall through to first-yaml fallback,
            // but surface the issue so the user can fix it. Silent failures
            // here led to "why isn't my recipe firing?" confusion.
            this.opts.logger?.warn?.(
              `[scheduler] could not parse recipe.json in "${f}" — ${err instanceof Error ? err.message : String(err)}; falling back to first-yaml lookup`,
            );
          }
        }
        if (!entrypoint) {
          try {
            const yaml = readdirSync(fullPath).find((x) => /\.ya?ml$/i.test(x));
            if (yaml) entrypoint = path.join(fullPath, yaml);
          } catch {
            // unreadable — skip
          }
        }
        if (entrypoint) {
          const ext = path.extname(entrypoint).toLowerCase();
          candidates.push({
            filePath: entrypoint,
            kind: ext === ".json" ? "json" : "yaml",
            installDir: fullPath,
          });
        }
        continue;
      }

      const isJson = f.endsWith(".json") && !f.endsWith(".permissions.json");
      const isYaml = f.endsWith(".yaml") || f.endsWith(".yml");
      if (!isJson && !isYaml) continue;
      candidates.push({
        filePath: fullPath,
        kind: isJson ? "json" : "yaml",
        installDir: null,
      });
    }

    for (const cand of candidates) {
      const f = path.basename(cand.filePath);
      try {
        let name: string;
        let schedule: string | undefined;

        if (cand.kind === "json") {
          const raw = readFileSync(cand.filePath, "utf-8");
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
          const raw = readFileSync(cand.filePath, "utf-8");
          const parsed = parseYaml(raw) as {
            name?: string;
            trigger?: { type?: string; at?: string; schedule?: string };
          };
          if (parsed.trigger?.type !== "cron") continue;
          schedule = parsed.trigger.at ?? parsed.trigger.schedule;
          if (!schedule || typeof schedule !== "string") continue;
          name = parsed.name ?? path.basename(f, path.extname(f));
        }

        // Apply config-file disabled list (legacy mechanism)
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
          // NO cross-process claim on this path (#1458). `setInterval` is
          // phase-anchored to each process's own start(), so two bridges have no
          // slot to agree on. Quantising to an epoch-aligned bucket would work
          // and is deliberately not done here: zero installed recipes use
          // `@every`, and the quantised form permanently favours whichever
          // process started earlier in the bucket — a bias that deserves its own
          // evidence. Announced rather than assumed, because a scheduling gap
          // nobody is told about is indistinguishable from one nobody has.
          this.opts.logger?.info?.(
            `[scheduler] "${name}" uses @every — not deduped across processes; ` +
              "use a cron expression if more than one bridge runs (#1458)",
          );
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
          const timezone =
            this.opts.timezone ?? loadConfig().recipes?.timezone ?? "UTC";
          const cronJob = cron.schedule(
            parsed2.expression,
            (ctx?: { date?: Date }) => {
              this.fire(name, matchedSlotMs(ctx));
            },
            { timezone },
          );
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
      } catch (err) {
        // Malformed recipe file — surface so users can debug rather than
        // silently dropping the recipe from the schedule.
        this.opts.logger?.warn?.(
          `[scheduler] could not load recipe at "${cand.filePath}" — ${err instanceof Error ? err.message : String(err)}; recipe will not be scheduled`,
        );
      }
    }
    return this.scheduled;
  }

  stop(): void {
    for (const entry of this.scheduled) {
      if (entry.cronJob) {
        entry.cronJob.stop();
      }
      // Always clear the sentinel/interval timer — cron entries hold a dummy timer too
      this.clearIntervalFn(entry.timer);
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

  /**
   * Test hook: dispatch a recipe immediately without waiting for the interval.
   *
   * Passes no slot BY DEFAULT, so it takes no cross-process claim. Deliberate:
   * this hook has no cron match behind it, so there is no instant two processes
   * could agree on, and inventing one from `Date.now()` would make repeated
   * calls within the same second collide — which is precisely what the existing
   * overlap tests do, and they must keep passing unchanged.
   *
   * A slot may be passed explicitly to drive the claim path without a live cron
   * tick, i.e. without a real timer and a real second boundary in CI.
   */
  fireForTest(name: string, slotEpochMs?: number): void {
    this.fire(name, slotEpochMs);
  }

  /**
   * @param slotEpochMs The instant the cron matcher matched, threaded from the
   *   cron callback. Its whole purpose is that two processes observing the same
   *   tick derive the SAME value — so it must never be re-read from the clock
   *   here, one event-loop hop later, where a second boundary would split it.
   *   Absent for `@every` intervals and the test hook: no slot, no claim, and
   *   behaviour identical to before #1458.
   */
  private fire(name: string, slotEpochMs?: number): void {
    // TOCTOU defence: re-check the disabled list at fire time. `start()`
    // snapshots it once; if the user runs `recipe disable <name>` after
    // start (and the recipe is a top-level legacy file, where the marker
    // file doesn't apply), the timer would otherwise still fire until
    // next restart(). The `.disabled` marker case is handled inside
    // findYamlRecipePath / loadRecipePrompt (skip disabled install dirs)
    // thanks to PR #49.
    //
    // When `opts.disabledRecipes` is injected (test path), use it instead
    // of `loadConfig()` — same reasoning as the start()-time injection in
    // PR #375: reading the operator's real ~/.patchwork/config.json from
    // a test process pollutes results when a fixtured recipe name
    // collides with the dev box's disabled set.
    try {
      const disabled =
        this.opts.disabledRecipes !== undefined
          ? new Set(this.opts.disabledRecipes)
          : getConfigDisabledNames(loadConfig());
      if (disabled.has(name)) {
        this.opts.logger?.info?.(
          `[scheduler] skipping "${name}" — disabled via config (TOCTOU re-check)`,
        );
        return;
      }
    } catch {
      // proceed if config unreadable — falling back to scan-time snapshot
    }

    // YAML recipe — delegate to runYaml if provided. findYamlRecipePath
    // now throws RecipeNameConflictError when two recipes declare the same
    // name; surface that loudly instead of letting the timer crash silently.
    let yamlPath: string | null;
    try {
      yamlPath = findYamlRecipePath(this.opts.recipesDir, name);
    } catch (err) {
      this.opts.logger?.warn?.(
        `[scheduler] skipped "${name}" — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (yamlPath) {
      if (!this.opts.runYaml) {
        this.opts.logger?.warn?.(
          `[scheduler] skipped "${name}" — YAML recipe requires runYaml callback (start bridge with --driver)`,
        );
        return;
      }
      // Per-recipe inflight guard — skip if a previous tick is still
      // running this recipe. Audit 2026-05-17: scheduler had no guard,
      // so cron + manual CLI in the same window would double-fire
      // (manualRunId is per-attempt → WriteEffectLedger doesn't dedup
      // across attempts).
      if (this.inflight.has(name)) {
        this.opts.logger?.info?.(
          `[scheduler] skipped "${name}" — previous run still in flight`,
        );
        return;
      }
      // Cross-process claim (#1458) — LAST, and the ordering is load-bearing.
      // Every local "should I even run this" decision has already been made. If
      // the claim came first, a bridge with this recipe disabled locally would
      // burn the slot and then skip, blocking a differently-configured peer that
      // would have run it — and the recipe would run nowhere.
      if (slotEpochMs !== undefined) {
        const claim = claimCronSlot(name, slotEpochMs, this.opts.claim ?? {});
        if (claim.kind === "taken") {
          this.opts.logger?.info?.(
            `[scheduler] skipped "${name}" — another process claimed this tick`,
          );
          return;
        }
        if (claim.kind === "refused") {
          // Fail-closed, because the operator asked for it. Loud: a silent skip
          // of every scheduled recipe is the failure mode fail-open exists to
          // avoid, so it must never be merely absent from the log.
          this.opts.logger?.warn?.(
            `[scheduler] NOT firing "${name}" — cron claim store unusable (${claim.reason}) ` +
              "and PATCHWORK_CRON_CLAIM_REQUIRED is set",
          );
          return;
        }
        if (claim.kind === "unavailable") {
          this.opts.logger?.warn?.(
            `[scheduler] cron claim store unusable (${claim.reason}) — firing "${name}" ` +
              "ANYWAY; a second bridge may fire it too. Set PATCHWORK_CRON_CLAIM_REQUIRED=1 to skip instead.",
          );
        }
      }
      this.inflight.add(name);
      this.opts
        .runYaml(name)
        .catch((err) => {
          this.opts.logger?.warn?.(
            `[scheduler] YAML recipe "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.inflight.delete(name);
        });
      this.opts.logger?.info?.(`[scheduler] fired YAML recipe "${name}"`);
      return;
    }

    // JSON recipe — legacy path
    const loaded = loadRecipePrompt(this.opts.recipesDir, name);
    if (!loaded) {
      // After PR #49, findYamlRecipePath / loadRecipePrompt return null for
      // recipes whose install dir has a `.disabled` marker — that's the
      // common case here. "Disappeared" was misleading; prefer a message
      // that names both possibilities.
      this.opts.logger?.warn?.(
        `[scheduler] skipped "${name}" — recipe not found or disabled`,
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
    // biome-ignore lint/style/noNonNullAssertion: capture group 1 is guaranteed by the regex
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

  // 5- or 6-field cron expression. node-cron accepts an optional leading
  // seconds field (e.g. "0 0 8 * * 1-5" = every weekday 08:00:00), so accept
  // both lengths and let cron.validate() decide correctness — previously a
  // 6-field expression passed cron.validate() but was rejected here, silently
  // never scheduling the recipe (audit 2026-06-09 sched-cron6-1).
  if (/^\S+(?:\s+\S+){4,5}$/.test(trimmed)) {
    if (cron.validate(trimmed)) {
      return { kind: "cron5", expression: trimmed };
    }
  }

  return null;
}
