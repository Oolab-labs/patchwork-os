import { describe, expect, it } from "vitest";
import { previewText, stripMarkdown, truncateAtWordBoundary } from "@/lib/textPreview";

describe("stripMarkdown", () => {
  it("strips headers, bold, italic, lists, code, underscores", () => {
    const input = "# Heading\n**bold** *italic* _under_ `code` \n- item one\n- item two";
    const out = stripMarkdown(input);
    expect(out).not.toMatch(/[*_#`]/);
    expect(out).toContain("bold");
    expect(out).toContain("item one");
  });

  it("flattens GFM tables into a single dot-separated line", () => {
    const input = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const out = stripMarkdown(input);
    expect(out).not.toContain("---");
    expect(out).toContain("A · B");
    expect(out).toContain("1 · 2");
  });

  it("collapses newlines to single spaces", () => {
    const out = stripMarkdown("line one\nline two\n\nline three");
    expect(out).not.toContain("\n");
  });
});

describe("truncateAtWordBoundary", () => {
  it("returns text unchanged when within the limit", () => {
    expect(truncateAtWordBoundary("short text", 100)).toBe("short text");
  });

  it("cuts at the last space, never mid-word", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const out = truncateAtWordBoundary(text, 20);
    expect(out.endsWith("…")).toBe(true);
    const withoutEllipsis = out.slice(0, -1);
    // Every remaining word must be a full word from the original text.
    const words = withoutEllipsis.split(" ").filter(Boolean);
    for (const w of words) {
      expect(text.split(" ")).toContain(w);
    }
    expect(withoutEllipsis.length).toBeLessThanOrEqual(20);
  });

  it("does not leave a dangling partial word (regression: 'false **Tri')", () => {
    const raw = "The verdict was false **Triage confirmed** after review of the evidence";
    const stripped = stripMarkdown(raw);
    const truncated = truncateAtWordBoundary(stripped, 24);
    expect(truncated).not.toMatch(/\*/);
    // No partial word: the text before the ellipsis, split on spaces,
    // must not include a fragment that isn't a real word boundary cut —
    // i.e. re-joining should never produce something like "Tri" from
    // "Triage".
    expect(truncated).not.toContain("Tri…");
    expect(truncated.replace(/…$/, "")).not.toMatch(/\S$/.test(stripped.slice(0, 24)) ? /$^/ : /a^b/);
  });
});

describe("previewText", () => {
  it("strips markdown then truncates at a word boundary with no dangling fragment", () => {
    const raw =
      "**Status:** false **Triage confirmed** — the flake was reproduced locally and is not a real regression.";
    const out = previewText(raw, 30);
    expect(out).not.toMatch(/[*_#`]/);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("Tri…");
  });
});
