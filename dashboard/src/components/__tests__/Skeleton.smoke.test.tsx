/**
 * Smoke test for the React rendering rig (jsdom + RTL + jest-dom matchers
 * + path alias). Picks the simplest leaf component (`Skeleton`) so a
 * failure here means the rig is broken, not the component.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton, SkeletonStatCard } from "@/components/Skeleton";

describe("rig smoke: <Skeleton/>", () => {
  it("renders with sizing and aria-hidden", () => {
    const { container } = render(<Skeleton width={120} height={20} />);
    const el = container.querySelector(".skeleton");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el).toHaveStyle({ width: "120px", height: "20px" });
  });

  it("renders a SkeletonStatCard with three skeleton-text children", () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.querySelector(".stat-card")).toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton-text").length).toBe(3);
  });
});
