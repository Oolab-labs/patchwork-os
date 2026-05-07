import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  classifyBehavior,
  classifyTool,
  getRiskTierMap,
  inferTierFromName,
  type RiskTier,
  requiresApproval,
  riskTierSummary,
  type ToolBehavior,
} from "../riskTier.js";

const TIERS: readonly RiskTier[] = ["low", "medium", "high"];
const BEHAVIORS: readonly ToolBehavior[] = [
  "readOnly",
  "localWrite",
  "shellExec",
  "externalEffect",
];

const TIER_TO_BEHAVIOR: Record<RiskTier, ToolBehavior> = {
  low: "readOnly",
  medium: "localWrite",
  high: "externalEffect",
};

describe("riskTier properties — totality", () => {
  test("classifyTool never throws for any string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        classifyTool(name);
        return true;
      }),
    );
  });

  test("inferTierFromName never throws for any string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        inferTierFromName(name);
        return true;
      }),
    );
  });

  test("classifyBehavior never throws for any string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        classifyBehavior(name);
        return true;
      }),
    );
  });

  test("requiresApproval never throws for any string + any policy", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.array(fc.constantFrom(...TIERS), { maxLength: 3 }),
        (name, policy) => {
          requiresApproval(name, policy);
          return true;
        },
      ),
    );
  });
});

describe("riskTier properties — closed enums", () => {
  test("classifyTool always returns a valid tier", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        return TIERS.includes(classifyTool(name));
      }),
    );
  });

  test("inferTierFromName always returns a valid tier", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        return TIERS.includes(inferTierFromName(name));
      }),
    );
  });

  test("classifyBehavior always returns a valid behavior", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        return BEHAVIORS.includes(classifyBehavior(name));
      }),
    );
  });
});

describe("riskTier properties — TIER_MAP authority", () => {
  test("every TIER_MAP entry classifies to its mapped tier", () => {
    const map = getRiskTierMap();
    for (const [toolName, expectedTier] of Object.entries(map)) {
      expect(classifyTool(toolName)).toBe(expectedTier);
    }
  });

  test("TIER_MAP entries' behavior derives correctly from their tier", () => {
    const map = getRiskTierMap();
    for (const [toolName, tier] of Object.entries(map)) {
      expect(classifyBehavior(toolName)).toBe(TIER_TO_BEHAVIOR[tier]);
    }
  });

  test("classifyTool tier always implies classifyBehavior == TIER_TO_BEHAVIOR[tier]", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        const tier = classifyTool(name);
        return classifyBehavior(name) === TIER_TO_BEHAVIOR[tier];
      }),
    );
  });
});

describe("riskTier properties — conservative defaults", () => {
  test("empty string falls back to medium (never low)", () => {
    expect(classifyTool("")).toBe("medium");
    expect(inferTierFromName("")).toBe("medium");
  });

  test("random gibberish strings never classify to low without matching a read pattern", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (name) => {
        const map = getRiskTierMap();
        if (name in map) return true;
        const tier = inferTierFromName(name);
        if (tier !== "low") return true;
        // If inference said "low", the name must start with one of the
        // recognized read prefixes (anchored). Otherwise the heuristic is
        // accidentally permissive.
        return (
          /^(get|find|search|list|read|describe|explain|goTo|hover|preview|capture|explore|resolve|probe|check|lookup|parse|classify|compute|compare|render|validate|ping|ready|detect|watch)/.test(
            name,
          ) || name === "contextBundle"
        );
      }),
    );
  });

  test("delete-prefixed camelCase names are always high", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("delete", "unlink", "drop"),
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => /^[A-Z]/.test(s)),
        (prefix, suffix) => {
          return inferTierFromName(`${prefix}${suffix}`) === "high";
        },
      ),
    );
  });

  test("github-prefixed camelCase action names are always high", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("Create", "Comment", "Post", "Delete"),
        fc
          .string({ minLength: 0, maxLength: 20 })
          .filter((s) => !/[()]/.test(s)),
        (action, suffix) => {
          return inferTierFromName(`github${action}${suffix}`) === "high";
        },
      ),
    );
  });
});

describe("riskTier properties — requiresApproval semantics", () => {
  test("empty policy never triggers approval", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        return requiresApproval(name, []) === false;
      }),
    );
  });

  test("full-tier policy always triggers approval", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        return requiresApproval(name, ["low", "medium", "high"]) === true;
      }),
    );
  });

  test('default policy (["high"]) triggers iff classifyTool returns "high"', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        return requiresApproval(name) === (classifyTool(name) === "high");
      }),
    );
  });

  test("policy is monotonic: adding a tier can only increase trigger frequency", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.subarray<RiskTier>(["low", "medium", "high"]),
        fc.constantFrom<RiskTier>("low", "medium", "high"),
        (name, basePolicy, extra) => {
          const before = requiresApproval(name, basePolicy);
          const after = requiresApproval(name, [...basePolicy, extra]);
          // monotone: before=true → after=true
          if (before) return after === true;
          return true;
        },
      ),
    );
  });
});

describe("riskTier properties — summary invariants", () => {
  test("riskTierSummary counts sum to TIER_MAP entry count", () => {
    const map = getRiskTierMap();
    const expected = Object.keys(map).length;
    const summary = riskTierSummary();
    expect(summary.low + summary.medium + summary.high).toBe(expected);
  });

  test("riskTierSummary low/medium/high counts each match TIER_MAP", () => {
    const map = getRiskTierMap();
    const counts = { low: 0, medium: 0, high: 0 };
    for (const tier of Object.values(map)) counts[tier]++;
    expect(riskTierSummary()).toEqual(counts);
  });

  test("getRiskTierMap returns a non-empty map", () => {
    expect(Object.keys(getRiskTierMap()).length).toBeGreaterThan(0);
  });
});
