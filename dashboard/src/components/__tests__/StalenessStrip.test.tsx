/** @vitest-environment jsdom */
/**
 * Verifies the global staleness-strip contract:
 *   - hidden when nothing registered is stale
 *   - renders when a registered fetcher goes stale (via the shared
 *     staleFetchRegistry, the same registry useBridgeFetch writes to)
 *   - clears when the stale fetcher recovers
 *   - "Retry now" calls refetch() on the stale entries
 */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StalenessStrip } from "@/components/StalenessStrip";
import { useBridgeFetch } from "@/hooks/useBridgeFetch";
import {
  __resetStaleFetchRegistryForTests,
  registerStaleFetch,
  updateStaleFetch,
} from "@/lib/staleFetchRegistry";

beforeEach(() => {
  __resetStaleFetchRegistryForTests();
});

afterEach(() => {
  __resetStaleFetchRegistryForTests();
  vi.useRealTimers();
});

describe("<StalenessStrip/>", () => {
  it("does not render when nothing is registered", () => {
    const { container } = render(<StalenessStrip />);
    expect(container.firstChild).toBeNull();
  });

  it("does not render when a registered fetcher is fresh", () => {
    const now = Date.now();
    const unregister = registerStaleFetch({
      id: "test-fresh",
      lastSuccessAt: now,
      staleAfterMs: 3000,
      refetch: vi.fn(),
    });

    const { container } = render(<StalenessStrip />);
    expect(container.firstChild).toBeNull();
    unregister();
  });

  it("renders when a registered fetcher goes stale", async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const refetch = vi.fn();
    const unregister = registerStaleFetch({
      id: "test-stale",
      lastSuccessAt: base,
      staleAfterMs: 1000,
      refetch,
    });

    const { container } = render(<StalenessStrip />);
    expect(container.firstChild).toBeNull();

    // Advance system clock + the strip's own poll ticker past the
    // staleness threshold.
    await act(async () => {
      vi.setSystemTime(base + 2000);
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(container.textContent).toMatch(/Data as of/i);
    expect(container.textContent).toMatch(/reconnecting/i);

    unregister();
  });

  it("clicking 'Retry now' calls refetch() on stale entries", async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const refetch = vi.fn();
    const unregister = registerStaleFetch({
      id: "test-retry",
      lastSuccessAt: base,
      staleAfterMs: 1000,
      refetch,
    });

    const { container, getByRole } = render(<StalenessStrip />);

    await act(async () => {
      vi.setSystemTime(base + 2000);
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(container.textContent).toMatch(/Data as of/i);
    const btn = getByRole("button", { name: /retry now/i });
    await act(async () => {
      btn.click();
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    unregister();
  });

  it("clears once the stale fetcher records a fresh success", async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);

    const unregister = registerStaleFetch({
      id: "test-recover",
      lastSuccessAt: base,
      staleAfterMs: 1000,
      refetch: vi.fn(),
    });

    const { container } = render(<StalenessStrip />);

    await act(async () => {
      vi.setSystemTime(base + 2000);
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(container.textContent).toMatch(/Data as of/i);

    // Recovery: registry entry records a fresh success.
    await act(async () => {
      vi.setSystemTime(base + 3600);
      updateStaleFetch("test-recover", Date.now());
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(container.textContent ?? "").not.toMatch(/reconnecting/i);

    unregister();
  });
});

describe("<StalenessStrip/> — integration with a real useBridgeFetch({ trackStaleness: true }) consumer", () => {
  // Smoke test for the actual end-to-end wiring used on /workers
  // (workers/page.tsx:1152 sets trackStaleness: true on its primary
  // shadow-report feed): a component polling via useBridgeFetch, not the
  // registry API directly. Confirms the hook's registration + the
  // strip's subscription actually connect, not just each half in
  // isolation.

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function jsonResponse(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function PrimaryFeedConsumer() {
    // Mirrors the real call site's shape (path + intervalMs + trackStaleness).
    useBridgeFetch<{ ok: boolean }>("/api/bridge/workers/shadow", {
      intervalMs: 1000,
      trackStaleness: true,
    });
    return null;
  }

  it("shows the global strip once a real trackStaleness consumer's poll goes quiet, and hides it again once it recovers", async () => {
    // First poll succeeds; every poll after that hangs (bridge went
    // unresponsive) — same failure mode the bug report describes.
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const { container } = render(
      <>
        <PrimaryFeedConsumer />
        <StalenessStrip />
      </>,
    );

    // Let the first successful tick land.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(container.textContent ?? "").not.toMatch(/reconnecting/i);

    // Advance past 3x intervalMs — the strip should now show the
    // aggregate staleness signal, driven purely by the hook's own
    // internal registration (no direct registry calls in this test).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 1000 + 1500);
    });
    expect(container.textContent).toMatch(/Data as of/i);
    expect(container.textContent).toMatch(/reconnecting/i);

    // Recovery: bridge comes back, next poll succeeds via retry.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(container.textContent ?? "").not.toMatch(/reconnecting/i);
  });
});
