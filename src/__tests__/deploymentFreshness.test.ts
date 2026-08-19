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
