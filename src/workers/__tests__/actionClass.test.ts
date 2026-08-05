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
      "vcs-push:compensable:high",
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

  it("classifies recipe-tool ids (what RecipeRunLog records) into the right domains", () => {
    expect(classifyActionClass("git.log_since").domain).toBe("vcs-read");
    expect(classifyActionClass("file.write").domain).toBe("fs-write");
    expect(classifyActionClass("github.list_prs").domain).toBe("vcs-read");
    expect(classifyActionClass("slack.post_message").brandExposed).toBe(true);
  });

  it("classifies github.create_issue as issue / compensable / brand-exposed (a graduating risky class)", () => {
    const c = classifyActionClass("github.create_issue");
    expect(c.domain).toBe("issue");
    expect(c.reversibility).toBe("compensable"); // an issue is closeable
    expect(c.brandExposed).toBe(true); // externally visible
    // compensable ⇒ the full ramp is reachable (can earn L4), unlike irreversible
    expect(reachableLevels(c)).toEqual([0, 1, 2, 3, 4]);
  });

  it("resolves github.create_issue blastTier to 'high' WITHOUT the recipe-tool registry (review #1029 MEDIUM)", () => {
    // This test process never imports recipes/tools, so the tier resolver is
    // absent — exactly the `workers shadow` process. The static override must
    // still yield `high`, matching the live gate, so a worker's trust ledger is
    // keyed identically in both processes (no medium/high split).
    const c = classifyActionClass("github.create_issue");
    expect(c.blastTier).toBe("high");
    expect(c.key).toBe("issue:compensable:high");
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

describe("magnitude bands (payments)", () => {
  it("separates a small purchase from a large one into distinct classes", () => {
    // The defect: the class key derived from the tool NAME alone, so trust
    // ground out on cheap instances auto-allowed an expensive one.
    const small = classifyActionClass("paystack.charge_authorization", {
      amount: 500, // minor units — 5.00
    });
    const large = classifyActionClass("paystack.charge_authorization", {
      amount: 500_000, // 5,000.00
    });
    expect(small.key).not.toBe(large.key);
    expect(small.domain).toBe("payments");
    expect(large.domain).toBe("payments");
  });

  it("puts a payments tool in the payments domain, not `other`", () => {
    const ac = classifyActionClass("paystack.initiate_transfer", {
      amount: 1000,
    });
    expect(ac.domain).toBe("payments");
    expect(ac.reversibility).toBe("irreversible");
    expect(ac.brandExposed).toBe(true);
  });

  it("bands are stable buckets, not raw amounts — so a class can graduate", () => {
    const a = classifyActionClass("paystack.charge_authorization", {
      amount: 100,
    });
    const b = classifyActionClass("paystack.charge_authorization", {
      amount: 4000,
    });
    expect(a.key).toBe(b.key); // both in the lowest band
  });

  it("omits the band facet for non-value-bearing domains", () => {
    expect(classifyActionClass("gitPush", { amount: 999_999 }).key).toBe(
      "vcs-push:compensable:high",
    );
  });

  it("falls to the widest band when no amount is derivable", () => {
    const unknown = classifyActionClass("paystack.initiate_transfer", {});
    const huge = classifyActionClass("paystack.initiate_transfer", {
      amount: 10_000_000,
    });
    // An unreadable amount must never be cheaper than the most expensive band.
    expect(unknown.key).toBe(huge.key);
  });
});

describe("money movement rates high blast", () => {
  it("does not let the namespaced-verb heuristic rate a charge as an ordinary write", () => {
    // `charge`/`transfer` are not in the read-verb list, so without an explicit
    // override they fell through to the generic "medium" write default — the
    // same tier as editText.
    for (const tool of [
      "paystack.charge_authorization",
      "paystack.initiate_transfer",
      "stripe.create_charge",
      "stripe.create_payment_intent",
    ]) {
      expect(classifyActionClass(tool, { amount: 100 }).blastTier).toBe("high");
    }
  });

  it("weights a failed high-value charge far above a routine success", () => {
    const ac = classifyActionClass("paystack.initiate_transfer", {
      amount: 5_000_00,
    });
    expect(outcomeWeight(ac, true)).toBe(1);
    // high blast × irreversible × brand-exposed
    expect(outcomeWeight(ac, false)).toBe(12 * 3 * 1.5);
  });
});
