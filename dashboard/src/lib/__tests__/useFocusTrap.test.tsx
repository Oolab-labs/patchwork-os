/**
 * Tests for the useFocusTrap hook used by the mobile drawer (Shell.tsx)
 * and the More sheet (MobileBottomNav.tsx).
 *
 * Covers the four behaviors the hook owes its callers:
 *   1. Focus enters the container on open, returns to the trigger on close.
 *   2. Tab + Shift+Tab cycle within the container.
 *   3. Escape calls onClose.
 *   4. Body scroll is locked + the inertSelector targets are marked
 *      inert + aria-hidden while open, restored on close.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen, act } from "@testing-library/react";
import { useFocusTrap } from "@/lib/useFocusTrap";

type FixtureProps = {
  onClose?: () => void;
  inertSelector?: string;
  lockScroll?: boolean;
};

function Fixture({ onClose, inertSelector, lockScroll }: FixtureProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap({
    open,
    onClose: () => {
      onClose?.();
      setOpen(false);
    },
    containerRef,
    inertSelector,
    lockScroll,
  });
  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      <main data-testid="main">
        <button type="button">outside-1</button>
      </main>
      <header data-testid="hdr" className="app-header">
        <button type="button">outside-2</button>
      </header>
      {open && (
        <div ref={containerRef} data-testid="trap" tabIndex={-1}>
          <button type="button" data-testid="t-first">
            first
          </button>
          <button type="button" data-testid="t-mid">
            middle
          </button>
          <button type="button" data-testid="t-last">
            last
          </button>
        </div>
      )}
    </div>
  );
}

describe("useFocusTrap", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
  });

  afterEach(() => {
    // jsdom quirk: HTMLElement.inert isn't fully reflected; clear by hand.
    for (const el of document.querySelectorAll("[inert]")) {
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    }
    document.body.style.overflow = "";
  });

  it("moves focus to the first focusable on open", () => {
    render(<Fixture />);
    act(() => {
      screen.getByTestId("trigger").focus();
      fireEvent.click(screen.getByTestId("trigger"));
    });
    expect(document.activeElement).toBe(screen.getByTestId("t-first"));
  });

  it("restores focus to the trigger when the trap closes", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    const trigger = screen.getByTestId("trigger");
    act(() => {
      trigger.focus();
      fireEvent.click(trigger);
    });
    expect(document.activeElement).toBe(screen.getByTestId("t-first"));
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("cycles Tab from last to first focusable", () => {
    render(<Fixture />);
    act(() => {
      fireEvent.click(screen.getByTestId("trigger"));
    });
    const last = screen.getByTestId("t-last");
    act(() => {
      last.focus();
      fireEvent.keyDown(document, { key: "Tab" });
    });
    expect(document.activeElement).toBe(screen.getByTestId("t-first"));
  });

  it("cycles Shift+Tab from first to last focusable", () => {
    render(<Fixture />);
    act(() => {
      fireEvent.click(screen.getByTestId("trigger"));
    });
    const first = screen.getByTestId("t-first");
    act(() => {
      first.focus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(screen.getByTestId("t-last"));
  });

  it("locks body scroll while open and restores it on close", () => {
    document.body.style.overflow = "auto";
    render(<Fixture />);
    expect(document.body.style.overflow).toBe("auto");
    act(() => {
      fireEvent.click(screen.getByTestId("trigger"));
    });
    expect(document.body.style.overflow).toBe("hidden");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.body.style.overflow).toBe("auto");
  });

  it("marks inertSelector targets inert + aria-hidden while open", () => {
    render(
      <Fixture inertSelector="main, .app-header" />,
    );
    const main = screen.getByTestId("main");
    const hdr = screen.getByTestId("hdr");
    expect(main.hasAttribute("inert")).toBe(false);
    expect(hdr.hasAttribute("inert")).toBe(false);

    act(() => {
      fireEvent.click(screen.getByTestId("trigger"));
    });
    expect(main.hasAttribute("inert")).toBe(true);
    expect(main.getAttribute("aria-hidden")).toBe("true");
    expect(hdr.hasAttribute("inert")).toBe(true);
    expect(hdr.getAttribute("aria-hidden")).toBe("true");

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(main.hasAttribute("inert")).toBe(false);
    expect(main.hasAttribute("aria-hidden")).toBe(false);
    expect(hdr.hasAttribute("inert")).toBe(false);
    expect(hdr.hasAttribute("aria-hidden")).toBe(false);
  });

  it("respects lockScroll: false and leaves body overflow alone", () => {
    document.body.style.overflow = "auto";
    render(<Fixture lockScroll={false} />);
    act(() => {
      fireEvent.click(screen.getByTestId("trigger"));
    });
    expect(document.body.style.overflow).toBe("auto");
  });

  it("does not run trap behavior when closed", () => {
    document.body.style.overflow = "auto";
    render(<Fixture />);
    expect(document.body.style.overflow).toBe("auto");
    expect(document.querySelectorAll("[inert]").length).toBe(0);
  });
});
