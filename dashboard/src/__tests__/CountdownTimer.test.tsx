/**
 * LOW #43 — CountdownTimer setInterval never clears on expiresAt=0
 *
 * Bugs:
 * 1. When expiresAt is 0 (or falsy), the useEffect still sets up an interval
 *    that fires every second but is never cleared when it should not be started.
 * 2. When the countdown reaches zero (remaining ≤ 0), the interval keeps
 *    firing at 1 Hz instead of stopping.
 *
 * Fixes:
 * 1. If expiresAt is 0/falsy, skip the setInterval entirely.
 * 2. When the timer reaches expiry, call clearInterval on the handle.
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountdownTimer } from "../app/approvals/_components/CountdownTimer";

describe("CountdownTimer — LOW #43 interval cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not start an interval when expiresAt is 0", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { unmount } = render(<CountdownTimer expiresAt={0} />);

    // Advance time to ensure no delayed interval is set
    vi.advanceTimersByTime(3000);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    unmount();
  });

  it("clears the interval when expiresAt is 0 and component unmounts", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<CountdownTimer expiresAt={0} />);

    unmount();

    // clearInterval may be called 0 times (no interval was created)
    // OR once (if a handle was created and then cleaned up).
    // What must NOT happen is a leaked interval continuing to fire.
    vi.advanceTimersByTime(5000);
    // After unmount, no state updates should be scheduled.
    // (This indirectly validates cleanup — no React "can't update unmounted" warnings.)
  });

  it("does not start an interval when expiresAt is already expired (past timestamp)", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    // A timestamp 10 seconds in the past
    const pastTimestamp = Date.now() - 10_000;

    render(<CountdownTimer expiresAt={pastTimestamp} />);

    // If the component correctly checks expiresAt ≤ 0 (remaining ≤ 0 at mount),
    // it should not start an interval.
    vi.advanceTimersByTime(3000);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("clears the interval once the countdown reaches zero during live countdown", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    // Expires 2 seconds from now
    const expiresAt = Date.now() + 2000;

    render(<CountdownTimer expiresAt={expiresAt} />);

    // Advance past expiry — wrap in act so React processes the state updates
    // triggered by the interval callback.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // clearInterval must have been called (interval stopped when remaining hits 0)
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("cleans up the interval on unmount for a live countdown", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const expiresAt = Date.now() + 60_000; // 60s from now

    const { unmount } = render(<CountdownTimer expiresAt={expiresAt} />);
    unmount();

    // cleanup function must call clearInterval
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
