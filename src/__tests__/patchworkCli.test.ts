import { describe, expect, it } from "vitest";
import { resolveModel } from "../patchworkCli.js";
import type { PatchworkConfig } from "../patchworkConfig.js";

function stubLoad(overrides: Partial<PatchworkConfig> = {}) {
  return () =>
    ({ model: "claude", ...overrides }) as unknown as PatchworkConfig;
}

describe("resolveModel", () => {
  it("returns null when no --model and no --patchwork-config", () => {
    expect(resolveModel([], { loadConfig: stubLoad() })).toBeNull();
  });

  it("returns adapter when --model passed", () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const out = resolveModel(["--model", "openai"], {
        loadConfig: stubLoad(),
      });
      expect(out?.adapter.name).toBe("openai");
      expect(out?.config.model).toBe("openai");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("--model wins over config file", () => {
    const prev = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "AIza-test";
    try {
      const out = resolveModel(["--model", "gemini"], {
        loadConfig: stubLoad({ model: "claude" }),
      });
      expect(out?.config.model).toBe("gemini");
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prev;
    }
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
