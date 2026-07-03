/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTodayProgress } from "../_useTodayProgress";

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `patchwork.today.done.${y}-${m}-${d}`;
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useTodayProgress", () => {
  it("starts with nothing done when localStorage is empty", async () => {
    const { result } = renderHook(() => useTodayProgress());
    await waitFor(() => {
      expect(result.current.done).toEqual({ brief: false, decisions: false, team: false });
    });
  });

  it("markDone persists to localStorage under today's date key", async () => {
    const { result } = renderHook(() => useTodayProgress());
    await waitFor(() => expect(result.current.done.team).toBe(false));

    act(() => {
      result.current.markDone("team", true);
    });

    await waitFor(() => expect(result.current.done.team).toBe(true));
    const raw = window.localStorage.getItem(todayKey());
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ brief: false, decisions: false, team: true });
  });

  it("markDone can be un-set (e.g. a brief that was read becomes unread again)", async () => {
    const { result } = renderHook(() => useTodayProgress());
    await waitFor(() => expect(result.current.done.brief).toBe(false));

    act(() => result.current.markDone("brief", true));
    await waitFor(() => expect(result.current.done.brief).toBe(true));

    act(() => result.current.markDone("brief", false));
    await waitFor(() => expect(result.current.done.brief).toBe(false));
  });

  it("does not read a stale (prior-day) key — state resets automatically on a new day", async () => {
    // Simulate "yesterday" having been marked fully done under its own key.
    window.localStorage.setItem(
      "patchwork.today.done.2020-01-01",
      JSON.stringify({ brief: true, decisions: true, team: true }),
    );
    const { result } = renderHook(() => useTodayProgress());
    await waitFor(() => {
      // Today's key is untouched by yesterday's — starts fresh.
      expect(result.current.done).toEqual({ brief: false, decisions: false, team: false });
    });
  });

  it("a fresh render picks up state persisted earlier the same day", async () => {
    window.localStorage.setItem(
      todayKey(),
      JSON.stringify({ brief: true, decisions: false, team: false }),
    );
    const { result } = renderHook(() => useTodayProgress());
    await waitFor(() => {
      expect(result.current.done).toEqual({ brief: true, decisions: false, team: false });
    });
  });
});
