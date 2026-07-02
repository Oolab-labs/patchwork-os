/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailsFold, ExpertToggle, useExpertMode } from "../DetailsFold";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

// A tiny harness: a toggle + a fold + a second fold, all sharing state.
function Harness() {
  return (
    <div>
      <ExpertToggle />
      <DetailsFold>
        <span>engine detail A</span>
      </DetailsFold>
      <DetailsFold>
        <span>engine detail B</span>
      </DetailsFold>
    </div>
  );
}

describe("DetailsFold + useExpertMode", () => {
  it("folds expert content by default; toggle reveals it in a data-details region", () => {
    const { container } = render(<Harness />);
    expect(container.textContent).not.toContain("engine detail A");
    expect(container.querySelector("[data-details]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));

    expect(container.textContent).toContain("engine detail A");
    // Both folds react to the single shared state.
    expect(container.textContent).toContain("engine detail B");
    expect(container.querySelectorAll("[data-details]").length).toBe(2);
  });

  it("persists the choice to localStorage", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(window.localStorage.getItem("pw:expert")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(window.localStorage.getItem("pw:expert")).toBe("0");
  });

  it("hydrates from a pre-existing stored value", () => {
    window.localStorage.setItem("pw:expert", "1");
    const { container } = render(<Harness />);
    expect(container.textContent).toContain("engine detail A");
    expect(screen.getByRole("button", { name: "Hide details" })).toBeTruthy();
  });

  it("exposes setExpert/toggle via the hook", () => {
    function Probe() {
      const { expert, setExpert } = useExpertMode();
      return (
        <button type="button" onClick={() => setExpert(true)}>
          {expert ? "on" : "off"}
        </button>
      );
    }
    render(<Probe />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toBe("off");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("on");
  });
});
