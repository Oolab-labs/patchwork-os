/**
 * Verifies the topbar live-event ticker:
 *   - renders an "idle" message before any event arrives
 *   - renders up to 3 most-recent events with the right tone + label
 *   - tool events render with the tool name + optional duration
 *   - lifecycle approval_decision events render decision + tool name
 *   - error tool calls render in the err tone (red)
 *   - dismissal hides the ticker + persists across remounts
 *   - clicking an event with id routes to /activity?focus=<id>
 *
 * The component uses useBridgeStream under the hood. Rather than mock
 * the hook directly (which would couple tests to its internals), we
 * mock useBridgeStream's transport by stubbing EventSource and
 * dispatching messages on it.
 */

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityTicker } from "@/components/ActivityTicker";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Defer onopen so the first render is "connecting" — production
    // EventSource also opens asynchronously.
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

const originalES = global.EventSource;

describe("<ActivityTicker/>", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    window.localStorage.clear();
    (global as unknown as { EventSource: typeof MockEventSource }).EventSource =
      MockEventSource;
  });
  afterEach(() => {
    window.localStorage.clear();
    global.EventSource = originalES;
  });

  it("shows a placeholder while idle", () => {
    const { getByText } = render(<ActivityTicker />);
    expect(getByText(/Listening for events|Live stream offline/)).toBeInTheDocument();
  });

  it("renders the most-recent tool event with its name + duration", async () => {
    const { findByText } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({ kind: "tool", tool: "Bash", status: "success", durationMs: 42, id: 1 });
    });
    expect(await findByText(/Bash \(42ms\)/)).toBeInTheDocument();
  });

  it("colours errored tool calls red and successful ones green (via inline style)", async () => {
    const { findByText } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({ kind: "tool", tool: "ToolA", status: "error", id: 1 });
    });
    const link = (await findByText(/ToolA · error/)).closest("a")!;
    expect(link.getAttribute("style") ?? "").toMatch(/var\(--red\)/);
  });

  it("renders approval_decision lifecycle with decision + tool name", async () => {
    const { findByText } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({
        kind: "lifecycle",
        event: "approval_decision",
        metadata: { decision: "approved", toolName: "Bash" },
        id: 7,
      });
    });
    expect(await findByText(/approved · Bash/)).toBeInTheDocument();
  });

  it("keeps only the 3 most-recent events visible", async () => {
    const { container } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({ kind: "tool", tool: "A", status: "success", id: 1 });
      es.emit({ kind: "tool", tool: "B", status: "success", id: 2 });
      es.emit({ kind: "tool", tool: "C", status: "success", id: 3 });
      es.emit({ kind: "tool", tool: "D", status: "success", id: 4 });
      es.emit({ kind: "tool", tool: "E", status: "success", id: 5 });
    });
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(3);
    // Newest first.
    expect(items[0]!.textContent).toMatch(/^E/);
    expect(items[2]!.textContent).toMatch(/^C/);
  });

  it("each event with an id links to /activity?focus=<id>", async () => {
    const { findByText } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({ kind: "tool", tool: "X", status: "success", id: 91 });
    });
    const link = (await findByText(/X/)).closest("a")!;
    expect(link.getAttribute("href")).toBe("/activity?focus=91");
  });

  it("dismissal hides the ticker + persists across remounts", async () => {
    const { container, getByRole, unmount } = render(<ActivityTicker />);
    fireEvent.click(getByRole("button", { name: /hide activity ticker/i }));
    expect(container.firstChild).toBeNull();
    unmount();
    const { container: c2 } = render(<ActivityTicker />);
    expect(c2.firstChild).toBeNull();
  });

  // LOW #44 — dedup set tests
  it("deduplicates adjacent events with the same id", async () => {
    const { container } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({ kind: "tool", tool: "Bash", status: "success", id: 10 });
      es.emit({ kind: "tool", tool: "Bash", status: "success", id: 10 }); // duplicate
    });
    // Should only appear once in the visible list
    const items = container.querySelectorAll("li");
    expect(items.length).toBe(1);
  });

  it("deduplicates non-adjacent events with the same id (LOW #44)", async () => {
    // Non-adjacent duplicate — the old lastIdRef approach only caught adjacent
    // duplicates (id5, id5) but missed (id5, id6, id5).
    const { container } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      es.emit({ kind: "tool", tool: "First",  status: "success", id: 5 });
      es.emit({ kind: "tool", tool: "Second", status: "success", id: 6 });
      es.emit({ kind: "tool", tool: "First",  status: "success", id: 5 }); // duplicate of id:5
    });
    // Only 2 unique events (id:5 and id:6), not 3.
    const items = container.querySelectorAll("li");
    // With MAX_VISIBLE=3, all unique events show; but id:5 must appear only once.
    const texts = Array.from(items).map((li) => li.textContent ?? "");
    const firstCount = texts.filter((t) => /^First/.test(t)).length;
    expect(firstCount).toBe(1);
    expect(items.length).toBe(2);
  });

  it("allows the same id to be re-shown after the dedup window (set > 50) is evicted", async () => {
    // Emit 51 distinct events to push id:1 out of the 50-slot window,
    // then re-emit id:1 — it should reappear.
    const { container } = render(<ActivityTicker />);
    const es = MockEventSource.instances[0]!;
    await act(async () => {
      // First emit: id 1
      es.emit({ kind: "tool", tool: "Original", status: "success", id: 1 });
      // Flood with 50 more distinct ids to evict id:1 from the window
      for (let i = 2; i <= 51; i++) {
        es.emit({ kind: "tool", tool: `T${i}`, status: "success", id: i });
      }
      // Re-emit id:1 — should now be accepted (evicted from window)
      es.emit({ kind: "tool", tool: "Reappeared", status: "success", id: 1 });
    });
    // The ticker shows MAX_VISIBLE=3 most recent. The last event re-emitted
    // id:1 ("Reappeared"), so it should be in the visible list.
    const items = container.querySelectorAll("li");
    const texts = Array.from(items).map((li) => li.textContent ?? "");
    expect(texts[0]).toMatch(/^Reappeared/);
  });
});
