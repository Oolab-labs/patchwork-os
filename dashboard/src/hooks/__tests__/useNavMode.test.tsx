/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useNavMode } from "../useNavMode";

const STORAGE_KEY = "patchwork.navMode";

beforeEach(() => {
  localStorage.clear();
});

describe("useNavMode", () => {
  it("defaults to simple for a totally fresh browser (empty localStorage)", async () => {
    const { result } = renderHook(() => useNavMode());
    // Initial render is "advanced" (SSR-safe default) until the effect
    // resolves the real value post-mount.
    await act(async () => {});
    expect(result.current[0]).toBe("simple");
  });

  it("defaults to advanced when any other patchwork.* key already exists (returning user)", async () => {
    localStorage.setItem("patchwork.theme", "paper");
    const { result } = renderHook(() => useNavMode());
    await act(async () => {});
    expect(result.current[0]).toBe("advanced");
  });

  it("defaults to advanced when the legacy pw-theme key exists", async () => {
    localStorage.setItem("pw-theme", "dark");
    const { result } = renderHook(() => useNavMode());
    await act(async () => {});
    expect(result.current[0]).toBe("advanced");
  });

  it("respects an explicit stored preference over the returning-user heuristic", async () => {
    localStorage.setItem("patchwork.theme", "paper");
    localStorage.setItem(STORAGE_KEY, "simple");
    const { result } = renderHook(() => useNavMode());
    await act(async () => {});
    expect(result.current[0]).toBe("simple");
  });

  it("persists a mode change to localStorage and updates the returned value", async () => {
    const { result } = renderHook(() => useNavMode());
    await act(async () => {});
    expect(result.current[0]).toBe("simple");

    act(() => {
      result.current[1]("advanced");
    });
    expect(result.current[0]).toBe("advanced");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("advanced");
  });

  it("a fresh hook instance reads back a persisted preference", async () => {
    const first = renderHook(() => useNavMode());
    await act(async () => {});
    act(() => {
      first.result.current[1]("advanced");
    });

    const second = renderHook(() => useNavMode());
    await act(async () => {});
    expect(second.result.current[0]).toBe("advanced");
  });
});
