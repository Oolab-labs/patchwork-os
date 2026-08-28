import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSnapshot,
  diffReadings,
  formatSweep,
  readLastSnapshot,
  SWEEP_LEDGER,
  SWEEP_RV,
  type SweepReading,
} from "../sweep.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pw-sweep-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reading(over: Partial<SweepReading> = {}): SweepReading {
  return {
    rv: SWEEP_RV,
    takenAt: 1_000,
    gates: { deployment: true, workers: true },
    counts: { "prOutcomes.rows": 10 },
    ...over,
  };
}

describe("diffReadings", () => {
  it("reports a first run as a BASELINE, never as 'nothing changed'", () => {
    const d = diffReadings(undefined, reading());
    expect(d.baseline).toBe(true);
    expect(d.regressed).toBe(false);
    // The rendering matters as much as the flag: "no changes" would be a claim
    // about a period nobody observed.
    const out = formatSweep(reading(), d, { wrote: true });
    expect(out).toContain("BASELINE");
    expect(out).not.toContain("No counter moved");
    expect(out).not.toContain("No gate changed state");
  });

  it("treats a healthy -> unhealthy gate flip as a regression", () => {
    const d = diffReadings(
      reading(),
      reading({ gates: { deployment: false, workers: true } }),
    );
    expect(d.regressed).toBe(true);
    expect(d.gates).toEqual([
      { key: "deployment", before: true, after: false, regression: true },
    ]);
  });

  it("treats an unhealthy -> healthy flip as a recovery, not a regression", () => {
    const d = diffReadings(
      reading({ gates: { deployment: false, workers: true } }),
      reading(),
    );
    expect(d.gates).toHaveLength(1);
    expect(d.gates[0]?.regression).toBe(false);
    expect(d.regressed).toBe(false);
  });

  it("does not report a gate the previous reading never carried", () => {
    // Otherwise every newly-added gate fails its own first sweep, and the
    // command is red on the one run where nothing can have regressed.
    const d = diffReadings(
      reading({ gates: { workers: true } }),
      reading({ gates: { workers: true, brandNew: false } }),
    );
    expect(d.gates).toEqual([]);
    expect(d.regressed).toBe(false);
  });

  it("never lets numeric drift produce a regression", () => {
    // The evidence ratios fall by construction as ledgers accrue rows. Failing
    // on that would make the command permanently red.
    const d = diffReadings(
      reading({
        counts: { "evidence.x.joinable": 57, "evidence.x.rows": 213 },
      }),
      reading({
        counts: { "evidence.x.joinable": 57, "evidence.x.rows": 900 },
      }),
    );
    expect(d.regressed).toBe(false);
    expect(d.counts).toEqual([
      { key: "evidence.x.rows", before: 213, after: 900, change: 687 },
    ]);
  });

  it("marks a counter the previous reading lacked as new, not as a rise from zero", () => {
    const d = diffReadings(
      reading({ counts: {} }),
      reading({ counts: { "privacy.undeclared": 3 } }),
    );
    expect(d.counts[0]).toEqual({
      key: "privacy.undeclared",
      after: 3,
      change: 3,
    });
    expect(d.counts[0]?.before).toBeUndefined();
    expect(formatSweep(reading(), d, { wrote: false })).toContain("new");
  });

  it("reports a counter that stopped being taken, rather than reading it as 0", () => {
    const d = diffReadings(
      reading({ counts: { "privacy.agentSteps": 74 } }),
      reading({ counts: {} }),
    );
    expect(d.disappeared).toEqual(["privacy.agentSteps"]);
    expect(formatSweep(reading({ counts: {} }), d, { wrote: false })).toContain(
      "is not a counter that hit 0",
    );
  });
});

describe("readLastSnapshot", () => {
  it("returns undefined when no ledger exists", () => {
    expect(readLastSnapshot(tmp())).toBeUndefined();
  });

  it("returns the LAST snapshot, so a diff compares against the previous run", () => {
    const d = tmp();
    appendSnapshot(d, reading({ takenAt: 1 }));
    appendSnapshot(d, reading({ takenAt: 2 }));
    expect(readLastSnapshot(d)?.takenAt).toBe(2);
  });

  it("skips a row from another schema version rather than diffing across it", () => {
    // A counter name can survive a meaning change. A delta computed across that
    // boundary would be a confident lie.
    const d = tmp();
    appendSnapshot(d, reading({ takenAt: 1 }));
    writeFileSync(
      path.join(d, SWEEP_LEDGER),
      `${JSON.stringify(reading({ takenAt: 1 }))}\n${JSON.stringify({ ...reading({ takenAt: 9 }), rv: SWEEP_RV + 1 })}\n`,
    );
    expect(readLastSnapshot(d)?.takenAt).toBe(1);
  });

  it("skips a corrupt line instead of repairing the ledger", () => {
    const d = tmp();
    appendSnapshot(d, reading({ takenAt: 1 }));
    writeFileSync(path.join(d, SWEEP_LEDGER), "{not json\n", { flag: "a" });
    appendSnapshot(d, reading({ takenAt: 3 }));
    expect(readLastSnapshot(d)?.takenAt).toBe(3);
  });
});

describe("the snapshot holds counts only", () => {
  it("carries no recipe name, path or other operator string", async () => {
    // This is the constraint, not a formality: two of the five inputs return
    // operator data, and a health check is the last place anyone thinks to look
    // for accumulated secrets. Driven against a recipe whose name is a token
    // that cannot occur by accident.
    const home = tmp();
    const recipes = path.join(home, "recipes");
    mkdirSync(recipes);
    writeFileSync(
      path.join(recipes, "zz-fixture.yaml"),
      [
        "name: sweep-fixture-unique-token",
        "steps:",
        "  - id: fetch",
        "    tool: http.get",
        "    into: payload",
        "  - id: think",
        "    agent:",
        "      prompt: summarise {{payload}}",
      ].join("\n"),
    );

    const { collectSweep } = await import("../sweepCollect.js");
    const r = collectSweep({ dir: home, now: 1 });

    // The reading must have SEEN the fixture — otherwise this test passes on an
    // empty scan and proves nothing.
    expect(r.counts["privacy.undeclared"]).toBe(1);
    expect(r.counts["privacy.agentSteps"]).toBe(1);

    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain("sweep-fixture-unique-token");
    expect(serialised).not.toContain("zz-fixture");
    expect(serialised).not.toContain(home);
    // Every value is a scalar; nothing nested can smuggle a string through.
    for (const v of Object.values(r.counts)) expect(typeof v).toBe("number");
    for (const v of Object.values(r.gates)) expect(typeof v).toBe("boolean");
  });

  it("omits a reading it could not take, rather than recording it as zero", async () => {
    // An unreadable recipes directory and a directory with zero agent steps are
    // different facts. A zero would render an unavailable reading as a drop, and
    // the diff already distinguishes an absent counter from a moved one.
    const home = tmp(); // no recipes/ and no ledgers inside it
    const { collectSweep } = await import("../sweepCollect.js");
    const r = collectSweep({ dir: home, now: 1 });
    expect("privacy.agentSteps" in r.counts).toBe(false);
    expect("privacy.undeclared" in r.counts).toBe(false);
    // Same rule for an absent ledger: `evidence` reports ABSENT, not 0 rows.
    expect("evidence.outcome-log.jsonl.rows" in r.counts).toBe(false);
  });
});
