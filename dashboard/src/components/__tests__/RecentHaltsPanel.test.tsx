/**
 * Verifies the halt-summary surfacing on /activity. Before this panel
 * the sidebar's halt badge linked to /activity but the page had zero
 * mention of halts — the badge promised data the page didn't deliver.
 *
 * Tests cover:
 *   - collapses to nothing on quiet workspaces (avoid noise)
 *   - renders when there are halts, with category chips + recent rows
 *   - bridge-offline / fetch failure also collapses (no broken UI)
 *   - recent rows link to /runs/<seq>
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentHaltsPanel } from "@/components/RecentHaltsPanel";

const originalFetch = global.fetch;

function mockFetch(payload: object | null, status = 200) {
  global.fetch = vi.fn(async () => {
    return new Response(payload === null ? null : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("<RecentHaltsPanel/>", () => {
  // Real timers throughout — the component schedules a 30s interval but
  // the tests assert only on the initial fetch. Fake timers caused the
  // fetch microtask chain to stall inside waitFor (vitest 4.x quirk).
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders nothing while loading + nothing on zero-halt response", async () => {
    mockFetch({ total: 0, byCategory: {}, recent: [] });
    const { container } = render(<RecentHaltsPanel />);
    // Synchronous render is empty (initial state).
    expect(container.firstChild).toBeNull();
    // After the fetch settles, still empty — collapse when quiet.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing if the bridge fetch errors", async () => {
    mockFetch({}, 500);
    const { container } = render(<RecentHaltsPanel />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it("renders the panel with categories + recent rows when there are halts", async () => {
    mockFetch({
      total: 5,
      byCategory: { tool_threw: 3, kill_switch: 2 },
      recent: [
        { reason: "tool foo blew up", category: "tool_threw", runSeq: 91 },
        { reason: "killed by user", category: "kill_switch", runSeq: 88 },
      ],
    });
    const { container } = render(<RecentHaltsPanel />);
    // Heading reads "Recent <Glossary>halts</Glossary> · last 24h" — the
    // glossary primitive wraps "halts" in a button, so the text is
    // broken across nodes. Match on container.textContent.
    await waitFor(() => {
      expect(container.textContent).toMatch(/Recent halts/);
    });
    expect(container.textContent).toMatch(/5 halts/);
    expect(container.textContent).toMatch(/tool threw/);
    expect(container.textContent).toMatch(/kill switch/);
    expect(container.textContent).toMatch(/tool foo blew up/);
    // Most-recent rows link to per-run detail pages.
    const link = container.querySelector('a[href="/runs/91"]');
    expect(link).not.toBeNull();
  });

  it("singularizes the count when total = 1", async () => {
    mockFetch({
      total: 1,
      byCategory: { tool_threw: 1 },
      recent: [{ reason: "x", category: "tool_threw", runSeq: 7 }],
    });
    const { container } = render(<RecentHaltsPanel />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/1 halt →/);
    });
  });
});
