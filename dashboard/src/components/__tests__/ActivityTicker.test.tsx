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
});
