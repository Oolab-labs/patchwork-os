import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModel } from "../patchworkCli.js";
import type { PatchworkConfig } from "../patchworkConfig.js";

function stubLoad(overrides: Partial<PatchworkConfig> = {}) {
  return () =>
    ({ model: "claude", ...overrides }) as unknown as PatchworkConfig;
}

describe("resolveModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no --model and no --patchwork-config", () => {
    expect(resolveModel([], { loadConfig: stubLoad() })).toBeNull();
  });

  it("returns adapter when --model passed", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const out = resolveModel(["--model", "openai"], {
      loadConfig: stubLoad(),
    });
    expect(out?.adapter.name).toBe("openai");
    expect(out?.config.model).toBe("openai");
  });

  it("--model wins over config file", () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
    const out = resolveModel(["--model", "gemini"], {
      loadConfig: stubLoad({ model: "claude" }),
    });
    expect(out?.config.model).toBe("gemini");
  });

  it("rejects invalid --model values", () => {
    expect(() =>
      resolveModel(["--model", "gpt5"], { loadConfig: stubLoad() }),
    ).toThrow(/must be one of/);
  });

  it("rejects --model without value", () => {
    expect(resolveModel(["--model"], { loadConfig: stubLoad() })).toBeNull();
  });
});
