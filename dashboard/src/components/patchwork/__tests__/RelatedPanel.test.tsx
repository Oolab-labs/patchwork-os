/**
 * Tests for <RelatedPanel> — the persistent side-rail that surfaces
 * grouped related entities on detail pages.
 *
 * Contract locked here:
 * - Groups with items render their label + items.
 * - Empty groups are silently omitted (no DOM noise).
 * - All-empty → EmptyState renders (nothing-related copy).
 * - Chip dispatch: each `kind` fires the matching chip component.
 * - `meta` text is visible alongside the chip.
 * - The wrapping nav carries aria-label="Related".
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RelatedPanel, type RelatedGroup } from "@/components/patchwork/RelatedPanel";

// next/link renders as a plain <a> in the test environment.

describe("<RelatedPanel/>", () => {
  it("renders each non-empty group heading", () => {
    const groups: RelatedGroup[] = [
      { label: "Recipe", items: [{ kind: "recipe", id: "morning-pulse", label: "morning-pulse" }] },
      { label: "Runs", items: [{ kind: "run", id: "42", label: "#42" }] },
    ];
    render(<RelatedPanel groups={groups} />);
    expect(screen.getByText("Recipe")).toBeDefined();
    expect(screen.getByText("Runs")).toBeDefined();
  });

  it("omits empty groups entirely", () => {
    const groups: RelatedGroup[] = [
      { label: "Recipe", items: [{ kind: "recipe", id: "abc", label: "abc" }] },
      { label: "Empty group", items: [] },
    ];
    const { queryByText } = render(<RelatedPanel groups={groups} />);
    expect(queryByText("Empty group")).toBeNull();
  });

  it("renders EmptyState when all groups are empty", () => {
    const groups: RelatedGroup[] = [
      { label: "Group A", items: [] },
      { label: "Group B", items: [] },
    ];
    render(<RelatedPanel groups={groups} />);
    // EmptyState renders its title
    expect(screen.getByText("Nothing related yet")).toBeDefined();
  });

  it("renders meta text below the chip", () => {
    const groups: RelatedGroup[] = [
      {
        label: "Runs",
        items: [{ kind: "run", id: "7", label: "#7", meta: "2.3s ago" }],
      },
    ];
    render(<RelatedPanel groups={groups} />);
    expect(screen.getByText("2.3s ago")).toBeDefined();
  });

  it("wraps the panel in a nav with aria-label='Related'", () => {
    const groups: RelatedGroup[] = [
      { label: "Recipe", items: [{ kind: "recipe", id: "pulse", label: "pulse" }] },
    ];
    const { container } = render(<RelatedPanel groups={groups} />);
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Related");
  });

  it("renders group items as <ul>/<li>", () => {
    const groups: RelatedGroup[] = [
      { label: "Runs", items: [{ kind: "run", id: "1", label: "#1" }, { kind: "run", id: "2", label: "#2" }] },
    ];
    const { container } = render(<RelatedPanel groups={groups} />);
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    const lis = ul?.querySelectorAll("li");
    expect(lis?.length).toBe(2);
  });

  it("dispatches a recipe chip (link to /recipes/:name)", () => {
    const groups: RelatedGroup[] = [
      { label: "Recipe", items: [{ kind: "recipe", id: "daily-digest", label: "daily-digest" }] },
    ];
    const { container } = render(<RelatedPanel groups={groups} />);
    const anchors = container.querySelectorAll("a");
    const recipeLink = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("/recipes/daily-digest"),
    );
    expect(recipeLink).toBeDefined();
  });

  it("dispatches a run chip (link to /runs/:seq)", () => {
    const groups: RelatedGroup[] = [
      { label: "Runs", items: [{ kind: "run", id: "55", label: "#55" }] },
    ];
    const { container } = render(<RelatedPanel groups={groups} />);
    const anchors = container.querySelectorAll("a");
    const runLink = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.includes("/runs/55"),
    );
    expect(runLink).toBeDefined();
  });

  it("dispatches an inbox chip (link to /inbox?item=...)", () => {
    const groups: RelatedGroup[] = [
      { label: "Inbox", items: [{ kind: "inbox", id: "2026-05-20-brief.md", label: "2026-05-20-brief" }] },
    ];
    const { container } = render(<RelatedPanel groups={groups} />);
    const anchors = container.querySelectorAll("a");
    const inboxLink = Array.from(anchors).find((a) =>
      a.getAttribute("href")?.startsWith("/inbox"),
    );
    expect(inboxLink).toBeDefined();
  });

  it("renders a fallback <Link> when only href is provided (unknown chip)", () => {
    // Simulate an item that can't be matched to a chip but has href.
    // We cast through unknown to test the fallback branch.
    const groups: RelatedGroup[] = [
      {
        label: "Links",
        items: [
          {
            kind: "run" as const, // valid kind, but id is non-numeric → fallback
            id: "not-a-number",
            label: "mystery",
            href: "/somewhere",
          },
        ],
      },
    ];
    const { container } = render(<RelatedPanel groups={groups} />);
    // RunChip renders seq NaN → falls through to href fallback
    const link = container.querySelector('a[href="/somewhere"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("mystery");
  });

  it("uses the custom title prop", () => {
    const groups: RelatedGroup[] = [
      { label: "G", items: [{ kind: "recipe", id: "r", label: "r" }] },
    ];
    render(<RelatedPanel title="Context" groups={groups} />);
    expect(screen.getByText("Context")).toBeDefined();
  });
});
