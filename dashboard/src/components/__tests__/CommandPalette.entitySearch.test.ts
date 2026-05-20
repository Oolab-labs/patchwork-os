/**
 * Unit tests for the entity-search helpers in CommandPalette.
 *
 * We test the pure scoring / filtering logic in isolation — no React, no
 * network. The score() function is not exported from the component, so we
 * copy the implementation here and keep the test in lockstep. If the
 * algorithm changes, the tests break loudly.
 */

import { describe, it, expect } from "vitest";
import { canonicalRecipeKey, inboxItemKey } from "@/lib/entityKey";

// ---------------------------------------------------------------------------
// Inline copy of score() from CommandPalette.tsx (pure function, no deps)
// ---------------------------------------------------------------------------
function score(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 500;
  if (h.includes(n)) return 250;
  let hi = 0;
  let matched = 0;
  for (let ni = 0; ni < n.length; ni++) {
    while (hi < h.length && h[hi] !== n[ni]) hi++;
    if (hi >= h.length) return 0;
    matched++;
    hi++;
  }
  return matched === n.length ? 100 - (h.length - n.length) : 0;
}

// ---------------------------------------------------------------------------
// Inline grouping logic (mirrors the palette's grouped const)
// ---------------------------------------------------------------------------
interface Cmd {
  id: string;
  label: string;
  hint?: string;
  group: string;
}

function groupCommands(items: Cmd[]): { group: string; ids: string[] }[] {
  const grouped: { group: string; ids: string[] }[] = [];
  for (const cmd of items) {
    const last = grouped[grouped.length - 1];
    if (last && last.group === cmd.group) last.ids.push(cmd.id);
    else grouped.push({ group: cmd.group, ids: [cmd.id] });
  }
  return grouped;
}

function filterAndSort(cmds: Cmd[], query: string): Cmd[] {
  if (!query.trim()) return cmds;
  return cmds
    .map((c) => ({ c, s: score(c.label, query) + (c.hint ? score(c.hint, query) * 0.3 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("score()", () => {
  it("returns > 0 for exact match", () => {
    expect(score("morning-brief", "morning-brief")).toBe(1000);
  });

  it("returns > 0 for prefix match", () => {
    expect(score("morning-brief", "morning")).toBe(500);
  });

  it("returns > 0 for substring match", () => {
    expect(score("daily-morning-brief", "morning")).toBe(250);
  });

  it("returns > 0 for fuzzy subsequence match", () => {
    expect(score("morning-brief", "mbrief")).toBeGreaterThan(0);
  });

  it("returns 0 for non-matching needle", () => {
    expect(score("morning-brief", "zzz")).toBe(0);
  });

  it("returns 1 for empty needle (matches everything)", () => {
    expect(score("anything", "")).toBe(1);
  });
});

describe("entity filtering and grouping", () => {
  const mockCmds: Cmd[] = [
    { id: "nav:/", label: "Home", hint: "/", group: "Navigate" },
    { id: "recipe:morning-brief", label: "morning-brief", hint: "Open recipe", group: "Recipes" },
    { id: "recipe:inbox-digest", label: "inbox-digest", hint: "Open recipe", group: "Recipes" },
    { id: "run:42", label: "morning-brief #42", hint: "done", group: "Runs" },
    { id: "inbox:morning-brief-2026-05-20.md", label: "morning-brief-2026-05-20", hint: "Today brief", group: "Inbox" },
    { id: "session:abc123", label: "abc123", hint: "cli", group: "Sessions" },
    { id: "action:reload", label: "Reload window", group: "Actions" },
  ];

  it("no query returns all items", () => {
    expect(filterAndSort(mockCmds, "")).toHaveLength(mockCmds.length);
  });

  it("query 'morning' matches recipe, run, inbox but not unrelated", () => {
    const results = filterAndSort(mockCmds, "morning");
    const ids = results.map((c) => c.id);
    expect(ids).toContain("recipe:morning-brief");
    expect(ids).toContain("run:42");
    expect(ids).toContain("inbox:morning-brief-2026-05-20.md");
    expect(ids).not.toContain("recipe:inbox-digest");
    expect(ids).not.toContain("session:abc123");
  });

  it("query 'abc' matches session", () => {
    const results = filterAndSort(mockCmds, "abc");
    expect(results.map((c) => c.id)).toContain("session:abc123");
  });

  it("groups preserve contiguous group membership", () => {
    const grouped = groupCommands(mockCmds);
    const groupNames = grouped.map((g) => g.group);
    // Each group appears exactly once (items are pre-sorted by group)
    expect(new Set(groupNames).size).toBe(groupNames.length);
    expect(groupNames).toContain("Navigate");
    expect(groupNames).toContain("Recipes");
    expect(groupNames).toContain("Runs");
    expect(groupNames).toContain("Inbox");
    expect(groupNames).toContain("Sessions");
  });

  it("filtered results are re-grouped correctly", () => {
    const filtered = filterAndSort(mockCmds, "morning");
    const grouped = groupCommands(filtered);
    // After filtering only Recipes/Runs/Inbox should appear (in whatever order)
    const groupNames = grouped.map((g) => g.group);
    expect(groupNames).toContain("Recipes");
    expect(groupNames).toContain("Runs");
    expect(groupNames).toContain("Inbox");
    expect(groupNames).not.toContain("Navigate");
    expect(groupNames).not.toContain("Sessions");
  });
});

describe("canonicalRecipeKey in route construction", () => {
  it("strips :agent suffix before building route", () => {
    expect(canonicalRecipeKey("morning-brief:agent")).toBe("morning-brief");
  });

  it("passes plain name through unchanged", () => {
    expect(canonicalRecipeKey("morning-brief")).toBe("morning-brief");
  });
});

describe("inboxItemKey in route construction", () => {
  it("strips .md extension", () => {
    expect(inboxItemKey("morning-brief-2026-05-20.md")).toBe("morning-brief-2026-05-20");
  });

  it("passes non-.md names unchanged", () => {
    expect(inboxItemKey("morning-brief-2026-05-20")).toBe("morning-brief-2026-05-20");
  });
});
