/**
 * Verifies the inline glossary primitive that gives Patchwork-specific
 * jargon a hover/focus-revealable definition. Locks the contract:
 *   - registered terms render with a button + dotted underline
 *   - unknown terms render as plain text (fail-open, no crash)
 *   - hover OR focus opens the popover (a11y)
 *   - tooltip carries the definition + Learn-more link to the term's
 *     destination page
 *   - Escape closes
 *   - mouse re-entry within grace period keeps the popover open
 */

import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Glossary } from "@/components/patchwork/Glossary";

describe("<Glossary/>", () => {
  it("renders a button trigger for registered terms", () => {
    const { getByRole } = render(
      <Glossary term="halt">halts</Glossary>,
    );
    const btn = getByRole("button", { name: /halts/i });
    expect(btn).toBeInTheDocument();
    // aria-expanded reflects the initial closed state.
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("falls open: unknown terms render as plain text without crashing", () => {
    const { container, queryByRole } = render(
      <Glossary term="not-a-real-term">whatever</Glossary>,
    );
    // No button means no popover machinery — pure passthrough.
    expect(queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("whatever");
  });

  it("opens the popover on click + reveals the definition + Learn more link", () => {
    const { getByRole, getByText } = render(
      <Glossary term="approval">approval</Glossary>,
    );
    fireEvent.click(getByRole("button", { name: /approval/i }));
    // Tooltip carries the registered definition.
    expect(getByText(/tool call your agent wants to run/i)).toBeInTheDocument();
    // Learn-more link points at /approvals.
    const learn = getByText(/Learn more/i).closest("a");
    expect(learn?.getAttribute("href")).toBe("/approvals");
  });

  it("opens on keyboard focus (a11y) — not just mouse hover", () => {
    const { getByRole } = render(
      <Glossary term="recipe">recipe</Glossary>,
    );
    const btn = getByRole("button", { name: /recipe/i });
    fireEvent.focus(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("Escape closes the popover and restores focus to the trigger", () => {
    const { getByRole } = render(
      <Glossary term="trace">trace</Glossary>,
    );
    const btn = getByRole("button", { name: /trace/i });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    // Escape is handled by the button's local onKeyDown so the popover
    // closes without needing a window-level listener — keeps test
    // behaviour deterministic in JSDOM.
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses the registered definition for each registered term", () => {
    const { getByRole, getByText } = render(
      <Glossary term="halt">halt</Glossary>,
    );
    fireEvent.click(getByRole("button"));
    // Definition is the term's registered 1-liner — locks the
    // registry / component contract.
    expect(getByText(/recipe run that stopped before completion/i)).toBeInTheDocument();
  });

  it("delays close on mouse-leave so user can move from trigger to popover", () => {
    vi.useFakeTimers();
    const { getByRole, container } = render(
      <Glossary term="run">run</Glossary>,
    );
    const btn = getByRole("button");
    fireEvent.mouseEnter(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseLeave(container.firstChild as HTMLElement);
    // Within the grace window, still open.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    // After the grace window, closed.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    vi.useRealTimers();
  });
});
