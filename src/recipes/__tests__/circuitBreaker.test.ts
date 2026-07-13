import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  deriveBreakerKey,
  resetCircuitBreakerForTests,
} from "../circuitBreaker.js";
import { buildChainedDeps } from "../yamlRunner.js";

const TMP = os.tmpdir();

describe("deriveBreakerKey", () => {
  it("is stable for the same (recipeName, toolId) pair", () => {
    expect(deriveBreakerKey("my-recipe", "file.write")).toBe(
      deriveBreakerKey("my-recipe", "file.write"),
    );
  });

  it("differs across recipes for the same tool", () => {
    expect(deriveBreakerKey("recipe-a", "file.write")).not.toBe(
      deriveBreakerKey("recipe-b", "file.write"),
    );
  });

  it("differs across tools for the same recipe", () => {
    expect(deriveBreakerKey("my-recipe", "file.write")).not.toBe(
      deriveBreakerKey("my-recipe", "file.read"),
    );
  });
});

describe("CircuitBreaker", () => {
  it("stays closed below the failure threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(false);
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 2,
      open: false,
    });
  });

  it("opens after `failureThreshold` consecutive failures", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(true);
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 3,
      open: true,
    });
  });

  it("a success resets the failure streak and closes the breaker", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure("k");
    breaker.recordFailure("k");
    breaker.recordSuccess("k");
    expect(breaker.isOpen("k")).toBe(false);
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 0,
      open: false,
    });
  });

  it("does not open a DIFFERENT key when one key trips", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });

  it("moves to half-open (isOpen returns false) once the cooldown elapses", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100);
    expect(breaker.isOpen("k", 200)).toBe(true);
    // Cooldown (1000ms from the trip at t=100) hasn't elapsed yet.
    expect(breaker.isOpen("k", 1099)).toBe(true);
    // Cooldown elapsed — half-open probe let through.
    expect(breaker.isOpen("k", 1100)).toBe(false);
  });

  it("re-opens immediately if the half-open probe itself fails", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100);
    expect(breaker.isOpen("k", 1100)).toBe(false); // half-open probe allowed
    breaker.recordFailure("k", 1100); // probe fails
    expect(breaker.isOpen("k", 1100)).toBe(true);
  });

  it("a successful half-open probe fully closes the breaker", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100);
    expect(breaker.isOpen("k", 1100)).toBe(false); // half-open probe allowed
    breaker.recordSuccess("k");
    expect(breaker.snapshot("k")).toEqual({
      consecutiveFailures: 0,
      open: false,
    });
  });

  it("uses default threshold (5) and cooldown (10m) when unset", () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 4; i++) breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(false);
    breaker.recordFailure("k");
    expect(breaker.isOpen("k")).toBe(true);
  });

  it("REGRESSION: only ONE concurrent caller gets the half-open probe permit", () => {
    // Bug found in session-review: isOpen() cleared `openedAt` synchronously
    // to admit a probe, but recordFailure/recordSuccess only run after the
    // AWAITED tool call resolves — so two concurrent callers sharing the
    // same key (e.g. overlapping cron + manual triggers of the same
    // recipe) could both observe isOpen()===false during the same
    // half-open window and both slip through unprotected before either
    // records an outcome. Only the first caller to check after the
    // cooldown elapses should get the probe permit.
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100); // trips at t=100

    // Two "concurrent" callers both check isOpen() at the same instant,
    // t=1100 (cooldown elapsed). Only the first may pass.
    const firstCallerResult = breaker.isOpen("k", 1100);
    const secondCallerResult = breaker.isOpen("k", 1100);
    expect(firstCallerResult).toBe(false); // gets the probe permit
    expect(secondCallerResult).toBe(true); // still sees the breaker as open

    // A third caller after the probe's outcome is recorded should see the
    // updated state, not remain stuck behind a stale in-flight probe.
    breaker.recordSuccess("k");
    expect(breaker.isOpen("k", 1200)).toBe(false);
  });

  it("REGRESSION: a failed probe releases the in-flight permit so the NEXT cooldown cycle can admit a probe", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 1000,
    });
    breaker.recordFailure("k", 0);
    breaker.recordFailure("k", 100); // trips at t=100
    expect(breaker.isOpen("k", 1100)).toBe(false); // probe admitted
    breaker.recordFailure("k", 1100); // probe fails — re-opens, releases permit
    expect(breaker.isOpen("k", 1100)).toBe(true); // immediately re-opened

    // Next cooldown cycle (from the NEW openedAt=1100) must still be able
    // to admit exactly one probe — a stuck `probeInFlight` from the failed
    // probe above would wedge the breaker open forever.
    expect(breaker.isOpen("k", 2099)).toBe(true); // cooldown not yet elapsed
    expect(breaker.isOpen("k", 2100)).toBe(false); // new probe admitted
  });
});

