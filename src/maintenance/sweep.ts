/**
 * `patchwork sweep` — what CHANGED since the last sweep?
 *
 * Five read-only verbs already answer "what is true now": `doctor`,
 * `workers validate`, `evidence`, `privacy undeclared`, `pr-outcomes show`.
 * Running them by hand answers each question in isolation and answers none of
 * the question an operator actually has on a Monday, which is *what moved*.
 * A denominator that has not shifted in three weeks and a gate that flipped
 * yesterday look identical when every verb is read fresh.
 *
 * ## It is a REPORT with two gates, not five
 *
 * Only two readings here are gates: is the running code the installed code, and
 * does every worker manifest actually govern something. Those are binary, they
 * are currently green, and a flip is unambiguously a regression — so a flip
 * exits 1.
 *
 * Everything else is DRIFT and never fails the command. The evidence-spine
 * ratios fall by construction as ledgers accrue rows faster than runs earn
 * correlation ids; an undeclared agent step is the documented fail-soft default
 * of ADR-0021, not a fault. Wiring those to an exit code would make `sweep`
 * permanently red, and a permanently-red gate is exactly how a real warning
 * gets ignored — the failure this repo has now recorded several times.
 *
 * ## A first run is a BASELINE, never "no changes"
 *
 * With no prior snapshot there is nothing to diff, and saying "nothing changed"
 * would be a claim about a week nobody observed. That state is named
 * `baseline`, printed as such, and carried in the JSON, for the same reason
 * `evidence` reports an absent ledger as ABSENT rather than as zero rows.
 *
 * ## The snapshot holds COUNTS ONLY
 *
 * This is a constraint, not a formality. Two of the five inputs return operator
 * data — `privacy undeclared` names real installed recipes, `doctor` carries
 * workspace paths — and a snapshot that accumulated them would be a brand-new
 * operator-data ledger created by a diagnostic, growing weekly, unnoticed
 * because nobody thinks of a health check as a place secrets collect. So the
 * reading is reduced to integers and booleans at the boundary, and a test
 * asserts the serialised snapshot contains no path- or name-shaped string.
 *
 * `rv` marks the snapshot schema. A later reading with a new counter must stay
 * distinguishable from an old reading that never had one — absence is a fact
 * here as it is in the gate decision log, and is never backfilled.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Snapshot schema version. Bump when a counter's MEANING changes. */
export const SWEEP_RV = 1;

/** File the snapshots are appended to, relative to `$PATCHWORK_HOME`. */
export const SWEEP_LEDGER = "sweep_snapshots.jsonl";

/**
 * One sweep reading, reduced to scalars.
 *
 * `gates` are the only fields that can produce a regression verdict. `counts` is
 * a flat integer bag deliberately: adding a metric must not be a schema change
 * that strands every prior snapshot, and a reader that finds a key missing
 * learns "this sweep predates that counter" rather than "it was zero".
 */
export interface SweepReading {
  rv: number;
  takenAt: number;
  gates: Record<string, boolean>;
  counts: Record<string, number>;
}

export interface GateDelta {
  key: string;
  before: boolean;
  after: boolean;
  /** true only for a true -> false flip. A false -> true flip is a recovery. */
  regression: boolean;
}

export interface CountDelta {
  key: string;
  /** undefined when the prior snapshot predates this counter. */
  before?: number;
  after: number;
  change: number;
}

export interface SweepDelta {
  /** No prior snapshot existed. Never rendered as "nothing changed". */
  baseline: boolean;
  previousAt?: number;
  gates: GateDelta[];
  counts: CountDelta[];
  /** Counters present in the prior reading and absent from this one. */
  disappeared: string[];
  /** True when any gate flipped true -> false. Drives the exit code. */
  regressed: boolean;
}

/**
 * Diff two readings. Pure — no clock, no filesystem, so a test can drive it.
 */
export function diffReadings(
  previous: SweepReading | undefined,
  current: SweepReading,
): SweepDelta {
  if (!previous) {
    return {
      baseline: true,
      gates: [],
      counts: [],
      disappeared: [],
      regressed: false,
    };
  }
  const gates: GateDelta[] = [];
  for (const [key, after] of Object.entries(current.gates)) {
    const before = previous.gates[key];
    // A gate the previous reading did not carry is not a flip. Treating a
    // missing key as `false` would report every newly-added gate as a
    // regression on its first sweep.
    if (typeof before !== "boolean" || before === after) continue;
    gates.push({ key, before, after, regression: before && !after });
  }
  const counts: CountDelta[] = [];
  for (const [key, after] of Object.entries(current.counts)) {
    const before = previous.counts[key];
    if (typeof before !== "number") {
      counts.push({ key, after, change: after });
      continue;
    }
    if (before === after) continue;
    counts.push({ key, before, after, change: after - before });
  }
  const disappeared = Object.keys(previous.counts).filter(
    (k) => !(k in current.counts),
  );
  return {
    baseline: false,
    previousAt: previous.takenAt,
    gates,
    counts,
    disappeared,
    regressed: gates.some((g) => g.regression),
  };
}

