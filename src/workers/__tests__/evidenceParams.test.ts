/**
 * The write side of the trust ledger must classify an action EXACTLY as the
 * gate does.
 *
 * #1267 added magnitude bands so evidence from a €5 action cannot authorise a
 * €5,000 one. The gate was made params-aware; the evidence path was not, so
 * every outcome was filed under the widest band. That did not merely disable
 * the protection — it inverted it: cheap successes credited the expensive
 * cell, so the large action became MORE likely to auto-allow the more small
 * ones succeeded.
 *
 * The missing assertion was this one.
 */

import { describe, expect, it } from "vitest";
import { classifyActionClass } from "../actionClass.js";
import { WorkerShadowObserver } from "../shadowObserver.js";
import type { WorkerManifest } from "../worker.js";
import { WorkerLevelStore } from "../workerLevelStore.js";

const payer: WorkerManifest = {
  id: "payer",
  name: "Payer",
  recipe: "pay-recipe",
  owns: ["payments"],
  autonomyCeiling: 4,
};

const AMOUNTS = [
  { params: { amount: 500 }, label: "small" },
  { params: { amount: 50_000 }, label: "medium" },
  { params: { amount: 5_000_00 }, label: "large" },
];

describe("write-side and gate-side classification agree", () => {
  it.each(
    AMOUNTS,
  )("files a $label payment under the same class the gate would read", ({
    params,
  }) => {
    const gateSide = classifyActionClass(
      "paystack.charge_authorization",
      params,
    );
    const store = new WorkerLevelStore();
    const applied = store.apply("w1", {
      toolName: "paystack.charge_authorization",
      params,
      good: true,
      at: 1,
    });
    expect(applied.classKey).toBe(gateSide.key);
  });

  it("does not let cheap successes accumulate in the expensive cell", () => {
    const store = new WorkerLevelStore();
    for (let i = 0; i < 50; i++) {
      store.apply("w1", {
        toolName: "paystack.charge_authorization",
        params: { amount: 500 }, // €5
        good: true,
        at: i,
      });
    }
    const expensive = classifyActionClass("paystack.charge_authorization", {
      amount: 5_000_00, // €5,000
    });
    // The large-value cell must still be untouched — no evidence, no autonomy.
    expect(store.getState("w1", expensive.key)).toBeUndefined();
  });
});

describe("ingest path carries the magnitude through (the real defect)", () => {
  it("credits a cheap payment to the cheap cell, not the widest one", () => {
    const obs = new WorkerShadowObserver([payer]);
    obs.ingestRun({
      recipeName: "pay-recipe",
      at: 0,
      steps: [
        {
          tool: "paystack.charge_authorization",
          status: "ok",
          resolvedParams: { amount: 500 }, // €5
        },
      ],
    });

    const cheap = classifyActionClass("paystack.charge_authorization", {
      amount: 500,
    });
    const expensive = classifyActionClass("paystack.charge_authorization", {
      amount: 5_000_00,
    });

    const board = obs.report()[0]?.board ?? [];
    const keys = board.map((r) => r.classKey);

    // The evidence belongs to the band it was actually earned in...
    expect(keys).toContain(cheap.key);
    // ...and must NOT have landed in the expensive band, which would mean a
    // €5,000 charge inherits autonomy earned on €5 ones.
    expect(keys).not.toContain(expensive.key);
  });
});
