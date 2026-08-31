/**
 * ADR-0021 (2026-08-30 amendment) — orchestrator dispatch is ENFORCED.
 *
 * `boundaryScope.test.ts` pins the wiring by reading the source: that the call
 * exists, at the dispatch point, before the observation. It cannot tell whether
 * the boundary actually STOPS anything, because a source-shaped guard passes
 * against an enforcement that computes a decision and discards it.
 *
 * So this file drives a real `ClaudeOrchestrator` with a driver that records
 * whether it ran. Every test here turns on whether the DRIVER was reached — not
 * on a status string, and not on a log line — because "the prompt did not leave
 * this machine" is the only claim the boundary actually makes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeOrchestrator } from "../../claudeOrchestrator.js";
import type { ProviderDriver, ProviderTaskInput } from "../../drivers/types.js";

const noop = () => {};

/** Records whether the prompt ever reached a driver. That is the whole claim. */
function makeSpyDriver(): { driver: ProviderDriver; ran: () => boolean } {
  let ran = false;
  return {
    ran: () => ran,
    driver: {
      name: "remote-driver",
      async run(_input: ProviderTaskInput) {
        ran = true;
        return { text: "dispatched", exitCode: 0, durationMs: 1 };
      },
    },
  };
}

let home: string;
let prevHome: string | undefined;

function writeConfig(privacy: unknown): void {
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ model: "sonnet", privacy }),
  );
}

/**
 * A registry that admits `internal` to a remote destination and refuses
 * `personal`. Both classifications resolve to the SAME destination, so a test
 * that flips only the operator's path-level label changes exactly one variable.
 */
const REGISTRY = {
  destinations: {
    "candidate-remote": {
      type: "remote",
      drivers: ["remote-driver"],
      classifications: ["public", "internal"],
    },
  },
};

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "pw-orch-boundary-"));
  prevHome = process.env.PATCHWORK_HOME;
  process.env.PATCHWORK_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PATCHWORK_HOME;
  else process.env.PATCHWORK_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

async function runOne(prompt = "free-form task"): Promise<{
  status: string | undefined;
  errorMessage: string | undefined;
  ran: boolean;
}> {
  const spy = makeSpyDriver();
  const orch = new ClaudeOrchestrator(spy.driver, home, noop);
  const task = await orch.runAndWait({ prompt });
  return {
    status: task.status,
    errorMessage: task.errorMessage,
    ran: spy.ran(),
  };
}

