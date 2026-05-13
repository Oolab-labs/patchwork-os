/**
 * Verifies the RelationStrip primitive — the "what this entity touches"
 * chip row that turns every detail page from an island into a node in
 * a graph. Tests lock the contract that future edits can't break:
 * chips render as links, internal vs external routing, tone styling,
 * empty-state collapse, and the accessibility wrapper.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RelationStrip,
  type RelationItem,
} from "@/components/patchwork/RelationStrip";

describe("<RelationStrip/>", () => {
  it("renders each item as a link with the given href + label", () => {
    const items: RelationItem[] = [
      { label: "12 runs", href: "/runs?recipe=morning-pulse" },
      { label: "3 halts", href: "/runs?halt=1", tone: "warn" },
    ];
    const { getByText } = render(<RelationStrip items={items} />);

    const first = getByText("12 runs").closest("a");
    expect(first?.getAttribute("href")).toBe("/runs?recipe=morning-pulse");
    const second = getByText("3 halts").closest("a");
    expect(second?.getAttribute("href")).toBe("/runs?halt=1");
  });

  it("returns null when given an empty list (no aria-noise for empty strips)", () => {
    const { container } = render(<RelationStrip items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("wraps the chip row in a nav landmark with a meaningful aria-label", () => {
    const { container } = render(
      <RelationStrip
        label="Recipe relations"
        items={[{ label: "x", href: "/x" }]}
      />,
    );
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Recipe relations");
  });

  it("defaults the aria-label to 'Related' when none is provided", () => {
    const { container } = render(
      <RelationStrip items={[{ label: "x", href: "/x" }]} />,
    );
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Related",
    );
  });

  it("routes external https URLs via a raw <a target='_blank' rel='noopener noreferrer'>", () => {
    const { getByText } = render(
      <RelationStrip
        items={[
          { label: "Docs", href: "https://patchwork.dev/docs" },
        ]}
      />,
    );
    const anchor = getByText("Docs").closest("a");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("uses the optional title as the hover tooltip (defaults to href when omitted)", () => {
    const { getByText } = render(
      <RelationStrip
        items={[
          { label: "A", href: "/a", title: "go to A" },
          { label: "B", href: "/b" },
        ]}
      />,
    );
    expect(getByText("A").closest("a")?.getAttribute("title")).toBe("go to A");
    expect(getByText("B").closest("a")?.getAttribute("title")).toBe("/b");
  });

  it("renders an optional icon node before the label", () => {
    const { getByText } = render(
      <RelationStrip
        items={[
          { label: "Slack", href: "/connections", icon: <span>#</span> },
        ]}
      />,
    );
    // The icon-wrapping span carries aria-hidden so screen readers see
    // only the label.
    const anchor = getByText("Slack").closest("a");
    expect(anchor?.textContent).toContain("#");
    expect(anchor?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
