/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDemoMode,
  onDemoModeChange,
  setDemoMode,
} from "@/lib/demoMode";

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_DEMO_MODE;

beforeEach(() => {
  localStorage.clear();
  // jsdom sets a default cookie store — wipe it via expiry to keep tests
  // independent of one another.
  document.cookie = "pw-demo=; path=/; max-age=0";
  delete process.env.NEXT_PUBLIC_DEMO_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  } else {
    process.env.NEXT_PUBLIC_DEMO_MODE = ORIGINAL_ENV;
  }
});

describe("isDemoMode (browser)", () => {
  it("returns false by default (no localStorage, no env var)", () => {
    expect(isDemoMode()).toBe(false);
  });

  it("returns true when localStorage has 'true'", () => {
    localStorage.setItem("pw-demo", "true");
    expect(isDemoMode()).toBe(true);
  });

  it("localStorage 'false' wins over env var 'true'", () => {
    // The cookie/localStorage flag is the user's explicit override and
    // must beat the build-time env default — pin that precedence.
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    localStorage.setItem("pw-demo", "false");
    expect(isDemoMode()).toBe(false);
  });

  it("falls back to env var when localStorage is unset", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    expect(isDemoMode()).toBe(true);
  });

  it("treats env vars other than the literal 'true' string as false", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    expect(isDemoMode()).toBe(false);
    process.env.NEXT_PUBLIC_DEMO_MODE = "TRUE";
    expect(isDemoMode()).toBe(false);
  });
});

describe("setDemoMode", () => {
  it("writes the flag to localStorage, sets a cookie, dispatches the event, and reloads", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    // window.location.reload is non-configurable on jsdom — replace the
    // whole `location` object with a stub so we can observe the call
    // without actually reloading the test runner's frame.
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload, href: "http://test/" },
    });

    setDemoMode(true);

    expect(localStorage.getItem("pw-demo")).toBe("true");
    expect(document.cookie).toContain("pw-demo=true");
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
    const ev = dispatchSpy.mock.calls[0]![0] as CustomEvent<boolean>;
    expect(ev.type).toBe("pw-demo-change");
    expect(ev.detail).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("writes 'false' on disable", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload: vi.fn(), href: "http://test/" },
    });
    setDemoMode(false);
    expect(localStorage.getItem("pw-demo")).toBe("false");
    expect(document.cookie).toContain("pw-demo=false");
  });
});

describe("onDemoModeChange", () => {
  it("invokes the listener with the new value when the event fires", () => {
    const listener = vi.fn();
    onDemoModeChange(listener);
    window.dispatchEvent(new CustomEvent("pw-demo-change", { detail: true }));
    expect(listener).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("returns an unsubscribe fn that removes the listener", () => {
    const listener = vi.fn();
    const off = onDemoModeChange(listener);
    off();
    window.dispatchEvent(new CustomEvent("pw-demo-change", { detail: true }));
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers independently", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onDemoModeChange(a);
    onDemoModeChange(b);
    window.dispatchEvent(new CustomEvent("pw-demo-change", { detail: false }));
    expect(a).toHaveBeenCalledExactlyOnceWith(false);
    expect(b).toHaveBeenCalledExactlyOnceWith(false);
    offA();
    window.dispatchEvent(new CustomEvent("pw-demo-change", { detail: true }));
    // a unsubscribed; b still active
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledTimes(2);
  });
});
