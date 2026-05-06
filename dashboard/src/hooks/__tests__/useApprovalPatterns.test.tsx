/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the onEvent callback from useBridgeStream so tests can simulate
// SSE events without spinning up an EventSource.
let capturedOnEvent: ((type: string, data: unknown) => void) | null = null;

vi.mock("../useBridgeStream", () => ({
  useBridgeStream: (
    _path: string,
    onEvent: (type: string, data: unknown) => void,
  ) => {
    capturedOnEvent = onEvent;
    return { connected: true, error: undefined };
  },
}));

import { useApprovalPatterns } from "../useApprovalPatterns";

const STORAGE_KEY = "patchwork-approval-patterns";

beforeEach(() => {
  localStorage.clear();
  capturedOnEvent = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fireEvent(type: string, data: unknown) {
  if (!capturedOnEvent) throw new Error("stream callback not captured");
  act(() => {
    capturedOnEvent!(type, data);
  });
}

describe("useApprovalPatterns — initial state", () => {
  it("hydrates from an empty localStorage as an empty Map", () => {
    const { result } = renderHook(() => useApprovalPatterns());
    expect(result.current.patterns.size).toBe(0);
  });

  it("rehydrates persisted entries", () => {
    const now = Date.now();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        Bash: { approved: 3, rejected: 1, lastSeen: now - 1000 },
        Read: { approved: 5, rejected: 0, lastSeen: now - 2000 },
      }),
    );
    const { result } = renderHook(() => useApprovalPatterns());
    expect(result.current.patterns.size).toBe(2);
    expect(result.current.patterns.get("Bash")).toEqual({
      approved: 3,
      rejected: 1,
      lastSeen: now - 1000,
    });
  });

  it("filters out entries older than the 30-day expiry", () => {
    const now = Date.now();
    const expired = now - 31 * 24 * 3600 * 1000;
    const fresh = now - 1000;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        OldTool: { approved: 1, rejected: 0, lastSeen: expired },
        NewTool: { approved: 1, rejected: 0, lastSeen: fresh },
      }),
    );
    const { result } = renderHook(() => useApprovalPatterns());
    expect(result.current.patterns.size).toBe(1);
    expect(result.current.patterns.has("OldTool")).toBe(false);
    expect(result.current.patterns.has("NewTool")).toBe(true);
  });

  it("treats malformed JSON in localStorage as an empty Map (no throw)", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useApprovalPatterns());
    expect(result.current.patterns.size).toBe(0);
  });
});

describe("useApprovalPatterns — approval_decision stream events", () => {
  it("creates a new entry when toolName is unknown", () => {
    const { result } = renderHook(() => useApprovalPatterns());
    fireEvent("approval_decision", { toolName: "Bash", decision: "approve" });
    const got = result.current.patterns.get("Bash");
    expect(got).toBeDefined();
    expect(got!.approved).toBe(1);
    expect(got!.rejected).toBe(0);
    expect(got!.lastSeen).toBeGreaterThan(0);
  });

  it("increments the approved counter on existing entry", () => {
    const now = Date.now();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        Bash: { approved: 5, rejected: 1, lastSeen: now - 1000 },
      }),
    );
    const { result } = renderHook(() => useApprovalPatterns());
    fireEvent("approval_decision", { toolName: "Bash", decision: "approve" });
    expect(result.current.patterns.get("Bash")!.approved).toBe(6);
    expect(result.current.patterns.get("Bash")!.rejected).toBe(1);
  });

  it("increments the rejected counter on 'reject' decision", () => {
    const { result } = renderHook(() => useApprovalPatterns());
    fireEvent("approval_decision", { toolName: "WebFetch", decision: "reject" });
    fireEvent("approval_decision", { toolName: "WebFetch", decision: "reject" });
    expect(result.current.patterns.get("WebFetch")).toMatchObject({
      approved: 0,
      rejected: 2,
    });
  });

  it("persists updated patterns to localStorage", () => {
    renderHook(() => useApprovalPatterns());
    fireEvent("approval_decision", { toolName: "Bash", decision: "approve" });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.Bash).toMatchObject({ approved: 1, rejected: 0 });
  });

  it("ignores non-approval_decision event types", () => {
    const { result } = renderHook(() => useApprovalPatterns());
    fireEvent("connector_status", { toolName: "Bash", decision: "approve" });
    fireEvent("ping", { x: 1 });
    expect(result.current.patterns.size).toBe(0);
  });

  it("ignores malformed event data (missing or wrong-shape fields)", () => {
    const { result } = renderHook(() => useApprovalPatterns());
    fireEvent("approval_decision", null);
    fireEvent("approval_decision", { toolName: "Bash" }); // missing decision
    fireEvent("approval_decision", { decision: "approve" }); // missing toolName
    fireEvent("approval_decision", { toolName: 7, decision: "approve" }); // wrong types
    fireEvent("approval_decision", { toolName: "Bash", decision: "maybe" }); // bad enum
    expect(result.current.patterns.size).toBe(0);
  });
});

describe("useApprovalPatterns — clearPatterns", () => {
  it("clears state and removes the localStorage entry", () => {
    const now = Date.now();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        Bash: { approved: 3, rejected: 0, lastSeen: now - 1000 },
      }),
    );
    const { result } = renderHook(() => useApprovalPatterns());
    expect(result.current.patterns.size).toBe(1);

    act(() => {
      result.current.clearPatterns();
    });

    expect(result.current.patterns.size).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
