/**
 * Locks the IA correction made on 2026-05-12: the third Decisions tab
 * used to be labelled "History" with the description "Past approvals &
 * rejections", but the /decisions page actually renders the
 * ctxSaveTrace knowledge base — saved reasoning, not a chronological
 * approval log. The mislabel was the single most disorienting IA bug
 * per the dashboard audit. This test fails if anyone reverts the
 * rename, so the page and its tab strip can never disagree again.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DecisionsTabs } from "@/components/DecisionsTabs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/decisions",
}));

describe("<DecisionsTabs/>", () => {
  it("labels the /decisions tab 'Knowledge' (not 'History')", () => {
    const { getByText, queryByText } = render(<DecisionsTabs />);
    expect(getByText("Knowledge")).toBeInTheDocument();
    expect(queryByText("History")).toBeNull();
  });

  it("renders all three tabs in order: Pending, Suggested, Knowledge", () => {
    const { container } = render(<DecisionsTabs />);
    const tabs = Array.from(container.querySelectorAll("a")).map(
      (a) => a.textContent?.trim(),
    );
    expect(tabs).toEqual(["Pending", "Suggested", "Knowledge"]);
  });

  it("marks /decisions as the active tab when on that path", () => {
    const { container } = render(<DecisionsTabs />);
    const active = container.querySelector('a[aria-current="page"]');
    expect(active?.getAttribute("href")).toBe("/decisions");
    expect(active?.textContent?.trim()).toBe("Knowledge");
  });

  it("shows the pending count badge on the Approvals tab when > 0", () => {
    const { container } = render(<DecisionsTabs pendingCount={5} />);
    const badge = container.querySelector(".cluster-tab-badge");
    expect(badge?.textContent).toBe("5");
  });

  it("hides the pending count badge when zero or undefined", () => {
    const { container, rerender } = render(<DecisionsTabs pendingCount={0} />);
    expect(container.querySelector(".cluster-tab-badge")).toBeNull();
    rerender(<DecisionsTabs />);
    expect(container.querySelector(".cluster-tab-badge")).toBeNull();
  });
});
