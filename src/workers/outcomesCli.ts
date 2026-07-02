import type {
  OutcomeDisposition,
  OutcomeRecord,
  OutcomeStore,
} from "./outcomeStore.js";

/**
 * `patchwork outcomes confirm|reject|list` — the operator's positive-act
 * confirmation path for worker-filed issues.
 *
 * WHY THIS EXISTS. The trust ramp only folds a durable non-reversible filing as
 * earned trust once its outcome disposition is `confirmed`; an `unknown` (still
 * open, nobody acted) filing is WITHHELD, never counted (the trust-by-neglect
 * fix). So a worker's `issue` dial cannot move on its own — something external
 * must confirm the filing was real. Closing the issue as completed on GitHub
 * does this (the outcome-ingester cron picks it up), but that needs the GitHub
 * connector and a round-trip. This verb is the direct, local alternative:
 * an operator records the disposition straight into ~/.patchwork/outcome-log.jsonl.
 *
 * Crucially, this is a HUMAN CLI, not a recipe step — no worker recipe can call
 * it, so a worker cannot self-confirm its own filings. The reward path stays as
 * independent of the worker as the penalty path (junk).
 */

export interface OutcomesCliResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

const OUTCOMES_USAGE = `Usage:
  patchwork outcomes confirm <issue-url> [--recipe <name>] [--class <actionClass>]
  patchwork outcomes reject  <issue-url> [--recipe <name>] [--class <actionClass>]
  patchwork outcomes list [--json]

Manually record an outcome disposition for a worker-filed issue so the trust
ramp can fold it as evidence. Writes to ~/.patchwork/outcome-log.jsonl. This is
an operator positive-act — NOT a step any worker recipe can run, so a worker
cannot self-confirm its own filings.

  confirm   the filing was real / accepted  -> "confirmed" (earns trust)
  reject    the filing was noise            -> "junk"      (lowers trust)
  list      print all recorded outcomes     (--json for raw output)

  --recipe <name>       stamp the filing recipe onto the record (audit context)
  --class <actionClass> stamp the action class onto the record (audit context)
`;

/** Value following `--flag` in argv, or undefined. */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Pure command core — takes argv (after `outcomes`) + an OutcomeStore and a
 * wall-clock, returns what to print and the exit code. No process.exit / no
 * Date.now so it is fully unit-testable; the index.ts dispatch supplies I/O.
 */
export function runOutcomesCli(
  args: string[],
  deps: { store: OutcomeStore; now: number },
): OutcomesCliResult {
  const sub = args[0];
  if (!sub || args.includes("--help") || args.includes("-h")) {
    // Bare `outcomes` is a usage error (exit 1); an explicit --help is exit 0.
    return { stdout: OUTCOMES_USAGE, exitCode: sub ? 0 : 1 };
  }

  if (sub === "list") {
    const records = deps.store.readAll();
    if (args.includes("--json")) {
      return { stdout: `${JSON.stringify(records, null, 2)}\n`, exitCode: 0 };
    }
    return { stdout: formatOutcomeList(records), exitCode: 0 };
  }

  if (sub === "confirm" || sub === "reject") {
    const issueUrl = args[1];
    if (!issueUrl || issueUrl.startsWith("-")) {
      return {
        stderr: `Error: \`outcomes ${sub}\` requires an <issue-url>.\n\n${OUTCOMES_USAGE}`,
        exitCode: 1,
      };
    }
    if (!/^https?:\/\//.test(issueUrl)) {
      return {
        stderr: `Error: <issue-url> must be an http(s) URL (got "${issueUrl}"). Pass the issue's GitHub URL exactly as the worker filed it.\n`,
        exitCode: 1,
      };
    }
    const disposition: OutcomeDisposition =
      sub === "confirm" ? "confirmed" : "junk";
    const recipeName = flagValue(args, "--recipe");
    const workerClass = flagValue(args, "--class");
    const record: OutcomeRecord = {
      issueUrl,
      disposition,
      checkedAt: deps.now,
      ...(recipeName ? { recipeName } : {}),
      ...(workerClass ? { workerClass } : {}),
    };
    deps.store.upsert(record);
    return {
      stdout:
        `Recorded ${disposition} for ${issueUrl}\n` +
        "The trust ramp folds this on its next replay — run `patchwork workers shadow` to see the dial move.\n",
      exitCode: 0,
    };
  }

  return {
    stderr: `Error: unknown subcommand "${sub}".\n\n${OUTCOMES_USAGE}`,
    exitCode: 1,
  };
}

/** Human-readable rendering of all recorded outcomes (last-writer-wins). */
export function formatOutcomeList(records: OutcomeRecord[]): string {
  if (records.length === 0) {
    return "No recorded outcomes yet (~/.patchwork/outcome-log.jsonl is empty or absent).\n";
  }
  const lines = records.map((r) => {
    const when = new Date(r.checkedAt).toISOString();
    const ctx = [r.recipeName, r.workerClass].filter(Boolean).join(" · ");
    return `  ${r.disposition.padEnd(9)} ${r.issueUrl}${ctx ? `  (${ctx})` : ""}  @ ${when}`;
  });
  return `${records.length} recorded outcome(s):\n${lines.join("\n")}\n`;
}
