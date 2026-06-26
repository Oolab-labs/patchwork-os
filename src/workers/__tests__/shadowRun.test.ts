import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Outcome } from "../graduation.js";
import { cadence, firstReached, shadowRun } from "../shadowRun.js";
import { parseWorker } from "../worker.js";

const DAY = 24 * 60 * 60 * 1000;
const EDIT_CLASS = "fs-write:reversible:medium";

describe("dogfood worker definitions parse", () => {
  it("the three shipped worker manifests are valid", () => {
    const dir = path.join(process.cwd(), "templates", "workers");
    for (const f of [
      "release-notes.worker.yaml",
      "dependency-upkeep.worker.yaml",
      "test-guardian.worker.yaml",
    ]) {
      const w = parseWorker(
        parseYaml(readFileSync(path.join(dir, f), "utf-8")),
      );
      expect(w.id).toMatch(/^[a-z0-9-]+$/);
      expect(w.owns.length).toBeGreaterThan(0);
      expect(w.autonomyCeiling).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("dial trajectory — the evidence-latency reality", () => {
  const noPrior = parseWorker({
    id: "rel-noprior",
    name: "R",
    owns: ["fs-write"],
  });
  const withPrior = parseWorker({
    id: "rel-prior",
    name: "R",
    owns: ["fs-write"],
    competence: { mean: 0.85, strength: 4 },
  });
  // ~2.5 weeks of one edit every 6h, all clean
  const work = cadence("editText", 70);

  it("a cold worker takes WEEKS of clean evidence to reach L4 (slow to climb)", () => {
    const r = shadowRun(noPrior, work);
    const l4 = firstReached(r, EDIT_CLASS, 4);
    expect(l4).toBeDefined();
    // not days — the trustworthy thing is genuinely slow
    expect(l4!.at).toBeGreaterThan(10 * DAY);
    // and it climbs gradually, not in one jump
    expect(
      r.events.filter((e) => e.type === "promote").length,
    ).toBeGreaterThanOrEqual(4);
    expect(r.board[0]!.level).toBe(4);
  });

  it("a shipped competence prior accelerates the climb without faking trust", () => {
    const cold = shadowRun(noPrior, work);
    const primed = shadowRun(withPrior, work);
    const coldL1 = firstReached(cold, EDIT_CLASS, 1)!;
    const primedL1 = firstReached(primed, EDIT_CLASS, 1)!;
    const coldL4 = firstReached(cold, EDIT_CLASS, 4)!;
    const primedL4 = firstReached(primed, EDIT_CLASS, 4)!;
    // the prior reaches the first rung no later (cold-start head start)…
    expect(primedL1.index).toBeLessThanOrEqual(coldL1.index);
    // …and reaches full autonomy sooner than the cold worker…
    expect(primedL4.at).toBeLessThan(coldL4.at);
    // …but trust is NOT faked: L4 still takes days of real local evidence.
    expect(primedL4.at).toBeGreaterThan(3 * DAY);
  });

  it("one failure demotes a long-earned L4 in a single step (instant to fall)", () => {
    const outcomes: Outcome[] = [
      ...cadence("editText", 65),
      { toolName: "editText", good: false, at: 66 * 6 * 60 * 60 * 1000 },
    ];
    const r = shadowRun(noPrior, outcomes);
    const demote = r.trajectory.find((s) => s.changed === "demote");
    expect(demote).toBeDefined();
    expect(demote!.level).toBeLessThan(4);
    // the step immediately before the failure was at L4
    const beforeFail = r.trajectory[r.trajectory.length - 2]!;
    expect(beforeFail.level).toBe(4);
  });
});
