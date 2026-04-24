import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiDriver } from "../claude/api.js";
import { SubprocessDriver } from "../claude/subprocess.js";
import { GeminiSubprocessDriver } from "../gemini/index.js";
import { GrokApiDriver } from "../grok/index.js";
import { createDriver } from "../index.js";
import { OpenAIApiDriver } from "../openai/index.js";

const log = () => {};

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.XAI_API_KEY = "test-xai-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

const opts = { binary: "claude", antBinary: "ant" };

describe("createDriver", () => {
  it("returns null for mode=none", () => {
    expect(createDriver("none", opts, log)).toBeNull();
  });

  it("returns SubprocessDriver for mode=subprocess", () => {
    expect(createDriver("subprocess", opts, log)).toBeInstanceOf(
      SubprocessDriver,
    );
  });

  it("returns ApiDriver for mode=api", () => {
    expect(createDriver("api", opts, log)).toBeInstanceOf(ApiDriver);
  });

  it("returns OpenAIApiDriver for mode=openai", () => {
    expect(createDriver("openai", opts, log)).toBeInstanceOf(OpenAIApiDriver);
  });

  it("returns GrokApiDriver for mode=grok", () => {
    expect(createDriver("grok", opts, log)).toBeInstanceOf(GrokApiDriver);
  });

  it("returns GeminiSubprocessDriver for mode=gemini", () => {
    expect(createDriver("gemini", opts, log)).toBeInstanceOf(
      GeminiSubprocessDriver,
    );
  });

  it("passes custom binary to GeminiSubprocessDriver when not 'claude'", () => {
    const driver = createDriver(
      "gemini",
      { ...opts, binary: "gemini-custom" },
      log,
    ) as GeminiSubprocessDriver;
    expect(driver).toBeInstanceOf(GeminiSubprocessDriver);
  });

  it("passes bridgeMcp to GeminiSubprocessDriver", () => {
    const bridgeMcp = () => ({
      url: "http://localhost:1234/mcp",
      authToken: "tok",
    });
    const driver = createDriver("gemini", { ...opts, bridgeMcp }, log);
    expect(driver).toBeInstanceOf(GeminiSubprocessDriver);
  });

  it("throws for unknown driver mode", () => {
    expect(() => createDriver("unknown" as never, opts, log)).toThrow(
      "Unknown driver mode: unknown",
    );
  });
});
