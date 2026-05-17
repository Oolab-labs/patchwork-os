/**
 * summarizeRisk — counts step-level risk values from a recipe YAML.
 *
 * Pre-fix used a regex against `^\s*risk:` which over-counted any
 * `risk:` substring inside multi-line block scalars (prompts that
 * mention the word) and nested non-step objects with a risk key.
 * The audit found morning-brief's narration prompt produces a false
 * "1 high risk" reading.
 */
import { describe, expect, it } from "vitest";
import { summarizeRisk } from "../registry";

describe("summarizeRisk", () => {
  it("counts step-level risk values correctly", () => {
    const yaml = `name: demo
steps:
  - id: a
    risk: low
  - id: b
    risk: medium
  - id: c
    risk: high
  - id: d
    risk: high
`;
    expect(summarizeRisk(yaml)).toEqual({
      low: 1,
      medium: 1,
      high: 2,
      steps: 4,
    });
  });

  it("does NOT count `risk:` strings that appear inside a block scalar prompt (regression)", () => {
    // Pre-fix this YAML returned high: 1 because the regex caught the
    // word in the prompt body. The real recipe has zero step risk.
    const yaml = `name: morning-brief
steps:
  - id: narrate
    agent:
      prompt: |
        Write a daily brief in plain prose.
        risk: high — this is the worst-case scenario phrasing.
      into: brief
`;
    expect(summarizeRisk(yaml)).toEqual({
      low: 0,
      medium: 0,
      high: 0,
      steps: 1,
    });
  });

  it("returns zeros on a recipe with no risk declarations", () => {
    const yaml = `name: bare
steps:
  - id: only
    agent:
      prompt: do thing
      into: out
`;
    expect(summarizeRisk(yaml)).toEqual({
      low: 0,
      medium: 0,
      high: 0,
      steps: 1,
    });
  });

  it("returns zeros on a parse error rather than throwing", () => {
    expect(summarizeRisk("not: valid: yaml: :")).toEqual({
      low: 0,
      medium: 0,
      high: 0,
      steps: 0,
    });
  });

  it("ignores non-recognised risk values", () => {
    const yaml = `name: weird
steps:
  - id: a
    risk: spicy
  - id: b
    risk: low
`;
    expect(summarizeRisk(yaml)).toEqual({
      low: 1,
      medium: 0,
      high: 0,
      steps: 2,
    });
  });
});
