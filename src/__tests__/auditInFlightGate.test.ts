/**
 * `scripts/audit-in-flight.mjs` — the gate must not skip itself in CI.
 *
 * This gate spent its entire life reporting green without checking anything.
 * Its probe was `gh api user`, and Actions' `GITHUB_TOKEN` is a repo-scoped
 * INSTALLATION token: it can read the repo and list PRs, but `GET /user`
 * returns 403 "Resource not accessible by integration" because an installation
 * has no user. So `canQuery` failed for both candidate environments and every
 * CI run printed:
 *
 *     [in-flight] SKIPPED — gh is unavailable or unauthenticated.
 *
 * Verified in a real CI log (run 31873349778) on a run that reported green
 * while two Active entries went unverified — one naming a branch whose PR had
 * already merged, which is precisely what the gate exists to catch.
 *
 * The file's own header documented this hazard ("Stripping it unconditionally
 * … would make the gate skip itself in the one place it is meant to run"). The
 * note was right and the code did not implement it, which is why these tests
 * drive the SCRIPT as a subprocess rather than asserting on its source: a
 * comment claiming a property is not the property.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "audit-in-flight.mjs");

/** Run the gate with `gh` removed from PATH, so `canQuery` must fail. */
function runWithoutGh(env: Record<string, string | undefined>) {
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "no-gh-"));
  try {
    const res = execFileSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: "utf8",
      // PATH containing only an empty dir ⇒ `gh` cannot be found at all,
      // which is the same observable state as an unauthenticated one.
      env: { ...process.env, ...env, PATH: emptyBin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: res };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
  }
}

/**
 * The gate only reaches the availability check when the Active section names
 * at least one branch — otherwise it short-circuits on "nothing to check".
 */
let ledgerBackup = "";
const LEDGER = path.join(REPO, "docs", "in-flight.md");

beforeEach(() => {
  ledgerBackup = readFileSync(LEDGER, "utf8");
  const withEntry = ledgerBackup.replace(
    "## Active\n",
    "## Active\n\n- 2026-01-01 `test/synthetic-branch` — synthetic entry for the gate's own test.\n",
  );
  writeFileSync(LEDGER, withEntry);
});

afterEach(() => {
  writeFileSync(LEDGER, ledgerBackup);
});

describe("audit-in-flight — must not skip itself in CI", () => {
  it("FAILS when it cannot query GitHub and CI is set", () => {
    // The regression that matters. Before this fix the same conditions
    // produced exit 0 and a green check.
    const { status, out } = runWithoutGh({ CI: "1" });
    expect(status).toBe(1);
    expect(out).toMatch(/FAIL/);
    expect(out).toMatch(/could not be verified/);
  });

  it("still SKIPS (exit 0) outside CI", () => {
    // A developer on a laptop with no `gh` must not be blocked by a check they
    // never asked for. The asymmetry is the design, not an oversight — so it
    // is pinned, or a later "make it strict everywhere" would break local work.
    const { status, out } = runWithoutGh({ CI: undefined });
    expect(status).toBe(0);
    expect(out).toMatch(/SKIPPED/);
    // And it says out loud what would happen in CI, so the local skip cannot
    // be mistaken for the check having run.
    expect(out).toMatch(/Would FAIL in CI/);
  });

  it("probes the REPO endpoint, not /user", () => {
    // The root cause, pinned directly. `GET /user` is the one call an
    // installation token cannot make, and it is a capability the gate never
    // uses — `prState` only ever does a repo read (`gh pr list`).
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/repos\/\{owner\}\/\{repo\}/);
    expect(src).not.toMatch(/"gh",\s*\[\s*"api",\s*"user"/);
  });
});
