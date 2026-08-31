/**
 * Is the code that is RUNNING the code we think shipped?
 *
 * Every gate in this repo verifies the repository: tests, lint, coverage, the
 * audit scripts, even the wiring guard that exists specifically to catch
 * "declared but supplied nowhere". Not one of them looks at a running process.
 *
 * That was invisible until it wasn't. On 2026-08-19 both live bridges were found
 * to contain neither the ADR-0021 privacy code nor the `butler` command — merged,
 * wired, tested, gated, and absent from every process serving requests. Three
 * separate workstreams had been blocked for five days on evidence those bridges
 * structurally could not produce, and every check was green throughout.
 *
 * ## Why not compare versions
 *
 * The obvious check — running version vs installed version — would NOT have
 * caught it. Both were `1.2.0-beta.2`: the package version had not been bumped
 * between the stale install and the fresh one, because a version is a release
 * marker and not a build identity. A check that reports OK in the exact case it
 * was written for is worse than no check, so this compares TIME instead.
 *
 * A bridge that started BEFORE the currently-installed build was written is
 * running something older, whatever its version string says. That is a fact
 * about processes rather than about a git tree, which is the whole point.
 *
 * ## What it deliberately does not claim
 *
 * It cannot see inside a running process. A bridge launched from a repo checkout
 * (`node dist/index.js`) loads that checkout's `dist`, not the global install, so
 * comparing it against the global build time answers a slightly different
 * question than it appears to. Those are reported as `unknown-origin` rather than
 * silently judged — the failure this file exists to prevent is a confident
 * statement about code nobody actually inspected.
 */

import type { Stats } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/** A bridge lock file, reduced to what freshness needs. */
export interface BridgeLock {
  /** Basename, for reporting. */
  file: string;
  pid: number;
  /** ms epoch, from the lock. */
  startedAt?: number;
  workspace?: string;
  /** Absent on locks written before the field existed. */
  isBridge?: boolean;
}

export type FreshnessState =
  | "fresh"
  | "stale-code"
  | "dead-lock"
  | "unknown-start";

export interface FreshnessFinding {
  file: string;
  pid: number;
  state: FreshnessState;
  workspace?: string;
  startedAt?: number;
  /** Human-readable, one line, names the remedy where there is one. */
  detail: string;
}

export interface FreshnessInput {
  locks: BridgeLock[];
  /** mtime (ms) of the installed build — the newest code we know about. */
  buildTimeMs: number;
  /** Liveness probe, injected so this stays a pure function under test. */
  isAlive: (pid: number) => boolean;
  /**
   * How many live bridges the caller expects (#1481).
   *
   * Absent ⇒ no expectation, and zero bridges stays HEALTHY. That default is
   * deliberate: "nothing is running" is a legitimate state for anyone who has
   * not started a bridge, and hard-failing on it would make the command useless
   * to them. The expectation has to be stated, because only the caller knows
   * it — this module cannot discover how many bridges *ought* to exist.
   */
  expectRunning?: number;
}

export interface FreshnessReport {
  findings: FreshnessFinding[];
  /** True when any bridge needs attention. Drives the exit code. */
  unhealthy: boolean;
  /**
   * Live bridges found. Counted separately from `findings.length`, which also
   * includes dead locks — a corpse must never satisfy an expectation.
   */
  running: number;
  /** Present only when fewer bridges are running than were expected. */
  shortfall?: { expected: number; running: number };
}

export function assessDeploymentFreshness(
  input: FreshnessInput,
): FreshnessReport {
  const findings: FreshnessFinding[] = [];
  for (const lock of input.locks) {
    // Non-bridge locks belong to an IDE, not to us. `isBridge` is absent on
    // locks written before the flag existed; treat that as "not ours" rather
    // than guessing, or this reports on Claude Code's own lock files.
    if (lock.isBridge !== true) continue;

    const alive = input.isAlive(lock.pid);
    if (!alive) {
      findings.push({
        file: lock.file,
        pid: lock.pid,
        state: "dead-lock",
        ...(lock.workspace && { workspace: lock.workspace }),
        detail:
          "process is gone but the lock remains — the shim discovers bridges by " +
          "lock file, so a dead lock can win discovery over a live bridge",
      });
      continue;
    }

    if (
      typeof lock.startedAt !== "number" ||
      !Number.isFinite(lock.startedAt)
    ) {
      // Cannot compare, so do not pretend to. Reported, never assumed fresh:
      // "we could not tell" and "it is fine" are different statements.
      findings.push({
        file: lock.file,
        pid: lock.pid,
        state: "unknown-start",
        ...(lock.workspace && { workspace: lock.workspace }),
        detail:
          "lock records no usable startedAt, so freshness cannot be determined " +
          "for this bridge",
      });
      continue;
    }

    if (lock.startedAt < input.buildTimeMs) {
      findings.push({
        file: lock.file,
        pid: lock.pid,
        state: "stale-code",
        startedAt: lock.startedAt,
        ...(lock.workspace && { workspace: lock.workspace }),
        detail:
          "started before the installed build was written, so it is serving " +
          "older code — restart it (launchd: `launchctl kickstart -k " +
          "gui/$UID/<label>`)",
      });
      continue;
    }

    findings.push({
      file: lock.file,
      pid: lock.pid,
      state: "fresh",
      startedAt: lock.startedAt,
      ...(lock.workspace && { workspace: lock.workspace }),
      detail: "started after the installed build",
    });
  }

  // A live bridge is one whose process answered the liveness probe. A STALE
  // bridge counts — it is running, it is merely running the wrong code, and
  // that is already reported on its own. Conflating the two would make a stale
  // bridge read as a missing one and send the operator to the wrong remedy.
  const running = findings.filter((f) => f.state !== "dead-lock").length;

  const shortfall =
    input.expectRunning !== undefined && running < input.expectRunning
      ? { expected: input.expectRunning, running }
      : undefined;

  return {
    findings,
    // `some` on an empty array is `false`, which is how zero bridges resolved
    // to healthy: the denominator was "locks that exist" rather than "bridges
    // that should exist". A shortfall now carries its own weight.
    unhealthy:
      findings.some((f) => f.state !== "fresh") || shortfall !== undefined,
    running,
    ...(shortfall ? { shortfall } : {}),
  };
}

