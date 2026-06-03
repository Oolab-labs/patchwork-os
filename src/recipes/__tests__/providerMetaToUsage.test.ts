/**
 * Phase 1 (cost-aware routing) — the providerMeta → AgentUsage mapper that lets
 * makeProviderDriverFn forward openai/grok/gemini token counts to RunBudget.
 * Both counts must be present as numbers; a half-populated count is dropped so
 * a budget is never enforced on a misleading partial figure.
 */
import { describe, expect, it } from "vitest";
import { providerMetaToUsage } from "../yamlRunner.js";

describe("providerMetaToUsage", () => {
  it("maps both token counts to AgentUsage", () => {
    expect(
      providerMetaToUsage({ model: "x", inputTokens: 12, outputTokens: 8 }),
    ).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it("returns undefined when meta is undefined", () => {
    expect(providerMetaToUsage(undefined)).toBeUndefined();
  });

  it("returns undefined when only one count is present", () => {
    expect(providerMetaToUsage({ inputTokens: 12 })).toBeUndefined();
    expect(providerMetaToUsage({ outputTokens: 8 })).toBeUndefined();
  });

  it("returns undefined for non-number counts", () => {
    expect(
      providerMetaToUsage({ inputTokens: "12", outputTokens: "8" }),
    ).toBeUndefined();
  });

  it("returns undefined for a model-only meta (no usage reported)", () => {
    expect(providerMetaToUsage({ model: "gpt-4o" })).toBeUndefined();
  });
});
