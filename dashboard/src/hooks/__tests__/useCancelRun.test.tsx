import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCancelRun } from "@/hooks/useCancelRun";

/**
 * Unit coverage for the shared cancel-run flow used by GlobalLiveRunsStrip,
 * LiveRunsStrip, /runs, and /runs/[seq]. Exercises the phase state machine
 * (idle → confirming → cancelling → idle) and the two outcomes of
 * `POST /api/bridge/runs/:seq/cancel`.
 */
describe("useCancelRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts idle and moves to confirming on requestConfirm", () => {
    const { result } = renderHook(() => useCancelRun());
    expect(result.current.phase).toBe("idle");
    expect(result.current.cancelSeq).toBeNull();

    act(() => {
      result.current.requestConfirm(42);
    });

    expect(result.current.phase).toBe("confirming");
    expect(result.current.cancelSeq).toBe(42);
  });

  it("dismiss returns to idle without calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCancelRun());

    act(() => {
      result.current.requestConfirm(7);
    });
    act(() => {
      result.current.dismiss();
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.cancelSeq).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirm: running -> cancelling -> idle, calls onCancelled on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cancelled: true, seq: 9 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onCancelled = vi.fn();
    const { result } = renderHook(() => useCancelRun(onCancelled));

    act(() => {
      result.current.requestConfirm(9);
    });

    let confirmPromise: Promise<void>;
    act(() => {
      confirmPromise = result.current.confirm();
    });
    // Phase flips to "cancelling" synchronously before the await resolves.
    expect(result.current.phase).toBe("cancelling");

    await act(async () => {
      await confirmPromise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/bridge/runs/9/cancel");
    expect(init.method).toBe("POST");

    expect(result.current.phase).toBe("idle");
    expect(result.current.cancelSeq).toBeNull();
    expect(onCancelled).toHaveBeenCalledWith(9);
  });

  it("confirm: reverts to idle (running-equivalent) on 404 and does not call onCancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ cancelled: false, seq: 9 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onCancelled = vi.fn();
    const { result } = renderHook(() => useCancelRun(onCancelled));

    act(() => {
      result.current.requestConfirm(9);
    });
    await act(async () => {
      await result.current.confirm();
    });

    await waitFor(() => {
      expect(result.current.phase).toBe("idle");
    });
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("confirm: reverts to idle on network error and does not call onCancelled", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const onCancelled = vi.fn();
    const { result } = renderHook(() => useCancelRun(onCancelled));

    act(() => {
      result.current.requestConfirm(9);
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.phase).toBe("idle");
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("confirm is a no-op when no seq is pending", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCancelRun());

    await act(async () => {
      await result.current.confirm();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
