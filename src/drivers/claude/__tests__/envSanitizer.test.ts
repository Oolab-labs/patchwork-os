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

  it("preserves ANTHROPIC_API_KEY", () => {
    const out = sanitizeEnv({
      ANTHROPIC_API_KEY: "sk-ant-api03-key",
      CLAUDECODE: "1",
    });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-api03-key");
  });

  it("leaves the input env unmodified (returns a copy)", () => {
    const input = { CLAUDECODE: "1", PATH: "/usr/bin" };
    sanitizeEnv(input);
    expect(input.CLAUDECODE).toBe("1");
  });
});