describe("orchestrator information boundary", () => {
  it("refuses a dispatch the operator's path classification does not permit", async () => {
    writeConfig({ ...REGISTRY, orchestrator: { classification: "personal" } });
    const r = await runOne();
    expect(r.ran, "the prompt reached the driver despite being refused").toBe(
      false,
    );
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("information boundary");
  });

  it("allows the same dispatch when the classification IS permitted", async () => {
    // The control, and it is not optional. Without it the assertion above
    // passes just as happily against an orchestrator that refuses everything,
    // or one whose driver is simply broken — the failure mode that makes a
    // security test read green while protecting nothing.
    writeConfig({ ...REGISTRY, orchestrator: { classification: "internal" } });
    const r = await runOne();
    expect(r.ran).toBe(true);
    expect(r.status).toBe("done");
  });

  it("stays inert when the operator has NOT opted the path in", async () => {
    // Registry configured, orchestrator key absent. ADR-0021's opt-in posture:
    // upgrading must not start refusing traffic on an install that never asked
    // for it. `personal` would be refused if the key were present, so this
    // pins the ABSENCE of the key as the thing doing the allowing.
    writeConfig(REGISTRY);
    const r = await runOne();
    expect(r.ran).toBe(true);
    expect(r.status).toBe("done");
  });

  it("stays inert when no destination is registered at all", async () => {
    writeConfig({ orchestrator: { classification: "personal" } });
    const r = await runOne();
    expect(r.ran).toBe(true);
    expect(r.status).toBe("done");
  });

  it("does NOT enforce on an unparseable classification", async () => {
    // Fail-OPEN, deliberately, and asserted so nobody "fixes" it quietly. A
    // typo in an optional key must not refuse every orchestrator task on the
    // machine — including the automation hooks an operator depends on — when
    // the symptom gives no hint of the cause. Recorded in the ADR amendment.
    writeConfig({ ...REGISTRY, orchestrator: { classification: "persnoal" } });
    const r = await runOne();
    expect(r.ran).toBe(true);
    expect(r.status).toBe("done");
  });

  it("writes a receipt stamped `default`, never `declared`", async () => {
    writeConfig({ ...REGISTRY, orchestrator: { classification: "personal" } });
    await runOne();
    const { summariseBoundaryReceipts } = await import(
      "../boundaryReceipts.js"
    );
    const s = summariseBoundaryReceipts({ dir: home });
    expect(s.recorded).toBe(1);
    const [receipt] = s.recent;
    // The precondition ADR-0021 set for enforcing a path with no per-dispatch
    // label. `declared` here would assert that an operator classified a
    // free-form prompt they never saw.
    expect(receipt?.labelSource).toBe("default");
    expect(receipt?.classification).toBe("personal");
    expect(receipt?.decision).not.toBe("ALLOW");
  });

  it("records an ALLOWED dispatch too, so the denominator is real", async () => {
    // A ledger holding only refusals has its numerator as its denominator and
    // always reads 100%.
    writeConfig({ ...REGISTRY, orchestrator: { classification: "internal" } });
    await runOne();
    const { summariseBoundaryReceipts } = await import(
      "../boundaryReceipts.js"
    );
    const s = summariseBoundaryReceipts({ dir: home });
    expect(s.recorded).toBe(1);
    expect(s.refusals).toBe(0);
    expect(s.recent[0]?.labelSource).toBe("default");
  });
});

describe("the orchestrator and the recipe path agree on one policy", () => {
  /**
   * Found by driving the DEPLOYED build, not by reading the source.
   *
   * `decideBoundary` offers LOCAL_ONLY — "a local destination accepts it" —
   * only when told one does. `resolveDestination` computes that and the recipe
   * path forwards it; the orchestrator dropped it, so the same registry and the
   * same classification produced DENY on one path and LOCAL_ONLY on the other.
   *
   * The direction was safe (DENY is stricter), which is exactly why it would
   * have survived review — nothing leaks and the refusal still happens. What
   * was wrong is the sentence an operator reads: DENY says no approval can
   * unlock it, while a registered local destination would take the data.
   */
  const REGISTRY_WITH_LOCAL = {
    destinations: {
      "local-models": {
        type: "local",
        classifications: [
          "public",
          "internal",
          "personal",
          "confidential",
          "restricted",
        ],
        drivers: ["local"],
      },
      "hosted-models": {
        type: "remote",
        drivers: ["remote-driver"],
        classifications: ["public", "internal"],
      },
    },
  };

  it("says LOCAL_ONLY, not DENY, when a local destination accepts the data", async () => {
    writeConfig({
      ...REGISTRY_WITH_LOCAL,
      orchestrator: { classification: "personal" },
    });
    const r = await runOne();
    expect(r.ran, "the prompt still must not reach the driver").toBe(false);
    // The refusal must name the remedy that exists. "no approval can unlock it"
    // is true only when nothing on this machine will take the data.
    expect(r.errorMessage).toMatch(/may not leave the machine/);
    expect(r.errorMessage).not.toMatch(/no approval can unlock/);
  });

  it("still says DENY when NO local destination accepts it", async () => {
    // The control. Without it the assertion above passes against a build that
    // hardcodes LOCAL_ONLY for every refusal — which would be the same class of
    // error in the opposite direction, and would tell an operator a local
    // driver will fix something it cannot.
    writeConfig({
      destinations: {
        "hosted-models": {
          type: "remote",
          drivers: ["remote-driver"],
          classifications: ["public", "internal"],
        },
      },
      orchestrator: { classification: "personal" },
    });
    const r = await runOne();
    expect(r.ran).toBe(false);
    expect(r.errorMessage).toMatch(/no approval can unlock/);
  });
});
