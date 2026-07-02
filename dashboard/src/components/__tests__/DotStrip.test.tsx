/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DotStrip, workedSentence } from "../DotStrip";

describe("workedSentence", () => {
  it("caps the window at max and phrases plainly", () => {
    expect(workedSentence(9, 10)).toBe("Worked 9 of last 10 times");
    expect(workedSentence(45, 50, 10)).toBe("Worked 10 of last 10 times"); // good clamps to shown
    expect(workedSentence(0, 0)).toBe("No runs yet");
    expect(workedSentence(1, 1)).toMatch(/the one time/);
    expect(workedSentence(0, 1)).toMatch(/Didn't work the one time/);
  });
});

describe("DotStrip", () => {
  it("renders one dot per outcome in the window, good ones filled", () => {
    const { container } = render(<DotStrip good={9} total={10} />);
    const strip = container.querySelector('[role="img"]');
    expect(strip?.getAttribute("aria-label")).toBe("Worked 9 of last 10 times");
    const dots = container.querySelectorAll('[aria-hidden="true"] > span');
    expect(dots.length).toBe(10);
  });

  it("clamps the window to max", () => {
    const { container } = render(<DotStrip good={30} total={40} max={10} />);
    const dots = container.querySelectorAll('[aria-hidden="true"] > span');
    expect(dots.length).toBe(10);
  });

  it("renders the sentence inline when asked", () => {
    const { container } = render(<DotStrip good={8} total={10} withSentence />);
    expect(container.textContent).toContain("Worked 8 of last 10 times");
  });

  it("renders nothing with no history", () => {
    const { container } = render(<DotStrip good={0} total={0} />);
    expect(container.firstChild).toBeNull();
  });
});
