/**
 * `scripts/audit-private-identifiers.mjs` — the mechanical half of CLAUDE.md's
 * Repository Privacy section.
 *
 * Tests drive the SCRIPT as a subprocess, never its internals. The rule being
 * enforced is "this must not reach a public commit", and only the real
 * entry point can demonstrate that. Every guard reviewed in this repo that
 * asserted on its own source instead turned out to be checking something other
 * than the invariant it claimed.
 *
 * NOTE ON FIXTURES: every denylist pattern below is invented for the test.
 * Using a real private identifier here would publish it in a tracked file —
 * the exact failure the gate exists to prevent, committed by its own tests.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "audit-private-identifiers.mjs");

let dir = "";
let denylist = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "priv-ids-"));
  denylist = path.join(dir, "denylist.txt");
  writeFileSync(
    denylist,
    "# synthetic\nAcmeConfidentialCo\nsecret-client-xyz\n",
  );
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): { status: number; out: string } {
  // spawnSync, NOT execFileSync: on a zero exit execFileSync returns stdout
  // ONLY, so every warning — which this script writes to stderr — was silently
  // discarded, and assertions ran against an empty string. Caught by two tests
  // failing against a script that was behaving correctly.
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, PATCHWORK_DENYLIST: denylist, ...env },
  });
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

function fileWith(content: string): string {
  const f = path.join(dir, `probe-${Math.abs(content.length)}.txt`);
  writeFileSync(f, content);
  return f;
}

describe("blocks denylisted identifiers", () => {
  it("blocks a commit message containing one", () => {
    const r = run([
      "--message",
      fileWith("chore: onboarding for AcmeConfidentialCo"),
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("BLOCKED");
  });

  it("blocks arbitrary text containing one", () => {
    const r = run(["--text", fileWith("const c = 'secret-client-xyz';")]);
    expect(r.status).toBe(1);
  });

  it("matches case-insensitively", () => {
    // The threat is a real name used as a neutral-looking identifier, so a
    // case variant is the likeliest form, not an exotic one.
    const r = run(["--text", fileWith("see ACMECONFIDENTIALCO notes")]);
    expect(r.status).toBe(1);
  });

  it("matches a substring inside a larger token", () => {
    const r = run(["--text", fileWith("acct-secret-client-xyz-004")]);
    expect(r.status).toBe(1);
  });

  it("NEVER prints the matched string", () => {
    // Echoing it would write the secret into scrollback, CI logs and
    // screenshots — the same disclosure one layer over. The report must
    // identify the entry by NUMBER.
    const r = run(["--text", fileWith("AcmeConfidentialCo")]);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("AcmeConfidentialCo");
    expect(r.out).toMatch(/entry #\d+/);
  });
});

describe("passes clean input (controls)", () => {
  it("passes text with no denylisted identifier", () => {
    // Without this, every assertion above would hold just as well for a gate
    // that blocked unconditionally.
    const r = run(["--text", fileWith("a perfectly ordinary commit body")]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("OK");
  });

  it("reports what it actually scanned", () => {
    // A scan of zero patterns or zero bytes must not read as clean. The counts
    // are the evidence that something was examined.
    const r = run(["--text", fileWith("nothing to see")]);
    expect(r.out).toMatch(/2 pattern\(s\) checked/);
    expect(r.out).toMatch(/\d+ bytes/);
  });
});

describe("cannot silently verify nothing", () => {
  it("says NOTHING WAS VERIFIED when no denylist is configured", () => {
    // Exiting 0 quietly here is exactly how `audit-in-flight` reported green
    // while checking nothing for its entire life. A developer without a
    // denylist must not be blocked — but must not read this as a pass either.
    const r = run(["--text", fileWith("anything")], {
      PATCHWORK_DENYLIST: "",
      HOME: dir, // no ~/.patchwork/private-identifiers.txt under here
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("verified NOTHING");
  });

  it("FAILS on a missing denylist when PATCHWORK_DENYLIST_REQUIRED=1", () => {
    const r = run(["--text", fileWith("anything")], {
      PATCHWORK_DENYLIST: "",
      HOME: dir,
      PATCHWORK_DENYLIST_REQUIRED: "1",
    });
    expect(r.status).toBe(1);
  });

  it("says NOTHING WAS VERIFIED for an empty denylist", () => {
    // A file with no patterns scans everything against nothing and reports
    // clean — the same hazard as a scan that walks zero files.
    writeFileSync(denylist, "# only comments\n\n");
    const r = run(["--text", fileWith("AcmeConfidentialCo")]);
    expect(r.out).toContain("verified NOTHING");
  });
});

describe("refuses to run if the denylist itself is committed", () => {
  // POSIX-only: the seam is a fake `git` earlier on PATH, and a `#!/bin/sh`
  // stub is not executable on Windows — real git runs, reports the file
  // untracked, and the assertion fails on a script that is behaving correctly.
  // Matches the existing `skipIf(win32)` convention for the symlink tests in
  // src/recipes/tools/__tests__/file.test.ts.
  //
  // The logic under test reads `git ls-files` and compares a string; there is
  // nothing platform-dependent in it, and it is exercised on ubuntu + macOS.
  it.skipIf(process.platform === "win32")(
    "is a FATAL error, not a warning",
    () => {
      // The worst outcome the design can produce: a tracked denylist publishes
      // verbatim every string it exists to keep out, in a file helpfully
      // labelled as the list of secrets. Simulated via a fake `git` on PATH so
      // the test never touches the real index.
      const fakeBin = path.join(dir, "bin");
      rmSync(fakeBin, { recursive: true, force: true });
      writeFileSync(
        path.join(dir, "git-stub.sh"),
        `#!/bin/sh\nif [ "$1" = "ls-files" ]; then echo ".private-denylist"; exit 0; fi\nexit 0\n`,
      );
      execFileSync("mkdir", ["-p", fakeBin]);
      execFileSync("cp", [
        path.join(dir, "git-stub.sh"),
        path.join(fakeBin, "git"),
      ]);
      execFileSync("chmod", ["+x", path.join(fakeBin, "git")]);

      const r = run(["--text", fileWith("clean")], {
        PATH: `${fakeBin}:${process.env.PATH}`,
      });
      expect(r.status).toBe(2);
      expect(r.out).toContain("FATAL");
      expect(r.out).toContain("git rm --cached");
    },
  );
});
