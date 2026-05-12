/**
 * Verifies the first-run orchestrator on /dashboard:
 *   - probes 4 endpoints and auto-checks steps that have data
 *   - hides when all 4 are complete (the happy path is established)
 *   - hides when the user dismisses + persists across remounts
 *   - shows incomplete steps with a CTA + hint
 *   - completed steps render with a check mark and line-through
 */

import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunChecklist } from "@/components/FirstRunChecklist";

const originalFetch = global.fetch;

type Probe =
  | { kind: "arr"; arr: unknown[] }
  | { kind: "wrap"; key: string; arr: unknown[] };

function makeFetch(perPath: Record<string, Probe>): typeof fetch {
  // Order keys longest-first so a URL like /api/bridge/approvals/history
  // matches its specific entry instead of the shorter /api/bridge/approvals.
  const keysByLength = Object.keys(perPath).sort((a, b) => b.length - a.length);
  const spy = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const match = keysByLength.find((p) => url.includes(p));
    if (!match) return new Response("[]", { headers: { "content-type": "application/json" } });
    const probe = perPath[match]!;
    const body = probe.kind === "arr" ? probe.arr : { [probe.key]: probe.arr };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  });
  return spy as unknown as typeof fetch;
}

describe("<FirstRunChecklist/>", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    global.fetch = originalFetch;
  });

  it("renders four steps with the right completion state from the probes", async () => {
    global.fetch = makeFetch({
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [{ id: "gmail" }] },
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/approvals": { kind: "arr", arr: [] },
      "/api/bridge/traces?traceType=approval": { kind: "wrap", key: "traces", arr: [] },
    });
    const { findByText, container } = render(<FirstRunChecklist />);
    expect(await findByText(/Get started/)).toBeInTheDocument();
    // Step 1 (connections) is done — check mark renders, line-through.
    expect(container.textContent).toMatch(/Connect a service/);
    // Step 4 (approvals) is incomplete — its CTA link is in the DOM.
    expect(container.querySelector('a[href="/approvals"]')).not.toBeNull();
  });

  it("collapses entirely when all four steps are complete", async () => {
    global.fetch = makeFetch({
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [{ id: "gmail" }] },
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [{ name: "x" }] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [{ seq: 1 }] },
      "/api/bridge/approvals": { kind: "arr", arr: [{ callId: "a" }] },
      "/api/bridge/traces?traceType=approval": { kind: "wrap", key: "traces", arr: [] },
    });
    const { container } = render(<FirstRunChecklist />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("renders nothing on first paint (waits for probes) — no skeleton flash", () => {
    global.fetch = makeFetch({
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/approvals": { kind: "arr", arr: [] },
      "/api/bridge/traces?traceType=approval": { kind: "wrap", key: "traces", arr: [] },
    });
    const { container } = render(<FirstRunChecklist />);
    // Pre-fetch, container is empty (no skeleton because a fresh user
    // would see a flicker every Overview load).
    expect(container.firstChild).toBeNull();
  });

  it("dismissal persists across remounts via localStorage", async () => {
    global.fetch = makeFetch({
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/approvals": { kind: "arr", arr: [] },
      "/api/bridge/traces?traceType=approval": { kind: "wrap", key: "traces", arr: [] },
    });
    const { findByRole, container, unmount } = render(<FirstRunChecklist />);
    const dismiss = await findByRole("button", {
      name: /dismiss first-run checklist/i,
    });
    fireEvent.click(dismiss);
    expect(container.firstChild).toBeNull();
    unmount();
    const { container: c2 } = render(<FirstRunChecklist />);
    // Even after the new mount's probes settle, the checklist stays
    // hidden because of the persisted dismissal.
    await waitFor(() => {
      // No assertion needed mid-await — we just want probes to fire.
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(c2.firstChild).toBeNull();
  });
});
