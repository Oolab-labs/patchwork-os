/**
 * Collect one `SweepReading` from the five read-only verbs.
 *
 * Kept apart from `sweep.ts` so the diff stays a pure function a test can drive.
 * This half touches the filesystem and every subsystem; that half decides what a
 * regression is.
 *
 * ## The reduction to scalars happens HERE, on purpose
 *
 * Two of these five inputs return operator data: `scanRecipeDir` names real
 * installed recipes, and a bridge lock carries a workspace path. Reducing at the
 * boundary — rather than storing the reports and projecting later — means there
 * is no version of the snapshot that ever held them. A privacy rule enforced by
 * a downstream formatter is one refactor away from being lost.
 */

import path from "node:path";
import {
  assessDeploymentFreshness,
  discoverLocks,
  installedBuildTimeMs,
} from "../deploymentFreshness.js";
import { evidenceCoverage } from "../evidenceCoverage.js";
import { patchworkHome } from "../patchworkHome.js";
import { scanRecipeDir } from "../privacy/undeclaredSteps.js";
import {
  defaultRecipesDir,
  defaultWorkersDir,
  validateWorkers,
} from "../workers/workersCli.js";
import { readObservations, summarise } from "./prOutcomeLedger.js";
import { SWEEP_RV, type SweepReading } from "./sweep.js";

export interface CollectOptions {
  /** Ledger directory. Defaults to `$PATCHWORK_HOME`. */
  dir?: string;
  /** How many live bridges ought to be up. Absent ⇒ no expectation. */
  expectRunning?: number;
  /** ms epoch for the reading. Injected so a test is not at the mercy of a clock. */
  now?: number;
}

/**
 * Readings that could not be taken are OMITTED, never recorded as zero.
 *
 * A recipes directory that cannot be read and a recipes directory holding zero
 * agent steps are different facts, and the diff already distinguishes an absent
 * counter ("this sweep predates it, or could not take it") from a moved one.
 * Writing a 0 would turn an unavailable reading into a dramatic-looking drop.
 */
export function collectSweep(opts: CollectOptions = {}): SweepReading {
  const dir = opts.dir ?? patchworkHome();
  const counts: Record<string, number> = {};
  const gates: Record<string, boolean> = {};

  // --- gate 1: is the running code the installed code? ---
  const buildTimeMs = installedBuildTimeMs();
  if (buildTimeMs !== undefined) {
    const fresh = assessDeploymentFreshness({
      locks: discoverLocks(),
      buildTimeMs,
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      ...(opts.expectRunning !== undefined
        ? { expectRunning: opts.expectRunning }
        : {}),
    });
    gates["deployment"] = !fresh.unhealthy;
    counts["bridges.running"] = fresh.running;
    counts["bridges.findings"] = fresh.findings.length;
  }

  // --- gate 2: does every worker manifest actually govern something? ---
  try {
    const v = validateWorkers({
      workersDir: defaultWorkersDir(),
      recipesDir: defaultRecipesDir(),
    });
    gates["workers"] = v.healthy;
    counts["workers.loaded"] = v.counts.loaded;
    counts["workers.broken"] = v.counts.broken;
    counts["workers.findings"] = v.findings.length;
  } catch {
    // No workers directory is a legitimate install. Omit rather than zero.
  }

  // --- drift: evidence spine ---
  const ev = evidenceCoverage(dir);
  for (const l of ev.ledgers) {
    // An absent ledger contributes NO counters. `evidence` reports absence as
    // ABSENT rather than as `0 rows` for a reason — permission_exercises is
    // absent because no standing permission has ever been granted, and that is
    // correct, not a gap. A zero here would invite someone to go and fix it.
    if (l.absent) continue;
    counts[`evidence.${l.file}.rows`] = l.rows;
    counts[`evidence.${l.file}.joinable`] = l.joinable;
  }
  counts["evidence.runsInMoreThanOneLedger"] = ev.runsInMoreThanOneLedger;

  // --- drift: undeclared agent steps (ADR-0021 fail-soft, never a gate) ---
  try {
    const u = scanRecipeDir(path.join(dir, "recipes"));
    counts["privacy.agentSteps"] = u.agentSteps;
    counts["privacy.declared"] = u.declared;
    counts["privacy.undeclared"] = u.undeclared.length;
    counts["privacy.unreadableRecipes"] = u.unreadable.length;
  } catch {
    // Unreadable recipes directory: omit, do not zero.
  }

  // --- drift: pull-request outcome ledger ---
  const pr = summarise(readObservations(path.join(dir, "pr_outcomes.jsonl")));
  counts["prOutcomes.rows"] = pr.rows;
  counts["prOutcomes.distinctPrs"] = pr.distinctPrs;
  counts["prOutcomes.withHistory"] = pr.prsWithHistory;

  return {
    rv: SWEEP_RV,
    takenAt: opts.now ?? Date.now(),
    gates,
    counts,
  };
}
