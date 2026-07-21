import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiDriver } from "../claude/api.js";
import { SubprocessDriver } from "../claude/subprocess.js";
import { CodexDriver } from "../codex/subprocess.js";
import { GeminiApiDriver } from "../gemini/api.js";
import { GeminiSubprocessDriver } from "../gemini/index.js";
import { GrokApiDriver } from "../grok/index.js";
import { createDriver } from "../index.js";
import { LocalApiDriver } from "../local/index.js";
import { OpenAIApiDriver } from "../openai/index.js";

const log = () => {};

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.XAI_API_KEY = "test-xai-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.LOCAL_ENDPOINT = "http://localhost:11434/v1";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LOCAL_ENDPOINT;
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

  it("returns GeminiApiDriver for mode=gemini-api", () => {
    expect(createDriver("gemini-api", opts, log)).toBeInstanceOf(
      GeminiApiDriver,
    );
  });

  it("returns CodexDriver for mode=codex", () => {
    expect(createDriver("codex", opts, log)).toBeInstanceOf(CodexDriver);
  });

  it("passes custom binary to CodexDriver when not 'claude'", () => {
    const driver = createDriver(
      "codex",
      { ...opts, binary: "codex-custom" },
      log,
    );
    expect(driver).toBeInstanceOf(CodexDriver);
  });

  it("defaults CodexDriver binary to 'codex' when opts.binary is 'claude'", () => {
    const driver = createDriver("codex", opts, log) as CodexDriver;
    expect(driver).toBeInstanceOf(CodexDriver);
  });

  it("returns LocalApiDriver for mode=local", () => {
    expect(createDriver("local", opts, log)).toBeInstanceOf(LocalApiDriver);
  });

  it("throws for unknown driver mode", () => {
    expect(() => createDriver("unknown" as never, opts, log)).toThrow(
      "Unknown driver mode: unknown",
    );
  });
});
