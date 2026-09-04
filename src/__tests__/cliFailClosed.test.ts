/**
 * An unrecognised argument must exit non-zero and name what it did not
 * understand.
 *
 * Three instances of one family were found by hand, all of which reported
 * SUCCESS while doing something other than what was asked:
 *
 *   - `patchwork evidence verify` ran the plain coverage report and exited 0,
 *     because the CLI predated the subcommand. The operator believes an
 *     integrity check passed; none ran. `verify` exists now — but any NEIGHBOUR
 *     of it (`check`, `validate`) still degrades to the report the same way, so
 *     the hole that produced that incident is open, merely moved one token
 *     over.
 *   - `audit-private-identifiers.mjs --message-file <f>` (the real flag is
 *     `--message`) fell through to the staged-diff branch, scanned 19 bytes of
 *     branch name, and printed OK.
 *   - a scripted `string.replace` that matched nothing exited 0.
 *
 * The shared property is that the failure is INVISIBLE: a silently-ignored
 * argument is indistinguishable from an honoured one, so the louder the
 * command's success message the more convincing the wrong answer. That is why
 * these tests assert on the EXIT CODE first and the text second.
 *
 * They SPAWN the built CLI. A unit test over the parser could not have caught
 * the `evidence` instance, because the parser was never wired to reject
 * anything — the defect was the absence of a call, which only the real entry
 * point can demonstrate. Same reasoning as `doctorDispatch.test.ts`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { rejectUnknownArgs, UNRECOGNISED_EXIT } from "../cliArgs.js";

const distIndex = path.resolve(import.meta.dirname, "../../dist/index.js");

let tmp = "";
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function run(...args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [distIndex, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("`patchwork evidence` refuses what it cannot honour", () => {
  /**
   * The shape of the original incident, with the token moved one over.
   * `check` is a plausible typo for the real `verify`, and today it runs the
   * coverage report and exits 0 — so an operator checking ledger integrity is
   * told everything is fine by a command that never looked. Exactly the
   * failure that stood before `verify` existed.
   */
  it("refuses an unknown subcommand instead of running the plain report", () => {
    const r = run("evidence", "check");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("check");
    // The tell: the coverage report must NOT have been produced.
    expect(r.out).not.toMatch(/rows carry|joinable/i);
  });

  it("refuses an unknown flag and names it", () => {
    const r = run("evidence", "--summary");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("--summary");
  });

  /**
   * Usage errors exit 2, not 1. `evidence verify` exits 1 for a BROKEN CHAIN —
   * the one form of this verb that gates.
   * Collapsing "I did not understand you" into the same code as "your ledgers
   * are tampered with" would make a typo indistinguishable from a real
   * integrity failure in exactly the cron job written to act on it.
   */
  it("uses a usage exit code distinct from a gate failure", () => {
    expect(run("evidence", "--summary").status).toBe(UNRECOGNISED_EXIT);
    expect(UNRECOGNISED_EXIT).not.toBe(1);
  });
});

describe("controls — the accepted forms must still work", () => {
  it("bare `evidence` still reports and exits 0", () => {
    const r = run("evidence");
    expect(r.status).toBe(0);
  });

  /**
   * The real subcommand must keep working, and must keep GATING: it is the one
   * form of this verb that exits non-zero on a broken chain. A guard that
   * refused it would disable the integrity check while looking like a fix.
   */
  it("`evidence verify` still runs the integrity check", () => {
    const r = run("evidence", "verify");
    expect(r.out).toContain("is the spine internally intact?");
    expect(r.status).not.toBe(UNRECOGNISED_EXIT);
  });

  it("`evidence verify --json` still runs", () => {
    const r = run("evidence", "verify", "--json");
    expect(r.status).not.toBe(UNRECOGNISED_EXIT);
    expect(r.out).toContain('"ok"');
  });

  it("`--json` still exits 0", () => {
    expect(run("evidence", "--json").status).toBe(0);
  });

  it("`--help` still exits 0", () => {
    const r = run("evidence", "--help");
    expect(r.status).toBe(0);
    expect(r.out).toContain("--dir");
  });

  /**
   * The value after a value-taking flag must not itself be read as an unknown
   * argument. Without this the guard would reject every real `--dir` call —
   * a fail-closed check that breaks the working path is worse than the hole.
   */
  it("does not mistake a --dir value for an unknown argument", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "evidence-args-"));
    const r = run("evidence", "--dir", tmp);
    expect(r.status).toBe(0);
  });
});

describe("naming the argument must not disclose a private path", () => {
  /**
   * This repository is world-readable and its operator ledgers are not. A
   * refusal is printed to a terminal, scrollback and CI logs, so echoing an
   * arbitrary token back would put whatever the operator typed — a path under
   * a real client directory, say — into all three. Flags and bare words are
   * echoed; anything path-shaped is described, never quoted. Same reasoning as
   * the private-identifier gate, which prints an entry NUMBER and never the
   * matched string.
   */
  it("echoes a bare word", () => {
    const r = rejectUnknownArgs({
      command: "evidence",
      args: ["verify"],
      flags: [],
      exit: false,
    });
    expect(r?.message).toContain("verify");
  });

  it("echoes a flag", () => {
    const r = rejectUnknownArgs({
      command: "evidence",
      args: ["--message-file"],
      flags: [],
      exit: false,
    });
    expect(r?.message).toContain("--message-file");
  });

  it("does NOT echo a path-shaped argument", () => {
    const secret = "/Users/someone/AcmeConfidentialCo/notes.txt";
    const r = rejectUnknownArgs({
      command: "evidence",
      args: [secret],
      flags: [],
      exit: false,
    });
    expect(r).not.toBeNull();
    expect(r?.message).not.toContain("AcmeConfidentialCo");
    expect(r?.message).not.toContain(secret);
  });

  it("returns null when every argument is recognised", () => {
    expect(
      rejectUnknownArgs({
        command: "evidence",
        args: ["--dir", os.tmpdir(), "--json"],
        flags: ["--json"],
        valueFlags: ["--dir"],
        exit: false,
      }),
    ).toBeNull();
  });
});
