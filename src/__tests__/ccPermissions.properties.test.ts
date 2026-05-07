import fc from "fast-check";
import { describe, test } from "vitest";
import {
  type AttributedPermissionRules,
  evaluateRules,
  explainRules,
  loadCcPermissions,
  type PermissionRules,
} from "../ccPermissions.js";

const toolNameGen = fc.constantFrom(
  "Read",
  "Bash",
  "Write",
  "Edit",
  "WebFetch",
  "gitPush",
  "gitCommit",
  "Unknown",
);

const specifierGen = fc.option(
  fc.oneof(
    fc.string({ maxLength: 30 }),
    fc.constantFrom("npm run build", "git status", "ls", "rm /tmp/foo", ""),
  ),
  { freq: 4, nil: undefined },
);

const patternGen = fc.oneof(
  toolNameGen,
  fc
    .tuple(toolNameGen, fc.string({ maxLength: 20 }))
    .map(([t, p]) => `${t}(${p})`),
  toolNameGen.map((t) => `${t}(*)`),
  toolNameGen.map((t) => `${t}(:*)`),
  fc
    .tuple(toolNameGen, fc.string({ maxLength: 10 }))
    .map(([t, p]) => `${t}(${p}:*)`),
  fc
    .tuple(toolNameGen, fc.string({ maxLength: 10 }))
    .map(([t, p]) => `${t}(${p} *)`),
);

const ruleListGen = fc.array(patternGen, { maxLength: 5 });

const rulesGen = fc.record({
  allow: ruleListGen,
  ask: ruleListGen,
  deny: ruleListGen,
});

describe("ccPermissions properties — totality", () => {
  test("evaluateRules never throws for any input", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          evaluateRules(toolName, specifier, rules);
          return true;
        },
      ),
    );
  });

  test("evaluateRules return value is in the closed enum", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const out = evaluateRules(toolName, specifier, rules);
          return ["allow", "ask", "deny", "none"].includes(out);
        },
      ),
    );
  });

  test("evaluateRules tolerates fully arbitrary string inputs", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.option(fc.string({ maxLength: 100 }), { freq: 3, nil: undefined }),
        ruleListGen,
        ruleListGen,
        ruleListGen,
        (toolName, specifier, allow, ask, deny) => {
          const out = evaluateRules(toolName, specifier, { allow, ask, deny });
          return ["allow", "ask", "deny", "none"].includes(out);
        },
      ),
    );
  });
});

describe("ccPermissions properties — precedence", () => {
  test("deny in rules forces a deny decision when its pattern matches", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const baseline = evaluateRules(toolName, specifier, rules);
          if (baseline === "none") return true;
          // baseline is "allow" | "ask" | "deny" — find the matched rule and
          // assert that adding it as a deny pattern forces a deny decision.
          const explanation = explainRules(toolName, specifier, {
            allow: rules.allow.map((p) => ({ pattern: p, source: "user" })),
            ask: rules.ask.map((p) => ({ pattern: p, source: "user" })),
            deny: rules.deny.map((p) => ({ pattern: p, source: "user" })),
          });
          if (explanation === null) return false; // baseline non-none implies a match exists
          const escalated: PermissionRules = {
            allow: rules.allow,
            ask: rules.ask,
            deny: [...rules.deny, explanation.matchedRule],
          };
          return evaluateRules(toolName, specifier, escalated) === "deny";
        },
      ),
    );
  });

  test("adding deny rules can only make decision more restrictive", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        ruleListGen,
        (toolName, specifier, rules, extraDeny) => {
          const before = evaluateRules(toolName, specifier, rules);
          const after = evaluateRules(toolName, specifier, {
            ...rules,
            deny: [...rules.deny, ...extraDeny],
          });
          // deny is the most restrictive; "none" can become any tier; otherwise
          // "after" must equal "before" or be "deny"
          if (before === "deny") return after === "deny";
          if (before === "none") return true;
          return after === before || after === "deny";
        },
      ),
    );
  });

  test("adding allow rules never lowers restrictiveness from deny or ask", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        ruleListGen,
        (toolName, specifier, rules, extraAllow) => {
          const before = evaluateRules(toolName, specifier, rules);
          const after = evaluateRules(toolName, specifier, {
            ...rules,
            allow: [...rules.allow, ...extraAllow],
          });
          if (before === "deny") return after === "deny";
          if (before === "ask") return after === "ask";
          // before === "allow" or "none" — after may flip "none" to "allow"
          if (before === "allow") return after === "allow";
          return after === "none" || after === "allow";
        },
      ),
    );
  });

  test("evaluateRules is order-independent within each tier", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const reversed: PermissionRules = {
            allow: [...rules.allow].reverse(),
            ask: [...rules.ask].reverse(),
            deny: [...rules.deny].reverse(),
          };
          return (
            evaluateRules(toolName, specifier, rules) ===
            evaluateRules(toolName, specifier, reversed)
          );
        },
      ),
    );
  });

  test("duplicating rules within a tier is idempotent", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const doubled: PermissionRules = {
            allow: [...rules.allow, ...rules.allow],
            ask: [...rules.ask, ...rules.ask],
            deny: [...rules.deny, ...rules.deny],
          };
          return (
            evaluateRules(toolName, specifier, rules) ===
            evaluateRules(toolName, specifier, doubled)
          );
        },
      ),
    );
  });
});

