/**
 * Deployment freshness (2026-08-19).
 *
 * The check exists because every other gate verifies the repository and none
 * verifies the running process. So the tests that matter are the ones proving
 * this check reports a problem in the exact situation that went unnoticed for
 * five days — and, critically, that the check it REPLACES would not have.
 */
import { describe, expect, it } from "vitest";

import {
  assessDeploymentFreshness,
  formatFreshness,
} from "../deploymentFreshness.js";

const BUILD = Date.parse("2026-08-19T06:21:00Z");
const alive = () => true;
const dead = () => false;

function lock(over: Record<string, unknown> = {}) {
  return {
    file: "3101.lock",
    pid: 1234,
    isBridge: true,
    startedAt: BUILD + 60_000,
    ...over,
  };
}

describe("the case that went unnoticed", () => {
  it("flags a bridge that started before the installed build", () => {
    // The live case: bridge up since 08-16, build installed 08-19. Same version
    // string on both, so only the timestamps separate them.
    const r = assessDeploymentFreshness({
      locks: [lock({ startedAt: Date.parse("2026-08-16T15:15:00Z") })],
      buildTimeMs: BUILD,
      isAlive: alive,
    });
    expect(r.findings[0]?.state).toBe("stale-code");
    expect(r.unhealthy).toBe(true);
  });

  it("does NOT flag a bridge started after the build", () => {
    const r = assessDeploymentFreshness({
      locks: [lock()],
      buildTimeMs: BUILD,
      isAlive: alive,
    });
    expect(r.findings[0]?.state).toBe("fresh");
    expect(r.unhealthy).toBe(false);
  });

  it("reports a dead lock rather than ignoring it", () => {
    // A dead lock is not harmless: the shim discovers bridges by lock file, so
    // an orphan can win discovery over a live bridge.
    const r = assessDeploymentFreshness({
      locks: [lock()],
      buildTimeMs: BUILD,
      isAlive: dead,
    });
    expect(r.findings[0]?.state).toBe("dead-lock");
    expect(r.unhealthy).toBe(true);
  });
});

describe("it refuses to answer questions it cannot", () => {
  it("reports unknown-start instead of assuming fresh", () => {
    // "We could not tell" and "it is fine" are different statements, and only
    // one of them is true here.
    const r = assessDeploymentFreshness({
      locks: [lock({ startedAt: undefined })],
      buildTimeMs: BUILD,
      isAlive: alive,
    });
    expect(r.findings[0]?.state).toBe("unknown-start");
    expect(r.unhealthy).toBe(true);
  });

  it("ignores locks that are not ours", () => {
    // Claude Code writes its own lock files. `isBridge` absent means the flag
    // predates the lock or it belongs to an IDE — either way, not ours to judge.
    const r = assessDeploymentFreshness({
      locks: [
        { file: "ide.lock", pid: 99, isBridge: undefined },
        { file: "other.lock", pid: 98, isBridge: false },
      ],
      buildTimeMs: BUILD,
      isAlive: alive,
    });
    expect(r.findings).toHaveLength(0);
    expect(r.unhealthy).toBe(false);
  });
});

describe("the output explains why it is not a version check", () => {
  it("says so when something is stale", () => {
    const r = assessDeploymentFreshness({
      locks: [lock({ startedAt: BUILD - 1 })],
      buildTimeMs: BUILD,
      isAlive: alive,
    });
    const out = formatFreshness(r, BUILD);
    // Recorded in the output, not just the source: the next person's instinct
    // will be "just compare versions", and on the live case that returns OK.
    expect(out).toContain("would not have caught this");
    expect(out).toContain("STALE");
  });

  it("says nothing is running rather than reporting health", () => {
    const out = formatFreshness(
      assessDeploymentFreshness({
        locks: [],
        buildTimeMs: BUILD,
        isAlive: alive,
      }),
      BUILD,
    );
    expect(out).toContain("Nothing is running to be stale");
  });
});

