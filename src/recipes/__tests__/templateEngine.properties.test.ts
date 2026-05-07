import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  compileTemplate,
  evaluateTemplate,
  type StepOutput,
  type TemplateContext,
  validateRecipeTemplates,
} from "../templateEngine.js";

const emptyContext: TemplateContext = { steps: {}, env: {} };

const stepOutputGen: fc.Arbitrary<StepOutput> = fc.record({
  status: fc.constantFrom("success", "error", "skipped"),
  data: fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.string(), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 20 }), {
      maxKeys: 3,
    }),
  ),
});

const contextGen: fc.Arbitrary<TemplateContext> = fc.record({
  steps: fc.dictionary(fc.string({ maxLength: 8 }), stepOutputGen, {
    maxKeys: 3,
  }),
  env: fc.dictionary(
    fc.string({ maxLength: 8 }),
    fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
    { maxKeys: 3 },
  ),
});

describe("templateEngine properties — totality", () => {
  test("compileTemplate never throws for any string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (template) => {
        compileTemplate(template);
        return true;
      }),
    );
  });

  test("evaluateTemplate never throws for any string + context", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        contextGen,
        (template, ctx) => {
          evaluateTemplate(template, ctx);
          return true;
        },
      ),
    );
  });

  test("evaluate result always has either value or error", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        contextGen,
        (template, ctx) => {
          const result = evaluateTemplate(template, ctx);
          return "value" in result || "error" in result;
        },
      ),
    );
  });

  test("validateRecipeTemplates never throws + always returns array", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 100 }), { maxLength: 20 }),
        (templates) => {
          const errors = validateRecipeTemplates(templates);
          return Array.isArray(errors);
        },
      ),
    );
  });
});

describe("templateEngine properties — value type safety", () => {
  test("evaluate value is always a string when present", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        contextGen,
        (template, ctx) => {
          const result = evaluateTemplate(template, ctx);
          if ("error" in result) return true;
          return typeof result.value === "string";
        },
      ),
    );
  });

  test("step data path-walk into prototype keys never returns a non-string", () => {
    // The path walker uses bracket access on `value as Record<string, unknown>`,
    // which would walk the prototype chain. If the engine returns something
    // like Object.prototype.constructor, JSON.stringify of a function returns
    // undefined and the value field would lie about being a string.
    const prototypeKeys = [
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ];
    for (const k of prototypeKeys) {
      const tpl = `{{steps.foo.data.${k}}}`;
      const result = evaluateTemplate(tpl, {
        steps: {
          foo: { status: "success", data: { other: "value" } },
        },
        env: {},
      });
      if ("error" in result) continue; // error is fine
      expect(typeof result.value).toBe("string");
    }
  });

  test("step data path-walk into deeper prototype chain never returns a non-string", () => {
    const result = evaluateTemplate(
      "{{steps.foo.data.__proto__.constructor}}",
      {
        steps: { foo: { status: "success", data: { x: 1 } } },
        env: {},
      },
    );
    if ("value" in result) {
      expect(typeof result.value).toBe("string");
    }
  });
});

describe("templateEngine properties — literal preservation", () => {
  test("strings without {{ are returned verbatim", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 200 })
          .filter((s) => !s.includes("{{") && !s.includes("}}")),
        (literal) => {
          const compiled = compileTemplate(literal);
          if (compiled.hasTemplates) return false;
          const result = compiled.evaluate(emptyContext);
          if ("error" in result) return false;
          return result.value === literal;
        },
      ),
    );
  });

  test("hasTemplates=false implies evaluate returns the source unchanged", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        contextGen,
        (template, ctx) => {
          const compiled = compileTemplate(template);
          if (compiled.hasTemplates) return true;
          const result = compiled.evaluate(ctx);
          if ("error" in result) return false;
          return result.value === template;
        },
      ),
    );
  });
});

