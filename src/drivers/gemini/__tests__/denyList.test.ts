/**
 * M10: Gemini deny list must cover all categories present in the Claude deny list.
 * The two drivers use different prefix formats (run_shell_command vs Bash) but
 * must block the same command categories: publish, git-destruct, rm, sudo, eval,
 * pipe-to-shell (curl/wget), process termination.
 */
import { describe, expect, it } from "vitest";
import { GEMINI_SHELL_DENY_PATTERNS } from "../index.js";

function coversPattern(patterns: string[], prefix: string): boolean {
  return patterns.some((p) => p.startsWith(`run_shell_command(${prefix}`));
}

describe("GEMINI_SHELL_DENY_PATTERNS parity with Claude DENY_LIST (M10)", () => {
  it("blocks npm publish variants", () => {
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "npm publish")).toBe(true);
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "yarn publish")).toBe(
      true,
    );
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "pnpm publish")).toBe(
      true,
    );
  });

  it("blocks npx release tools", () => {
    expect(
      coversPattern(GEMINI_SHELL_DENY_PATTERNS, "npx semantic-release"),
    ).toBe(true);
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "npx release-it")).toBe(
      true,
    );
  });

  it("blocks git tag and gh release", () => {
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "git tag")).toBe(true);
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "gh release")).toBe(true);
  });

  it("blocks eval", () => {
    expect(coversPattern(GEMINI_SHELL_DENY_PATTERNS, "eval")).toBe(true);
  });
});
