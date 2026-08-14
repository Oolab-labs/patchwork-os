import { describe, expect, it, vi } from "vitest";

import { executeAgent } from "../../recipes/agentExecutor.js";
import type { Destination } from "../dataPolicy.js";

const REMOTE: Destination = {
  id: "remote-model",
  type: "remote",
  classifications: ["public", "internal"],
};

/** Minimal deps: a driver that records whether it was ever reached. */
function depsWithSpy() {
  const ran = vi.fn(async () => ({ text: "model output" }));
  const receipts: Array<Record<string, unknown>> = [];
  return {
    ran,
    receipts,
    deps: {
      localFn: ran,
      // Enough of the real dep surface for the ALLOW path to reach dispatch.
      // The refusal tests deliberately do NOT need these — that they pass with
      // a bare stub is itself evidence the boundary short-circuits before any
      // driver work happens.
      loadPatchworkConfig: () => ({}),
      recordBoundaryDecisionFn: (r: Record<string, unknown>) => {
        receipts.push(r);
      },
    } as never,
  };
}

describe("executeAgent enforces the information boundary (ADR-0021)", () => {
  it("refuses to dispatch when the destination is not cleared", async () => {
    const { ran, deps } = depsWithSpy();
    const result = await executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "local",
        boundary: {
          dataPolicy: { classification: "restricted" },
          destination: REMOTE,
        },
      },
      deps,
    );
    // The invariant: no model-bound context leaves without passing the point.
    // Asserting the DRIVER WAS NEVER CALLED, not merely that the text says so —
    // a check on the message alone would pass even if the prompt had been sent.
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toContain("information boundary");
  });

  it("refuses a typo'd classification rather than defaulting it", async () => {
    const { ran, deps } = depsWithSpy();
    const result = await executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "local",
        boundary: {
          dataPolicy: { classification: "confidentail" },
          destination: REMOTE,
        },
      },
      deps,
    );
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toMatch(/unrecognised classification/);
  });

  it("refuses ALLOW_REDACTED rather than sending unredacted", async () => {
    // Redaction is not implemented in this phase. "We know something must be
    // removed and cannot remove it" must fail closed — the alternative sends
    // the data and logs that it should not have.
    const { ran, deps } = depsWithSpy();
    await executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "local",
        boundary: {
          dataPolicy: { classification: "internal", categories: ["beta"] },
          destination: { ...REMOTE, forbiddenCategories: ["beta"] },
        },
      },
      deps,
    );
    expect(ran).not.toHaveBeenCalled();
  });

  it("writes a receipt for every decision, including ALLOW", async () => {
    const { receipts, deps } = depsWithSpy();
    await executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "local",
        boundary: {
          dataPolicy: { classification: "internal" },
          destination: REMOTE,
        },
      },
      deps,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      decision: "ALLOW",
      destinationId: "remote-model",
    });
  });

  it("is inert when no destination is registered — existing recipes unaffected", async () => {
    const { ran, receipts, deps } = depsWithSpy();
    await executeAgent({ prompt: "synthetic prompt", driver: "local" }, deps);
    expect(ran).toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it("does not depend on its own audit trail being wired", async () => {
    // A boundary that refuses when no receipt sink is configured would be
    // trivially disabled by removing the sink. Enforcement must not need it.
    const ran = vi.fn(async () => ({ text: "out" }));
    const result = await executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "local",
        boundary: {
          dataPolicy: { classification: "restricted" },
          destination: REMOTE,
        },
      },
      { localFn: ran } as never,
    );
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toContain("information boundary");
  });
});

describe("executeAgent resolves its own destination from config", () => {
  const CFG = {
    destinations: {
      "remote-narrow": {
        type: "remote",
        classifications: ["public"],
        drivers: ["anthropic"],
      },
    },
  };

  it("enforces without the caller passing a destination", async () => {
    // The property that makes the boundary unconditional: four dispatch sites
    // exist in the flat runner alone, and a boundary depending on each of them
    // remembering to pass a destination is a boundary with four bypasses.
    const ran = vi.fn(async () => ({ text: "out" }));
    const result = await executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "anthropic",
        boundary: { dataPolicy: { classification: "confidential" } },
      },
      { localFn: ran, loadPrivacyConfigFn: () => CFG } as never,
    );
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toContain("information boundary");
  });

  it("enforces even when the step declares NO policy at all", async () => {
    // Default `internal` against a destination cleared only for `public`.
    // A step that declares nothing is still governed once the operator has
    // opted in by registering destinations.
    const ran = vi.fn(async () => ({ text: "out" }));
    const result = await executeAgent(
      { prompt: "synthetic prompt", driver: "anthropic" },
      { localFn: ran, loadPrivacyConfigFn: () => CFG } as never,
    );
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toContain("information boundary");
  });

  it("stays inert when no destinations are configured", async () => {
    const ran = vi.fn(async () => ({ text: "out" }));
    await executeAgent({ prompt: "synthetic prompt", driver: "local" }, {
      localFn: ran,
      loadPatchworkConfig: () => ({}),
      loadPrivacyConfigFn: () => undefined,
    } as never);
    expect(ran).toHaveBeenCalled();
  });
});