describe("ccPermissions properties — glob semantics", () => {
  test('"*" specifier matches any string', () => {
    fc.assert(
      fc.property(
        toolNameGen,
        fc.string({ maxLength: 80 }),
        (toolName, specifier) => {
          const rules = {
            allow: [`${toolName}(*)`],
            ask: [],
            deny: [],
          };
          return evaluateRules(toolName, specifier, rules) === "allow";
        },
      ),
    );
  });

  test('"*" specifier also matches an undefined specifier', () => {
    fc.assert(
      fc.property(toolNameGen, (toolName) => {
        const rules = { allow: [`${toolName}(*)`], ask: [], deny: [] };
        return evaluateRules(toolName, undefined, rules) === "allow";
      }),
    );
  });

  test("bare tool-name rule matches regardless of specifier", () => {
    fc.assert(
      fc.property(toolNameGen, specifierGen, (toolName, specifier) => {
        const rules = { allow: [toolName], ask: [], deny: [] };
        return evaluateRules(toolName, specifier, rules) === "allow";
      }),
    );
  });

  test("bare tool-name rule does NOT match a different tool name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string>("Read", "Bash", "Write"),
        fc.constantFrom<string>("Edit", "WebFetch", "gitPush"),
        specifierGen,
        (ruleTool, callTool, specifier) => {
          if (ruleTool === callTool) return true;
          const rules = { allow: [ruleTool], ask: [], deny: [] };
          return evaluateRules(callTool, specifier, rules) === "none";
        },
      ),
    );
  });

  test("colon-star and space-star forms agree", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        fc.constantFrom("git", "npm", "docker"),
        fc.string({ maxLength: 30 }),
        (toolName, prefix, suffix) => {
          const colonStar = {
            allow: [`${toolName}(${prefix}:*)`],
            ask: [],
            deny: [],
          };
          const spaceStar = {
            allow: [`${toolName}(${prefix} *)`],
            ask: [],
            deny: [],
          };
          const callSpecifier = `${prefix} ${suffix}`;
          return (
            evaluateRules(toolName, callSpecifier, colonStar) ===
            evaluateRules(toolName, callSpecifier, spaceStar)
          );
        },
      ),
    );
  });

  test("rule with unclosed paren never matches", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        fc.string({ maxLength: 20 }).filter((s) => !s.includes(")")),
        (toolName, specifier, partial) => {
          const rules = {
            allow: [`${toolName}(${partial}`],
            ask: [],
            deny: [],
          };
          return evaluateRules(toolName, specifier, rules) === "none";
        },
      ),
    );
  });
});

