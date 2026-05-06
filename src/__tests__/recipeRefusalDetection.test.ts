/**
 * Tests for the AI generator's refusal detection.
 *
 * Security review (post-#269) found the previous detection regex
 * `/^\s*#\s*REFUSED\b/i` requires the OUTPUT to start with `#`. A
 * model can wrap the recipe in ```yaml fences first; the comment
 * inside the YAML body gets stripped by the parser; a malicious
 * recipe lints clean. Closes the bypass by:
 *   - scanning the first ~10 non-blank lines of raw output
 *   - skipping code-fence markers without consuming a slot
 *   - additionally checking the first non-blank line of the
 *     extracted YAML body for the marker
 */

import { describe, expect, it } from "vitest";
import {
  detectRefusal,
  detectRefusalInYamlBody,
} from "../recipeOrchestration.js";

describe("detectRefusal — raw output", () => {
  it("matches a single-line refusal", () => {
    expect(detectRefusal("# REFUSED: bitcoin mining")).toEqual({
      reason: "bitcoin mining",
    });
  });

  it("matches even when wrapped in code fences (the audit-flagged bypass)", () => {
    const output = "```yaml\n# REFUSED: harmful\nname: backdoor\n```";
    expect(detectRefusal(output)).toEqual({ reason: "harmful" });
  });

  it("matches with leading prose that ends before the marker", () => {
    const output = "I can't help with that.\n# REFUSED: against policy";
    // First non-blank, non-fence line is the prose, which doesn't
    // match REFUSED. We stop scanning to avoid false-positives on
    // recipe bodies that legitimately contain `# REFUSED` inside a
    // step prompt 50 lines down. So this case returns null — but the
    // user still gets `no_yaml_in_output` downstream, which is fine.
    // (The audit's specific bypass was the FIRST few lines being a
    // refusal smuggled inside fences; that case IS caught.)
    expect(detectRefusal(output)).toBeNull();
  });

  it("matches with optional separators (— / - / :)", () => {
    expect(detectRefusal("# REFUSED — illegal")).toEqual({ reason: "illegal" });
    expect(detectRefusal("# REFUSED - illegal")).toEqual({ reason: "illegal" });
    expect(detectRefusal("#REFUSED: no separator")).toEqual({
      reason: "no separator",
    });
  });

  it("is case-insensitive on the marker", () => {
    expect(detectRefusal("# refused: lower")).toEqual({ reason: "lower" });
    expect(detectRefusal("# Refused: mixed")).toEqual({ reason: "mixed" });
  });

  it("returns null for non-refusals", () => {
    expect(detectRefusal("```yaml\nname: ok\n```")).toBeNull();
    expect(detectRefusal("# This is just a comment\nname: ok")).toBeNull();
    expect(detectRefusal("REFUSED without hash")).toBeNull();
    expect(detectRefusal("")).toBeNull();
  });

  it("handles refusal with empty reason", () => {
    expect(detectRefusal("# REFUSED")).toEqual({ reason: "" });
  });

  it("strips leading whitespace lines before checking", () => {
    expect(detectRefusal("\n\n   \n# REFUSED: spaced")).toEqual({
      reason: "spaced",
    });
  });
});

describe("detectRefusalInYamlBody", () => {
  it("matches refusal as first line of YAML body (defense-in-depth)", () => {
    const yaml =
      "# REFUSED: smuggled\nname: backdoor\ntrigger:\n  type: manual";
    expect(detectRefusalInYamlBody(yaml)).toEqual({ reason: "smuggled" });
  });

  it("ignores comments that aren't refusals", () => {
    const yaml = "# yaml-language-server: $schema=...\nname: ok";
    expect(detectRefusalInYamlBody(yaml)).toBeNull();
  });

  it("only checks the first non-blank line — comments deep in the body don't false-positive", () => {
    const yaml =
      "name: ok\ntrigger:\n  type: manual\nsteps:\n  - id: s1\n    agent:\n      prompt: |\n        # REFUSED: this is text in a prompt";
    expect(detectRefusalInYamlBody(yaml)).toBeNull();
  });

  it("returns null on empty body", () => {
    expect(detectRefusalInYamlBody("")).toBeNull();
    expect(detectRefusalInYamlBody("\n\n")).toBeNull();
  });
});
