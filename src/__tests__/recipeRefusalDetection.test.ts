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

  it("matches when refusal follows a prose preamble (security audit, 2026-05-07)", () => {
    // Previously the scanner broke at the first non-refusal line, so a
    // model that emitted "I can't help with that." then "# REFUSED:"
    // bypassed detection. Detection now scans all top-level (col-0)
    // lines within the bound, so the marker on line 2 is caught.
    const output = "I can't help with that.\n# REFUSED: against policy";
    expect(detectRefusal(output)).toEqual({ reason: "against policy" });
  });

  it("matches when refusal follows a partial header (security audit, 2026-05-07)", () => {
    // Audit-flagged bypass: model emits a top-level YAML header
    // (`apiVersion:`) and then a refusal comment on line 2. The pre-
    // fix detector returned null because it broke after `apiVersion:`.
    const output =
      "apiVersion: patchwork.sh/v1\n# REFUSED: credential harvesting\nname: foo";
    expect(detectRefusal(output)).toEqual({ reason: "credential harvesting" });
  });

  it("does NOT match an indented `# REFUSED` deep inside a prompt body", () => {
    // Top-level-only scanning means an indented comment inside a
    // multi-line `prompt: |` block can't false-positive.
    const output =
      "name: ok\nsteps:\n  - id: s1\n    agent:\n      prompt: |\n        # REFUSED: this is text in a prompt";
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

  it("does NOT match an indented `# REFUSED` inside a prompt body", () => {
    const yaml =
      "name: ok\ntrigger:\n  type: manual\nsteps:\n  - id: s1\n    agent:\n      prompt: |\n        # REFUSED: this is text in a prompt";
    expect(detectRefusalInYamlBody(yaml)).toBeNull();
  });

  it("matches refusal on a later top-level line (security audit, 2026-05-07)", () => {
    // Audit-flagged bypass: model emits real YAML headers first, then
    // smuggles `# REFUSED:` on a later top-level line. Pre-fix the
    // helper only checked the first non-blank line and missed this.
    const yaml =
      "apiVersion: patchwork.sh/v1\n# REFUSED: smuggled\nname: backdoor";
    expect(detectRefusalInYamlBody(yaml)).toEqual({ reason: "smuggled" });
  });

  it("ignores top-level non-refusal comments and continues scanning", () => {
    // A leading `# yaml-language-server` directive must not stop the
    // scan; the refusal on the next top-level line should still match.
    const yaml =
      "# yaml-language-server: $schema=...\n# REFUSED: smuggled\nname: foo";
    expect(detectRefusalInYamlBody(yaml)).toEqual({ reason: "smuggled" });
  });

  it("returns null on empty body", () => {
    expect(detectRefusalInYamlBody("")).toBeNull();
    expect(detectRefusalInYamlBody("\n\n")).toBeNull();
  });
});
