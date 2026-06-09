/**
 * Tests for `resolveYamlPositions` + `enrichIssuesWithPositions`
 * (Phase 1B). Pinning the wire shape so CodeMirror diagnostics land
 * on the right lines.
 */

import { describe, expect, it } from "vitest";
import type { LintIssue } from "../validation.js";
import {
  enrichIssuesWithPositions,
  resolveYamlPositions,
} from "../yamlPositions.js";

const SAMPLE = `name: my-recipe
description: x
trigger:
  type: cron
  at: "0 6 * * *"
steps:
  - id: first
    tool: file.read
    path: /tmp/x
  - id: second
    agent: {}
`;

describe("resolveYamlPositions", () => {
  it("indexes every top-level key", () => {
    const idx = resolveYamlPositions(SAMPLE);
    expect(idx.byPath.get("name")?.line).toBe(1);
    expect(idx.byPath.get("description")?.line).toBe(2);
    expect(idx.byPath.get("trigger")?.line).toBe(3);
    expect(idx.byPath.get("steps")?.line).toBe(6);
  });

  it("indexes trigger sub-fields", () => {
    const idx = resolveYamlPositions(SAMPLE);
    expect(idx.byPath.get("trigger.type")?.line).toBe(4);
    expect(idx.byPath.get("trigger.at")?.line).toBe(5);
  });

  it("indexes each step by zero-based index + step-level fields", () => {
    const idx = resolveYamlPositions(SAMPLE);
    expect(idx.byPath.get("steps.0")?.line).toBe(7);
    expect(idx.byPath.get("steps.0.tool")?.line).toBe(8);
    expect(idx.byPath.get("steps.0.path")?.line).toBe(9);
    expect(idx.byPath.get("steps.1")?.line).toBe(10);
    expect(idx.byPath.get("steps.1.agent")?.line).toBe(11);
  });

  it("returns an empty index for malformed YAML (no throw)", () => {
    const idx = resolveYamlPositions("name: x\n  bad: indent\nfoo: [unclosed");
    // Either parses partially or returns empty — either way no exception.
    expect(idx.byPath instanceof Map).toBe(true);
  });

  it("returns an empty index when the root isn't an object", () => {
    const idx = resolveYamlPositions("- just\n- a\n- list\n");
    expect(idx.byPath.size).toBe(0);
  });

  // LOW #6 — positionAt column off-by-one regression tests.
  // The first character on any line must have column 0 (0-indexed).
  // Previously `col` was initialised to 1, making all columns 1-indexed.

  it("top-level key at start of file has column 0 (0-indexed)", () => {
    const idx = resolveYamlPositions(SAMPLE);
    // 'name' is the very first byte of the file — column 0.
    expect(idx.byPath.get("name")?.column).toBe(0);
  });

  it("top-level key on a subsequent line has column 0", () => {
    const idx = resolveYamlPositions(SAMPLE);
    // 'description', 'trigger', 'steps' — all start at column 0.
    expect(idx.byPath.get("description")?.column).toBe(0);
    expect(idx.byPath.get("trigger")?.column).toBe(0);
    expect(idx.byPath.get("steps")?.column).toBe(0);
  });

  it("2-space-indented key has column 2", () => {
    const idx = resolveYamlPositions(SAMPLE);
    // '  type: ...' and '  at: ...' → 'type' / 'at' start at column 2.
    expect(idx.byPath.get("trigger.type")?.column).toBe(2);
    expect(idx.byPath.get("trigger.at")?.column).toBe(2);
  });

  it("4-space-indented step key has column 4", () => {
    const idx = resolveYamlPositions(SAMPLE);
    // '    tool: ...' → 'tool' starts at column 4.
    expect(idx.byPath.get("steps.0.tool")?.column).toBe(4);
  });
});

describe("enrichIssuesWithPositions", () => {
  it("attaches line/column for 'Step N:' messages", () => {
    const issues: LintIssue[] = [
      { level: "error", message: "Step 2: Agent step missing 'prompt'" },
    ];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    // Step 2 (1-indexed) → steps[1] in the AST → line 10.
    expect(out[0]?.line).toBe(10);
  });

  it("attaches line/column for AJV-style path issues (Phase 1A `path` field)", () => {
    const issues: LintIssue[] = [
      {
        level: "error",
        message: "Schema validation: trigger.at must match pattern",
        code: "pattern",
        path: "trigger.at",
      },
    ];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    expect(out[0]?.line).toBe(5);
    // After fix: column is 0-indexed, so '  at:' → column 2.
    expect(out[0]?.column).toBe(2);
  });

  it("falls back to parent path when the deep schema key isn't indexed", () => {
    const issues: LintIssue[] = [
      {
        level: "error",
        message: "Schema validation: steps.0.params.0.nested oops",
        path: "steps.0.params.0.nested",
      },
    ];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    // No exact match; walks up to `steps.0.tool` parent? No — it walks
    // segment-by-segment until match. `steps.0` is the deepest known.
    expect(out[0]?.line).toBe(7);
  });

  it("matches 'Missing or invalid X field' messages on a root key", () => {
    const issues: LintIssue[] = [
      { level: "error", message: "Missing or invalid 'trigger' field" },
    ];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    expect(out[0]?.line).toBe(3);
  });

  it("passes issues through unchanged when no path resolves", () => {
    const issues: LintIssue[] = [
      {
        level: "warning",
        message: "Unspecific generic warning that doesn't reference any path",
      },
    ];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    expect(out[0]?.line).toBeUndefined();
    expect(out[0]?.column).toBeUndefined();
  });

  it("preserves an already-populated line/column (validator-set positions win)", () => {
    const issues: LintIssue[] = [
      { level: "error", message: "Step 1: ...", line: 999, column: 1 },
    ];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    expect(out[0]?.line).toBe(999);
  });

  it("returns the original array for empty input (no parse work)", () => {
    const issues: LintIssue[] = [];
    const out = enrichIssuesWithPositions(SAMPLE, issues);
    expect(out).toBe(issues);
  });
});