/** Last snapshot in the ledger, or undefined when there is none. */
export function readLastSnapshot(dir: string): SweepReading | undefined {
  const file = path.join(dir, SWEEP_LEDGER);
  if (!existsSync(file)) return undefined;
  let last: SweepReading | undefined;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SweepReading;
      // A row from a future schema is skipped rather than diffed against: its
      // counters may share a name with a different meaning, and a delta built
      // across that boundary would be a confident lie.
      if (typeof row?.takenAt !== "number" || row.rv !== SWEEP_RV) continue;
      last = row;
    } catch {
      // A corrupt line is skipped, never repaired. Rewriting an append-only
      // evidence file to make it parse is how evidence stops being evidence.
    }
  }
  return last;
}

export function appendSnapshot(dir: string, reading: SweepReading): void {
  appendFileSync(path.join(dir, SWEEP_LEDGER), `${JSON.stringify(reading)}\n`, {
    mode: 0o600,
  });
}

const CHECK = "✓";

export function formatSweep(
  reading: SweepReading,
  delta: SweepDelta,
  opts: { wrote: boolean },
): string {
  const L: string[] = [];
  L.push("[sweep] what moved since the last sweep?");
  L.push("");

  L.push("  gates");
  for (const [key, ok] of Object.entries(reading.gates)) {
    L.push(`    ${ok ? `${CHECK} ` : "FAIL"}  ${key}`);
  }
  L.push("");

  if (delta.baseline) {
    // Never "no changes". Nothing was observed to change; there was nothing to
    // compare against, and those are different facts.
    L.push("  BASELINE — no prior snapshot, so nothing is compared here.");
    L.push("  Run it again later and this section becomes the deltas.");
    L.push("");
    L.push(`  ${Object.keys(reading.counts).length} counter(s) recorded:`);
    for (const [key, v] of Object.entries(reading.counts)) {
      L.push(`    ${String(v).padStart(7)}  ${key}`);
    }
    L.push("");
    L.push(
      opts.wrote
        ? `  Snapshot appended to ${SWEEP_LEDGER}.`
        : "  Not written (--no-write): the next sweep will still see no baseline.",
    );
    L.push("");
    return `${L.join("\n")}\n`;
  }

  const since = delta.previousAt
    ? new Date(delta.previousAt).toISOString()
    : "unknown";
  L.push(`  since ${since}`);
  L.push("");

  if (delta.gates.length === 0) {
    L.push("  No gate changed state.");
  } else {
    for (const g of delta.gates) {
      L.push(
        `  ${g.regression ? "REGRESSED" : "recovered "}  ${g.key}: ${g.before} -> ${g.after}`,
      );
    }
  }
  L.push("");

  if (delta.counts.length === 0) {
    L.push("  No counter moved.");
  } else {
    L.push("  drift (reported, never fatal)");
    for (const c of delta.counts) {
      const before = c.before === undefined ? "new" : String(c.before);
      const sign = c.change > 0 ? "+" : "";
      L.push(
        `    ${before.padStart(7)} -> ${String(c.after).padEnd(7)} ${sign}${c.change}  ${c.key}`,
      );
    }
  }

  if (delta.disappeared.length > 0) {
    L.push("");
    L.push(
      `  ${delta.disappeared.length} counter(s) the previous sweep had are absent now:`,
    );
    for (const k of delta.disappeared) L.push(`    ${k}`);
    L.push(
      "  A counter that stops being reported is not a counter that hit 0.",
    );
  }

  L.push("");
  if (delta.regressed) {
    L.push("  A gate flipped from healthy to unhealthy. Exiting 1.");
  } else {
    L.push("  No gate regressed. Drift above is information, not a failure.");
  }
  if (opts.wrote) L.push(`  Snapshot appended to ${SWEEP_LEDGER}.`);
  L.push("");
  return `${L.join("\n")}\n`;
}
