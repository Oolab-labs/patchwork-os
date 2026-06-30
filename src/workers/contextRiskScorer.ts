import { execSafe } from "../tools/utils.js";
import type { ContextRisk } from "./contextRisk.js";

/**
 * The live producer behind the context-risk seam (workerGate / contextRisk.ts).
 * Gathers cheap, dependency-light situational signals from the workspace and
 * scores them into a `ContextRisk` the gate uses as a DESCENDING de-rater.
 *
 * Signals are deliberately the ones reliably available server-side during a
 * recipe run (the bridge runs in a git repo): working-tree size + which branch.
 * Diagnostics / coverage / CI are richer but require the extension / network and
 * are added later. Everything is fail-soft: an unavailable signal simply doesn't
 * contribute, and a total failure yields score 0 (no de-rate, never widens).
 * See docs/worker-autonomy-policy-gate.md §3a.
 */

/** Raw situational signals. All optional — absent ⇒ no contribution. */
export interface ContextSignals {
  /** Uncommitted lines changed (added + deleted) vs HEAD. */
  diffLines?: number;
  /** Files with uncommitted changes vs HEAD. */
  dirtyFiles?: number;
  /** HEAD is the default branch (main/master) — acting on trunk is riskier
   *  than on a feature branch that can be reviewed before merge. */
  onDefaultBranch?: boolean;
}

/**
 * Pure scorer: signals → ContextRisk (0..1 + human reasons). Each signal
 * contributes risk independently and they combine by NOISY-OR
 * (`1 − ∏(1 − sᵢ)`), so several moderate signals compound toward "act with
 * caution" without any single one needing to be severe. Higher = more dangerous
 * to act RIGHT NOW. Pure + deterministic.
 */
export function scoreContextRisk(signals: ContextSignals): ContextRisk {
  const contribs: Array<{ score: number; reason: string }> = [];

  if (signals.diffLines !== undefined) {
    if (signals.diffLines >= 2000)
      contribs.push({
        score: 0.9,
        reason: `huge uncommitted diff (${signals.diffLines} lines)`,
      });
    else if (signals.diffLines >= 500)
      contribs.push({
        score: 0.5,
        reason: `large uncommitted diff (${signals.diffLines} lines)`,
      });
    else if (signals.diffLines >= 200)
      contribs.push({
        score: 0.3,
        reason: `sizeable uncommitted diff (${signals.diffLines} lines)`,
      });
  }
  if (signals.dirtyFiles !== undefined && signals.dirtyFiles >= 20)
    contribs.push({
      score: 0.5,
      reason: `${signals.dirtyFiles} files with uncommitted changes`,
    });
  if (signals.onDefaultBranch)
    contribs.push({
      score: 0.3,
      reason: "operating directly on the default branch",
    });

  const score =
    contribs.length === 0
      ? 0
      : 1 - contribs.reduce((p, c) => p * (1 - c.score), 1);
  return {
    score,
    ...(contribs.length > 0 && { reasons: contribs.map((c) => c.reason) }),
  };
}

/** Injectable command runner (returns stdout). Defaults to the bridge's
 *  allowlisted `execSafe` over `cwd`. Exposed so tests supply fake git output. */
export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

/**
 * Gather git working-tree signals. Fully fail-soft: any git error leaves the
 * corresponding signal undefined (→ no contribution). Never throws.
 */
export async function collectGitContextSignals(opts: {
  cwd: string;
  exec?: ExecFn;
}): Promise<ContextSignals> {
  const exec: ExecFn =
    opts.exec ??
    (async (cmd, args) =>
      (await execSafe(cmd, args, { cwd: opts.cwd, timeout: 5000 })).stdout);
  const signals: ContextSignals = {};

  try {
    // `diff HEAD` = staged + unstaged vs the last commit (the full uncommitted
    // delta). `--numstat` is `<added>\t<deleted>\t<path>` per file ("-" binary).
    const numstat = await exec("git", ["diff", "HEAD", "--numstat"]);
    let lines = 0;
    let files = 0;
    for (const row of numstat.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(row);
      if (!m) continue;
      files++;
      lines +=
        (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
    }
    signals.diffLines = lines;
    signals.dirtyFiles = files;
  } catch {
    /* git unavailable / not a repo → leave diff signals undefined */
  }

  try {
    const branch = (
      await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    signals.onDefaultBranch = branch === "main" || branch === "master";
  } catch {
    /* ignore */
  }

  return signals;
}

/** Convenience: collect + score in one fail-soft call. Returns undefined when
 *  the situation is clean (score 0) so callers can omit the field. */
export async function resolveGitContextRisk(opts: {
  cwd: string;
  exec?: ExecFn;
}): Promise<ContextRisk | undefined> {
  try {
    const risk = scoreContextRisk(await collectGitContextSignals(opts));
    return risk.score > 0 ? risk : undefined;
  } catch {
    return undefined;
  }
}
