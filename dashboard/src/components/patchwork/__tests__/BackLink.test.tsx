/**
 * Locks the visual contract of <BackLink>. Six detail pages previously
 * hand-rolled "← Parent" links with subtly different markup and styles
 * (IA audit, 2026-05-12); this primitive normalizes them. The tests
 * here are intentionally about the rendered output, not implementation
 * — anyone refactoring the internals should keep the same href/label/
 * caret contract.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BackLink } from "@/components/patchwork/BackLink";

describe("<BackLink/>", () => {
  it("renders a Next.js link to the given href", () => {
    const { container } = render(<BackLink href="/runs" label="Runs" />);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("/runs");
  });

  it("prefixes the label with a left-arrow caret", () => {
    const { getByText } = render(<BackLink href="/approvals" label="Approvals" />);
    expect(getByText("← Approvals")).toBeInTheDocument();
  });

  it("supports labels with multiple words", () => {
    const { getByText } = render(
      <BackLink href="/insights" label="Approval Insights" />,
    );
    expect(getByText("← Approval Insights")).toBeInTheDocument();
  });

  it("accepts a style override without dropping default margins", () => {
    const { container } = render(
      <BackLink href="/x" label="X" style={{ marginTop: 20 }} />,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.marginTop).toBe("20px");
    // Default marginBottom should still be present (4px).
    expect(wrapper.style.marginBottom).toBe("4px");
  });
});
