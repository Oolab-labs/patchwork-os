import { describe, expect, it } from "vitest";
import { sanitizeEnv } from "../envSanitizer.js";

describe("sanitizeEnv", () => {
  it("strips parent-session env vars", () => {
    const out = sanitizeEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "abc",
      MCP_SERVER: "bridge",
      PATH: "/usr/bin",
    });
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(out.MCP_SERVER).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("preserves CLAUDE_CODE_OAUTH_TOKEN — subscription auth, not a session marker", () => {
    const out = sanitizeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-deadbeef",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-deadbeef");
    expect(out.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it("strips ANTHROPIC_API_KEY so non-Anthropic subprocesses do not receive it (LOW #21)", () => {
    const out = sanitizeEnv({
      ANTHROPIC_API_KEY: "sk-ant-api03-key",
      CLAUDECODE: "1",
      PATH: "/usr/bin",
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("leaves the input env unmodified (returns a copy)", () => {
    const input = { CLAUDECODE: "1", PATH: "/usr/bin" };
    sanitizeEnv(input);
    expect(input.CLAUDECODE).toBe("1");
  });

  // ── Tier-0 #3 (audit 2026-06-22): cross-provider LLM credential leak ──────
  // A subprocess agent authenticates as exactly one provider; every OTHER
  // provider's key in its environment is pure exfiltration surface (printenv /
  // curl). The sanitizer stripped only Anthropic/MCP vars, so OPENAI/XAI/GEMINI
  // keys reached both the Claude and Gemini subprocess drivers.
  it("strips cross-provider LLM API keys so they cannot leak to a subprocess", () => {
    const out = sanitizeEnv({
      OPENAI_API_KEY: "sk-openai",
      XAI_API_KEY: "xai-key",
      GEMINI_API_KEY: "gem-key",
      GOOGLE_API_KEY: "goog-key",
      GROQ_API_KEY: "groq-key",
      MISTRAL_API_KEY: "mistral-key",
      PATH: "/usr/bin",
    });
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.XAI_API_KEY).toBeUndefined();
    expect(out.GEMINI_API_KEY).toBeUndefined();
    expect(out.GOOGLE_API_KEY).toBeUndefined();
    expect(out.GROQ_API_KEY).toBeUndefined();
    expect(out.MISTRAL_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("preserves explicitly-listed provider keys (Gemini driver keeps its own creds)", () => {
    const out = sanitizeEnv(
      {
        GEMINI_API_KEY: "gem-key",
        GOOGLE_API_KEY: "goog-key",
        OPENAI_API_KEY: "sk-openai",
      },
      { preserve: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
    );
    expect(out.GEMINI_API_KEY).toBe("gem-key");
    expect(out.GOOGLE_API_KEY).toBe("goog-key");
    // A non-preserved provider key is still stripped.
    expect(out.OPENAI_API_KEY).toBeUndefined();
  });
});
