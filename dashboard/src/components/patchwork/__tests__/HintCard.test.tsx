/**
 * Verifies HintCard contract:
 *   - renders the registered hint for a given id
 *   - hides itself on dismiss + persists via localStorage
 *   - HintCard.Toggle is hidden while the card is visible (no redundant ?)
 *   - HintCard.Toggle becomes visible after dismiss and re-opens the card
 *   - state syncs across mounts via the in-page CustomEvent bridge
 *   - unknown ids render nothing
 */

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HintCard } from "@/components/patchwork/HintCard";

const APPROVALS_TITLE = /What's the Approval queue/i;

describe("<HintCard/>", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders the registered hint by id", () => {
    const { getByText } = render(<HintCard id="approvals" />);
    expect(getByText(APPROVALS_TITLE)).toBeInTheDocument();
  });

  it("renders nothing for an unknown id (no crash, no stray nodes)", () => {
    const { container } = render(<HintCard id="not-a-real-page" />);
    expect(container.firstChild).toBeNull();
  });

  it("hides itself on dismiss and persists across remounts", () => {
    const { getByRole, container, unmount } = render(
      <HintCard id="approvals" />,
    );
    expect(container.firstChild).not.toBeNull();
    fireEvent.click(getByRole("button", { name: /dismiss this hint/i }));
    expect(container.firstChild).toBeNull();

    unmount();
    const { container: c2 } = render(<HintCard id="approvals" />);
    expect(c2.firstChild).toBeNull();
  });

  it("HintCard.Toggle is hidden while the card is visible", () => {
    const { container } = render(
      <>
        <HintCard.Toggle id="approvals" />
        <HintCard id="approvals" />
      </>,
    );
    // The toggle must not render while the card is up — would be a
    // duplicate "show hint" affordance.
    expect(container.querySelector("button[aria-label^='Show hint']")).toBeNull();
  });

  it("HintCard.Toggle re-opens a dismissed card (same id)", () => {
    const { container, getByRole, getByText } = render(
      <>
        <HintCard.Toggle id="approvals" />
        <HintCard id="approvals" />
      </>,
    );
    fireEvent.click(getByRole("button", { name: /dismiss this hint/i }));
    // After dismissal, the toggle should render and the card should disappear.
    const showBtn = container.querySelector(
      "button[aria-label^='Show hint']",
    ) as HTMLButtonElement;
    expect(showBtn).not.toBeNull();
    fireEvent.click(showBtn);
    expect(getByText(APPROVALS_TITLE)).toBeInTheDocument();
  });

  it("two mounts of the same hint stay in sync (CustomEvent bridge)", () => {
    const { container, getAllByRole } = render(
      <>
        <HintCard id="approvals" />
        <HintCard id="approvals" />
      </>,
    );
    expect(container.querySelectorAll('[role="note"]')).toHaveLength(2);
    const dismissButtons = getAllByRole("button", {
      name: /dismiss this hint/i,
    });
    fireEvent.click(dismissButtons[0]!);
    // BOTH should hide after a single dismiss — the second instance
    // observes the dismissal via the in-page CustomEvent bridge so
    // pages with header + body mounts stay consistent without a reload.
    expect(container.querySelectorAll('[role="note"]')).toHaveLength(0);
  });
});
