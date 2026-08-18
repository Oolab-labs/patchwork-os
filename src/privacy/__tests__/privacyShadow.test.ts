/**
 * Privacy shadow mode (ADR-0021).
 *
 * The dangerous property of this feature is not that it under-reports — it is
 * that it lives INSIDE the enforcement chokepoint. A shadow evaluation that
 * perturbs enforcement turns an observation tool into a privacy regression, so
 * that is what the first two tests are for, and both are written so they would
 * fail if the property were lost.
 *
 * Every fixture here is synthetic. Privacy fixtures pull real names in by
 * gravity, and a privacy engine that leaks in its own test data is the sharpest
 * possible own goal.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeAgent } from "../../recipes/agentExecutor.js";
import type { PrivacyConfig } from "../destinationRegistry.js";
import {
  formatPrivacyShadow,
  recordPrivacyShadow,
  summarisePrivacyShadow,
} from "../shadowLog.js";

/**
 * A candidate policy that clears NOTHING above `public` for a remote
 * destination — so a default (`internal`) step is a crossing.
 */
const SHADOW_CONFIG: PrivacyConfig = {
  destinations: {
    "candidate-remote": {
      type: "remote",
      classifications: ["public"],
      drivers: ["local", "anthropic", "openai"],
    },
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "privacy-shadow-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function deps(extra: Record<string, unknown> = {}) {
  const ran = vi.fn(async () => ({ text: "model output" }));
  const shadowRows: Array<Record<string, unknown>> = [];
  return {
    ran,
    shadowRows,
    deps: {
      localFn: ran,
      loadPatchworkConfig: () => ({}),
      ...extra,
    } as never,
  };
}

describe("shadow mode cannot perturb enforcement", () => {
  it("dispatches identically with and without a shadow policy that would DENY", async () => {
    // Baseline: no shadow wiring at all.
    const a = deps();
    const before = await executeAgent(
      { prompt: "synthetic prompt", driver: "local" },
      a.deps,
    );

    // Same call, but with a candidate policy that refuses this step outright.
    const b = deps({
      loadPrivacyShadowConfigFn: () => SHADOW_CONFIG,
      recordPrivacyShadowFn: (r: Record<string, unknown>) => {
        b.shadowRows.push(r);
      },
    });
    const after = await executeAgent(
      { prompt: "synthetic prompt", driver: "local" },
      b.deps,
    );

    // The driver ran BOTH times. Asserting the call, not the returned text — a
    // text-only check would pass even if the shadow path had suppressed the
    // dispatch, which is precisely the failure being excluded.
    expect(a.ran).toHaveBeenCalledTimes(1);
    expect(b.ran).toHaveBeenCalledTimes(1);
    expect(after.text).toBe(before.text);

    // ...and the shadow genuinely disagreed, or this test proves nothing: a
    // shadow policy that happened to ALLOW would make the assertions above
    // pass for the wrong reason.
    expect(b.shadowRows).toHaveLength(1);
    expect(b.shadowRows[0]?.decision).not.toBe("ALLOW");
  });

  it("a shadow recorder that throws does not fail the step", async () => {
    const d = deps({
      loadPrivacyShadowConfigFn: () => SHADOW_CONFIG,
      recordPrivacyShadowFn: () => {
        throw new Error("ledger is unwritable");
      },
    });
    const result = await executeAgent(
      { prompt: "synthetic prompt", driver: "local" },
      d.deps,
    );
    expect(d.ran).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("model output");
  });
});

describe("the denominator counts every observed dispatch", () => {
  it("records ALLOWed dispatches too, not only crossings", async () => {
    // A candidate policy that clears `internal` — so this step is ALLOWed and
    // must STILL be observed. If only refusals were recorded, the denominator
    // would be the refusals themselves and coverage would always read 100%.
    const permissive: PrivacyConfig = {
      destinations: {
        "candidate-local": {
          type: "local",
          classifications: ["public", "internal", "personal"],
          drivers: ["local"],
        },
      },
    };
    const d = deps({
      loadPrivacyShadowConfigFn: () => permissive,
      recordPrivacyShadowFn: (r: Record<string, unknown>) => {
        d.shadowRows.push(r);
      },
    });
    await executeAgent({ prompt: "synthetic prompt", driver: "local" }, d.deps);
    expect(d.shadowRows).toHaveLength(1);
    expect(d.shadowRows[0]?.decision).toBe("ALLOW");
  });
});

describe("the ledger carries no payload", () => {
  it("never stores the prompt, only declared metadata", () => {
    recordPrivacyShadow(
      {
        decision: "DENY",
        classification: "confidential",
        categories: ["financial"],
        destinationId: "candidate-remote",
        destinationType: "remote",
        reason: "synthetic reason",
        enforcing: false,
      },
      { dir },
    );
    const raw = readFileSync(path.join(dir, "privacy_shadow.jsonl"), "utf-8");
    const row = JSON.parse(raw.trim());
    // Category NAMES are metadata; their contents are not. A privacy ledger
    // holding the prompts would be the largest unclassified copy of exactly
    // what the boundary protects.
    expect(row.categories).toEqual(["financial"]);
    expect(Object.keys(row)).not.toContain("prompt");
    expect(Object.keys(row)).not.toContain("payload");
    expect(Object.keys(row)).not.toContain("text");
  });
});

describe("reporting leads with coverage and never a bare count", () => {
  it("an empty ledger reports 'nothing observed', NOT '0 crossings'", () => {
    const out = formatPrivacyShadow(summarisePrivacyShadow({ dir }));
    // "0 crossings" from an empty ledger asserts a clean result from a
    // measurement that never happened — the exact false comfort this whole
    // feature exists to avoid.
    expect(out).toContain("Nothing has been observed yet");
    expect(out).not.toMatch(/\b0 of 0\b/);
  });

  it("always names the unobserved path alongside any count", () => {
    for (const decision of ["ALLOW", "DENY", "LOCAL_ONLY"] as const) {
      recordPrivacyShadow(
        {
          decision,
          classification: "internal",
          destinationId: "candidate-remote",
          destinationType: "remote",
          reason: "synthetic reason",
          enforcing: false,
        },
        { dir },
      );
    }
    const s = summarisePrivacyShadow({ dir });
    expect(s.observed).toBe(3);
    expect(s.crossings).toBe(2);

    const out = formatPrivacyShadow(s);
    // Coverage precedes the finding, in the output itself and not merely in
    // documentation: the orchestrator path is ungoverned (#1397), so a count
    // presented without it invites "my policy is fine" from a partial surface.
    expect(out.indexOf("NOT observed")).toBeLessThan(out.indexOf("would have"));
    expect(out).toContain("orchestrator task dispatch");
    expect(out).toContain("2 of 3 observed dispatch(es)");
  });

  it("separates observations made while a live policy was enforcing", () => {
    recordPrivacyShadow(
      {
        decision: "DENY",
        classification: "internal",
        destinationId: "candidate-remote",
        destinationType: "remote",
        reason: "synthetic reason",
        enforcing: true,
      },
      { dir },
    );
    const s = summarisePrivacyShadow({ dir });
    // "my candidate disagrees with my live policy" is a different claim from
    // "here is what a policy would have done on an ungoverned machine".
    expect(s.enforcingObservations).toBe(1);
  });
});
