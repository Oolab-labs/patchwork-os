/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusMedallion } from "../StatusMedallion";

describe("StatusMedallion", () => {
  it("renders title + sentence and exposes the tone", () => {
    const { container } = render(
      <StatusMedallion tone="ok" title="Working fine">
        Ran this morning in 42s.
      </StatusMedallion>,
    );
    expect(screen.getByText("Working fine")).toBeTruthy();
    expect(screen.getByText(/Ran this morning/)).toBeTruthy();
    expect(container.querySelector('[data-tone="ok"]')).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("carries each tone as a data attribute (state by color, not words)", () => {
    for (const tone of ["ok", "warn", "err", "muted"] as const) {
      const { container, unmount } = render(
        <StatusMedallion tone={tone} title="x" />,
      );
      expect(container.querySelector(`[data-tone="${tone}"]`)).toBeTruthy();
      unmount();
    }
  });

  it("renders without a sentence", () => {
    render(<StatusMedallion tone="muted" title="New" />);
    expect(screen.getByText("New")).toBeTruthy();
  });
});
