/**
 * Tests for the AI recipe generator prompt + helpers.
 *
 * Audit (2026-05-06) finding: the system prompt taught no real tool
 * integrations, so every "Generate with AI" output was agent-prompt-only
 * — none of the 4 production recipes could be reproduced. This PR adds
 * a TOOLS AVAILABLE section + a third example using `tool:` steps,
 * plus post-generation validation that emitted `tool: <id>` IDs are
 * actually registered.
 *
 * The system prompt itself is tested for invariants: tool IDs match
 * the registry, length budget, required clauses present, no obvious
 * regression of the bug rule "do NOT invent tool names" (the audit
 * found this rule was the actual source of the agent-only bias and it
 * had to invert).
 */

import { describe, expect, it } from "vitest";
import {
  collectUnknownToolIds,
  RECIPE_GENERATION_SYSTEM_PROMPT,
} from "../recipeOrchestration.js";
// Force-load the tool registry — `hasTool` reads the in-memory map
// populated by these registration side effects.
import "../recipes/tools/index.js";
import { hasTool } from "../recipes/toolRegistry.js";

describe("RECIPE_GENERATION_SYSTEM_PROMPT", () => {
  it("stays under the 9 KB budget (regression guard against unbounded growth)", () => {
    // Soft cap. Prompt is cached on Claude's side after the first hit so
    // length is mostly a one-time cache-miss cost, not per-call. The
    // ratchet here just catches accidental doubling — set ~10% above
    // the current size when this PR landed (~8 KB).
    expect(RECIPE_GENERATION_SYSTEM_PROMPT.length).toBeLessThan(9000);
  });

  it("contains the required safety clauses (regression guard for the lost #263 hardening)", () => {
    // <user_request> wrap → prompt-injection mitigation
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(/<user_request>/);
    // REFUSAL clause → abuse filter
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(/REFUSAL/);
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(/# REFUSED:/);
    // vars-under-trigger rule → schema correctness
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(
      /Vars MUST be nested under .*trigger/i,
    );
    // untrusted_data wrapping → prevents prompt-injection via
    // connector-sourced text (emails, GitHub bodies, etc.)
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(/<untrusted_data>/);
  });

  it("teaches `tool:` steps (the audit's P0 product gap)", () => {
    // Must explicitly invert the previous "do NOT invent tool names" rule.
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(/TOOLS AVAILABLE/);
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).toMatch(/prefer concrete .*tool/i);
    // No relic of the bug rule. The phrase "invent tool names" must NOT
    // appear without a "do NOT … invent" qualifier wrapping a tool-id
    // example. We simply assert the bare phrase is absent.
    expect(RECIPE_GENERATION_SYSTEM_PROMPT).not.toMatch(
      /Step prompts are plain natural-language — do NOT invent tool names/,
    );
  });

  it("only names tool IDs that are actually registered", () => {
    // Pull every `<token>.<token>` look-alike from the prompt's TOOLS
    // AVAILABLE section. The format is "  tool_id          — purpose"
    // so `^\s+([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s+—` is the line shape.
    const toolsSectionStart =
      RECIPE_GENERATION_SYSTEM_PROMPT.indexOf("TOOLS AVAILABLE");
    const toolsSectionEnd = RECIPE_GENERATION_SYSTEM_PROMPT.indexOf(
      "OUTPUT SHAPES",
      toolsSectionStart,
    );
    expect(toolsSectionStart).toBeGreaterThan(0);
    expect(toolsSectionEnd).toBeGreaterThan(toolsSectionStart);
    const section = RECIPE_GENERATION_SYSTEM_PROMPT.slice(
      toolsSectionStart,
      toolsSectionEnd,
    );
    const ids = [
      ...section.matchAll(/^\s+([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s+—/gm),
    ].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    const unregistered = ids.filter((id) => !hasTool(id));
    expect(unregistered).toEqual([]);
  });

  it("worked examples reference only registered tool IDs", () => {
    // Audit (2026-05-06) follow-up: the original example #1 promised
    // GitHub-notification fetching and email delivery via agent: prose,
    // implying tools that don't exist in the registry. Going forward,
    // every `- tool: <id>` line in the EXAMPLES block must resolve to a
    // registered tool, so the worked examples can't drift back into
    // making promises the runtime can't keep.
    const examplesStart = RECIPE_GENERATION_SYSTEM_PROMPT.indexOf("EXAMPLES:");
    expect(examplesStart).toBeGreaterThan(0);
    const examples = RECIPE_GENERATION_SYSTEM_PROMPT.slice(examplesStart);
    const ids = [
      ...examples.matchAll(
        /^\s*-\s*tool:\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)/gim,
      ),
    ].map((m) => m[1] as string);
    // Examples must use at least one tool: step (otherwise we've regressed
    // to the agent-only bias that motivated the audit fix).
    expect(ids.length).toBeGreaterThan(0);
    const unregistered = ids.filter((id) => !hasTool(id));
    expect(unregistered).toEqual([]);
  });
});

describe("collectUnknownToolIds", () => {
  it("returns [] for a recipe that uses only registered tools", () => {
    const yaml = `
name: brief
trigger:
  type: manual
steps:
  - tool: gmail.fetch_unread
    since: 24h
    into: messages
  - tool: file.write
    path: /tmp/x
    content: hi
    into: result
`;
    expect(collectUnknownToolIds(yaml)).toEqual([]);
  });

  it("warns about a hallucinated camelCase tool ID", () => {
    const yaml = `
name: bad
trigger:
  type: manual
steps:
  - tool: gmail.fetchUnread
    into: messages
`;
    const warnings = collectUnknownToolIds(yaml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Unknown tool ID "gmail\.fetchUnread"/);
  });

  it("warns about an entirely-invented tool ID", () => {
    const yaml = `
name: bad
trigger:
  type: manual
steps:
  - tool: gmail.send_message
    to: x
`;
    const warnings = collectUnknownToolIds(yaml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Unknown tool ID "gmail\.send_message"/);
  });

  it("dedupes — one warning per distinct ID even if used multiple times", () => {
    const yaml = `
name: bad
trigger:
  type: manual
steps:
  - tool: gmail.fetchUnread
    into: a
  - tool: gmail.fetchUnread
    into: b
`;
    expect(collectUnknownToolIds(yaml)).toHaveLength(1);
  });

  it("recurses into parallel groups", () => {
    const yaml = `
name: bad
trigger:
  type: manual
steps:
  - parallel:
      - tool: gmail.fakeTool
        into: a
      - tool: file.write
        path: /tmp/x
        content: hi
        into: b
`;
    const warnings = collectUnknownToolIds(yaml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/gmail\.fakeTool/);
  });

  it("recurses into parallel.steps map-reduce form", () => {
    const yaml = `
name: bad
trigger:
  type: manual
steps:
  - parallel:
      each: items
      as: item
      steps:
        - tool: not.a.tool
          into: out
`;
    const warnings = collectUnknownToolIds(yaml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not\.a\.tool/);
  });

  it("ignores agent steps (only checks `tool:` ones)", () => {
    const yaml = `
name: ok
trigger:
  type: manual
steps:
  - id: synth
    agent:
      prompt: hi
      into: out
`;
    expect(collectUnknownToolIds(yaml)).toEqual([]);
  });

  it("returns [] on parse failure (lint catches malformed YAML separately)", () => {
    expect(collectUnknownToolIds("name: [unclosed")).toEqual([]);
  });

  it("returns [] when steps is missing or non-array", () => {
    expect(collectUnknownToolIds("name: foo")).toEqual([]);
    expect(collectUnknownToolIds("name: foo\nsteps: not-an-array")).toEqual([]);
  });
});
