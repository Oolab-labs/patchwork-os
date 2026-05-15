import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHaltsLookbackMs,
  markHaltsSeen,
  subscribeHaltsSeen,
} from "@/lib/haltsSeen";

describe("haltsSeen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to 24h lookback when never marked", () => {
    expect(getHaltsLookbackMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("shrinks lookback to elapsed time after markHaltsSeen", () => {
    markHaltsSeen();
    vi.setSystemTime(1_700_000_000_000 + 5_000);
    expect(getHaltsLookbackMs()).toBe(5_000);
  });

  it("caps lookback at 24h even if last-seen is much older", () => {
    markHaltsSeen();
    vi.setSystemTime(1_700_000_000_000 + 48 * 60 * 60 * 1000);
    expect(getHaltsLookbackMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("returns 0 immediately after markHaltsSeen (same instant)", () => {
    markHaltsSeen();
    expect(getHaltsLookbackMs()).toBe(0);
  });

  it("ignores non-numeric or negative stored values", () => {
    window.localStorage.setItem("patchwork.haltsLastSeenAt", "not-a-number");
    expect(getHaltsLookbackMs()).toBe(24 * 60 * 60 * 1000);
    window.localStorage.setItem("patchwork.haltsLastSeenAt", "-1");
    expect(getHaltsLookbackMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("notifies same-tab subscribers when markHaltsSeen fires", () => {
    const cb = vi.fn();
    const unsub = subscribeHaltsSeen(cb);
    markHaltsSeen();
    expect(cb).toHaveBeenCalledTimes(1);
    markHaltsSeen();
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    markHaltsSeen();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
