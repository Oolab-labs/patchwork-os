#!/usr/bin/env node
/**
 * Wait for a pull request's checks to settle, then exit with the verdict.
 *
 *   node scripts/wait-pr-checks.mjs <pr-number> [--repo owner/name]
 *        [--interval <sec>] [--timeout <sec>] [--min-checks <n>] [--json]
 *
 * Exit 0: every check passed. Exit 1: at least one failed. Exit 2: timed out
 * while checks were still pending, or `gh` could not answer.
 *
 * ## Why a script and not a one-liner
 *
 * The one-liner this replaces got the central decision wrong on 2026-10-01:
 * a `jq` filter counted a check with `conclusion: ""` as a failure. An empty
 * (or null) conclusion is what GitHub reports for a check run that is QUEUED
 * or IN_PROGRESS — four CI cells showed as "failed" while they were simply
 * still running. The classification lives here, once, with a test that pins
 * it: an incomplete check is PENDING — never failed, never passed.
 *
 * Two shapes appear in `statusCheckRollup`: `CheckRun` (status + conclusion)
 * and the legacy `StatusContext` (a single `state`). Both are handled; an item
 * of any other shape is reported as pending rather than dropped, because a
 * dropped check is a check that can never block.
 *
 * `--min-checks` exists for the first poll after a PR is opened, when the
 * rollup is empty or has one entry while the rest register: an empty rollup
 * is "not settled", not "all passed".
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const CONTEXT_PENDING = new Set(["PENDING", "EXPECTED"]);

/**
 * Classify a `statusCheckRollup` array.
 *
 * @param {Array<Record<string, unknown>>} rollup
 * @param {{ minChecks?: number }} [opts]
 * @returns {{ pending: string[], passed: string[], failed: string[], settled: boolean, ok: boolean }}
 */
export function classifyChecks(rollup, opts = {}) {
  const minChecks = opts.minChecks ?? 1;
  const pending = [];
  const passed = [];
  const failed = [];

  for (const item of rollup ?? []) {
    const name = String(item.name ?? item.context ?? "<unnamed>");
    if (item.__typename === "CheckRun") {
      if (item.status !== "COMPLETED") {
        pending.push(name);
      } else if (PASSING.has(String(item.conclusion ?? ""))) {
        passed.push(name);
      } else {
        // COMPLETED with FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED,
        // STALE — or no conclusion at all. Completion without a verdict is
        // not a pass.
        failed.push(name);
      }
    } else if (item.__typename === "StatusContext") {
      const state = String(item.state ?? "");
      if (CONTEXT_PENDING.has(state)) pending.push(name);
      else if (state === "SUCCESS") passed.push(name);
      else failed.push(name);
    } else {
      pending.push(name);
    }
  }

  const total = pending.length + passed.length + failed.length;
  const settled = total >= minChecks && pending.length === 0;
  return {
    pending,
    passed,
    failed,
    settled,
    ok: settled && failed.length === 0,
  };
}

function parseArgs(argv) {
  const out = {
    pr: null,
    repo: null,
    interval: 45,
    timeout: 900,
    minChecks: 1,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--min-checks") out.minChecks = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (/^\d+$/.test(a) && out.pr === null) out.pr = a;
    else {
      process.stderr.write(`wait-pr-checks: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  if (out.pr === null) {
    process.stderr.write(
      "usage: wait-pr-checks <pr-number> [--repo owner/name] [--interval s] [--timeout s] [--min-checks n] [--json]\n",
    );
    process.exit(2);
  }
  return out;
}

function fetchRollup(pr, repo) {
  const args = ["pr", "view", pr, "--json", "statusCheckRollup"];
  if (repo) args.push("--repo", repo);
  // GITHUB_TOKEN in the environment overrides gh's keyring login and, in this
  // repo's setup, points at a token without the right scope — same reason the
  // in-flight gate strips it.
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  const out = execFileSync("gh", args, { encoding: "utf8", env });
  return JSON.parse(out).statusCheckRollup ?? [];
}

function sleep(sec) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + o.timeout * 1000;
  let result;
  for (;;) {
    let rollup;
    try {
      rollup = fetchRollup(o.pr, o.repo);
    } catch (err) {
      process.stderr.write(
        `wait-pr-checks: gh failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
    result = classifyChecks(rollup, { minChecks: o.minChecks });
    if (result.settled) break;
    if (Date.now() >= deadline) {
      if (o.json)
        process.stdout.write(
          `${JSON.stringify({ ...result, timedOut: true })}\n`,
        );
      else {
        const seen =
          result.pending.length + result.passed.length + result.failed.length;
        const why =
          result.pending.length > 0
            ? `${result.pending.length} pending: ${result.pending.join(", ")}`
            : `only ${seen} check(s) registered, --min-checks is ${o.minChecks}`;
        process.stdout.write(`timed out — ${why}\n`);
      }
      process.exit(2);
    }
    sleep(o.interval);
  }
  if (o.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `passed=${result.passed.length} failed=${result.failed.length}\n`,
    );
    for (const f of result.failed) process.stdout.write(`  FAILED  ${f}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

// Run only when invoked directly, so the test can import classifyChecks.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