/**
 * #1481 — doctor's denominator is "locks that exist", not "bridges that should
 * exist", so it cannot see a bridge that is not there.
 *
 * `findings.some(...)` on an empty array is `false`, so zero locks resolved to
 * healthy and exit 0. The prose said "No bridge locks found. Nothing is running
 * to be stale.", which is literally true and is what made it easy to miss — the
 * exit code did not carry it, so `patchwork doctor && echo deployed` printed
 * `deployed` after a total failure to start.
 *
 * That matters because doctor is run IMMEDIATELY AFTER a kickstart, which is
 * exactly the moment a bridge is most likely to be absent: a failed LaunchAgent,
 * a crash on startup, a port collision, a half-finished restart. Observed on
 * 2026-08-20 — doctor printed one of two bridges and exited 0 while the second
 * was still restarting.
 */
describe("#1481: expecting a number of bridges to be running", () => {
  it("still exits healthy on zero locks when no expectation is set", () => {
    // The legitimate state — nothing installed yet — must stay quiet by
    // default, or the command hard-fails for people who never ran a bridge.
    const r = assessDeploymentFreshness({
      locks: [],
      buildTimeMs: BUILD,
      isAlive: alive,
    });
    expect(r.unhealthy).toBe(false);
    expect(r.running).toBe(0);
  });

  it("is unhealthy on zero locks once a bridge is expected", () => {
    const r = assessDeploymentFreshness({
      locks: [],
      buildTimeMs: BUILD,
      isAlive: alive,
      expectRunning: 1,
    });
    expect(r.unhealthy).toBe(true);
    expect(r.shortfall).toEqual({ expected: 1, running: 0 });
  });

  it("catches the observed case — one of two bridges missing", () => {
    const r = assessDeploymentFreshness({
      locks: [lock()],
      buildTimeMs: BUILD,
      isAlive: alive,
      expectRunning: 2,
    });
    expect(r.unhealthy).toBe(true);
    expect(r.shortfall).toEqual({ expected: 2, running: 1 });
  });

  it("is satisfied when the expectation is met", () => {
    const r = assessDeploymentFreshness({
      locks: [lock(), lock({ file: "63906.lock", pid: 5678 })],
      buildTimeMs: BUILD,
      isAlive: alive,
      expectRunning: 2,
    });
    expect(r.unhealthy).toBe(false);
    expect(r.shortfall).toBeUndefined();
  });

  it("does not count a dead lock as a running bridge", () => {
    // A dead lock is the opposite of reassurance — the shim discovers by lock
    // file, so it can win discovery over a live bridge. Counting it toward the
    // expectation would let a corpse satisfy the check.
    const r = assessDeploymentFreshness({
      locks: [lock(), lock({ file: "63906.lock", pid: 5678 })],
      buildTimeMs: BUILD,
      isAlive: dead,
      expectRunning: 2,
    });
    expect(r.running).toBe(0);
    expect(r.shortfall).toEqual({ expected: 2, running: 0 });
  });

  it("counts a live but STALE bridge as running", () => {
    // It is running — it is just running the wrong code. Staleness is already
    // reported on its own; conflating the two would let a stale bridge read as
    // a missing one and send the operator to the wrong remedy.
    const r = assessDeploymentFreshness({
      locks: [lock({ startedAt: BUILD - 60_000 })],
      buildTimeMs: BUILD,
      isAlive: alive,
      expectRunning: 1,
    });
    expect(r.running).toBe(1);
    expect(r.shortfall).toBeUndefined();
    // Still unhealthy, for the original reason rather than a shortfall.
    expect(r.unhealthy).toBe(true);
  });

  it("does not count an IDE's own lock toward the expectation", () => {
    const r = assessDeploymentFreshness({
      locks: [lock({ isBridge: undefined, file: "47326.lock" })],
      buildTimeMs: BUILD,
      isAlive: alive,
      expectRunning: 1,
    });
    expect(r.running).toBe(0);
    expect(r.unhealthy).toBe(true);
  });

  it("says how many were expected and how many were found", () => {
    const r = assessDeploymentFreshness({
      locks: [lock()],
      buildTimeMs: BUILD,
      isAlive: alive,
      expectRunning: 2,
    });
    const out = formatFreshness(r, BUILD);
    expect(out).toMatch(/expected 2 .*found 1/i);
  });

  it("names the absence explicitly when nothing is running at all", () => {
    const out = formatFreshness(
      assessDeploymentFreshness({
        locks: [],
        buildTimeMs: BUILD,
        isAlive: alive,
        expectRunning: 1,
      }),
      BUILD,
    );
    expect(out).toMatch(/expected 1 .*found 0/i);
  });
});