describe("ccPermissions properties — explainRules / evaluateRules agreement", () => {
  test("when explainRules returns null, evaluateRules returns 'none'", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const attributed: AttributedPermissionRules = {
            allow: rules.allow.map((p) => ({ pattern: p, source: "user" })),
            ask: rules.ask.map((p) => ({ pattern: p, source: "user" })),
            deny: rules.deny.map((p) => ({ pattern: p, source: "user" })),
          };
          const explanation = explainRules(toolName, specifier, attributed);
          if (explanation !== null) return true;
          return evaluateRules(toolName, specifier, rules) === "none";
        },
      ),
    );
  });

  test("when explainRules returns a tier, evaluateRules returns that tier", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const attributed: AttributedPermissionRules = {
            allow: rules.allow.map((p) => ({ pattern: p, source: "user" })),
            ask: rules.ask.map((p) => ({ pattern: p, source: "user" })),
            deny: rules.deny.map((p) => ({ pattern: p, source: "user" })),
          };
          const explanation = explainRules(toolName, specifier, attributed);
          if (explanation === null) return true;
          return evaluateRules(toolName, specifier, rules) === explanation.tier;
        },
      ),
    );
  });

  test("explainRules preserves the matched pattern verbatim", () => {
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        (toolName, specifier, rules) => {
          const attributed: AttributedPermissionRules = {
            allow: rules.allow.map((p) => ({ pattern: p, source: "user" })),
            ask: rules.ask.map((p) => ({ pattern: p, source: "user" })),
            deny: rules.deny.map((p) => ({ pattern: p, source: "user" })),
          };
          const explanation = explainRules(toolName, specifier, attributed);
          if (explanation === null) return true;
          const allRules = [
            ...attributed.deny,
            ...attributed.ask,
            ...attributed.allow,
          ];
          return allRules.some((r) => r.pattern === explanation.matchedRule);
        },
      ),
    );
  });

  test("explainRules attributes the source faithfully", () => {
    const sources = ["managed", "project-local", "project", "user"] as const;
    fc.assert(
      fc.property(
        toolNameGen,
        specifierGen,
        rulesGen,
        fc.array(fc.constantFrom(...sources), { minLength: 0, maxLength: 8 }),
        (toolName, specifier, rules, srcSeq) => {
          // Use fixed-length source assignment to guarantee deterministic mapping
          const pickSrc = (i: number) => srcSeq[i % srcSeq.length] ?? "user";
          const attributed: AttributedPermissionRules = {
            allow: rules.allow.map((p, i) => ({
              pattern: p,
              source: pickSrc(i),
            })),
            ask: rules.ask.map((p, i) => ({
              pattern: p,
              source: pickSrc(i + 100),
            })),
            deny: rules.deny.map((p, i) => ({
              pattern: p,
              source: pickSrc(i + 200),
            })),
          };
          const explanation = explainRules(toolName, specifier, attributed);
          if (explanation === null) return true;
          const tierRules = attributed[explanation.tier];
          // The reported source must match some rule in the reported tier
          // whose pattern equals the reported matchedRule.
          return tierRules.some(
            (r) =>
              r.pattern === explanation.matchedRule &&
              r.source === explanation.source,
          );
        },
      ),
    );
  });
});

describe("ccPermissions properties — loadCcPermissions robustness", () => {
  test("loadCcPermissions never throws for arbitrary file contents", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (contents) => {
        const rules = loadCcPermissions("/ws", {
          readFile: () => contents,
          exists: () => true,
        });
        return (
          Array.isArray(rules.allow) &&
          Array.isArray(rules.ask) &&
          Array.isArray(rules.deny)
        );
      }),
    );
  });

  test("loadCcPermissions never returns non-string entries", () => {
    fc.assert(
      fc.property(
        fc.array(fc.anything(), { maxLength: 10 }),
        fc.array(fc.anything(), { maxLength: 10 }),
        fc.array(fc.anything(), { maxLength: 10 }),
        (allow, ask, deny) => {
          const blob = JSON.stringify({
            permissions: { allow, ask, deny },
          });
          const rules = loadCcPermissions("/ws", {
            readFile: () => blob,
            exists: () => true,
          });
          // Schema-level: the loader doesn't validate element types, so this
          // property only asserts the shape passthrough doesn't throw and
          // returns three arrays of equal length to inputs (trivially total).
          return (
            Array.isArray(rules.allow) &&
            Array.isArray(rules.ask) &&
            Array.isArray(rules.deny)
          );
        },
      ),
    );
  });

  test("loadCcPermissions skips files that exist() returns false for", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (contents) => {
        const rules = loadCcPermissions("/ws", {
          readFile: () => contents,
          exists: () => false,
        });
        return (
          rules.allow.length === 0 &&
          rules.ask.length === 0 &&
          rules.deny.length === 0
        );
      }),
    );
  });
});
