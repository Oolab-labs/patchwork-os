/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldIgnoreShortcutEvent, usePaneShortcut } from "../usePaneShortcuts";

function fireKeydown(init: KeyboardEventInit, target?: EventTarget) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (target) {
    Object.defineProperty(event, "target", { value: target, configurable: true });
  }
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shouldIgnoreShortcutEvent", () => {
  it("ignores when focus target is an input", () => {
    const input = document.createElement("input");
    const event = new KeyboardEvent("keydown", { key: "j" });
    Object.defineProperty(event, "target", { value: input, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(true);
  });

  it("ignores when focus target is a textarea", () => {
    const textarea = document.createElement("textarea");
    const event = new KeyboardEvent("keydown", { key: "j" });
    Object.defineProperty(event, "target", { value: textarea, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(true);
  });

  it("ignores when focus target is contenteditable", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    const event = new KeyboardEvent("keydown", { key: "j" });
    Object.defineProperty(event, "target", { value: div, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(true);
  });

  it("ignores when focus target is a select", () => {
    const select = document.createElement("select");
    const event = new KeyboardEvent("keydown", { key: "j" });
    Object.defineProperty(event, "target", { value: select, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(true);
  });

  it("ignores when Cmd/Ctrl/Alt is held even outside an input", () => {
    const div = document.createElement("div");
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      const event = new KeyboardEvent("keydown", { key: "j", [mod]: true });
      Object.defineProperty(event, "target", { value: div, configurable: true });
      expect(shouldIgnoreShortcutEvent(event)).toBe(true);
    }
  });

  it("does NOT ignore Shift by default", () => {
    const div = document.createElement("div");
    const event = new KeyboardEvent("keydown", { key: "j", shiftKey: true });
    Object.defineProperty(event, "target", { value: div, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(false);
  });

  it("ignores Shift when ignoreShift is set (j/k row-nav sites)", () => {
    const div = document.createElement("div");
    const event = new KeyboardEvent("keydown", { key: "j", shiftKey: true });
    Object.defineProperty(event, "target", { value: div, configurable: true });
    expect(shouldIgnoreShortcutEvent(event, { ignoreShift: true })).toBe(true);
  });

  it("fires normally when no modifier is held and focus is outside an input", () => {
    const div = document.createElement("div");
    const event = new KeyboardEvent("keydown", { key: "j" });
    Object.defineProperty(event, "target", { value: div, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(false);
  });

  it("treats a null target as not-ignored (still checks modifiers)", () => {
    const event = new KeyboardEvent("keydown", { key: "j" });
    Object.defineProperty(event, "target", { value: null, configurable: true });
    expect(shouldIgnoreShortcutEvent(event)).toBe(false);
  });
});

describe("usePaneShortcut", () => {
  it("invokes handler for events that pass the guard", () => {
    const handler = vi.fn();
    renderHook(() => usePaneShortcut(handler, []));
    const div = document.createElement("div");
    fireKeydown({ key: "j" }, div);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not invoke handler when focus is in an input", () => {
    const handler = vi.fn();
    renderHook(() => usePaneShortcut(handler, []));
    const input = document.createElement("input");
    fireKeydown({ key: "j" }, input);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke handler when a modifier is held", () => {
    const handler = vi.fn();
    renderHook(() => usePaneShortcut(handler, []));
    const div = document.createElement("div");
    fireKeydown({ key: "k", metaKey: true }, div);
    expect(handler).not.toHaveBeenCalled();
  });

  it("respects ignoreShift option", () => {
    const handler = vi.fn();
    renderHook(() => usePaneShortcut(handler, [], { ignoreShift: true }));
    const div = document.createElement("div");
    fireKeydown({ key: "j", shiftKey: true }, div);
    expect(handler).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => usePaneShortcut(handler, []));
    unmount();
    const div = document.createElement("div");
    fireKeydown({ key: "j" }, div);
    expect(handler).not.toHaveBeenCalled();
  });
});
