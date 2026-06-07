/**
 * LOW #41 — HaltToastWatcher fires on every SSE event due to runs Map reference
 *
 * Bug: The useEffect dependency array includes `runs` (a Map object). A new
 * Map reference is created on every SSE event even when halt-relevant data
 * hasn't changed, causing the effect to re-run on EVERY event and potentially
 * fire duplicate toasts.
 *
 * Fix: Use a stable derived value (e.g. via useMemo) that only changes when
 * halt-relevant fields actually change, OR deduplicate inside the effect by
 * checking a stable set of already-toasted run IDs before calling toast.error.
 *
 * Test: Simulate two SSE events with the same run data and assert toast.error
 * is only called once.
 */

import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRunState } from "../hooks/useRecipeRunStream";

// ---------------------------------------------------------------------------
// Mock the hooks consumed by HaltToastWatcher
// ---------------------------------------------------------------------------

const mockToastError = vi.fn();
const mockToastInfo = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("@/components/Toast", () => ({
  useToast: () => ({
    error: mockToastError,
    info: mockToastInfo,
    success: mockToastSuccess,
    warn: vi.fn(),
    toast: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

// We control what useActiveRuns returns via this mutable variable
let activeRunsSnapshot: Map<string, ActiveRunState> = new Map();

vi.mock("@/hooks/LiveRunsContext", () => ({
  useActiveRuns: () => activeRunsSnapshot,
}));

// Stub push subscription utilities so the async push-offer path is a no-op
vi.mock("@/lib/pushSubscription", () => ({
  getPushSubscriptionStatus: vi.fn().mockResolvedValue("unsupported"),
  registerServiceWorker: vi.fn(),
  subscribeToPush: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<ActiveRunState> = {}): ActiveRunState {
  return {
    runSeq: 1,
    recipeName: "my-recipe",
    totalSteps: 3,
    doneSteps: 3,
    startedAt: Date.now() - 5000,
    status: "halted",
    haltReason: "budget exceeded",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HaltToastWatcher — LOW #41 stable deps / dedup toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeRunsSnapshot = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires toast.error exactly once when a run transitions running→halted", async () => {
    const { HaltToastWatcher } = await import("../components/HaltToastWatcher");

    // First render: run is "running"
    activeRunsSnapshot = new Map([
      ["my-recipe", makeRunState({ status: "running", haltReason: undefined })],
    ]);

    const { rerender } = render(<HaltToastWatcher />);

    // Second render: same run transitions to "halted" — first SSE event
    activeRunsSnapshot = new Map([
      ["my-recipe", makeRunState({ status: "halted", haltReason: "budget exceeded" })],
    ]);
    await act(async () => { rerender(<HaltToastWatcher />); });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0][0]).toContain("my-recipe");
  });

  it("does NOT fire toast.error a second time when a new Map is produced with the same halted state", async () => {
    const { HaltToastWatcher } = await import("../components/HaltToastWatcher");

    // Transition 1: running → halted
    activeRunsSnapshot = new Map([
      ["my-recipe", makeRunState({ status: "running", haltReason: undefined })],
    ]);
    const { rerender } = render(<HaltToastWatcher />);

    // Move to halted
    activeRunsSnapshot = new Map([
      ["my-recipe", makeRunState({ status: "halted", haltReason: "budget exceeded" })],
    ]);
    await act(async () => { rerender(<HaltToastWatcher />); });
    expect(mockToastError).toHaveBeenCalledTimes(1);

    // Simulate a second SSE event: NEW Map reference but SAME data
    // (This is the scenario that triggered the bug — the Map ref changed
    //  even though the underlying data did not, causing the effect to re-run)
    activeRunsSnapshot = new Map([
      ["my-recipe", makeRunState({ status: "halted", haltReason: "budget exceeded" })],
    ]);
    await act(async () => { rerender(<HaltToastWatcher />); });

    // Toast must still only have been called once — not twice
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("does not fire any toast on the initial mount (skip pre-existing terminal runs)", async () => {
    const { HaltToastWatcher } = await import("../components/HaltToastWatcher");

    // Run is already halted when the component first mounts
    activeRunsSnapshot = new Map([
      ["my-recipe", makeRunState({ status: "halted", haltReason: "pre-existing" })],
    ]);

    render(<HaltToastWatcher />);

    // The initialMountRef guard should suppress toasts on the first render
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
