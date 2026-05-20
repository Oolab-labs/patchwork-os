/**
 * EntityTimeline — unit tests.
 *
 * Covers: empty state, sort (newest first), chip rendering, spine,
 * and accessible list structure.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityTimeline } from "@/components/patchwork/EntityTimeline";
import type { TimelineEvent } from "@/components/patchwork/EntityTimeline";

// ---------- fixtures

const NOW = 1_700_000_000_000; // stable epoch so relTime never flickers

const runEvent: TimelineEvent = {
  id: "run-1",
  kind: "run",
  timestamp: NOW - 1000,
  label: "Run #1 — done",
  status: "done",
  meta: { seq: 1, recipeName: "morning-pulse" },
};

const triggerEvent: TimelineEvent = {
  id: "trigger-1",
  kind: "trigger",
  timestamp: NOW - 5000,
  label: "Triggered by: cron",
};

const inboxEvent: TimelineEvent = {
  id: "inbox-1",
  kind: "inbox",
  timestamp: NOW - 500,
  label: "morning-brief-2026-05-20.md",
  meta: { name: "morning-brief-2026-05-20.md", recipeName: "morning-pulse" },
};

const stepEvent: TimelineEvent = {
  id: "step-1",
  kind: "step",
  timestamp: NOW - 2000,
  label: "sendEmail (step-1)",
  href: "#step-step-1",
};

// ---------- tests

describe("<EntityTimeline />", () => {
  it("renders EmptyState when events array is empty", () => {
    render(<EntityTimeline events={[]} />);
    expect(screen.getByText("No timeline events")).toBeTruthy();
  });

  it("renders an <ol> list with correct aria-label", () => {
    const { container } = render(
      <EntityTimeline events={[runEvent]} ariaLabel="Run #1 timeline" />,
    );
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
    expect(ol?.getAttribute("aria-label")).toBe("Run #1 timeline");
  });

  it("renders one <li> per event", () => {
    const { container } = render(
      <EntityTimeline events={[runEvent, triggerEvent, inboxEvent]} />,
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(3);
  });

  it("sorts events newest first (descending by timestamp)", () => {
    const { container } = render(
      <EntityTimeline events={[triggerEvent, inboxEvent, runEvent]} />,
    );
    const items = container.querySelectorAll("li");
    // inboxEvent has the highest timestamp (NOW - 500), should be first
    expect(items[0].textContent).toContain("inbox");
    // triggerEvent has the lowest (NOW - 5000), should be last
    expect(items[2].textContent).toContain("trigger");
  });

  it("renders a RunChip <a> for run-kind events that have a seq", () => {
    const { container } = render(<EntityTimeline events={[runEvent]} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/runs/1");
  });

  it("renders an InboxChip <a> for inbox-kind events", () => {
    const { container } = render(<EntityTimeline events={[inboxEvent]} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toContain("/inbox?item=");
  });

  it("renders a plain next/link for step events that have an href", () => {
    const { container } = render(<EntityTimeline events={[stepEvent]} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("#step-step-1");
  });

  it("renders trigger event as plain text when no chip/href", () => {
    render(<EntityTimeline events={[triggerEvent]} />);
    expect(screen.getByText("Triggered by: cron")).toBeTruthy();
  });

  it("spine dots are aria-hidden", () => {
    const { container } = render(<EntityTimeline events={[runEvent]} />);
    // The spine wrapper div has aria-hidden="true"
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThan(0);
  });

  it("defaults ariaLabel to 'Timeline'", () => {
    const { container } = render(<EntityTimeline events={[runEvent]} />);
    const ol = container.querySelector("ol");
    expect(ol?.getAttribute("aria-label")).toBe("Timeline");
  });

  it("does not mutate the input events array", () => {
    const events = [triggerEvent, inboxEvent, runEvent];
    const before = events.map((e) => e.id);
    render(<EntityTimeline events={events} />);
    expect(events.map((e) => e.id)).toEqual(before);
  });
});
