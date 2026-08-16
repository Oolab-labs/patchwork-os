/**
 * `patchwork approve` must be reachable from the REAL binary.
 *
 * This is a separate file from approve.test.ts on purpose. Those tests call
 * `runApproveCommand` directly and pass whether or not argv ever reaches it —
 * which is exactly the bug being fixed. The command's logic was never the
 * problem; the dispatch was. `KNOWN_SUBCOMMANDS` in src/index.ts is the
 * dispatch source, and a subcommand missing from it falls through to the
 * unknown-command suggester (and, worse, on to the bridge-mode tail, which
 * validates argv against the bridge's flag list).
 *
 * So this drives `node dist/index.js` as a subprocess and asserts on what an
 * operator actually sees after pasting the string the dashboard gave them.
 *
 * No bridge is needed: a missing callId is rejected before any lock discovery,
 * so these cases are deterministic on any machine.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const BIN = path.join(REPO, "dist", "index.js");

/** Run the built CLI, capturing stdout+stderr and the exit code. */
function run(args: string[]): { out: string; status: number } {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    return { out, status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      status: e.status ?? -1,
    };
  }
}

/**
 * `dist/` is gitignored. Skipping locally is right — a developer who has not
 * built should not see a red test — but skipping in CI is how a check reports
 * green while verifying nothing (#1414 was exactly that). CI builds before it
 * tests, so a missing binary there is a real failure.
 */
const built = existsSync(BIN);
if (!built && process.env.CI) {
  throw new Error(
    `dist/index.js is missing and CI is set. This test verifies CLI dispatch and ` +
      `must not skip itself in the one place it is guaranteed to run. Build first.`,
  );
}

describe.skipIf(!built)("patchwork approve — CLI dispatch", () => {
  it("dispatches `approve` instead of suggesting `approvals`", () => {
    const { out, status } = run(["approve"]);

    // The regression, stated exactly: before this change the binary printed
    // "Unknown command: 'approve'. Did you mean: approvals?" for the precise
    // string the dashboard copies to the clipboard.
    expect(out).not.toContain("Unknown command");
    expect(out).toContain("usage: patchwork approve <callId>");
    expect(status).toBe(1);
  });

  it("dispatches `reject` too", () => {
    const { out, status } = run(["reject"]);
    expect(out).not.toContain("Unknown command");
    expect(out).toContain("usage: patchwork reject <callId>");
    expect(out).toContain("--reason");
    expect(status).toBe(1);
  });

  it("rejects a malformed callId without needing a bridge", () => {
    const { out, status } = run(["approve", "not a call id"]);
    expect(out).toContain("is not a callId");
    expect(status).toBe(1);
  });

  it("still suggests `approve` for a near-miss typo", () => {
    // Guards the other direction: adding the subcommand must not break the
    // suggester, and `appruve` should now land on `approve`, not `approvals`.
    const { out } = run(["appruve"]);
    expect(out).toContain("Unknown command: 'appruve'");
    expect(out).toContain("approve");
  });
});
