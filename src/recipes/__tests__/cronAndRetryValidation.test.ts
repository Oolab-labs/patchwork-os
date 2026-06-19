/**
 * M24: 6-field cron expressions rejected by lint but accepted by scheduler.
 * M26: parallel:{each} passes lint in chained recipes but throws at runtime.
 * M31: Negative step.retry silently skips the step.
 */
import { describe, expect, it } from "vitest";
import { validateRecipeDefinition } from "../validation.js";

const BASE = {
  name: "r",
  version: "1.0.0",
  trigger: { type: "manual" },
  steps: [{ id: "s", agent: { prompt: "hi" } }],
};

describe("validateRecipeDefinition — cron 6-field acceptance (M24)", () => {
  it("accepts a standard 5-field cron expression", () => {
    const r = validateRecipeDefinition({
      ...BASE,
      trigger: { type: "cron", schedule: "0 8 * * *" },
    });
    expect(r.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("accepts a 6-field cron expression that node-cron supports (M24)", () => {
    const r = validateRecipeDefinition({
      ...BASE,
      trigger: { type: "cron", schedule: "0 30 8 * * *" },
    });
    expect(r.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
});

describe("validateRecipeDefinition — parallel:{each} rejected in chained recipes (M26)", () => {
  const CHAINED_BASE = {
    name: "r",
    version: "1.0.0",
    trigger: { type: "chained" },
    steps: [{ id: "s", agent: { prompt: "hi" } }],
  };

  it("rejects parallel:{each} in a chained recipe (M26)", () => {
    const r = validateRecipeDefinition({
      ...CHAINED_BASE,
      steps: [
        {
          id: "fan",
          parallel: {
            each: "{{items}}",
            as: "item",
            steps: [{ id: "s", agent: { prompt: "{{item}}" } }],
          },
        },
      ],
    });
    const errs = r.issues
      .filter((i) => i.level === "error")
      .map((i) => i.message);
    expect(
      errs.some((e) =>
        /parallel.*each.*chained|chained.*parallel.*each/i.test(e),
      ),
    ).toBe(true);
  });

  it("allows parallel:{each} in non-chained recipes", () => {
    const r = validateRecipeDefinition({
      ...BASE,
      steps: [
        {
          id: "fan",
          parallel: {
            each: "{{items}}",
            as: "item",
            steps: [{ id: "s", agent: { prompt: "{{item}}" } }],
          },
        },
      ],
    });
    const errs = r.issues
      .filter((i) => i.level === "error")
      .map((i) => i.message);
    expect(
      errs.some((e) =>
        /parallel.*each.*chained|chained.*parallel.*each/i.test(e),
      ),
    ).toBe(false);
  });
});

describe("validateRecipeDefinition — negative step retry rejected (M31)", () => {
  it("rejects a step with negative retry value (M31)", () => {
    const r = validateRecipeDefinition({
      ...BASE,
      steps: [{ id: "s", retry: -1, agent: { prompt: "hi" } }],
    });
    const errs = r.issues
      .filter((i) => i.level === "error")
      .map((i) => i.message);
    expect(errs.some((e) => /non-negative/i.test(e))).toBe(true);
  });

  it("accepts a step with retry: 0", () => {
    const r = validateRecipeDefinition({
      ...BASE,
      steps: [{ id: "s", retry: 0, agent: { prompt: "hi" } }],
    });
    expect(r.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("accepts a step with retry: 3", () => {
    const r = validateRecipeDefinition({
      ...BASE,
      steps: [{ id: "s", retry: 3, agent: { prompt: "hi" } }],
    });
    expect(r.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });
});