describe("buildChainedDeps — REGRESSION: recipeName threading (chained/nested recipes)", () => {
  // Bug found in session-review: buildChainedDeps() called
  // resolveStepDeps(runnerDeps) with NO scope argument, so StepDeps.recipeName
  // stayed undefined and every tool call inside a chained (or nested)
  // recipe silently skipped the circuit breaker check in executeStep
  // (`deps.recipeName && isEnabled(...)` is false with no recipeName) no
  // matter how many times the tool failed.
  afterEach(async () => {
    const { setFlag, FLAG_CIRCUIT_BREAKER } = await import(
      "../../featureFlags.js"
    );
    setFlag(FLAG_CIRCUIT_BREAKER, false);
    resetCircuitBreakerForTests();
  });

  it("trips the breaker for a tool called through buildChainedDeps's executeTool when recipeName is passed", async () => {
    const { setFlag, FLAG_CIRCUIT_BREAKER } = await import(
      "../../featureFlags.js"
    );
    setFlag(FLAG_CIRCUIT_BREAKER, true);
    let realCalls = 0;
    const chainedDeps = buildChainedDeps(
      {
        workdir: TMP,
        testMode: true,
        writeFile: () => {
          realCalls++;
          throw new Error("disk full");
        },
      },
      undefined,
      "my-chained-recipe", // the fix: recipeName threaded through
    );

    for (let i = 0; i < 5; i++) {
      await expect(
        chainedDeps.executeTool("file.write", {
          path: path.join(TMP, "x.md"),
          content: "x",
        }),
      ).rejects.toThrow(/disk full/);
    }
    // 6th call: breaker should be open now — short-circuited without
    // invoking the real tool again.
    await expect(
      chainedDeps.executeTool("file.write", {
        path: path.join(TMP, "x.md"),
        content: "x",
      }),
    ).rejects.toThrow(/circuit_open/);
    expect(realCalls).toBe(5);
  });

  it("without recipeName (pre-fix behavior), the breaker never trips no matter how many failures", async () => {
    const { setFlag, FLAG_CIRCUIT_BREAKER } = await import(
      "../../featureFlags.js"
    );
    setFlag(FLAG_CIRCUIT_BREAKER, true);
    let realCalls = 0;
    const chainedDeps = buildChainedDeps({
      workdir: TMP,
      testMode: true,
      writeFile: () => {
        realCalls++;
        throw new Error("disk full");
      },
    }); // no recipeName argument at all

    for (let i = 0; i < 8; i++) {
      await expect(
        chainedDeps.executeTool("file.write", {
          path: path.join(TMP, "x.md"),
          content: "x",
        }),
      ).rejects.toThrow(/disk full/);
    }
    // Confirms the ABSENCE of recipeName really does disable the breaker
    // (documents the tradeoff — this is expected, not a bug, when a
    // caller genuinely has no recipe name available).
    expect(realCalls).toBe(8);
  });
});
