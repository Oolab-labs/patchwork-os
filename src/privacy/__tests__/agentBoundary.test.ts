import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("receipts name the RESOLVED destination", () => {
  it("records where the data was actually going, not what the caller passed", () => {
    // Regression guard. The first wiring read `input.boundary.destination.id`,
    // which is undefined on the normal path where the destination is resolved
    // from config — so every receipt recorded a decision with no record of the
    // destination, which is the field that makes it an audit trail rather than
    // a counter.
    const receipts: Array<Record<string, unknown>> = [];
    const ran = vi.fn(async () => ({ text: "out" }));
    return executeAgent(
      {
        prompt: "synthetic prompt",
        driver: "anthropic",
        boundary: { dataPolicy: { classification: "confidential" } },
      },
      {
        localFn: ran,
        loadPrivacyConfigFn: () => ({
          destinations: {
            "remote-narrow": {
              type: "remote",
              classifications: ["public"],
              drivers: ["anthropic"],
            },
          },
        }),
        recordBoundaryDecisionFn: (r: Record<string, unknown>) =>
          receipts.push(r),
      } as never,
    ).then(() => {
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        destinationId: "remote-narrow",
        destinationType: "remote",
        classification: "confidential",
      });
      expect(receipts[0]?.destinationId).toBeDefined();
    });
  });
});

// ── #1398 part 2: the boundary judges the driver that ACTUALLY runs ─────────
//
// These drive `executeAgent` — the real entry point — rather than calling the
// resolver directly. A test that hand-injected a resolved driver would pass
// whether or not `executeAgent` was wired to use it, which is exactly how
// ADR-0021 shipped inert twice.
describe("boundary judges the RESOLVED driver, not the configured string", () => {
  // `narrow` exists so the anthropic case DISCRIMINATES. Without it, an
  // unresolved driver ("") falls through to strictest-remote and lands on the
  // same destination the explicit `anthropic` mapping would have chosen, so
  // the test would pass whether or not the resolved driver was wired in — a
  // verification that cannot fail. With it, the two paths name different
  // destinations: `cloud` via the mapping, `narrow` via the fallback.
  const LOCAL_CFG = {
    destinations: {
      "on-box": {
        type: "local",
        classifications: ["restricted"],
      },
      cloud: {
        type: "remote",
        classifications: ["public", "internal"],
        drivers: ["anthropic"],
      },
      narrow: {
        type: "remote",
        classifications: ["public"],
      },
    },
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function deps(pwCfg: Record<string, unknown>) {
    const receipts: Array<Record<string, unknown>> = [];
    const localFn = vi.fn(async () => ({ text: "out" }));
    const anthropicFn = vi.fn(async () => ({ text: "out" }));
    return {
      receipts,
      localFn,
      anthropicFn,
      deps: {
        localFn,
        anthropicFn,
        probeClaudeCli: () => false,
        loadPatchworkConfig: () => pwCfg,
        loadPrivacyConfigFn: () => LOCAL_CFG,
        recordBoundaryDecisionFn: (r: Record<string, unknown>) => {
          receipts.push(r);
        },
      } as never,
    };
  }

  it("an undefined driver resolving to local is judged against the LOCAL destination", async () => {
    // Before the fix the boundary saw `undefined`, fell through to the
    // strictest-remote fallback, and REFUSED a restricted prompt that was
    // never going to leave the machine.
    const { receipts, localFn, deps: d } = deps({ model: "local" });
    const result = await executeAgent(
      {
        prompt: "synthetic prompt",
        boundary: { dataPolicy: { classification: "restricted" } },
      },
      d,
    );
    expect(receipts[0]).toMatchObject({
      decision: "ALLOW",
      destinationId: "on-box",
      destinationType: "local",
    });
    expect(localFn).toHaveBeenCalled();
    expect(result.text).toBe("out");
  });

  it("an undefined driver resolving to anthropic is judged against the REMOTE destination", async () => {
    // Same undefined `driver`, opposite resolution. The receipt must name
    // `cloud` — the destination mapped to the RESOLVED driver — and not
    // `narrow`, which is where an unresolved driver falls through to.
    const { receipts, anthropicFn, deps: d } = deps({ driver: "anthropic" });
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
    {
      const result = await executeAgent(
        {
          prompt: "synthetic prompt",
          boundary: { dataPolicy: { classification: "restricted" } },
        },
        d,
      );
      // LOCAL_ONLY rather than DENY: an on-box destination in this registry
      // DOES accept `restricted`, so the correct reading is "this may run,
      // but not there" — still a refusal for this dispatch.
      expect(receipts[0]).toMatchObject({
        decision: "LOCAL_ONLY",
        destinationId: "cloud",
        destinationType: "remote",
      });
      // The side effect, not the message: a message assertion passes even if
      // the prompt already went.
      expect(anthropicFn).not.toHaveBeenCalled();
      expect(result.text).toContain("information boundary");
    }
  });

  it("a local driver aimed off-box is judged REMOTE and never dispatches", async () => {
    // The end-to-end version of part 1: driver says local, endpoint says
    // otherwise, and the prompt must not be sent.
    const {
      receipts,
      localFn,
      deps: d,
    } = deps({
      model: "local",
      localEndpoint: "https://inference.example.test/v1",
    });
    // Cleared so the config-file value is what resolves, not this machine's env.
    vi.stubEnv("LOCAL_ENDPOINT", "");
    {
      const result = await executeAgent(
        {
          prompt: "synthetic prompt",
          boundary: { dataPolicy: { classification: "restricted" } },
        },
        d,
      );
      expect(receipts[0]).toMatchObject({ decision: "LOCAL_ONLY" });
      expect(receipts[0]?.destinationType).toBe("remote");
      expect(localFn).not.toHaveBeenCalled();
      expect(result.text).toContain("information boundary");
    }
  });
});
