import { describe, expect, it } from "vitest";
import {
  classifyActionClass,
  outcomeWeight,
  reachableLevels,
} from "../actionClass.js";

describe("classifyActionClass", () => {
  it("keys a class as domain:reversibility:blastTier", () => {
    expect(classifyActionClass("getGitStatus")).toEqual({
      key: "vcs-read:reversible:low",
      domain: "vcs-read",
      reversibility: "reversible",
      blastTier: "low",
      brandExposed: false,
    });
    expect(classifyActionClass("gitPush").key).toBe(
      "vcs-remote:compensable:high",
    );
    expect(classifyActionClass("slackPostMessage").key).toBe(
      "messaging:irreversible:medium",
    );
  });

  it("folds blast-tier into the key so a higher-blast action is a DISTINCT class", () => {
    // routine read vs a high-blast local mutation in the same vcs family
    expect(classifyActionClass("getGitStatus").key).not.toBe(
      classifyActionClass("gitCommit").key,
    );
    expect(classifyActionClass("gitCommit").key).toBe(
      "vcs-local:reversible:high",
    );
  });

  it("treats unknown tools as irreversible (conservative default)", () => {
    const c = classifyActionClass("someBespokePluginTool");
    expect(c.domain).toBe("other");
    expect(c.reversibility).toBe("irreversible");
  });
});

describe("reachableLevels", () => {
  it("irreversible classes skip the safety-net rungs L2/L3", () => {
    expect(reachableLevels(classifyActionClass("runCommand"))).toEqual([
      0, 1, 4,
    ]);
  });

  it("reversible classes can reach every rung", () => {
    expect(reachableLevels(classifyActionClass("editText"))).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe("outcomeWeight", () => {
  it("a routine success is low-information (weight 1)", () => {
    expect(outcomeWeight(classifyActionClass("editText"), true)).toBe(1);
    expect(outcomeWeight(classifyActionClass("runCommand"), true)).toBe(1);
  });

  it("a high-blast irreversible failure vastly outweighs a low-blast reversible one", () => {
    const catastrophic = outcomeWeight(
      classifyActionClass("runCommand"), // shell:irreversible:high → 12 * 3
      false,
    );
    const trivial = outcomeWeight(
      classifyActionClass("getGitStatus"), // vcs-read:reversible:low → 2 * 1
      false,
    );
    expect(catastrophic).toBe(36);
    expect(trivial).toBe(2);
    // the anti-grinding guarantee: one catastrophic failure outweighs ~18
    // trivial successes worth of climb
    expect(catastrophic).toBeGreaterThan(trivial * 10);
  });

  it("a brand-exposed failure is weighted heavier than the same class would be internally", () => {
    const slack = classifyActionClass("slackPostMessage"); // messaging → brand-exposed
    expect(slack.brandExposed).toBe(true);
    // messaging:irreversible:medium → 5 × 3 × 1.5 (brand) = 22.5
    expect(outcomeWeight(slack, false)).toBe(22.5);
    // internal tools are not brand-exposed (no multiplier)
    expect(classifyActionClass("runCommand").brandExposed).toBe(false);
    expect(classifyActionClass("editText").brandExposed).toBe(false);
  });
});
