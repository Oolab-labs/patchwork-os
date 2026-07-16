/**
 * Verifies the first-run funnel on /dashboard:
 *   - step ordering: recipe → run → inbox → connect
 *   - first incomplete step is marked as "next" (data-state="next")
 *   - collapses when all 4 steps are complete
 *   - collapses when the user dismisses + persists across remounts
 */

import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunChecklist } from "@/components/FirstRunChecklist";

const originalFetch = global.fetch;

type Probe =
  | { kind: "arr"; arr: unknown[] }
  | { kind: "wrap"; key: string; arr: unknown[] };

function makeFetch(perPath: Record<string, Probe>): typeof fetch {
  // Order keys longest-first so more-specific paths match first.
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

  it("step 1 (recipe) is active/next when no data exists", async () => {
    global.fetch = makeFetch({
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
    });
    const { findByText, container } = render(<FirstRunChecklist />);
    expect(await findByText(/Get started/)).toBeInTheDocument();
    // Step 1 label is present
    expect(container.textContent).toMatch(/Install or create a recipe/);
    // First item should have data-state="next"
    const items = container.querySelectorAll("li");
    expect(items[0]?.getAttribute("data-state")).toBe("next");
    expect(items[1]?.getAttribute("data-state")).not.toBe("next");
  });

  it("step 2 (run) is next when recipes are installed but no runs", async () => {
    global.fetch = makeFetch({
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [{ name: "x" }] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
    });
    const { findByText, container } = render(<FirstRunChecklist />);
    await findByText(/Get started/);
    const items = container.querySelectorAll("li");
    // Step 1 done, step 2 is next
    expect(items[0]?.getAttribute("data-state")).toBe("done");
    expect(items[1]?.getAttribute("data-state")).toBe("next");
  });

  it("step 3 (inbox) is next when recipes + runs exist but inbox empty", async () => {
    global.fetch = makeFetch({
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [{ name: "x" }] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [{ seq: 1 }] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
    });
    const { findByText, container } = render(<FirstRunChecklist />);
    await findByText(/Get started/);
    const items = container.querySelectorAll("li");
    expect(items[2]?.getAttribute("data-state")).toBe("next");
  });

  it("collapses entirely when all four steps are complete", async () => {
    global.fetch = makeFetch({
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [{ name: "x" }] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [{ seq: 1 }] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [{ id: "i1" }] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [{ id: "gmail" }] },
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
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
    });
    const { container } = render(<FirstRunChecklist />);
    expect(container.firstChild).toBeNull();
  });

  it("dismissal persists across remounts via localStorage", async () => {
    global.fetch = makeFetch({
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
    });
    const { findByRole, container, unmount } = render(<FirstRunChecklist />);
    const dismiss = await findByRole("button", {
      name: /dismiss first-run checklist/i,
    });
    fireEvent.click(dismiss);
    expect(container.firstChild).toBeNull();
    unmount();
    const { container: c2 } = render(<FirstRunChecklist />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(c2.firstChild).toBeNull();
  });

  it("suppresses itself when the bridge is unreachable (leaves it to BridgeOfflineBanner)", async () => {
    // /api/bridge/status and /api/bridge/approvals both fail (no bridge
    // running) — useBridgeStatus() should land on ok:false, degraded:false.
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/status") || url.includes("/api/bridge/approvals")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      // Recipe/run/inbox/connection probes would all report "empty" too,
      // since a real 503 from the proxy looks the same to probeArray().
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { container } = render(<FirstRunChecklist />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("step CTAs link to the correct pages", async () => {
    global.fetch = makeFetch({
      "/api/bridge/recipes": { kind: "wrap", key: "recipes", arr: [] },
      "/api/bridge/runs": { kind: "wrap", key: "runs", arr: [] },
      "/api/bridge/inbox": { kind: "wrap", key: "items", arr: [] },
      "/api/bridge/connections": { kind: "wrap", key: "connectors", arr: [] },
    });
    const { findByText, container } = render(<FirstRunChecklist />);
    await findByText(/Get started/);
    // All 4 steps have CTAs since nothing is done
    expect(container.querySelector('a[href="/marketplace"]')).not.toBeNull();
    expect(container.querySelector('a[href="/recipes"]')).not.toBeNull();
    expect(container.querySelector('a[href="/inbox"]')).not.toBeNull();
    expect(container.querySelector('a[href="/connections"]')).not.toBeNull();
  });
});
