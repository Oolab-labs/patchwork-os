/**
 * `patchwork doctor` had TWO top-level `argv[2] === "doctor"` blocks.
 *
 * The deployment-freshness one won every time, so `commands/doctor.ts`'s four
 * health checks never produced output — `runDoctor` had exactly one production
 * caller and it was unreachable. Its own tests passed throughout, because they
 * call `runDoctor` directly with a mocked `runBridgeHealthChecks`: logic proven,
 * wiring never exercised. That is the failure this file exists to catch, so it
 * SPAWNS the built CLI rather than importing anything.
 *
 * Worse than the dead code: `--help` was answered by the losing block, so the
 * documented behaviour of `patchwork doctor` described checks that did not run
 * and never mentioned `--expect-running`, the flag that does.
 *
 * `doctor` keeps deployment freshness and its exit semantics unchanged. That
 * verb is run straight after a kickstart and `patchwork doctor && echo deployed`
 * is a real shape, so folding config checks into it would let a failing config
 * check newly fail a contract people already depend on.
 *
 * ## What these tests do NOT catch, established by mutation
 *
 * Removing the `&& argv[3] === "health"` guard — restoring the original
 * two-blocks-match-`doctor` collision — leaves every test here PASSING. Once
 * each block answers its own `--help`, the collision stops being observable
 * from outside: the deployment block still wins bare `doctor` and exits, and
 * `doctor health` still routes correctly because the deployment block skips it.
 *
 * So what is pinned is the OUTCOME (each command emits its own output and its
 * own help), not the routing guard that currently produces it. Stated because
 * the alternative is a comment claiming coverage that a mutation disproves —
 * and a test suite believed to pin something it does not is worse than one
 * known to have a gap.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const distIndex = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../dist/index.js",
);

function run(...args: string[]): string {
  const r = spawnSync(process.execPath, [distIndex, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  return `${r.stdout}${r.stderr}`;
}

describe("patchwork doctor — which handler answers", () => {
  it("`doctor` runs deployment freshness", () => {
    expect(run("doctor")).toContain("is the running code the installed code?");
  });

  it("`doctor health` runs the config checks, which never ran before", () => {
    const out = run("doctor", "health");
    expect(out).toMatch(/Workspace path/);
    expect(out).toMatch(/Git/);
    // And it must NOT be answered by the freshness block.
    expect(out).not.toContain("is the running code the installed code?");
  });
});

describe("each --help describes the command it belongs to", () => {
  it("`doctor --help` documents --expect-running, not the config checks", () => {
    const out = run("doctor", "--help");
    expect(out).toContain("--expect-running");
    // Case-insensitive: the help sentence capitalises where the runtime banner
    // does not, and asserting the banner's exact casing tests the wrong thing.
    expect(out).toMatch(/is the running code the installed code\?/i);
    // The old text. If this reappears, the losing block is answering again.
    expect(out).not.toContain(
      "Runs bridge health checks (workspace, git, lock file, automation policy)",
    );
  });

  it("`doctor health --help` documents the config checks", () => {
    const out = run("doctor", "health", "--help");
    expect(out).toContain("patchwork doctor health");
    expect(out).toContain("automation policy");
  });

  /**
   * Without `--port` the lock check looks for a lock belonging to THIS process,
   * which is a CLI and never a bridge — so it always warns. Surfacing a check
   * that always warns without saying why is how a real warning gets ignored.
   */
  it("`doctor health --help` explains the unavoidable default lock warning", () => {
    expect(run("doctor", "health", "--help")).toMatch(/--port/);
  });
});