/** mtime in ms, or undefined when the build cannot be located. */
export function buildTimeFromStat(stat: Stats | undefined): number | undefined {
  return stat ? stat.mtimeMs : undefined;
}

export function formatFreshness(
  report: FreshnessReport,
  buildTimeMs: number,
): string {
  const L: string[] = [];
  L.push("[deployment] is the running code the installed code?");
  L.push(`  installed build: ${new Date(buildTimeMs).toISOString()}`);
  if (report.shortfall) {
    L.push("");
    L.push(
      `  MISSING  expected ${report.shortfall.expected} live bridge(s), found ` +
        `${report.shortfall.running}`,
    );
    L.push(
      "           a bridge that failed to start leaves no lock, and a check whose",
    );
    L.push(
      "           denominator is the locks it found cannot see one that is absent.",
    );
  }
  if (report.findings.length === 0) {
    L.push("");
    if (!report.shortfall) {
      L.push("  No bridge locks found. Nothing is running to be stale.");
    }
    return L.join("\n");
  }
  L.push("");
  for (const f of report.findings) {
    const tag =
      f.state === "fresh"
        ? "ok      "
        : f.state === "stale-code"
          ? "STALE   "
          : f.state === "dead-lock"
            ? "DEAD    "
            : "UNKNOWN ";
    const started =
      f.startedAt !== undefined
        ? new Date(f.startedAt).toISOString()
        : "(no startedAt)";
    L.push(`  ${tag} ${f.file}  pid=${f.pid}  started=${started}`);
    if (f.state !== "fresh") L.push(`           ${f.detail}`);
    if (f.workspace) L.push(`           workspace: ${f.workspace}`);
  }
  if (report.unhealthy) {
    L.push("");
    L.push(
      "  A version check would not have caught this: a stale process and a fresh",
    );
    L.push(
      "  one can report the same version, because a version marks a release and",
    );
    L.push("  not a build. Times are compared instead.");
  }
  return L.join("\n");
}

/**
 * Where the bridge lock files live. Honours `CLAUDE_CONFIG_DIR`.
 *
 * Extracted from the `doctor` handler so `patchwork sweep` counts bridges the
 * same way `doctor` judges them. Two discoveries of "which bridges exist" would
 * drift, and the drift is silent: the sweep would report a green gate over a set
 * of locks the verb never looked at.
 */
export function bridgeLockDir(): string {
  return nodePath.join(
    process.env.CLAUDE_CONFIG_DIR || os.homedir() + nodePath.sep + ".claude",
    "ide",
  );
}

/** Every parseable `.lock` in `dir`. An unparseable one is skipped, not fixed. */
export function discoverLocks(dir: string = bridgeLockDir()): BridgeLock[] {
  const locks: BridgeLock[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".lock")) continue;
      try {
        const d = JSON.parse(readFileSync(nodePath.join(dir, f), "utf-8"));
        if (typeof d?.pid === "number") locks.push({ ...d, file: f });
      } catch {
        // An unparseable lock is not this module's problem to solve.
      }
    }
  } catch {
    // No lock dir ⇒ no bridges ⇒ "nothing running", which is legitimate.
  }
  return locks;
}

/**
 * mtime of the installed build, or undefined when none can be located.
 *
 * Falls back to this process's own `dist` when the global package is absent
 * (running from a checkout) — the honest reference in that case.
 */
export function installedBuildTimeMs(): number | undefined {
  for (const candidate of [
    nodePath.join(
      process.env.npm_config_prefix ?? "/opt/homebrew",
      "lib/node_modules/patchwork-os/dist/index.js",
    ),
    // `fileURLToPath`, NOT `.pathname`. On Windows a file URL's pathname is
    // `/D:/a/...` — a leading slash before the drive letter — which statSync
    // cannot open, so this fallback never resolved there.
    fileURLToPath(new URL("./index.js", import.meta.url)),
  ]) {
    try {
      return statSync(candidate).mtimeMs;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
