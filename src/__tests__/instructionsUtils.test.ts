import { describe, expect, it } from "vitest";
import { buildEnforcementBlock } from "../instructionsUtils.js";

describe("buildEnforcementBlock", () => {
  it("returns an array starting with the BRIDGE TOOL ENFORCEMENT header", () => {
    const block = buildEnforcementBlock();
    expect(block[0]).toBe("BRIDGE TOOL ENFORCEMENT:");
  });

  it("includes all four primary tool substitutions", () => {
    const text = buildEnforcementBlock().join("\n");
    expect(text).toContain("runTests");
    expect(text).toContain("getDiagnostics");
    expect(text).toContain("gitCommit");
    expect(text).toContain("searchWorkspace");
  });

  it("references bridge-tools.md", () => {
    const text = buildEnforcementBlock().join("\n");
    expect(text).toContain("bridge-tools.md");
  });

  it("returns at least 4 lines", () => {
    expect(buildEnforcementBlock().length).toBeGreaterThanOrEqual(4);
  });
});
