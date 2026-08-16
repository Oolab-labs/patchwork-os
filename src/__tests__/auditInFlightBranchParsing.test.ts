/**
 * `audit-in-flight` — which backticked tokens are BRANCHES.
 *
 * The old pattern (`[a-z][a-z0-9]*\/[a-z0-9][a-z0-9._-]*`) was wrong in both
 * directions simultaneously, and the two errors hid each other: it invented
 * branches out of file paths (inflating the count a human reads) while missing
 * real branch names (silently not verifying them).
 *
 * Observed live on 2026-08-16: an Active section holding ONE entry printed
 * "3 branch(es) named in the Active section checked" — the real branch plus
 * `src/server.ts` and `src/bridge.ts`, both of which the entry named as files
 * it touched.
 *
 * These drive the script as a subprocess against a fixture ledger via
 * `--ledger`, and read the count off the SKIP message (the gate reports how
 * many Active entries it would have verified). Running with `gh` removed from
 * PATH means no GitHub credential is needed to observe the parse.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "audit-in-flight.mjs");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

/** Run the gate against a fixture ledger, with `gh` unavailable and CI unset. */
function runOn(activeBody: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "in-flight-parse-"));
  tmpDirs.push(dir);
  const ledger = path.join(dir, "in-flight.md");
  writeFileSync(
    ledger,
    `# ledger\n\n## Active\n\n${activeBody}\n\n## Recently closed\n`,
  );
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "no-gh-"));
  tmpDirs.push(emptyBin);
  const env = { ...process.env, PATH: emptyBin };
  delete (env as Record<string, string | undefined>).CI;
  try {
    return execFileSync(process.execPath, [SCRIPT, "--ledger", ledger], {
      cwd: REPO,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

describe("audit-in-flight — branch token parsing", () => {
  it("does NOT count a backticked file path as a branch", () => {
    const out = runOn(
      "- 2026-01-01 `feat/real-branch` — touches `src/server.ts` and `src/bridge.ts`.",
    );
    // One entry, one branch. The two file paths are named in the same line and
    // match the branch shape exactly; only their existence on disk separates
    // them.
    expect(out).toContain("1 Active entry");
    expect(out).not.toContain("3 Active");
    expect(out).toContain("src/server.ts");
  });

  it("SEES a branch with more than one slash", () => {
    // The old pattern stopped at the second slash, so this entry named a
    // branch the gate could not see — and an unseen entry is an unverified
    // one, which is this gate's entire failure history.
    const out = runOn("- 2026-01-01 `feat/scope/deep-branch` — a real branch.");
    // Under the old pattern this line matched nothing at all, so the gate
    // printed "names no branches" and exited 0 — green, having checked none.
    expect(out).toContain("1 Active entry");
    expect(out).not.toContain("names no branches");
  });

  it("SEES a branch containing uppercase and underscores", () => {
    const out = runOn("- 2026-01-01 `fix/ADR_20-thing` — a real branch.");
    expect(out).toContain("1 Active entry");
  });

  it("counts a real branch even when the line also names paths", () => {
    const out = runOn(
      "- 2026-01-01 `feat/one` — see `dashboard/src/lib/session.ts`, `package.json`.",
    );
    expect(out).toContain("1 Active entry");
  });

  it("reports nothing to check when the entry names ONLY paths", () => {
    // Not a pass-by-accident: an entry naming no branch is unverifiable, and
    // the gate must say so rather than counting a path and reporting green.
    const out = runOn("- 2026-01-01 touches `src/server.ts` only.");
    expect(out).toContain("names no branches");
  });
});
