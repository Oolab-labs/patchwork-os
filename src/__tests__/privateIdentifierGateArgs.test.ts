/**
 * `audit-private-identifiers.mjs` must refuse an argument it does not
 * understand, rather than scanning something else and printing OK.
 *
 * The instance: `--message-file <path>` — the real flag is `--message` —
 * matched neither branch of `collectSources`, fell through to the staged-diff
 * default, scanned ~19 bytes of branch name, and reported success. The commit
 * message it was pointed at was never read. This gate runs from a git hook,
 * where nobody reads the output of a passing check, so the wrong flag name
 * could have stood indefinitely.
 *
 * A SEPARATE file from `privateIdentifierGate.test.ts` on purpose: this covers
 * argument dispatch, that one covers denylist matching, and they are edited by
 * different work.
 *
 * NOTE ON FIXTURES: every denylist pattern here is invented for the test, per
 * the same rule as its sibling.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "audit-private-identifiers.mjs");

let dir = "";
let denylist = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "priv-ids-args-"));
  denylist = path.join(dir, "denylist.txt");
  writeFileSync(denylist, "# synthetic\nAcmeConfidentialCo\n");
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, PATCHWORK_DENYLIST: denylist },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("refuses an argument it cannot honour", () => {
  /**
   * The exact defect. The file contains a denylisted identifier, so a gate
   * that had honoured the flag would BLOCK; one that ignored it prints OK.
   * Asserting only on the exit code would therefore have been ambiguous —
   * hence the assertion that the flag name is named.
   */
  it("rejects --message-file rather than scanning the staged diff", () => {
    const f = path.join(dir, "msg.txt");
    writeFileSync(f, "AcmeConfidentialCo");

    const r = run(["--message-file", f]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("--message-file");
    expect(r.out).not.toMatch(/\bOK\b/);
  });

  it("rejects an unknown bare argument", () => {
    const r = run(["scan"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("scan");
  });

  /**
   * The refusal reaches a terminal, scrollback and CI logs. This script exists
   * precisely to keep private strings out of published text and never prints a
   * matched identifier — only an entry number — so its own usage error must
   * hold the same line.
   */
  it("does not echo a path-shaped argument back", () => {
    const r = run(["/Users/someone/AcmeConfidentialCo/notes.txt"]);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("AcmeConfidentialCo");
  });
});

describe("controls — accepted forms are unchanged", () => {
  it("--message still scans the named file and blocks", () => {
    const f = path.join(dir, "msg.txt");
    writeFileSync(f, "AcmeConfidentialCo");
    expect(run(["--message", f]).status).toBe(1);
  });

  it("--message on clean text still passes", () => {
    const f = path.join(dir, "clean.txt");
    writeFileSync(f, "fix: a perfectly ordinary commit message");
    expect(run(["--message", f]).status).toBe(0);
  });

  it("--text still scans the named file", () => {
    const f = path.join(dir, "body.txt");
    writeFileSync(f, "AcmeConfidentialCo");
    expect(run(["--text", f]).status).toBe(1);
  });

  it("no arguments still scans the staged diff and branch name", () => {
    expect(run([]).status).toBe(0);
  });
});