describe("templateEngine properties — env semantics", () => {
  test("any env.<key> with key in env returns the env value", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 16 })
          .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
        fc.string({ maxLength: 60 }),
        (key, value) => {
          const tpl = `{{env.${key}}}`;
          const result = evaluateTemplate(tpl, {
            steps: {},
            env: { [key]: value },
          });
          if ("error" in result) return false;
          return result.value === value;
        },
      ),
    );
  });

  test("undefined env.<key> resolves to empty string", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 16 })
          .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
        (key) => {
          const tpl = `{{env.${key}}}`;
          const result = evaluateTemplate(tpl, { steps: {}, env: {} });
          if ("error" in result) return false;
          return result.value === "";
        },
      ),
    );
  });
});

describe("templateEngine properties — invariants", () => {
  test("evaluation is deterministic (same input → same output)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        contextGen,
        (template, ctx) => {
          const a = evaluateTemplate(template, ctx);
          const b = evaluateTemplate(template, ctx);
          if ("error" in a && "error" in b)
            return a.error.type === b.error.type;
          if ("value" in a && "value" in b) return a.value === b.value;
          return false;
        },
      ),
    );
  });

  test("compileTemplate then evaluate equals evaluateTemplate", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        contextGen,
        (template, ctx) => {
          const direct = evaluateTemplate(template, ctx);
          const split = compileTemplate(template).evaluate(ctx);
          if ("error" in direct && "error" in split)
            return direct.error.type === split.error.type;
          if ("value" in direct && "value" in split)
            return direct.value === split.value;
          return false;
        },
      ),
    );
  });

  test("invalid step accessor (not data/status/metadata) yields eval_error", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter(
            (s) =>
              /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) &&
              !["data", "status", "metadata"].includes(s),
          ),
        (accessor) => {
          const tpl = `{{steps.foo.${accessor}}}`;
          const result = evaluateTemplate(tpl, {
            steps: { foo: { status: "success", data: {} } },
            env: {},
          });
          return "error" in result && result.error.type === "eval_error";
        },
      ),
    );
  });

  test("missing step ref yields eval_error", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
        (stepId) => {
          const tpl = `{{steps.${stepId}.data}}`;
          const result = evaluateTemplate(tpl, { steps: {}, env: {} });
          return "error" in result && result.error.type === "eval_error";
        },
      ),
    );
  });
});

describe("templateEngine properties — no code execution", () => {
  test("expressions never evaluate JS code regardless of content", () => {
    // The engine path-walks plain values; it must never call a function or
    // construct anything. We assert by ensuring side-effect-bearing values
    // placed in `data` are not invoked: a getter on a step's data object
    // either returns the getter's value (treated as data) or is reported as
    // an error/empty — but never throws.
    let getterCalled = false;
    const data = Object.defineProperty({} as Record<string, unknown>, "x", {
      get() {
        getterCalled = true;
        return "side-effect";
      },
      enumerable: true,
    });
    const ctx: TemplateContext = {
      steps: { foo: { status: "success", data } },
      env: {},
    };
    const result = evaluateTemplate("{{steps.foo.data.x}}", ctx);
    // The getter does fire (it's a normal property access, not eval), but
    // the engine never calls a function value or constructs a class. Confirm
    // the result type stays in the contract.
    expect(getterCalled).toBe(true);
    expect("value" in result || "error" in result).toBe(true);
    if ("value" in result) expect(typeof result.value).toBe("string");
  });

  test("malformed templates always return either value or error, never throw", () => {
    const adversarial = [
      "{{",
      "}}",
      "{{}}",
      "{{ }}",
      "{{{}}",
      "{{nested.{{deeper}}}}",
      "{{steps}}",
      "{{steps.}}",
      "{{steps..data}}",
      "{{env}}",
      "{{env.}}",
      "{{a.b.c.d.e.f.g.h.i.j.k}}",
      "{{__proto__}}",
      "{{constructor.constructor('alert(1)')()}}",
    ];
    for (const tpl of adversarial) {
      const result = evaluateTemplate(tpl, emptyContext);
      expect("value" in result || "error" in result).toBe(true);
      if ("value" in result) expect(typeof result.value).toBe("string");
    }
  });
});
