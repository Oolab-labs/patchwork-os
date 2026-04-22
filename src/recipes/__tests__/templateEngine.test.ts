import { describe, expect, it } from "vitest";
import { compileTemplate, validateRecipeTemplates } from "../templateEngine.js";

describe("compileTemplate", () => {
  it("returns literal value unchanged", () => {
    const t = compileTemplate("hello world");
    expect(t.hasTemplates).toBe(false);
    const r = t.evaluate({ steps: {}, env: {} });
    expect("value" in r && r.value).toBe("hello world");
  });

  it("resolves env variable", () => {
    const t = compileTemplate("Home is {{env.HOME}}");
    expect(t.hasTemplates).toBe(true);
    const r = t.evaluate({ steps: {}, env: { HOME: "/Users/test" } });
    expect("value" in r && r.value).toBe("Home is /Users/test");
  });

  it("resolves step data path", () => {
    const t = compileTemplate("Result: {{steps.fetch.data.url}}");
    const ctx = {
      steps: {
        fetch: {
          status: "success" as const,
          data: { url: "https://example.com" },
        },
      },
      env: {},
    };
    const r = t.evaluate(ctx);
    expect("value" in r && r.value).toBe("Result: https://example.com");
  });

  it("returns empty string for undefined env var", () => {
    const t = compileTemplate("{{env.MISSING}}");
    const r = t.evaluate({ steps: {}, env: {} });
    expect("value" in r && r.value).toBe("");
  });

  it("returns eval_error for missing step", () => {
    const t = compileTemplate("{{steps.missing.data.field}}");
    const r = t.evaluate({ steps: {}, env: {} });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.type).toBe("eval_error");
  });

  it("returns compile error for invalid expression syntax", () => {
    const t = compileTemplate("{{invalid expression!}}");
    const r = t.evaluate({ steps: {}, env: {} });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.type).toBe("compile_error");
  });

  it("handles multiple templates in one string", () => {
    const t = compileTemplate("{{env.FIRST}} and {{env.SECOND}}");
    const r = t.evaluate({ steps: {}, env: { FIRST: "A", SECOND: "B" } });
    expect("value" in r && r.value).toBe("A and B");
  });

  it("does not allow env with dot path (security — single segment only)", () => {
    const t = compileTemplate("{{env.A.B}}");
    const r = t.evaluate({ steps: {}, env: { "A.B": "danger" } });
    // env with sub-path is invalid syntax → compile error
    expect("error" in r).toBe(true);
  });

  it("resolves nested data path on step", () => {
    const t = compileTemplate("{{steps.s.data.a.b.c}}");
    const ctx = {
      steps: {
        s: { status: "success" as const, data: { a: { b: { c: "deep" } } } },
      },
      env: {},
    };
    const r = t.evaluate(ctx);
    expect("value" in r && r.value).toBe("deep");
  });
});

describe("validateRecipeTemplates", () => {
  it("returns no errors for valid templates", () => {
    const errs = validateRecipeTemplates([
      "hello",
      "{{env.HOME}}",
      "{{steps.x.data.y}}",
    ]);
    expect(errs).toHaveLength(0);
  });

  it("returns compile error for invalid syntax", () => {
    const errs = validateRecipeTemplates(["{{bad syntax!}}"]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]?.type).toBe("compile_error");
  });

  it("ignores runtime-only errors (missing step at parse time)", () => {
    // Missing step reference is not a compile error — it resolves to ""
    const errs = validateRecipeTemplates(["{{steps.missing.data.field}}"]);
    expect(errs).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(validateRecipeTemplates([])).toHaveLength(0);
  });
});
